import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

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

test("prelude compiles in real JXA", { skip: process.platform !== "darwin" || process.env.PERCH_LIVE === "0" }, () => {
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
  assert.equal(rows.length, 50);
  assert.equal(world.counts["tabs.url()"], 1);
  assert.equal(world.counts["tab.url"] || 0, 0);
});

test("Arc background tab: every page tool refuses before calling execute", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(3, "a") }])], cg: [{ owner: "Arc" }] });
  const target = { app: "Arc", tabIndex: 2 };
  for (const [tool, args] of [["eval_js", { script: "return 1" }], ["eval_js", { script: "return 1", awaitPromise: true }], ["wait", { readyState: "complete" }], ["get_text", {}]]) {
    const { r, t } = await call(tool, { ...args, target });
    assert.equal(r.isError, true, tool);
    assert.match(t, /^error: tab_not_visible: /, tool);
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
  assert.equal(a.o.__perch_error, "x");
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
  assert.ok(o.waited >= 3 * 50, `waited ${o.waited}`);
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
  // The old 'complete' document answers 3 more checks, then the next one loads for 5.
  world.state.linger = 3;
  world.state.loadTicks = 5;
  const { o } = await call("navigate", { url: "https://next.test/" });
  assert.equal(o.ok, true);
  assert.deepEqual(world.log.filter((l) => l[0] === "navigate" || l[0] === "assign"), [["assign", "Google Chrome", "https://next.test/"]]);
  // 1 stamp + 3 on the old document + 5 loading + 1 complete.
  assert.equal(world.counts["tab.execute"], 10);
  assert.equal(o.waited, true);
  assert.equal(world.page("Google Chrome", 0, 0).location.href, "https://next.test/");
});

test("navigate to a same-document #hash does not wait for a load", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://a.test/p", id: "x" }] }])], cg: [{ owner: "Google Chrome" }] });
  const t0 = world.clock.t;
  const { o } = await call("navigate", { url: "https://a.test/p#sec" });
  assert.equal(o.ok, true);
  assert.equal(world.counts["tab.execute"], 1);
  assert.equal(o.waited, true);
  assert.ok(world.clock.t - t0 < 1000);
});

test("navigate to a download or 204 returns once loading settles, not at the timeout", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: "Google Chrome" }] });
  world.state.noContent = /\.zip$/;
  const t0 = world.clock.t;
  const { o } = await call("navigate", { url: "https://t0.test/file.zip" });
  // The tab still shows its page; a load the page dropped looks the same.
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: the tab stayed on https:\/\/t0\.test\/, as a download/);
  // Past the 300ms grace, two idle loading() reads in a row end the wait.
  assert.ok(world.clock.t - t0 >= 300 && world.clock.t - t0 < 1000, `took ${world.clock.t - t0}ms`);
  assert.equal(world.page("Google Chrome", 0, 0).location.href, "https://t0.test/");
});

test("navigate gives up at its timeout when the new document never arrives", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: "Google Chrome" }] });
  world.state.linger = 1e9;
  const t0 = world.clock.t;
  const { r } = await call("navigate", { url: "https://slow.test/" });
  assert.equal(r.isError, undefined);
  const took = world.clock.t - t0;
  assert.ok(took >= 15000 && took < 16000, `took ${took}ms`);
});

test("navigate tells the caller a load it gave up on didn't finish", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: "Google Chrome" }] });
  world.state.linger = 1e9;
  const { o } = await call("navigate", { url: "https://slow.test/" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^timeout: https:\/\/slow\.test\/ had not committed/);
});

test("navigate on an Arc background tab sets the url without evaluating", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(2, "a") }])], cg: [{ owner: "Arc" }] });
  const { r } = await call("navigate", { url: "https://n.test/", target: { tabIndex: 1 } });
  assert.equal(r.isError, undefined);
  assert.deepEqual(world.log.filter((l) => l[0] === "navigate"), [["navigate", "Arc", "https://n.test/"]]);
  assert.equal(JSON.parse(r.content[0].text).waited, true);
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

