// Per-call Apple Event trims: each event to a browser costs about one display
// frame live, so these pin the events a single page call sends (world.aeBy) and,
// where the spacing of polls matters, the time on the fake clock.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
const rt = (fn, args) => world.run(`JSON.stringify(__perch.${fn}(${JSON.stringify(args)}))`);

beforeEach(() => { world = null; });

// ---- Arc hints ----

const arcTwo = () => install({
  browsers: [arc([{ id: "W1", active: 0, tabs: tabs(2, "a") }, { id: "W2", active: 1, tabs: tabs(3, "b") }])],
  cg: [{ owner: "Arc" }],
});

test("an Arc tab found once is re-checked with one read of its window's shown tab: 3 events a call", async () => {
  arcTwo();
  assert.equal((await call("eval_js", { script: "return location.href", target: { tabId: "arc:b1" } })).o, "https://b1.test/");
  world.reset();
  assert.equal((await call("eval_js", { script: "return location.href", target: { tabId: "arc:b1" } })).o, "https://b1.test/");
  assert.deepEqual(world.aeBy("Arc"), ["tab.id", "tab.url", "tab.execute"]);
});

test("an Arc hint whose window now shows another tab is not trusted: tab_not_visible, nothing executed", async () => {
  arcTwo();
  await call("eval_js", { script: "return 1", target: { tabId: "arc:b1" } });
  world.winSpec("Arc", 1).active = 2;
  world.reset();
  const { r, t } = await call("eval_js", { script: "return 1", target: { tabId: "arc:b1" } });
  assert.equal(r.isError, true);
  assert.match(t, /^error: tab_not_visible: /);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("an Arc hint whose tab is now shown through another window runs there", async () => {
  const shared = tabs(3, "a");
  install({ browsers: [arc([{ id: "W1", active: 2, tabs: shared }, { id: "W2", active: 0, tabs: shared }])], cg: [{ owner: "Arc" }] });
  await call("eval_js", { script: "return 1", target: { tabId: "arc:a2" } });
  world.winSpec("Arc", 0).active = 0;
  world.winSpec("Arc", 1).active = 2;
  const { r, o } = await call("eval_js", { script: "window.hit = 1; return 2", target: { tabId: "arc:a2" } });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o, 2);
});

test("an Arc hint never lets page JS reach an arc: page", async () => {
  arcTwo();
  await call("eval_js", { script: "return 1", target: { tabId: "arc:b1" } });
  world.tabsOf("Arc", 1)[1].url = "arc://newtab/";
  world.reset();
  const { t } = await call("eval_js", { script: "return 1", target: { tabId: "arc:b1" } });
  assert.match(t, /^error: tab_not_scriptable: /);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

// ---- default target ----

test("the default target is one read of the front window's shown tab on Chrome and Arc", () => {
  for (const [spec, owner, id] of [
    [chrome([{ id: 1, active: 1, tabs: tabs(3, "c") }, { id: 2, active: 0, tabs: tabs(1, "d") }]), "Google Chrome", "c1"],
    [arc([{ id: "W1", active: 1, tabs: tabs(3, "a") }, { id: "W2", active: 0, tabs: tabs(1, "b") }]), "Arc", "a1"],
  ]) {
    install({ browsers: [spec], cg: [{ owner: "Terminal" }, { owner }] });
    const g = JSON.parse(rt("activate", {}));
    assert.equal(g, true);
    // activate: resolve, then focus (window id, select check, raise, activate).
    assert.equal(world.aeBy(owner)[0], "tab.id", owner + " " + JSON.stringify(world.aeBy(owner)));
    assert.equal(world.aeBy(owner).filter((k) => /length|activeTabIndex\(\)/.test(k)).length, 0, owner + " " + JSON.stringify(world.aeBy(owner)));
    assert.equal(world.winSpec(owner, 0).active, 1, "the shown tab stays shown");
  }
});

test("Arc default-target eval_js is 3 events: the shown tab's id, its url, the execute", async () => {
  install({ browsers: [arc([{ id: "W1", active: 1, tabs: tabs(3, "a") }])], cg: [{ owner: "Arc" }] });
  const { o } = await call("eval_js", { script: "return location.href" });
  assert.equal(o, "https://a1.test/");
  assert.deepEqual(world.aeBy("Arc"), ["tab.id", "tab.url", "tab.execute"]);
});

test("a front window showing no tab still falls back to the next window", async () => {
  install({ browsers: [arc([{ id: "NEW", active: null, tabs: [] }, { id: "OLD", active: 0, tabs: tabs(1, "b") }])], cg: [{ owner: "Arc" }] });
  const { o } = await call("eval_js", { script: "return location.href" });
  assert.equal(o, "https://b0.test/");
});

// ---- wait, awaitPromise: quickExec first, lazy Chrome handles ----

test("wait on the default Chrome tab of a loaded page is one Apple Event", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const { o } = await call("wait", { readyState: "complete" });
  assert.equal(o.ok, true);
  assert.deepEqual(world.aeBy("Google Chrome"), ["tab.execute"]);
});

test("wait on a listed Chrome handle polls every 50ms and reads nothing but the page", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1, "a") }, { id: 2, active: 0, tabs: tabs(2, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const h = (await call("list_tabs", {})).o.tabs.find((t) => t.url === "https://c1.test/").tabId;
  world.state.loadTicks = 0;
  world.tabsOf("Google Chrome", 1)[1].page.ticks = 3;
  world.reset();
  const t0 = world.clock.t;
  const { o } = await call("wait", { readyState: "complete", target: { tabId: h } });
  assert.equal(o.ok, true);
  assert.deepEqual(world.aeBy("Google Chrome"), ["tab.execute", "tab.execute", "tab.execute", "tab.execute"]);
  assert.ok(world.clock.t - t0 <= 3 * 50, `took ${world.clock.t - t0}ms`);
});

test("eval_js awaitPromise on a listed Chrome handle is the kick and one poll", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const h = (await call("list_tabs", {})).o.tabs[1].tabId;
  world.reset();
  const { o } = await call("eval_js", { script: "return 5", awaitPromise: true, target: { tabId: h } });
  assert.equal(o, 5);
  assert.deepEqual(world.aeBy("Google Chrome"), ["tab.execute", "tab.execute"]);
});

