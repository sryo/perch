// Apple Event budgets. Live, every Apple Event to a browser costs about one
// display frame (~16.7ms), while the CGWindowList read and running() probes cost
// well under that, so per-call latency is the number of Apple Events a tool
// sends. These tests pin that number with the fake world's accessor counts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const chrome = (windows, extra = {}) => ({ name: "Google Chrome", kind: "chrome", windows, ...extra });
const safari = (windows, extra = {}) => ({ name: "Safari", kind: "safari", windows, ...extra });
const arc = (windows, extra = {}) => ({ name: "Arc", kind: "arc", windows, ...extra });
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

// Counters that are not Apple Events: specifier construction (lazy in JXA),
// Application() objects, the CGWindowList read, and running() (LaunchServices).
const NOT_AE = /^(win\.tabs|tabs\.byId|win\.activeTab|windows\[\d+\]\(.*\)|Application\(.*\)|running\(.*\)|deepUnwrap|CGWindowList)$/;
const appleEvents = () => Object.entries(world.counts).filter(([k]) => !NOT_AE.test(k)).reduce((s, [, n]) => s + n, 0);
const breakdown = () => JSON.stringify(Object.fromEntries(Object.entries(world.counts).filter(([k]) => !NOT_AE.test(k))));
const listed = async (app) => (await call("list_tabs", { app })).o.tabs;

beforeEach(() => { world = null; });

test("eval_js on a Safari handle is one Apple Event when the tab is where the handle says", async () => {
  install({ browsers: [safari([{ id: 5, active: 0, tabs: tabs(1, "x") }, { id: 3, active: 1, tabs: tabs(3, "s") }])], cg: [{ owner: "Safari" }] });
  const h = (await listed("Safari")).find((t) => t.url === "https://s1.test/").tabId;
  world.reset();
  const { o } = await call("eval_js", { script: "window.hits = (window.hits || 0) + 1; return location.href", target: { tabId: h } });
  assert.equal(o, "https://s1.test/");
  assert.equal(world.page("Safari", 1, 1).hits, 1);
  assert.equal(appleEvents(), 1, breakdown());
});

test("a Safari handle whose tab moved still runs once, in the right tab", async () => {
  install({ browsers: [safari([{ id: 3, active: 1, tabs: tabs(3, "s") }])], cg: [{ owner: "Safari" }] });
  const h = (await listed("Safari")).find((t) => t.url === "https://s1.test/").tabId;
  const live = world.tabsOf("Safari", 0);
  live.push(live.shift()); // s1 moves to index 0, s2 now sits at the handle's index
  world.winSpec("Safari", 0).active = 0;
  const { o } = await call("eval_js", { script: "window.hits = (window.hits || 0) + 1; return location.href", target: { tabId: h } });
  assert.equal(o, "https://s1.test/");
  assert.equal(world.page("Safari", 0, 0).hits, 1);
  assert.equal(world.page("Safari", 0, 1).hits, undefined, "the tab now at the recorded index never ran the script");
});

test("a Safari handle whose tab navigated away is stale and runs nothing", async () => {
  install({ browsers: [safari([{ id: 3, active: 1, tabs: tabs(2, "s") }])], cg: [{ owner: "Safari" }] });
  const h = (await listed("Safari"))[1].tabId;
  const tab = world.tabsOf("Safari", 0)[1];
  tab.url = "https://elsewhere.test/";
  const { r, t } = await call("eval_js", { script: "window.hits = 1; return 1", target: { tabId: h } });
  assert.equal(r.isError, true);
  assert.match(t, /stale_tab/);
  assert.equal(world.page("Safari", 0, 1).hits, undefined);
});