test("new_tab creates a background tab without selecting it", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  const { r, o } = await call("new_tab", { app: "Google Chrome", url: "about:blank" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(o, { app: "Google Chrome", tabId: "chrome:new1" });
  assert.equal(world.winSpec("Google Chrome", 0).active, 0, "the shown tab is unchanged");
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
});

test("new_tab refuses to launch a browser or make a window implicitly", async () => {
  install({ browsers: [chrome([], { running: false })], cg: [{ owner: "Terminal" }] });
  const stopped = await call("new_tab", { app: "Google Chrome", url: "about:blank" });
  assert.equal(stopped.r.isError, true);
  assert.match(stopped.t, /already be running/);
  assert.equal(world.counts["activate(Google Chrome)"], undefined);

  install({ browsers: [chrome([])], cg: [{ owner: "Terminal" }] });
  const noWindow = await call("new_tab", { app: "Google Chrome", url: "about:blank" });
  assert.equal(noWindow.r.isError, true);
  assert.match(noWindow.t, /existing window/);
});

test("new_tab never selects the new Arc or Safari tab", async () => {
  install({
    browsers: [arc([{ id: "A", active: 0, tabs: tabs(1, "a") }]), safari([{ id: 2, active: 0, tabs: tabs(1, "s") }])],
    cg: [{ owner: "Terminal" }, { owner: "Arc" }, { owner: "Safari" }],
  });
  const arcTab = await call("new_tab", { app: "Arc", url: "about:blank" });
  const safariTab = await call("new_tab", { app: "Safari", url: "about:blank" });
  assert.equal(arcTab.r.isError, undefined);
  assert.equal(safariTab.r.isError, undefined);
  assert.equal(arcTab.o.tabId, "arc:new1");
  assert.match(safariTab.o.tabId, /^safari:2\.1\./);
  assert.equal(world.counts["tab.select"], undefined);
  assert.equal(world.counts["win.currentTab="], undefined);
  assert.equal(world.counts["activate(Arc)"], undefined);
  assert.equal(world.counts["activate(Safari)"], undefined);
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

// Many tests prove a focus change or a window walk never happened by checking that
// its counter is undefined. That only means something while the server still goes
// through those accessors and the fake still counts them under those names.
test("counter canary: the keys never-happened checks rely on are live", async () => {
  install({
    browsers: [
      chrome([{ id: 1, active: 0, tabs: tabs(2, "c") }, { id: 2, active: 0, tabs: tabs(2, "d") }]),
      arc([{ id: "A", active: 0, tabs: tabs(2, "a") }]),
      safari([{ id: 3, active: 0, tabs: tabs(2, "s") }]),
    ],
    cg: [{ owner: "Google Chrome" }],
  });
  await call("list_tabs", {});
  for (const target of [{ app: "Google Chrome", windowId: 2, tabIndex: 1 }, { app: "Arc", tabIndex: 1 }, { app: "Safari", tabIndex: 1 }]) {
    const { r } = await call("activate_tab", { target });
    assert.equal(r.isError, undefined, target.app);
  }
  for (const key of [
    "windows[0](Google Chrome)", "windows[1](Google Chrome)", "win.id()", "win.index=",
    "win.activeTabIndex=", "win.currentTab=", "tab.select",
    "activate(Google Chrome)", "activate(Arc)", "activate(Safari)",
  ]) assert.ok(world.counts[key] > 0, key);
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
  assert.deepEqual(active.map((t) => t.title), ["b3", "a0"]);
});

// ---- review fixes ----

test("wait with an invalid selector is an error, not an instant success", async () => {
  const dom = page(`<div id="x"></div>`);
  Object.defineProperty(dom.document, "readyState", { value: "complete", configurable: true });
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://a.test/p", id: "d", dom }] }])], cg: [{ owner: "Google Chrome" }] });
  const ok = await call("wait", { selector: "#x" });
  assert.equal(ok.o.ok, true);
  const { r, t } = await call("wait", { selector: "##" });
  assert.equal(r.isError, true);
  assert.match(t, /^error: wait: .*##/);
});

test("Safari navigate makes the tab current before stamping the old document", async () => {
  install({ browsers: [safari([{ id: 3, active: 0, tabs: tabs(2, "s") }])], cg: [{ owner: "Safari" }] });
  const old = world.page("Safari", 0, 1);
  const { o } = await call("navigate", { url: "https://next.test/", target: { tabIndex: 1 } });
  assert.equal(o.ok, true);
  assert.equal(typeof old.__perch_nav, "string", "stamp never reached the old document");
});

test("navigate: a #hash change on a normalized URL is same-document (no load wait)", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x" }] }])], cg: [{ owner: "Google Chrome" }] });
  const t0 = world.clock.t;
  await call("navigate", { url: "https://a.test#sec" });
  assert.ok(world.clock.t - t0 < 300, `waited ${world.clock.t - t0}ms`);
});

// ---- tab handles ----

test("tabId is an opaque handle that alone targets the tab, even after tabs move", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(3, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const { o } = await call("list_tabs", {});
  const row = o.tabs.find((t) => t.title === "c2");
  assert.deepEqual(Object.keys(row), ["app", "tabId", "url", "title"]);
  assert.equal(row.tabId, "chrome:c2");
  const live = world.tabsOf("Google Chrome", 0);
  live.unshift(live.pop()); // c2 moves to position 0
  await call("eval_js", { script: "window.hit = 1; return 1", target: { tabId: row.tabId } });
  assert.equal(live[0].page.ctx.hit, 1);
  assert.equal(live[2].page.ctx.hit, undefined);
});

test("the handle names its browser: equal raw ids in two Chromium apps don't collide", async () => {
  const same = () => [{ url: "https://x.test/", title: "x", id: "5" }];
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: same() }]), { name: "Google Chrome Canary", kind: "chrome", windows: [{ id: 2, active: 0, tabs: same() }] }],
    cg: [{ owner: "Google Chrome" }, { owner: "Google Chrome Canary" }],
  });
  await call("eval_js", { script: "window.hit = 1; return 1", target: { tabId: "canary:5" } });
  assert.equal(world.page("Google Chrome Canary", 0, 0).hit, 1);
  assert.equal(world.page("Google Chrome", 0, 0).hit, undefined);
  // A bare id from before handles still resolves (first browser holding it).
  const { o } = await call("eval_js", { script: "return 2", target: { tabId: "5" } });
  assert.equal(o, 2);
});