test("a lazy Chrome handle whose tab moved window re-finds it once and runs the kick once", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "a") }, { id: 2, active: 0, tabs: tabs(3, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const h = (await call("list_tabs", {})).o.tabs.find((t) => t.url === "https://c1.test/").tabId;
  const [moved] = world.tabsOf("Google Chrome", 1).splice(1, 1);
  world.tabsOf("Google Chrome", 0).push(moved);
  const { r, o } = await call("eval_js", { script: "window.kicks = (window.kicks || 0) + 1; return location.href", awaitPromise: true, target: { tabId: h } });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o, "https://c1.test/");
  assert.equal(moved.page.ctx.kicks, 1);
});

test("a lazy Chrome handle retries only a missing tab, never another failure", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const h = (await call("list_tabs", {})).o.tabs[1].tabId;
  world.state.jsOff = true;
  world.reset();
  const { r } = await call("eval_js", { script: "return 5", awaitPromise: true, target: { tabId: h } });
  assert.equal(r.isError, true);
  // A bounded execute that fails fast is sent once more on the plain path, which
  // reports the real error; the fake counts NSAppleScript's execute as tab.execute.
  assert.equal(world.counts.NSAppleScript, 1);
  assert.equal(world.counts["tab.execute"] - world.counts.NSAppleScript, 1);
  assert.equal(world.counts["tabs.id()"] || 0, 0);
});

test("a lazy Chrome handle whose tab closed is stale", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(3, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const h = (await call("list_tabs", {})).o.tabs[2].tabId;
  world.tabsOf("Google Chrome", 0).pop();
  const { r, t } = await call("eval_js", { script: "return 5", awaitPromise: true, target: { tabId: h } });
  assert.equal(r.isError, true);
  assert.match(t, /stale_tab/);
});

test("select and click readback on a listed Chrome handle read nothing but the page", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(1, "a") }, { id: 2, active: 0, tabs: tabs(2, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const h = (await call("list_tabs", {})).o.tabs.find((t) => t.url === "https://c1.test/").tabId;
  const done = "JSON.stringify({ok: false, error: location.href})";
  for (const [fn, args] of [["select", { start: done }], ["click", { click: done }]]) {
    world.reset();
    assert.deepEqual(JSON.parse(rt(fn, { target: { tabId: h }, ...args })), { ok: false, error: "https://c1.test/" }, fn);
    assert.deepEqual(world.aeBy("Google Chrome"), ["tab.execute"], fn);
  }
});

// ---- navigate ----

test("navigate's load check polls every 50ms", () => {
  install({ browsers: [safari([{ id: 3, active: 0, tabs: tabs(1, "s") }])], cg: [{ owner: "Safari" }], loadTicks: 4 });
  world.page("Safari", 0, 0).__ready = () => "complete";
  const t0 = world.clock.t;
  const r = JSON.parse(rt("navigate", { target: null, url: "https://next.test/", timeout: 15000 }));
  assert.equal(r.waited, true);
  // Four checks read the new page loading, the fifth complete: four sleeps.
  assert.ok(world.clock.t - t0 <= 4 * 50, `took ${world.clock.t - t0}ms`);
});

test("navigate that loads is 7 events on Chrome and Safari, 6 on Arc's shown tab", async () => {
  for (const [spec, app, n] of [
    [chrome([{ id: 1, active: 0, tabs: tabs(1) }]), "Google Chrome", 7],
    [arc([{ id: "A", active: 0, tabs: tabs(1, "a") }]), "Arc", 6],
    [safari([{ id: 3, active: 0, tabs: tabs(1, "s") }]), "Safari", 7],
  ]) {
    install({ browsers: [spec], cg: [{ owner: app }] });
    const { o } = await call("navigate", { url: "https://next.test/" });
    assert.equal(o.waited, true);
    assert.equal(world.aeBy(app).length, n, `${app}: ${world.aeBy(app)}`);
  }
});