test("Safari handle resolution reads its recorded window directly", async () => {
  install({
    browsers: [safari([{ id: 1, active: 0, tabs: tabs(2, "a") }, { id: 2, active: 0, tabs: tabs(2, "b") }, { id: 3, active: 1, tabs: tabs(2, "s") }])],
    cg: [{ owner: "Safari" }],
  });
  const h = (await listed("Safari")).find((t) => t.url === "https://s1.test/").tabId;
  world.reset();
  const { r, t } = await call("wait", { readyState: "complete", target: { tabId: h } });
  assert.equal(r.isError, undefined, t);
  assert.equal(world.counts["win.id()"], undefined, "no window-id walk");
  assert.equal(world.counts["windows.length(Safari)"], undefined);
  assert.equal(appleEvents(), 2, breakdown()); // tabs.url() + doJavaScript
});

test("eval_js on a listed Chrome handle is one Apple Event and probes nothing else", async () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "a") }, { id: 2, active: 0, tabs: tabs(3, "c") }]), safari([{ id: 9, active: 0, tabs: tabs(1, "s") }])],
    cg: [{ owner: "Google Chrome" }],
  });
  const h = (await listed("Google Chrome")).find((t) => t.url === "https://c2.test/").tabId;
  world.reset();
  const { o } = await call("eval_js", { script: "window.hits = 1; return location.href", target: { tabId: h } });
  assert.equal(o, "https://c2.test/");
  assert.equal(appleEvents(), 1, breakdown());
  assert.ok((world.counts.CGWindowList || 0) <= 1);
  assert.equal(world.counts["running(Safari)"], undefined);
});

test("eval_js on a new Chrome tab's handle is one Apple Event", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const { o: made } = await call("new_tab", { url: "https://fresh.test/" });
  world.reset();
  const { o } = await call("eval_js", { script: "return location.href", target: { tabId: made.tabId } });
  assert.equal(o, "https://fresh.test/");
  assert.equal(appleEvents(), 1, breakdown());
});

test("a cold Chrome handle is found once, then costs one Apple Event", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "a") }, { id: 2, active: 0, tabs: tabs(3, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const target = { tabId: "chrome:c1" };
  assert.equal((await call("eval_js", { script: "return location.href", target })).o, "https://c1.test/");
  world.reset();
  assert.equal((await call("eval_js", { script: "return location.href", target })).o, "https://c1.test/");
  assert.equal(appleEvents(), 1, breakdown());
});

test("a Chrome tab dragged to another window after it was found runs once, in that tab", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "a") }, { id: 2, active: 0, tabs: tabs(3, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const h = (await listed("Google Chrome")).find((t) => t.url === "https://c1.test/").tabId;
  const [moved] = world.tabsOf("Google Chrome", 1).splice(1, 1);
  world.tabsOf("Google Chrome", 0).push(moved);
  world.winSpec("Google Chrome", 1).active = 0;
  const { o } = await call("eval_js", { script: "window.hits = (window.hits || 0) + 1; return location.href", target: { tabId: h } });
  assert.equal(o, "https://c1.test/");
  assert.equal(moved.page.ctx.hits, 1);
});

test("a closed Chrome tab's handle is stale", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(3, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const h = (await listed("Google Chrome"))[2].tabId;
  world.tabsOf("Google Chrome", 0).pop();
  const { r, t } = await call("eval_js", { script: "return 1", target: { tabId: h } });
  assert.equal(r.isError, true);
  assert.match(t, /stale_tab/);
});

test("default-target eval_js is one Apple Event on Chrome and on Safari", async () => {
  for (const [spec, owner, url] of [
    [chrome([{ id: 1, active: 1, tabs: tabs(3, "c") }, { id: 2, active: 0, tabs: tabs(1, "d") }]), "Google Chrome", "https://c1.test/"],
    [safari([{ id: 1, active: 2, tabs: tabs(3, "s") }]), "Safari", "https://s2.test/"],
  ]) {
    install({ browsers: [spec], cg: [{ owner: "Terminal" }, { owner }] });
    const { o } = await call("eval_js", { script: "return location.href" });
    assert.equal(o, url);
    assert.equal(appleEvents(), 1, owner + " " + breakdown());
  }
});