test("Safari tabs get handles too: found again by URL after moving, stale after navigating away", async () => {
  install({ browsers: [safari([{ id: 3, active: 1, tabs: tabs(3, "s") }])], cg: [{ owner: "Safari" }] });
  const { o } = await call("list_tabs", {});
  const row = o.tabs.find((t) => t.title === "s1");
  assert.match(row.tabId, /^safari:3\.1\./);
  const live = world.tabsOf("Safari", 0);
  live.unshift(live.splice(1, 1)[0]); // s1 moves to position 0 and stays current
  world.winSpec("Safari", 0).active = 0;
  const { r } = await call("eval_js", { script: "window.hit = 1; return 1", target: { tabId: row.tabId } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(live[0].page.ctx.hit, 1);
  live[0].page.url = "https://elsewhere.test/";
  const gone = await call("eval_js", { script: "return 1", target: { tabId: row.tabId } });
  assert.match(gone.t, /^error: stale_tab: /);
});

test("unknown tabId is stale_tab; unknown browser is no_browser; browser names match loosely", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: "Google Chrome" }] });
  assert.match((await call("eval_js", { script: "return 1", target: { tabId: "chrome:nope" } })).t, /^error: stale_tab: /);
  assert.match((await call("list_tabs", { app: "Netscape" })).t, /^error: no_browser: unknown browser/);
  const { o } = await call("list_tabs", { app: "chrome" });
  assert.equal(o.total, 1);
});

test("new_tab without app opens in the browser the user is looking at", async () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1, "c") }]), arc([{ id: "A", active: 0, tabs: tabs(1, "a") }])],
    cg: [{ owner: "Terminal" }, { owner: "Arc" }, { owner: "Google Chrome" }],
  });
  const { o } = await call("new_tab", { url: "about:blank" });
  assert.deepEqual(o, { app: "Arc", tabId: "arc:new1" });
});

test("tool descriptions and instructions never name a browser", async () => {
  const { TOOLS, INSTRUCTIONS } = await import("../server.js");
  const text = JSON.stringify(TOOLS) + INSTRUCTIONS;
  assert.doesNotMatch(text, /\b(Chrome|Chromium|Arc|Safari|Brave|Edge|Vivaldi|Canary)\b/);
});

test("Arc list_tabs follows the sidebar, not win.tabs order; tabIndex means that row", async () => {
  // Raw order is scrambled; Favorites (topApp) are mixed in, as in real Arc.
  const raw = [
    { id: "u2", url: "https://u2.test/", title: "u2" },
    { id: "f0", url: "https://f0.test/", title: "f0", location: "topApp" },
    { id: "p0", url: "https://p0.test/", title: "p0", location: "pinned" },
    { id: "u1", url: "https://u1.test/", title: "u1" },
  ];
  install({ browsers: [arc([{ id: "A", active: 3, sidebar: ["p0", "u1", "u2"], tabs: raw }])], cg: [{ owner: "Arc" }] });
  const { o } = await call("list_tabs", {});
  assert.deepEqual(o.tabs.map((t) => t.tabId), ["arc:f0", "arc:p0", "arc:u1", "arc:u2"]);
  assert.equal(o.tabs[0].favorite, true);
  assert.equal(o.tabs[1].pinned, true);
  assert.equal(o.tabs[2].active, true);
  await call("eval_js", { script: "window.hit = 1; return 1", target: { tabIndex: 2 } });
  assert.equal(world.page("Arc", 0, 3).hit, 1);
});

