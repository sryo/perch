import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const chrome = (windows, extra = {}) => ({ name: "Google Chrome", kind: "chrome", windows, ...extra });
const arc = (windows, extra = {}) => ({ name: "Arc", kind: "arc", windows, ...extra });
const safari = (windows, extra = {}) => ({ name: "Safari", kind: "safari", windows, ...extra });
const tabs = (n, p = "t") => Array.from({ length: n }, (_, i) => ({ url: `https://${p}${i}.test/`, title: `${p}${i}`, id: `${p}${i}` }));

let world;
function install(spec) {
  world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  return { r, t, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};

beforeEach(() => { world = null; });

test("prelude defines __perch without touching Node scope", () => {
  install({ browsers: [] });
  assert.equal(typeof world.ctx.__perch, "object");
});

test("prelude compiles in real JXA", { skip: process.platform !== "darwin" }, () => {
  const out = execFileSync("osascript", ["-l", "JavaScript", "-e", JXA_PRELUDE + ";typeof __perch"]).toString().trim();
  assert.equal(out, "object");
});

test("default target prefers the browser highest in on-screen z-order", async () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "c") }]), arc([{ id: "A", active: 1, tabs: tabs(3, "a") }])],
    cg: [{ owner: "Terminal" }, { owner: "Arc", pid: 7 }, { owner: "Google Chrome", pid: 8 }],
  });
  await call("eval_js", { script: "window.picked = 1; return 1" });
  assert.equal(world.page("Arc", 0, 1).picked, 1);
  assert.equal(world.counts["tab.execute"], 1);
  assert.equal(world.counts["windows[0](Google Chrome)"], undefined, "chrome never walked");
  assert.equal(world.counts["Application(System Events)"], undefined);
});

test("default target reads only window 0 and never asks window ids", async () => {
  install({
    browsers: [chrome(Array.from({ length: 5 }, (_, i) => ({ id: i + 1, active: 0, tabs: tabs(2, "w" + i) })))],
    cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }],
  });
  await call("eval_js", { script: "return 1" });
  assert.equal(world.counts["windows[1](Google Chrome)"], undefined);
  assert.equal(world.counts["win.id()"], undefined);
  assert.equal(world.counts["deepUnwrap"], 1);
});

test("browsers missing from the CG list are probed with running(); absent apps skipped", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [] });
  const { o } = await call("eval_js", { script: "return 5" });
  assert.equal(o, 5);
  assert.equal(world.counts["running(Google Chrome)"], 1);
});

test("explicit windowId + tabIndex target; out-of-range tabIndex errors", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "x") }, { id: 2, active: 0, tabs: tabs(3, "y") }])], cg: [{ owner: "Google Chrome" }] });
  await call("eval_js", { script: "window.hit = 1; return 1", target: { windowId: 2, tabIndex: 2 } });
  assert.equal(world.page("Google Chrome", 1, 2).hit, 1);
  const { r, t } = await call("eval_js", { script: "return 1", target: { windowId: 2, tabIndex: 9 } });
  assert.equal(r.isError, true);
  assert.match(t, /tabIndex 9 out of range; window has 3 tabs/);
});

test("active tab detection per browser kind", async () => {
  install({
    browsers: [chrome([{ id: 1, active: 2, tabs: tabs(4, "c") }]), arc([{ id: "A", active: 1, tabs: tabs(3, "a") }]), safari([{ id: 3, active: 2, tabs: tabs(3, "s") }])],
    cg: [{ owner: "Google Chrome" }, { owner: "Arc" }, { owner: "Safari" }],
  });
  const { o } = await call("list_tabs", {});
  const rows = Array.isArray(o) ? o : o.tabs;
  assert.deepEqual(rows.filter((r) => r.active).map((r) => r.title), ["c2", "a1", "s2"]);
  for (const [app, idx] of [["Google Chrome", 2], ["Arc", 1], ["Safari", 2]]) {
    await call("eval_js", { script: "window.picked = 1; return 1", target: { app } });
    assert.equal(world.page(app, 0, idx).picked, 1, app);
  }
});

test("list_tabs reads urls/titles in bulk, never per tab", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(50) }])], cg: [{ owner: "Google Chrome" }] });
  const { o } = await call("list_tabs", {});
  const rows = Array.isArray(o) ? o : o.tabs;
  assert.equal(rows.length >= 1, true);
  assert.equal(world.counts["tabs.url()"], 1);
  assert.equal(world.counts["tab.url"] || 0, 0);
});