test("list_tabs reads every window of a browser in bulk", async () => {
  const wins = (p) => [{ id: 1, active: 1, tabs: tabs(2, p + "a") }, { id: 2, active: 0, tabs: tabs(3, p + "b") }, { id: 3, active: 2, tabs: tabs(4, p + "c") }];
  for (const [spec, budget] of [[chrome(wins("c")), 4], [safari(wins("s")), 4]]) {
    install({ browsers: [spec], cg: [{ owner: spec.name }] });
    const { o } = await call("list_tabs", { app: spec.name });
    assert.equal(o.total, 9);
    assert.deepEqual(o.tabs.filter((t) => t.active).map((t) => t.url), [`https://${spec.name === "Safari" ? "s" : "c"}a1.test/`, `https://${spec.name === "Safari" ? "s" : "c"}b0.test/`, `https://${spec.name === "Safari" ? "s" : "c"}c2.test/`]);
    assert.ok(appleEvents() <= budget, spec.name + " " + breakdown());
  }
});

test("list_tabs reads every Arc window in bulk, in sidebar order", async () => {
  const shared = tabs(3, "b");
  install({
    browsers: [arc([
      { id: "W1", active: 1, sidebar: ["a1", "a0"], tabs: [...tabs(2, "a"), { url: "https://f.test/", title: "f", id: "f", location: "topApp" }] },
      { id: "W2", active: 0, tabs: shared },
      { id: "W3", active: 2, tabs: shared },
      { id: "W4", active: null, tabs: [] },
    ])],
    cg: [{ owner: "Arc" }],
  });
  const { o } = await call("list_tabs", { app: "Arc" });
  assert.deepEqual(o.tabs.map((t) => [t.tabId, !!t.active, !!t.favorite]), [
    ["arc:f", false, true], ["arc:a1", true, false], ["arc:a0", false, false],
    ["arc:b0", true, false], ["arc:b1", false, false], ["arc:b2", true, false],
  ]);
  assert.ok(appleEvents() <= 6, breakdown());
});

test("list_tabs with urlContains stops at one read for a browser with no match", async () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: tabs(3, "c") }]), arc([{ id: "A", active: 0, tabs: tabs(3, "a") }]), safari([{ id: 3, active: 1, tabs: tabs(2, "s") }])],
    cg: [{ owner: "Google Chrome" }, { owner: "Arc" }, { owner: "Safari" }],
  });
  const { o } = await call("list_tabs", { urlContains: "S1.test" });
  assert.deepEqual(o.tabs.map((t) => [t.app, t.url, !!t.active]), [["Safari", "https://s1.test/", true]]);
  assert.equal(o.total, 1);
  assert.ok(appleEvents() <= 1 + 1 + 4, breakdown());
});

// JXA launches an app whose windows are touched, so a remembered tab must not
// outlive its browser: after a quit, no event may reach the app at all.
test("a remembered tab never launches a browser that has quit", async () => {
  const c = chrome([{ id: 1, active: 0, tabs: tabs(2, "c") }]);
  const s = safari([{ id: 3, active: 0, tabs: tabs(1, "s") }]);
  install({ browsers: [c, s], cg: [] });
  const rows = await listed(null);
  const ch = rows.find((t) => t.app === "Google Chrome").tabId, sh = rows.find((t) => t.app === "Safari").tabId;
  c.running = false; s.running = false;
  world.reset();
  for (const tabId of [ch, sh]) {
    const { r } = await call("eval_js", { script: "return 1", target: { tabId } });
    assert.equal(r.isError, true, tabId);
  }
  assert.equal(appleEvents(), 0, breakdown());
});

// new_tab reads the shown tab before and after creating and sends one selection
// only when the browser moved it: at most 3 Apple Events over creation itself.
test("new_tab costs a fixed number of Apple Events, one more when the browser selects the new tab", async () => {
  // Creation alone is 3 (Chrome), 5 (Arc, about: loads after its new-tab page) and 4 (Safari).
  for (const [make, app, url, n] of [[chrome, "Google Chrome", "https://n.test/", 5], [arc, "Arc", "about:blank", 7], [safari, "Safari", "https://n.test/", 6]]) {
    for (const selectOnCreate of [false, true]) {
      install({ browsers: [make([{ id: 1, active: 0, tabs: tabs(2) }], { selectOnCreate })], cg: [{ owner: "Terminal" }, { owner: app }] });
      await call("new_tab", { app, url });
      assert.equal(appleEvents(), n + (selectOnCreate ? 1 : 0), `${app} ${breakdown()}`);
      assert.equal(world.counts.CGWindowList, 2, "procs() before and after, nothing more");
    }
  }
});