test("windows sharing tabs: each tab listed once, tabId runs through the window showing it", async () => {
  const shared = tabs(3, "a");
  install({
    browsers: [arc([{ id: "W1", active: 0, tabs: shared }, { id: "W2", active: 2, tabs: shared }])],
    cg: [{ owner: "Arc" }],
  });
  const { o } = await call("list_tabs", {});
  assert.deepEqual(o.tabs.map((t) => [t.tabId, !!t.active]), [["arc:a0", true], ["arc:a1", false], ["arc:a2", true]]);
  assert.equal(world.counts["tabs.url()"], 1, "shared windows read urls once");
  // a2 is background in W1 (execute would hang there) but active in W2.
  const { r, o: v } = await call("eval_js", { script: "window.hit = 1; return 7", target: { tabId: "arc:a2" } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(v, 7);
  assert.equal(world.page("Arc", 1, 2).hit, 1);
});

test("Arc list_tabs gives the same rows when the all-windows read fails", async () => {
  const shared = tabs(3, "a");
  const spec = () => [{ id: "W1", active: 0, tabs: shared }, { id: "W2", active: 2, tabs: shared }, { id: "W3", active: 1, sidebar: ["b1", "b0"], tabs: tabs(2, "b") }];
  install({ browsers: [arc(spec())], cg: [{ owner: "Arc" }] });
  const bulk = (await call("list_tabs", {})).o;
  install({ browsers: [arc(spec())], cg: [{ owner: "Arc" }] });
  world.state.arcBulkFails = true;
  assert.deepEqual((await call("list_tabs", {})).o, bulk);
  assert.deepEqual(bulk.tabs.map((t) => [t.tabId, !!t.active]), [["arc:a0", true], ["arc:a1", false], ["arc:a2", true], ["arc:b1", true], ["arc:b0", false]]);
});

test("an Arc tabId active in no window is refused as not visible, never executed", async () => {
  const shared = tabs(3, "a");
  install({ browsers: [arc([{ id: "W1", active: 0, tabs: shared }, { id: "W2", active: 0, tabs: shared }])], cg: [{ owner: "Arc" }] });
  const { r, t } = await call("eval_js", { script: "return 1", target: { tabId: "arc:a1" } });
  assert.equal(r.isError, true);
  assert.match(t, /^error: tab_not_visible: /);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("tabId plus windowId only looks in that window", async () => {
  const shared = tabs(3, "a");
  install({ browsers: [arc([{ id: "W1", active: 0, tabs: shared }, { id: "W2", active: 2, tabs: shared }])], cg: [{ owner: "Arc" }] });
  // a2 is shown in W2, but the caller pinned W1, where it is in the background.
  const pinned = await call("eval_js", { script: "return 1", target: { tabId: "arc:a2", windowId: "W1" } });
  assert.match(pinned.t, /^error: tab_not_visible: /);
  const other = await call("eval_js", { script: "return 2", target: { tabId: "arc:a2", windowId: "W2" } });
  assert.equal(other.o, 2);
  const none = await call("eval_js", { script: "return 3", target: { tabId: "arc:a2", windowId: "W9" } });
  assert.match(none.t, /^error: stale_tab: /);
});

test("Chrome windows whose tabs report no ids list windowId/tabIndex rows that still target", async () => {
  const noIds = tabs(2, "n").map(({ id, ...t }) => t);
  install({ browsers: [chrome([{ id: 5, active: 1, tabs: noIds }])], cg: [{ owner: "Google Chrome" }] });
  const { o } = await call("list_tabs", {});
  assert.deepEqual(o.tabs.map((r) => [r.windowId, r.tabIndex, r.tabId, !!r.active]), [[5, 0, undefined, false], [5, 1, undefined, true]]);
  await call("eval_js", { script: "window.hit = 1; return 1", target: { app: "Google Chrome", windowId: 5, tabIndex: 0 } });
  assert.equal(world.page("Google Chrome", 0, 0).hit, 1);
});

test("a window showing no tab is skipped, not read as tab 0", async () => {
  install({
    browsers: [arc([{ id: "NEW", active: null, tabs: tabs(2, "a") }, { id: "OLD", active: 1, tabs: tabs(2, "b") }])],
    cg: [{ owner: "Arc" }],
  });
  const { r } = await call("eval_js", { script: "window.hit = 1; return 1" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(world.page("Arc", 1, 1).hit, 1);
  const { o } = await call("list_tabs", {});
  assert.deepEqual(o.tabs.filter((t) => t.active).map((t) => t.tabId), ["arc:b1"]);
});

test("Arc screenshot picks the CG window by title, pairing same-titled windows front to back", () => {
  install({
    browsers: [arc([
      { id: "W1", active: 0, name: "Docs", tabs: tabs(1, "a") },
      { id: "W2", active: 0, name: "Mail", tabs: tabs(1, "b") },
      { id: "W3", active: 0, name: "Mail", tabs: tabs(1, "c") },
    ])],
    cg: [
      { owner: "Arc", wid: 10, name: "Mail" },
      { owner: "Arc", wid: 11, name: "Docs" },
      { owner: "Arc", wid: 12, name: "Mail" },
    ],
  });
  const wid = (id) => JSON.parse(world.run(`JSON.stringify(__perch.shotGeom({ target: { windowId: "${id}" } }))`)).windowNumber;
  assert.deepEqual([wid("W1"), wid("W2"), wid("W3")], [11, 10, 12]);
});

test("new_tab on Arc refuses a data: url before making any tab", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(1, "a") }])], cg: [{ owner: "Arc" }] });
  const { r, t } = await call("new_tab", { app: "arc", url: "data:text/html,<p>x</p>" });
  assert.equal(r.isError, true);
  assert.match(t, /^error: bad_url: new_tab takes an absolute http\(s\) or file URL, or about:blank; got data$/);
  assert.equal(world.tabsOf("Arc", 0).length, 1);
  assert.deepEqual(world.log, []);
});

