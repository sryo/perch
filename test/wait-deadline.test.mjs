// A timed-out wait, wait {quiet} or awaitPromise ends on its deadline, measured
// from the call's start, and is not followed by a dialog probe: the page answered
// its polls, so nothing blocked it. Only a hang (the REPL killed, a reply that
// never came) is probed. Fake world, virtual clock.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JXA_PRELUDE, DAEMONS, handleCall, deps, HANG, ERR } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const saved = { fast: DAEMONS.fast, slow: DAEMONS.slow, dialogs: deps.dialogs };
afterEach(() => {
  DAEMONS.fast = saved.fast;
  DAEMONS.slow = saved.slow;
  deps.dialogs = saved.dialogs;
});

const OPEN = [{ kind: "confirm", message: "Delete the draft?" }];
let probes = 0;
const countProbes = (found = []) => { probes = 0; deps.dialogs = async () => { probes++; return found; }; };

function install({ dom } = {}) {
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return world;
}
const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  return { r, t };
};
// Clock times at which page scripts were sent.
const execStarts = (world) => {
  const at = [];
  world.state.onExecute = () => at.push(world.clock.t);
  return at;
};
const mutating = () => {
  const dom = page(`<p id=s>Idle</p><div id=spin></div>`);
  const orig = dom.eval.bind(dom);
  let n = 0;
  dom.eval = (js) => { dom.document.getElementById("spin").textContent = String(++n); return orig(js); };
  return dom;
};

test("runtime deadline timeouts keep their wording and never probe for dialogs", async () => {
  countProbes(OPEN);
  install({ dom: page(`<p>x</p>`) });
  let { r, t } = await call("wait", { expression: "false", timeout: 300 });
  assert.equal(r.isError, true);
  assert.equal(t, "error: timeout: wait timed out after 300ms");
  assert.equal(probes, 0, "wait {expression}");

  install({ dom: mutating() });
  ({ r, t } = await call("wait", { quiet: 200, timeout: 300 }));
  assert.equal(t, "error: timeout: wait timed out after 300ms; the page never stayed quiet for 200ms");
  assert.equal(probes, 0, "wait {quiet}");

  install();
  ({ r, t } = await call("eval_js", { script: "await new Promise(() => {})", awaitPromise: true }));
  assert.match(t, /^error: timeout: eval_js \(awaitPromise\) timed out after 30000ms; the code ran and may still be running/);
  assert.equal(probes, 0, "awaitPromise");
});

test("only hangs are probed: the REPL killed, or a reply that never came", async () => {
  const hangs = [
    "timeout: osascript gave up after 35000ms: the tab is unreachable (hung page, or a tab its window doesn't show). Re-run list_tabs.",
    "timeout: page JS got no reply within 2s; the page may be navigating; retry",
    "timeout: page JS got no reply within 5s; it may have run, and the page may be navigating; retry after checking the page",
    "timeout: the click ran but its result got no reply; the page may be navigating; don't click again, check the page",
    "timeout: page JS failed without a reply; it may have run, and the page may be navigating; retry after checking the page",
    "timeout: page JS got no reply within the Apple Event timeout",
    "timeout: the page didn't answer, so the load may or may not have started; check the tab's url before retrying",
  ];
  const deadlines = [
    "timeout: wait timed out after 300ms",
    "timeout: wait timed out after 300ms; the page never stayed quiet for 200ms",
    "timeout: eval_js (awaitPromise) timed out after 300ms; the code ran and may still be running",
  ];
  for (const msg of hangs.concat(deadlines)) {
    countProbes(OPEN);
    DAEMONS.fast = { run: async () => { throw new Error(msg); } };
    const { t } = await call("eval_js", { script: "return 1", target: { tabId: "chrome:x" } });
    if (hangs.includes(msg)) {
      assert.match(t, /^error: dialog_open: a confirm/, msg);
      assert.equal(probes, 1, msg);
    } else {
      assert.equal(t, "error: " + msg);
      assert.equal(probes, 0, msg);
    }
  }
});

test("every hang message is built from the shared HANG phrases the probe checks", async () => {
  const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const decl = src.slice(src.indexOf("export const HANG = {"), src.indexOf("};", src.indexOf("export const HANG = {")));
  const rest = src.replace(decl, "");
  for (const [key, phrase] of Object.entries(HANG)) {
    assert.equal(rest.includes(phrase.trim()), false, `"${phrase}" is spelled out outside HANG`);
    assert.match(rest, new RegExp("HANG\\." + key + "\\b"), `HANG.${key} is never used to build a message`);
  }
  // The Node-side kill, built for real, is probed.
  countProbes(OPEN);
  DAEMONS.fast = { run: async () => { throw new Error(ERR.timeout(35000)); } };
  const { t } = await call("eval_js", { script: "return 1", target: { tabId: "chrome:x" } });
  assert.match(t, /^error: dialog_open: a confirm/);
});

test("wait {quiet}: time spent finding the tab counts against the timeout", async () => {
  countProbes();
  const world = install({ dom: mutating() });
  let spent = false;
  world.state.onCgList = () => { if (!spent) { spent = true; world.clock.t += 200; } };
  const at = execStarts(world);
  const t0 = world.clock.t;
  const { t } = await call("wait", { quiet: 100, timeout: 300 });
  const took = world.clock.t - t0;
  assert.match(t, /^error: timeout: wait timed out after 300ms/);
  assert.ok(spent, "the tab lookup ran");
  assert.ok(at.length >= 1, "polled at least once");
  assert.ok(at.every((x) => x < t0 + 300), `a poll started after the deadline: ${at.map((x) => x - t0)}`);
  assert.ok(took <= 300 + 50 + 100, `took ${took}ms`);
});

test("wait: no poll run starts at or after the deadline", async () => {
  countProbes();
  const world = install();
  const handle = "chrome:x";
  await call("list_tabs", {});
  const at = execStarts(world);
  const t0 = world.clock.t;
  const { t } = await call("wait", { expression: "false", timeout: 300, target: { tabId: handle } });
  assert.equal(t, "error: timeout: wait timed out after 300ms");
  assert.deepEqual(at.map((x) => x - t0), [0, 50, 100, 150, 200, 250]);
  assert.equal(world.clock.t - t0, 300);
});

test("awaitPromise: once the deadline passed after a negative poll, it ends without another run", async () => {
  const world = install();
  await call("list_tabs", {});
  const at = execStarts(world);
  const t0 = world.clock.t;
  // The kick holds the page 250ms of the 300: one poll fits, then the deadline.
  const kick = `(function(){window.__k=0;__busy(250);return "1"})()`;
  const poll = `(function(){var v=window.__k;if(v===undefined)return '{"__perch_gone":1}';return v===0?"null":JSON.stringify(v)})()`;
  assert.throws(() => world.run(`__perch.evalAsync(${JSON.stringify({ target: { tabId: "chrome:x" }, kick, poll, timeout: 300 })})`),
    /^Error: timeout: eval_js \(awaitPromise\) timed out after 300ms; the code ran/);
  assert.deepEqual(at.map((x) => x - t0), [0, 250], "the kick, then one poll");
  assert.equal(world.clock.t - t0, 300);
});
