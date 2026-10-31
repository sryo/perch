// A client that cuts tool calls short (Codex at 60s, Copilot at 30s by default)
// can't take one eval_js await that runs longer. With PERCH_CALL_MAX_MS set, an
// await whose timeout passes it answers {ok:true, pending:true, job} once that
// budget is spent, and wait {job} picks it up again, each call under the budget,
// until the page's promise settles or the original timeout runs out. Fake world,
// virtual clock.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JXA_PRELUDE, DAEMONS, handleCall, deps } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const saved = { ...DAEMONS, dialogs: deps.dialogs };
afterEach(() => {
  for (const lane of ["fast", "slow", "long"]) DAEMONS[lane] = saved[lane];
  for (const lane of ["long2", "long3", "long4"]) delete DAEMONS[lane];
  deps.dialogs = saved.dialogs;
  delete process.env.PERCH_CALL_MAX_MS;
});
const H = "chrome:x";
let world;
function install() {
  world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x" }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  for (const lane of ["fast", "slow", "long"]) DAEMONS[lane] = { run: (script) => world.daemon.run(script) };
  deps.dialogs = async () => [];
}
const pg = () => world.page("Google Chrome", 0, 0);
const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  let o = null; try { o = JSON.parse(t); } catch {}
  return { r, t, o };
};
const SETTLE = "return await new Promise((res) => { window.__go = res; })";
const settleAt = (ms, value) => {
  const t0 = world.clock.t;
  let done = false;
  world.state.onExecute = () => {
    if (done || world.clock.t - t0 < ms) return;
    done = true;
    pg().__go(value);
    vm.runInContext("0", pg());
  };
};

test("an await past PERCH_CALL_MAX_MS answers a job within the budget, and wait {job} takes its value", async () => {
  install();
  await call("list_tabs", {});
  process.env.PERCH_CALL_MAX_MS = "25000";
  settleAt(40000, 42);
  const t0 = world.clock.t;
  const first = await call("eval_js", { script: SETTLE, awaitPromise: true, timeout: 120000, target: { tabId: H } });
  assert.equal(first.o.pending, true, first.t);
  assert.equal(first.o.ok, true);
  assert.equal(typeof first.o.job, "string");
  assert.ok(world.clock.t - t0 <= 25000, `first call took ${world.clock.t - t0}ms`);
  const t1 = world.clock.t;
  const second = await call("wait", { job: first.o.job, target: { tabId: H } });
  assert.equal(second.t, "42", second.t);
  assert.ok(world.clock.t - t1 <= 25000, `second call took ${world.clock.t - t1}ms`);
});

test("wait {job} answers pending again while the promise is still out, then times out at the original deadline", async () => {
  install();
  await call("list_tabs", {});
  process.env.PERCH_CALL_MAX_MS = "25000";
  const t0 = world.clock.t;
  const first = await call("eval_js", { script: "await new Promise(() => {})", awaitPromise: true, timeout: 60000, target: { tabId: H } });
  assert.equal(first.o.pending, true);
  const second = await call("wait", { job: first.o.job, target: { tabId: H } });
  assert.equal(second.o.pending, true, second.t);
  assert.equal(second.o.job, first.o.job);
  const third = await call("wait", { job: first.o.job, target: { tabId: H } });
  assert.match(third.t, /^error: timeout: eval_js \(awaitPromise\) timed out after 60000ms/);
  assert.ok(world.clock.t - t0 <= 60100, `ended at ${world.clock.t - t0}ms`);
});

test("without PERCH_CALL_MAX_MS, or with a timeout under it, an await blocks as before", async () => {
  install();
  await call("list_tabs", {});
  settleAt(40000, 7);
  assert.equal((await call("eval_js", { script: SETTLE, awaitPromise: true, timeout: 120000, target: { tabId: H } })).t, "7");
  process.env.PERCH_CALL_MAX_MS = "25000";
  settleAt(10000, 8);
  assert.equal((await call("eval_js", { script: SETTLE, awaitPromise: true, timeout: 20000, target: { tabId: H } })).t, "8");
});

test("a malformed job is bad_args before any Apple Event", async () => {
  install();
  world.reset();
  const { t } = await call("wait", { job: "nope", target: { tabId: H } });
  assert.match(t, /^error: bad_args: wait `job`/);
  assert.equal(Object.keys(world.counts).filter((k) => /execute|NSAppleScript/.test(k)).length, 0);
});