test("Arc background tab: every page tool refuses before calling execute", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(3, "a") }])], cg: [{ owner: "Arc" }] });
  const target = { app: "Arc", tabIndex: 2 };
  for (const [tool, args] of [["eval_js", { script: "return 1" }], ["eval_js", { script: "return 1", awaitPromise: true }], ["wait", { readyState: "complete" }], ["get_text", {}]]) {
    const { r, t } = await call(tool, { ...args, target });
    assert.equal(r.isError, true, tool);
    assert.match(t, /Arc cannot .* background tab/, tool);
  }
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("Arc active tab: execute result is unwrapped one layer", async () => {
  install({ browsers: [arc([{ id: "A", active: 1, tabs: tabs(3, "a") }])], cg: [{ owner: "Arc" }] });
  const { o } = await call("eval_js", { script: "return {a: [1, 'x']}" });
  assert.deepEqual(o, { a: [1, "x"] });
});

test("sync and async eval errors have the same shape", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: "Google Chrome" }] });
  const a = await call("eval_js", { script: "throw new TypeError('x')" });
  const b = await call("eval_js", { script: "throw new TypeError('x')", awaitPromise: true });
  assert.equal(a.r.isError, true);
  assert.equal(b.r.isError, true);
  assert.deepEqual(Object.keys(a.o).sort(), Object.keys(b.o).sort());
  assert.equal(b.o.__perch_error_name, "TypeError");
});

test("a trailing line comment in user script does not break the wrapper", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: "Google Chrome" }] });
  const { o } = await call("eval_js", { script: "return 3 // done" });
  assert.equal(o, 3);
});

test("wait polls until true, sleeping on the fake clock", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: "Google Chrome" }], loadTicks: 4 });
  const { o } = await call("wait", { readyState: "complete" });
  assert.equal(o.ok, true);
  assert.ok(o.waited >= 3 * 150, `waited ${o.waited}`);
});

test("wait expression returns its value; timeout is an error", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: "Google Chrome" }] });
  const { o } = await call("wait", { expression: "({n: 2})" });
  assert.deepEqual(o.value, { n: 2 });
  const { r, t } = await call("wait", { expression: "false", timeout: 500 });
  assert.equal(r.isError, true);
  assert.match(t, /timed out after 500ms/);
});

test("navigate waits for the NEW document, not the old one's readyState", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: "Google Chrome" }] });
  world.state.loadTicks = 5; // old page is 'complete'; the next one loads for 5 checks
  const { o } = await call("navigate", { url: "https://next.test/" });
  assert.equal(o.ok, true);
  assert.deepEqual(world.log.filter((l) => l[0] === "navigate"), [["navigate", "Google Chrome", "https://next.test/"]]);
  assert.ok(world.counts["tab.execute"] >= 7, `only ${world.counts["tab.execute"]} executes`);
});

test("navigate to a same-document #hash does not wait for a load", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://a.test/p", id: "x" }] }])], cg: [{ owner: "Google Chrome" }] });
  const t0 = world.clock.t;
  const { o } = await call("navigate", { url: "https://a.test/p#sec" });
  assert.equal(o.ok, true);
  assert.ok(world.clock.t - t0 < 1000);
});

test("navigate on an Arc background tab sets the url without evaluating", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(2, "a") }])], cg: [{ owner: "Arc" }] });
  const { r } = await call("navigate", { url: "https://n.test/", target: { tabIndex: 1 } });
  assert.equal(r.isError, undefined);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("new_tab and click run exactly once even when the call times out", async () => {
  let runs = 0;
  const hang = { run: async () => { runs++; throw new Error("osascript timed out after 30000ms: target tab unreachable"); } };
  DAEMONS.fast = hang; DAEMONS.slow = hang;
  const a = await handleCall("new_tab", { url: "about:blank" });
  const b = await handleCall("click", { selector: "button" });
  assert.equal(a.isError, true);
  assert.equal(b.isError, true);
  assert.equal(runs, 2);
});

test("activate_tab selects via each browser's working verb", async () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: tabs(3, "c") }]), arc([{ id: "A", active: 0, tabs: tabs(3, "a") }]), safari([{ id: 3, active: 0, tabs: tabs(3, "s") }])],
    cg: [{ owner: "Google Chrome" }],
  });
  for (const app of ["Google Chrome", "Arc", "Safari"]) {
    const { r } = await call("activate_tab", { target: { app, tabIndex: 2 } });
    assert.equal(r.isError, undefined, app);
  }
  assert.equal(world.counts["win.activeTabIndex="], 1);
  assert.equal(world.counts["tab.select"], 1);
  assert.equal(world.counts["win.currentTab="], 1);
  assert.equal(world.counts["activate(Arc)"], 1);
});

test("raising a second window still switches the tab in THAT window", async () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: tabs(4, "a") }, { id: 2, active: 0, tabs: tabs(4, "b") }])],
    cg: [{ owner: "Google Chrome" }],
  });
  const { r } = await call("activate_tab", { target: { windowId: 2, tabIndex: 3 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  const { o } = await call("list_tabs", {});
  const active = o.tabs.filter((t) => t.active);
  assert.deepEqual(active.map((t) => [t.windowId, t.tabIndex]), [[2, 3]]);
});
