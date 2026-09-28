// A second instance of the user's browser (another tool's headless copy, with its
// own profile and no Dock icon). AppleScript's by-name `tell` reaches that one,
// while JXA's Application(name) reaches the user's, so page JS must not take the
// NSAppleScript path, and CG lookups by owner name must keep to the user's pid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const FRAME = { x: 0, y: 57, w: 854, h: 600 };
const HEADLESS = { name: "Google Chrome", bundle: "com.google.Chrome", pid: 777 };

let world, handle;
async function install({ twin = HEADLESS, cg = [{ owner: "Google Chrome", pid: 100, wid: 50, ...FRAME }] } = {}) {
  world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [
      { id: 1, active: 0, ...FRAME, tabs: [{ url: "https://a0.test/", id: "a0" }] },
    ] }],
    cg,
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  if (twin) world.state.twins = [twin];
  handle = (await call("list_tabs", {})).o.tabs[0].tabId;
  world.reset();
}
const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  return { r, t, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
const rt = (fn, args) => JSON.parse(world.run(`JSON.stringify(__perch.${fn}(${JSON.stringify(args)}))`));
const page = () => world.page("Google Chrome", 0, 0);

test("two instances: select starts once and picks in the user's tab", async () => {
  await install();
  const out = rt("select", {
    target: { tabId: handle },
    start: "window.starts = (window.starts || 0) + 1; JSON.stringify({pending: true})",
    pick: "window.picks = (window.picks || 0) + 1; JSON.stringify({ok: true})",
    miss: "JSON.stringify({ok: false, error: 'miss'})",
    read: "JSON.stringify({ok: true, value: 'B'})", readFinal: "JSON.stringify(null)",
  });
  assert.deepEqual(out, { ok: true, value: "B" });
  assert.equal(page().starts, 1);
  assert.equal(page().picks, 1);
  assert.equal(world.counts.NSAppleScript || 0, 0);
});

test("two instances: wait, click and awaitPromise reach the user's tab", async () => {
  await install();
  const w = await call("wait", { expression: "location.href", timeout: 2000, target: { tabId: handle } });
  assert.equal(w.r.isError, undefined, w.t);
  assert.equal(w.o.value, "https://a0.test/");
  const c = rt("click", {
    target: { tabId: handle }, click: "window.clicks = (window.clicks || 0) + 1; JSON.stringify({ok: true})",
    read: "JSON.stringify(null)", readFinal: "JSON.stringify({changed: false})", settle: 100,
  });
  assert.equal(c.ok, true);
  assert.equal(page().clicks, 1);
  const e = await call("eval_js", { script: "await 0; return 5", awaitPromise: true, target: { tabId: handle } });
  assert.equal(e.r.isError, undefined, e.t);
  assert.equal(e.t, "5");
  assert.equal(world.counts.NSAppleScript || 0, 0);
});

test("one instance still takes the bounded path", async () => {
  await install({ twin: null });
  const w = await call("wait", { expression: "location.href", timeout: 2000, target: { tabId: handle } });
  assert.equal(w.o.value, "https://a0.test/");
  assert.ok(world.counts.NSAppleScript >= 1);
});

test("a headless twin's window in front is never taken for the user's", async () => {
  await install({ cg: [
    { owner: "Google Chrome", pid: 777, wid: 90, ...FRAME },
    { owner: "Google Chrome", pid: 100, wid: 50, ...FRAME },
  ] });
  const I = rt("shotGeom", { target: { tabId: handle } });
  assert.equal(I.pid, 100);
  assert.equal(I.windowNumber, 50);
  assert.equal(I.ambiguous, undefined);
});

test("two regular instances with windows: window lookups refuse with a code", async () => {
  await install({ twin: { ...HEADLESS, policy: 0 }, cg: [
    { owner: "Google Chrome", pid: 777, wid: 90, x: 900, y: 57, w: 854, h: 600 },
    { owner: "Google Chrome", pid: 100, wid: 50, ...FRAME },
  ] });
  assert.throws(() => rt("shotGeom", { target: { tabId: handle } }), /^Error: window_ambiguous: /);
});

test("a fresh runtime's first page call with a twin imports AppKit and takes the plain path", async () => {
  await install({ cg: [] });
  assert.equal(world.state.imports.includes("AppKit"), false, "nothing before the page call needed AppKit");
  const w = await call("wait", { expression: "location.href", timeout: 2000, target: { tabId: handle } });
  assert.equal(w.o.value, "https://a0.test/", w.t);
  assert.equal(world.counts.NSAppleScript || 0, 0);
});

test("importing AppKit makes the runtime a prohibited app, once", async () => {
  await install();
  for (let i = 0; i < 2; i++) await call("wait", { expression: "1", timeout: 500, target: { tabId: handle } });
  assert.ok(world.state.imports.includes("AppKit"));
  assert.deepEqual(world.state.policies, [2]);
});

test("an instance count that can't be read takes the plain path", async () => {
  await install({ twin: null });
  world.state.countFails = true;
  const w = await call("wait", { expression: "location.href", timeout: 2000, target: { tabId: handle } });
  assert.equal(w.o.value, "https://a0.test/", w.t);
  assert.equal(world.counts.NSAppleScript || 0, 0);
});
