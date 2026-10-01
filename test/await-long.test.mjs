// eval_js {awaitPromise, timeout}: a caller may wait up to AWAIT_MAX_MS (5 min)
// for a long page job (a design tool loading every page, a large export in a
// background tab); the default stays 30s. A wait past the default runs on its
// own lane, so neither quick calls (fast) nor polling tools (slow) queue behind
// it, and its polls back off after the first seconds. Navigation, a closed tab
// and a page that stops answering still end it as before. Fake world, virtual
// clock.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JXA_PRELUDE, DAEMONS, handleCall, deps, AWAIT_MAX_MS } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const saved = { ...DAEMONS, dialogs: deps.dialogs };
afterEach(() => {
  for (const lane of ["fast", "slow", "long"]) DAEMONS[lane] = saved[lane];
  deps.dialogs = saved.dialogs;
});

const H = "chrome:x";
// The runtime entry a script calls, past rt()'s note helpers.
const entry = (script) => [...script.matchAll(/__perch\.(\w+)\(/g)].map((m) => m[1]).find((f) => f !== "takeNote" && f !== "lateArm");
let world;
// Every lane on the world's daemon; `lanes` records which lane ran each entry.
function install() {
  world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x" }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  const lanes = [];
  for (const lane of ["fast", "slow", "long"]) {
    DAEMONS[lane] = { run: (script, timeout) => { lanes.push([lane, entry(script), timeout]); return world.daemon.run(script); } };
  }
  deps.dialogs = async () => [];
  return lanes;
}
const pg = () => world.page("Google Chrome", 0, 0);
const call = async (name, args) => {
  const r = await handleCall(name, args);
  return { r, t: r.content.find((c) => c.type === "text")?.text };
};
const execs = () => Object.entries(world.counts).filter(([k]) => /^tab\.execute/.test(k)).reduce((s, [, n]) => s + n, 0);
const SETTLE = "return await new Promise((res) => { window.__go = res; })";
// Settles the page's promise on the first page script sent at or after `ms` into
// the call; the page's next turn runs its continuation.
const settleAt = (ms, value) => {
  const t0 = world.clock.t;
  let done = false;
  world.state.onExecute = () => {
    if (done || world.clock.t - t0 < ms) return;
    done = true;
    pg().__go(value);
    vm.runInContext("0", pg());
  };
  return t0;
};

for (const [at, timeout] of [[45000, 60000], [200000, AWAIT_MAX_MS]]) {
  test(`a promise settling at ${at / 1000}s answers ok under timeout:${timeout}, on the long lane`, async () => {
    const lanes = install();
    await call("list_tabs", {});
    const t0 = settleAt(at, at);
    const { r, t } = await call("eval_js", { script: SETTLE, awaitPromise: true, timeout, target: { tabId: H } });
    const took = world.clock.t - t0;
    assert.equal(r.isError, undefined, t);
    assert.equal(t, String(at));
    // Seen at most 5% late, plus one poll.
    assert.ok(took >= at && took <= at * 1.05 + 100, `took ${took}ms`);
    const run = lanes.find(([, fn]) => fn === "evalAsync");
    assert.equal(run[0], "long");
    assert.ok(run[2] >= timeout + 5000, `the Node-side kill waits ${run[2]}ms`);
  });
}

test("the default timeout still ends at 30s, on the slow lane", async () => {
  const lanes = install();
  await call("list_tabs", {});
  const t0 = settleAt(45000, 1);
  const { r, t } = await call("eval_js", { script: SETTLE, awaitPromise: true, target: { tabId: H } });
  assert.equal(r.isError, true);
  assert.match(t, /^error: timeout: eval_js \(awaitPromise\) timed out after 30000ms; the code ran/);
  const took = world.clock.t - t0;
  assert.ok(took >= 30000 && took <= 30000 + 100, `took ${took}ms`);
  assert.equal(lanes.find(([, fn]) => fn === "evalAsync")[0], "slow");
});

test("a timeout up to 30s stays on the slow lane and is honoured", async () => {
  const lanes = install();
  await call("list_tabs", {});
  const t0 = world.clock.t;
  const { t } = await call("eval_js", { script: "await new Promise(() => {})", awaitPromise: true, timeout: 2000, target: { tabId: H } });
  assert.match(t, /^error: timeout: eval_js \(awaitPromise\) timed out after 2000ms/);
  assert.ok(world.clock.t - t0 <= 2100, `took ${world.clock.t - t0}ms`);
  assert.equal(lanes.find(([, fn]) => fn === "evalAsync")[0], "slow");
});

test("a timeout over 300s, under 1s, or not a number, is bad_args before any Apple Event", async () => {
  install();
  for (const [args, re] of [
    [{ awaitPromise: true, timeout: AWAIT_MAX_MS + 1 }, /^error: bad_args: eval_js awaits at most 300000ms \(5 min\); got 300001\. /],
    [{ awaitPromise: true, timeout: 1e9, world: "main" }, /^error: bad_args: eval_js awaits at most 300000ms/],
    // Seconds given by mistake would time out at once, and a re-run repeats side effects.
    [{ awaitPromise: true, timeout: 60 }, /^error: bad_args: eval_js timeout is in milliseconds \(1000 to 300000\); got 60$/],
    [{ awaitPromise: true, timeout: 999, world: "main" }, /^error: bad_args: eval_js timeout is in milliseconds \(1000 to 300000\); got 999$/],
    [{ awaitPromise: true, timeout: 0 }, /^error: bad_args: eval_js timeout is in milliseconds \(1000 to 300000\); got 0$/],
    [{ awaitPromise: true, timeout: "60000" }, /^error: bad_args: eval_js timeout is in milliseconds \(1000 to 300000\); got "60000"$/],
    [{ awaitPromise: true, timeout: NaN }, /^error: bad_args: eval_js timeout is in milliseconds \(1000 to 300000\); got NaN$/],
    [{ timeout: 60000 }, /^error: bad_args: eval_js `timeout` bounds awaitPromise; pass awaitPromise:true or drop it/],
  ]) {
    world.reset();
    const { r, t } = await call("eval_js", { script: "window.ran = 1; return 1", target: { tabId: H }, ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(t, re);
    assert.equal(pg().ran, undefined);
    assert.equal(execs(), 0, JSON.stringify(args));
  }
  for (const timeout of [1000, AWAIT_MAX_MS]) {
    const ok = await call("eval_js", { script: "return 3", awaitPromise: true, timeout, target: { tabId: H } });
    assert.equal(ok.t, "3", `timeout ${timeout}`);
  }
});

test("a long await polls every 50ms for 3s, then backs off to one poll a second", async () => {
  install();
  await call("list_tabs", {});
  world.reset();
  const at = [];
  world.state.onExecute = () => at.push(world.clock.t);
  const t0 = world.clock.t;
  const { t } = await call("eval_js", { script: "await new Promise(() => {})", awaitPromise: true, timeout: AWAIT_MAX_MS, target: { tabId: H } });
  assert.match(t, /^error: timeout: eval_js \(awaitPromise\) timed out after 300000ms; the code ran/);
  assert.ok(world.clock.t - t0 <= AWAIT_MAX_MS + 100, `took ${world.clock.t - t0}ms`);
  const rel = at.map((x) => x - t0);
  const inMin = (m) => rel.filter((x) => x >= m * 60000 && x < (m + 1) * 60000).length;
  const gaps = rel.slice(1).map((x, i) => x - rel[i]);
  // Before: a poll every 50ms, 1200 Apple Events a minute for as long as it waited.
  assert.equal(rel.filter((x) => x < 3000).length, 61, "the kick, then 50ms polls for the first 3s");
  assert.ok(Math.max(...gaps) <= 1000, `longest gap ${Math.max(...gaps)}ms`);
  assert.ok(gaps.every((g, i) => g <= Math.max(50, Math.round(rel[i] / 20)) + 1), "no gap over 5% of the time waited");
  assert.ok(inMin(0) <= 150, `minute 1: ${inMin(0)} Apple Events`);
  for (let m = 1; m < 5; m++) assert.ok(inMin(m) <= 61, `minute ${m + 1}: ${inMin(m)} Apple Events`);
  console.log(`# Apple Events per minute of waiting: ${[0, 1, 2, 3, 4].map(inMin).join(", ")} (was 1200)`);
});

test("quick calls (fast) and polling tools (slow) keep running while a long await waits", async () => {
  const lanes = install();
  await call("list_tabs", {});
  // The long lane holds its job until released, as a REPL busy for minutes would.
  let release;
  const gate = new Promise((r) => { release = r; });
  DAEMONS.long = { run: async (script) => { lanes.push(["long", entry(script)]); await gate; return world.daemon.run(script); } };
  settleAt(120000, "done");
  let long = null;
  const pending = call("eval_js", { script: SETTLE, awaitPromise: true, timeout: 180000, target: { tabId: H } }).then((x) => { long = x; });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lanes.at(-1), ["long", "evalAsync"], "the await went to the long lane");
  const quick = await call("eval_js", { script: "return 1 + 1", target: { tabId: H } });
  assert.equal(quick.t, "2");
  assert.equal((await call("get_text", { target: { tabId: H } })).r.isError, undefined);
  const w = await call("wait", { expression: "location.href", timeout: 1000, target: { tabId: H } });
  assert.equal(JSON.parse(w.t).value, "https://a.test/");
  const short = await call("eval_js", { script: "return 4", awaitPromise: true, target: { tabId: H } });
  assert.equal(short.t, "4");
  assert.equal(long, null, "the long await is still waiting");
  assert.deepEqual(lanes.filter(([l]) => l === "long").map(([, fn]) => fn), ["evalAsync"], "nothing else queued on the long lane");
  release();
  await pending;
  assert.equal(long.t, "done");
});

test("a long await still ends at once on a navigation, a closed tab, or at its deadline on a page that stopped answering", async () => {
  // The document is replaced at 100s: its slot is gone.
  install();
  await call("list_tabs", {});
  let t0 = world.clock.t, at = null;
  // Ends within one poll (at most 1s) of `at`.
  const prompt = (what) => assert.ok(at != null && world.clock.t - at <= 1000 + 50, `${what}: ended ${world.clock.t - at}ms after`);
  world.state.onExecute = () => {
    if (at != null || world.clock.t - t0 < 100000) return;
    at = world.clock.t;
    for (const k of Object.keys(pg())) if (k.startsWith("__perch_async_")) delete pg()[k];
  };
  let out = await call("eval_js", { script: "await new Promise(() => {})", awaitPromise: true, timeout: AWAIT_MAX_MS, target: { tabId: H } });
  assert.match(out.t, /^error: timeout: eval_js \(awaitPromise\) lost its result before the promise settled; it may have run/);
  prompt("navigation");

  // The tab closes at 100s.
  install();
  await call("list_tabs", {});
  t0 = world.clock.t;
  at = null;
  world.state.onExecute = () => {
    if (at != null || world.clock.t - t0 < 100000) return;
    at = world.clock.t;
    world.tabsOf("Google Chrome", 0).splice(0, 1);
  };
  out = await call("eval_js", { script: "await new Promise(() => {})", awaitPromise: true, timeout: AWAIT_MAX_MS, target: { tabId: H } });
  assert.match(out.t, /^error: stale_tab: /);
  prompt("closed tab");

  // One reply dropped at 100s is a "not yet"; the promise settling at 150s still answers.
  install();
  await call("list_tabs", {});
  t0 = settleAt(150000, 7);
  const settle = world.state.onExecute;
  let dropped = 0;
  world.state.hangIf = () => (world.clock.t - t0 >= 100000 && dropped++ === 0);
  world.state.onExecute = settle;
  out = await call("eval_js", { script: SETTLE, awaitPromise: true, timeout: AWAIT_MAX_MS, target: { tabId: H } });
  assert.equal(out.t, "7");
  assert.equal(dropped > 1, true);

  // The page stops answering at 100s: it ends on its deadline, saying so.
  install();
  await call("list_tabs", {});
  t0 = world.clock.t;
  world.state.onExecute = () => { if (world.clock.t - t0 >= 100000) world.state.hung = true; };
  out = await call("eval_js", { script: "await new Promise(() => {})", awaitPromise: true, timeout: 200000, target: { tabId: H } });
  assert.match(out.t, /^error: timeout: eval_js \(awaitPromise\) timed out after 200000ms; .*the page stopped answering/);
  assert.ok(world.clock.t - t0 <= 200000 + 200, `hung: took ${world.clock.t - t0}ms`);
});