test("new_tab on Arc accepts about:blank, which Arc refuses at creation", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(1, "a") }])], cg: [{ owner: "Arc" }] });
  const { r, o } = await call("new_tab", { app: "arc", url: "about:blank" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(world.tabsOf("Arc", 0)[1].page.url, "about:blank");
  assert.equal(o.tabId, "arc:new1");
  // Created on Arc's own new-tab page, then pointed at the url, in that order.
  assert.deepEqual(world.log.filter((l) => l[0] === "newTab" || l[0] === "navigate"),
    [["newTab", "Arc", "arc://newtab"], ["navigate", "Arc", "about:blank"]]);
  // Still a background tab: nothing selected, Arc not brought forward.
  assert.equal(world.counts["tab.select"], undefined);
  assert.equal(world.counts["activate(Arc)"], undefined);
});

test("new_tab on Arc says so when it can't find the tab it made for an about: url", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(1, "a") }])], cg: [{ owner: "Arc" }] });
  world.state.tabIdsFail = true;
  const { r, t } = await call("new_tab", { app: "arc", url: "about:blank" });
  assert.equal(r.isError, true);
  assert.match(t, /^error: no_browser: Arc made no tab perch could find for about:blank/);
  assert.equal(world.log.filter((l) => l[0] === "navigate").length, 0);
});

test("page JS on a browser-internal page is refused at once, not left to hang", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: [{ id: "n", url: "arc://newtab/", title: "New Tab" }] }])], cg: [{ owner: "Arc" }] });
  const { r, t } = await call("eval_js", { script: "return 1" });
  assert.equal(r.isError, true);
  assert.match(t, /^error: tab_not_scriptable: /);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("a new blank Safari tab's handle matches what list_tabs reports and resolves", async () => {
  install({ browsers: [safari([{ id: 7, active: 0, tabs: tabs(1, "s") }])], cg: [{ owner: "Safari" }] });
  const { o } = await call("new_tab", { app: "safari", url: "about:blank" });
  const { o: listed } = await call("list_tabs", { app: "safari" });
  assert.ok(listed.tabs.some((t) => t.tabId === o.tabId), `${o.tabId} not in ${listed.tabs.map((t) => t.tabId)}`);
  world.winSpec("Safari", 0).active = 1;
  const { r } = await call("eval_js", { script: "return 1", target: { tabId: o.tabId } });
  assert.equal(r.isError, undefined, r.content[0].text);
});

test("Arc new_tab waits out url() reads that throw before the URL commits", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(1, "a") }])], cg: [{ owner: "Arc" }] });
  world.state.arcSlowUrl = { throws: 2, reads: 3 };
  const { o } = await call("new_tab", { app: "arc", url: "about:blank" });
  world.winSpec("Arc", 0).active = 1;
  const { r } = await call("eval_js", { script: "return 1", target: { tabId: o.tabId } });
  assert.equal(r.isError, undefined, r.content[0].text);
});