// The dialog probe runs every 2s while a call hangs, so with no dialog open it
// must stay on Accessibility and the CGWindowList. Attribution (resolve, the
// shown tab, the window's geometry) only starts once a dialog window exists.
test("the dialog probe sends no Apple Events while no dialog is open, and few once one is", () => {
  const cg = [{ owner: "Google Chrome", pid: 40, wid: 400, x: 0, y: 0, w: 800, h: 600, ax: { web: [{ x: 0, y: 80, w: 800, h: 520 }] } }];
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(3, "c") }])], cg });
  const probe = (target) => JSON.parse(world.run(`JSON.stringify(__perch.dialogs(${JSON.stringify({ target })}))`));
  const events = () => Object.entries(world.counts).filter(([k]) => !NOT_AE.test(k) && !/^AX/.test(k)).reduce((s, [, n]) => s + n, 0);
  for (const target of [{ tabId: "chrome:c1" }, undefined]) {
    world.reset();
    assert.deepEqual(probe(target), []);
    assert.equal(events(), 0, breakdown());
  }
  world.state.dialogs = [{ pid: 40, parent: 400, blocks: "c0", texts: ["c0.test says", "Sure?"], buttons: ["Cancel", "OK"] }];
  world.reset();
  assert.deepEqual(probe({ tabId: "chrome:c0" }), [{ kind: "confirm", message: "Sure?" }]);
  // The proof adds the tab's url and one bounded execute (NSAppleScript, which
  // the fake also counts as tab.execute).
  assert.ok(events() <= 7, breakdown());
});

// A default snapshot is one page call and no Accessibility work; frames:true adds
// the frame walk in the same runtime call: a few Apple Events for the tab's shown
// state and window geometry, and Accessibility reads bounded by the tree's size.
test("accessibility_snapshot: the default does no Accessibility work; frames:true stays one call with a few more events", async () => {
  const dom = page(`<button>Go</button>`, { url: "https://c0.test/" });
  Object.defineProperty(dom, "innerWidth", { value: 800, configurable: true });
  Object.defineProperty(dom, "innerHeight", { value: 520, configurable: true });
  const frame = { url: "https://pay.test/f", box: { x: 10, y: 100, w: 300, h: 100 }, kids: [{ role: "AXButton", title: "Pay", box: { x: 20, y: 110, w: 80, h: 30 } }] };
  const cg = [{ owner: "Google Chrome", pid: 40, wid: 400, x: 0, y: 0, w: 800, h: 600, ax: { web: [{ x: 0, y: 80, w: 800, h: 520, frames: [frame] }] } }];
  install({ browsers: [chrome([{ id: 1, active: 0, x: 0, y: 0, w: 800, h: 600, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg });
  const ax = () => world.counts.AX || 0;
  const events = () => Object.entries(world.counts).filter(([k]) => !NOT_AE.test(k) && !/^AX/.test(k)).reduce((s, [, n]) => s + n, 0);
  let { t } = await call("accessibility_snapshot", {});
  assert.equal(t.split("\n").length, 2, t);
  assert.equal(ax(), 0, breakdown());
  assert.equal(events(), 1, breakdown());
  world.reset();
  ({ t } = await call("accessibility_snapshot", { frames: true }));
  assert.match(t, /\nf1 button "Pay" frame="pay\.test"$/);
  // resolve (4), the tab's shown state (1) and the page script (1); the fake world
  // doesn't count window geometry reads (2 more live).
  assert.equal(events(), 6, breakdown());
  // Window match (its geometry and CGWindowID) and page area, then role, name,
  // flags and frame per node.
  assert.equal(ax(), 35, breakdown());
});