// A raised background Arc tab runs no page JS, so its load is followed by
// reading `loading` every 50ms and its url once loading settles. The load reads
// busy for 100ms: one never seen loading waits out the start grace.
test("navigate with raise:true on a background Arc tab: the url before, the set, loading polls, the url after", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(2, "a") }])], cg: [{ owner: "Arc" }] });
  world.state.commitMs = 100;
  const { o } = await call("navigate", { url: "https://next.test/", raise: true, target: { tabId: "arc:a1" } });
  assert.equal(o.waited, true);
  const ae = world.aeBy("Arc");
  assert.deepEqual(ae.filter((e) => e !== "tab.loading"), ["windows.length(Arc)", "tabs.id()", "tab.id", "tab.id", "tab.url", "tab.url=", "tab.url"]);
  assert.ok(ae.filter((e) => e === "tab.loading").length <= 9, String(ae));
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("navigate on an Arc tab showing arc://newtab sets the url and runs no page JS until it leaves", () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: [{ id: "n", url: "arc://newtab/", title: "New Tab" }] }])], cg: [{ owner: "Arc" }] });
  const tab = world.tabsOf("Arc", 0)[0];
  tab.slow = { throws: 0, reads: 3, target: null };
  let onArc = 0;
  const execute = tab.execute;
  tab.execute = (...x) => { if (/^arc:/.test(tab.page.url)) onArc++; return execute(...x); };
  const t0 = world.clock.t;
  const r = JSON.parse(rt("navigate", { target: null, url: "https://next.test/", timeout: 15000 }));
  assert.equal(onArc, 0);
  assert.equal(r.waited, true);
  assert.equal(tab.page.url, "https://next.test/");
  assert.ok(world.clock.t - t0 < 1000, `took ${world.clock.t - t0}ms`);
});

test("navigate on Arc from an arc: page to an http url sets it and runs no page JS there", () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: [{ id: "n", url: "arc://newtab/", title: "New Tab" }] }])], cg: [{ owner: "Arc" }] });
  const tab = world.tabsOf("Arc", 0)[0];
  let onArc = 0;
  const execute = tab.execute;
  tab.execute = (...x) => { if (/^arc:/.test(tab.page.url)) onArc++; return execute(...x); };
  const t0 = world.clock.t;
  const r = JSON.parse(rt("navigate", { target: null, url: "https://n.test/", timeout: 15000 }));
  assert.equal(onArc, 0);
  assert.equal(r.waited, true);
  assert.equal(tab.page.url, "https://n.test/");
  assert.ok(world.clock.t - t0 < 1000, `took ${world.clock.t - t0}ms`);
});

// ---- trusted input on arc: pages ----

test("trusted press and point clicks refuse an Arc arc: page before any page JS", async () => {
  install({
    browsers: [arc([{ id: "A", active: 0, tabs: [{ id: "n", url: "arc://newtab/", title: "New Tab" }] }])],
    cg: [{ owner: "Arc", pid: 9, wid: 31, x: 0, y: 0, w: 900, h: 700, name: "New Tab", ax: { web: [{ x: 0, y: 80, w: 900, h: 620 }] } }],
  });
  for (const [tool, args] of [["press", { key: "Enter", trusted: true }], ["click", { trusted: true, x: 300, y: 300 }], ["click", { trusted: true, selector: "#b" }]]) {
    world.reset();
    const t0 = world.clock.t;
    const { r, t } = await call(tool, args);
    assert.equal(r.isError, true, tool + " " + t);
    assert.match(t, /tab_not_scriptable: /, tool);
    assert.equal(world.counts["tab.execute"] || 0, 0, tool);
    assert.equal(world.posted.length, 0, tool);
    assert.ok(world.clock.t - t0 < 1000, tool);
  }
});

// ---- hints from list_tabs and new_tab ----

test("an Arc tab list_tabs saw shown takes 3 events on its first page call", async () => {
  arcTwo();
  await call("list_tabs", {});
  world.reset();
  assert.equal((await call("eval_js", { script: "return location.href", target: { tabId: "arc:b1" } })).o, "https://b1.test/");
  assert.deepEqual(world.aeBy("Arc"), ["tab.id", "tab.url", "tab.execute"]);
});

test("an Arc tab new_tab made behind the shown one leaves no hint to spend a read on", async () => {
  const spec = () => ({ browsers: [arc([{ id: "W1", active: 0, tabs: tabs(2, "a") }])], cg: [{ owner: "Terminal" }, { owner: "Arc" }] });
  install(spec());
  const { o } = await call("new_tab", { url: "https://n.test/", app: "Arc" });
  const made = o.tabId;
  world.reset();
  await call("eval_js", { script: "return 1", target: { tabId: made } });
  const withNew = world.aeBy("Arc");
  install({ browsers: [arc([{ id: "W1", active: 0, tabs: [...tabs(2, "a"), { url: "https://n.test/", title: "", id: made.slice(4) }] }])], cg: [{ owner: "Terminal" }, { owner: "Arc" }] });
  await call("eval_js", { script: "return 1", target: { tabId: made } });
  assert.deepEqual(withNew, world.aeBy("Arc"));
});
