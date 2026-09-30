// Apple Event budgets. Live, every Apple Event to a browser costs about one
// display frame (~16.7ms), while the CGWindowList read and running() probes cost
// well under that, so per-call latency is the number of Apple Events a tool
// sends. These tests pin that number with the fake world's accessor counts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tempDir } from "../scripts/temp.mjs";
import { join } from "node:path";
import { JXA_PRELUDE, DAEMONS, handleCall, PAGE_PRELUDE, PAGE_SCRIPTS, pageScript, buildEvalWrapper } from "../server.js";
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

test("a Safari handle that stamped its page stays one Apple Event where the handle says", async () => {
  install({ browsers: [safari([{ id: 3, active: 1, tabs: tabs(3, "s") }])], cg: [{ owner: "Safari" }] });
  const h = (await listed("Safari")).find((t) => t.url === "https://s1.test/").tabId;
  await call("eval_js", { script: "return 1", target: { tabId: h } });
  world.reset();
  const { o } = await call("eval_js", { script: "return location.href", target: { tabId: h } });
  assert.equal(o, "https://s1.test/");
  assert.equal(appleEvents(), 1, breakdown());
});

// Off its index among same-URL tabs, a handle tries one candidate per event,
// nearest first, until its stamp answers: here the recorded index (1 event),
// the window's URLs (1), then the user's tab (1) before its own (1).
test("a stamped Safari handle off its index among same-URL tabs costs one event per candidate tried", async () => {
  const same = (id) => ({ url: "https://u.test/", title: "u", id });
  install({ browsers: [safari([{ id: 3, active: 0, tabs: [same("agent"), ...tabs(2, "s"), same("user")] }])], cg: [{ owner: "Safari" }] });
  const h = (await listed("Safari")).find((t) => t.url === "https://u.test/").tabId;
  await call("eval_js", { script: "return 1", target: { tabId: h } });
  const live = world.tabsOf("Safari", 0);
  live.splice(3, 0, live.shift()); // agent to index 3, behind the user's tab now at 2
  world.reset();
  const { r, t } = await call("eval_js", { script: "window.hits = (window.hits || 0) + 1; return 1", target: { tabId: h } });
  assert.notEqual(r.isError, true, t);
  assert.equal(world.page("Safari", 0, 3).hits, 1);
  assert.equal(world.page("Safari", 0, 2).hits, undefined);
  assert.equal(appleEvents(), 4, breakdown());
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
  // Still loading at the first look, so wait resolves the handle to poll it.
  world.tabsOf("Safari", 2)[1].page.ticks = 1;
  world.reset();
  const { r, t } = await call("wait", { readyState: "complete", target: { tabId: h } });
  assert.equal(r.isError, undefined, t);
  assert.equal(world.counts["win.id()"], undefined, "no window-id walk");
  assert.equal(world.counts["windows.length(Safari)"], undefined);
  assert.equal(appleEvents(), 3, breakdown()); // doJavaScript, then tabs.url() + doJavaScript
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
  // Creation alone is 3 (Chrome), 5 (Arc, about: loads after its new-tab page) and 3 (Safari: one url read gives the new tab's index and URL).
  for (const [make, app, url, n] of [[chrome, "Google Chrome", "https://n.test/", 5], [arc, "Arc", "about:blank", 7], [safari, "Safari", "https://n.test/", 5]]) {
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
  // resolve (1, the front window's shown tab, so no separate shown check) and the
  // page script (1); the fake world doesn't count window geometry reads (2 more live).
  assert.equal(events(), 2, breakdown());
  // Window match (its geometry and CGWindowID) and page area, then role, name,
  // flags and frame per node.
  assert.equal(ax(), 35, breakdown());
});

// A trusted page click checks its final point with Accessibility's hit test: a
// few AX reads (the hit and an AXParent walk up to the first web area), no Apple
// Events. Aim's page area is reused; a click by point reads it once.
test("the trusted click's hit test adds Accessibility reads only, no Apple Events", async () => {
  const dom = page(`<button id=b>Go</button>`, { url: "https://c0.test/" });
  for (const [k, v] of Object.entries({ screenX: 0, screenY: 57, outerWidth: 654, innerWidth: 598, outerHeight: 600, innerHeight: 500 })) Object.defineProperty(dom, k, { value: v, configurable: true });
  const cg = [{ owner: "Google Chrome", pid: 40, wid: 400, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 598, h: 500 }] } }];
  install({ browsers: [chrome([{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg });
  const events = () => Object.entries(world.counts).filter(([k]) => !NOT_AE.test(k) && !/^AX/.test(k)).reduce((s, [, n]) => s + n, 0);
  const ax = () => world.counts.AX || 0;
  const cost = [];
  for (const args of [{ selector: "#b" }, { x: 120, y: 170 }, { selector: "#b", raise: true }]) {
    await call("click", { trusted: true, ...args });
    cost.push([events(), ax()]);
    world.reset();
  }
  // [Apple Events, AX reads] for background selector, background point, raised
  // selector. The AX reads are the window match and page area (13) plus the hit
  // test (4). A click by point reads its hit check after posting, as a selector
  // click does; that check goes through the bounded execute, which the fake counts
  // twice (NSAppleScript and tab.execute); live it is one event.
  assert.deepEqual(cost, [[4, 17], [4, 17], [18, 17]]);
});

// select {trusted} in a background tab, on a picker that opens only on trusted
// input: start, the 400ms open poll, the shown-tab check, the typing step, the
// list polls and pick, and the readback. The fake world answers each poll at
// once, so the open poll and pick settle in a fixed number of runs.
test("select {trusted} typing into a background picker costs a fixed number of Apple Events", async () => {
  const fx = readFileSync(new URL("./fixtures/trusted-select.html", import.meta.url), "utf8");
  const dom = page(/<body>([\s\S]*?)<script>/.exec(fx)[1], { url: "https://form.test/" });
  dom.eval(/<script>([\s\S]*?)<\/script>/.exec(fx)[1]);
  dom.document.execCommand = (_cmd, _ui, text) => {
    const el = dom.document.activeElement;
    el.value = text || "";
    const ev = new dom.Event("input", { bubbles: true });
    Object.defineProperty(ev, "isTrusted", { value: true });
    el.dispatchEvent(ev);
    return true;
  };
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "about:blank", id: "front" }, { url: "https://form.test/", id: "t", dom }] }])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  const { o } = await call("select", { selector: "#loc", text: "Córdoba, Argentina", trusted: true, target: { tabIndex: 1 } });
  assert.deepEqual(o.trusted, ["typed"], JSON.stringify(o));
  // 12 page runs (start 1, open poll 8, type 1, pick 1, readback 1), each counted
  // twice by the fake (NSAppleScript and tab.execute), plus the resolve's window
  // walk and the shown-tab read.
  assert.equal(world.counts["tab.execute"], 12, breakdown());
  assert.equal(appleEvents(), 28, breakdown());
});

// Rows past `limit` are never returned, but `total` still counts them. A browser
// reached once the limit is full only needs its tabs counted: one read per filter
// (urls when there is none), plus Arc's tab ids, since its windows share tabs.
test("list_tabs only counts the tabs of browsers reached past its limit", async () => {
  const shared = tabs(4, "a");
  const spec = () => ({
    browsers: [
      chrome([{ id: 1, active: 1, tabs: tabs(3, "c") }]),
      arc([{ id: "W1", active: 0, tabs: shared }, { id: "W2", active: 1, tabs: shared }]),
      safari([{ id: 3, active: 0, tabs: tabs(2, "s") }, { id: 4, active: 0, tabs: [{ url: "https://x.test/", title: "S0", id: "x" }] }]),
    ],
    cg: [{ owner: "Google Chrome" }, { owner: "Arc" }, { owner: "Safari" }],
  });
  for (const [args, budget] of [[{ limit: 2 }, 4 + 1 + 1], [{ limit: 1, urlContains: "0.test" }, 4 + 2 + 1], [{ limit: 0, titleContains: "s0" }, 1 + 2 + 1]]) {
    install(spec());
    const full = (await call("list_tabs", { ...args, limit: 1000 })).o;
    world.reset();
    const { o } = await call("list_tabs", args);
    assert.deepEqual(o, { tabs: full.tabs.slice(0, args.limit), total: full.total }, JSON.stringify(args));
    assert.ok(appleEvents() <= budget, JSON.stringify(args) + " " + breakdown());
  }
});

// Window geometry: Chromium and Safari answer `bounds` and fail `position`, and
// Arc answers neither (its frame comes from its CG entry). A failed read still
// costs an Apple Event, so screenshots and trusted input ask once, or not at all.
test("window geometry is one Apple Event, none on Arc", () => {
  for (const [make, owner, reads] of [[chrome, "Google Chrome", { bounds: 1 }], [safari, "Safari", { bounds: 1 }], [arc, "Arc", {}]]) {
    install({ browsers: [make([{ id: 1, active: 0, x: 10, y: 40, w: 700, h: 500, name: "t0", tabs: tabs(1) }])], cg: [{ owner, wid: 7, name: "t0", x: 10, y: 40, w: 700, h: 500 }] });
    const g = JSON.parse(world.run(`JSON.stringify(__perch.shotGeom({}))`));
    assert.deepEqual([g.windowNumber, g.geom], [7, { x: 10, y: 40, w: 700, h: 500 }], owner);
    assert.deepEqual({ ...world.geom }, reads, owner);
  }
});

// A wait that times out spends one bounded execute per poll that fits in its
// timeout (every 50ms from the first, none at the deadline), and nothing else.
// The fake counts each bounded execute twice (NSAppleScript and tab.execute).
test("a timed-out wait costs the polls that fit in its timeout, no more", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const h = (await listed("Google Chrome")).find((t) => t.url === "https://c1.test/").tabId;
  world.reset();
  const { t } = await call("wait", { expression: "false", timeout: 300, target: { tabId: h } });
  assert.equal(t, "error: timeout: wait timed out after 300ms");
  assert.equal(world.counts.NSAppleScript, 6, breakdown());
  assert.equal(appleEvents(), 2 * 6, breakdown());
});

// A raised background Arc tab is followed through url and loading reads alone:
// one loading read per 50ms poll, a url read only once loading settles.
test("navigate on a raised background Arc tab costs a fixed count of Apple Events for a load that commits", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(2, "a") }])], cg: [{ owner: "Finder", pid: 50 }, { owner: "Arc" }] });
  world.state.commitMs = 200;
  const { o } = await call("navigate", { url: "https://next.test/", raise: true, target: { tabId: "arc:a1" } });
  assert.equal(o.ok, true);
  assert.equal(o.waited, true);
  assert.equal(appleEvents(), 16, breakdown());
});

// A plain click sends one script: the page prelude once, the new-tab probe, and
// no second pass or readback code, which a _blank target fetches only when found.
test("click: a plain click's one script carries the prelude once and no second pass or readback code", async () => {
  const dom = page(`<button id=b>Save</button>`, { url: "https://c0.test/" });
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  const sent = [], d = { run: (s) => { sent.push(s); return world.daemon.run(s); } };
  DAEMONS.fast = d; DAEMONS.slow = d;
  const { o } = await call("click", { selector: "#b" });
  assert.equal(o.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].split("function deepAll(").length - 1, 1);
  assert.ok(!sent[0].includes("function rbArm("), "no readback code");
  assert.ok(sent[0].length < 26000, `sent ${sent[0].length} bytes`);
  assert.equal(appleEvents(), 1, breakdown());
});

// Every page call and every poll carries its script over Apple Events, so
// internal page scripts ship without comment lines or indentation.
function evalsOf(dom) {
  const seen = [], orig = dom.eval.bind(dom);
  dom.eval = (js) => { seen.push(js); return orig(js); };
  return seen;
}
const commentLines = (js) => js.split("\n").filter((l) => l.trim().startsWith("//")).length;

test("click: a plain click's page script has no comment lines and stays under 16000 bytes", async () => {
  const dom = page(`<button id=b>Save</button>`, { url: "https://c0.test/" });
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  const seen = evalsOf(dom);
  assert.equal((await call("click", { selector: "#b" })).o.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(commentLines(seen[0]), 0);
  assert.ok(seen[0].length < 16000, `eval'd ${seen[0].length} bytes`);
});

test("fill {fields}: a 5-field form's page script has no comment lines and stays under 60000 bytes", async () => {
  const dom = page(`<form><label>Name <input name=name></label><label>Email <input type=email name=email></label>
    <label>Message <textarea name=msg></textarea></label>
    <label>Country <select name=country><option value="">Pick</option><option value=ar>Argentina</option></select></label>
    <label><input type=checkbox name=agree> I agree</label></form>`, { url: "https://c0.test/" });
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  const seen = evalsOf(dom);
  const fields = [
    { label_pattern: "name", text: "Ada" }, { label_pattern: "email", text: "a@b.test" }, { label_pattern: "message", text: "Hi" },
    { label_pattern: "country", option: "Argentina" }, { label_pattern: "agree", checked: true },
  ];
  const { o } = await call("fill", { fields });
  assert.deepEqual(o.results.map((r) => r.ok), [true, true, true, true, true], JSON.stringify(o));
  // The form census rides the same page pass; the only other call is the
  // short re-read a task later.
  assert.deepEqual(o.form, { requiredEmpty: 0 });
  assert.equal(seen.length, 2);
  assert.ok(seen[1].length < 16000, `re-read eval'd ${seen[1].length} bytes`);
  assert.ok(!seen[1].includes("function fillOne"), "the re-read ships none of fill's matching");
  assert.equal(commentLines(seen[0]), 0);
  assert.ok(seen[0].length < 60000, `eval'd ${seen[0].length} bytes`);
  // Click and select-picker helpers ship only with the scripts that call them.
  for (const s of ["clickableByLabel", "loadingIn", "function tabbables", "function taBlur"]) assert.ok(!seen[0].includes(s), s);
});

// Stripping whole comment lines and indentation is safe only while no string,
// template or comment spans a line; these scripts are String.raw templates.
test("page scripts have no backticks, block comments or line continuations, and still compile once lean", () => {
  for (const [name, src] of Object.entries({ PAGE_PRELUDE, ...PAGE_SCRIPTS })) {
    assert.ok(!src.includes("`"), `${name} has a backtick`);
    assert.ok(!src.includes("/*"), `${name} has a block comment`);
    assert.ok(!src.split("\n").some((l) => l.endsWith("\\")), `${name} has a line continuation`);
    if (name === "PAGE_PRELUDE") continue;
    const js = buildEvalWrapper(pageScript(name, {}));
    assert.equal(commentLines(js), 0, name);
    assert.doesNotThrow(() => new Function(js), name);
  }
});

// Helpers that live in a lib only some scripts include: a script that calls one
// must carry its definition, or the call throws only at run time.
test("page scripts define every split-out helper they call", () => {
  const helpers = ["CLICKABLE", "inertCtl", "inertOut", "clickableByLabel", "resolveClick", "tabbables", "wantL", "wantN", "wantT", "OPT",
    "press", "pressFocus", "pressEscape", "bestMatch", "optOff", "shownEls", "ownText", "shownParts", "commaParts", "chipLike", "multiBox",
    "isMulti", "chosenAlready", "loadingIn", "stillOpen", "escapeOwn", "linkedLists", "byIdNear", "ownOptions", "popSearch", "mine",
    "taNorm", "taShown", "taBlur", "snapVis", "unpicked", "reqEmpty", "census"];
  for (const name of Object.keys(PAGE_SCRIPTS)) {
    const js = pageScript(name, {});
    for (const h of helpers) {
      if (!new RegExp("(^|[^.\\w$])" + h + "(?![\\w$:])", "m").test(js)) continue;
      assert.ok(new RegExp("^(function " + h + "\\(|const " + h + " = )", "m").test(js), `${name} calls ${h} without defining it`);
    }
  }
});

// A plain click is one page call, as eval_js is. A click on a link or submit
// aimed at a new tab adds every window's tab list in one bulk read before and
// after the second page call that clicks, plus one read of the shown tab once a
// tab appeared (goal 1's note), in whichever window it landed; Chromium also
// reads the new tab's URL to tell it is the click's (Safari's list has it). One
// that opens nothing re-reads the lists every 100ms for 500ms before calling it unconfirmed.
test("click: same-tab links and buttons cost what they did; a _blank link adds the tab reads and one page call", async () => {
  const html = `<a id=a href="/job/1" target=_blank>Apply</a><a id=same href="/job/2">Details</a><button id=b>Save</button>`;
  const cost = {};
  for (const [label, spec, owner] of [["chrome", chrome, "Google Chrome"], ["safari", safari, "Safari"]]) {
    for (const [sel, opens] of [["#same"], ["#b"], ["#a", 0], ["#a", 1], ["#a", false]]) {
      const dom = page(html, { url: "https://c0.test/" });
      install({ browsers: [spec([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }, { id: 2, active: 0, tabs: [{ url: "https://w1.test/", id: "w1" }] }])], cg: [{ owner: "Terminal" }, { owner }] });
      if (opens !== undefined && opens !== false) dom.document.getElementById("a").addEventListener("click", (e) => world.openTab(owner, opens, e.currentTarget.href));
      const { o } = await call("click", { selector: sel });
      assert.equal(o.ok, true, JSON.stringify(o));
      if (opens === false) assert.equal(o.unconfirmed, true, JSON.stringify(o));
      if (opens === 1) assert.ok(o.opened.tabId, JSON.stringify(o));
      cost[`${label} ${sel}${opens === false ? " unconfirmed" : opens === 1 ? " other window" : ""}`] = appleEvents();
    }
  }
  assert.deepEqual(cost, {
    "chrome #same": 1, "chrome #b": 1, "chrome #a": 1 + 1 + 1 + 1 + 1 + 1, "chrome #a other window": 1 + 1 + 1 + 1 + 1 + 1, "chrome #a unconfirmed": 1 + 1 + 1 + 6,
    // Safari's handle also needs the window id.
    "safari #same": 1, "safari #b": 1, "safari #a": 1 + 1 + 1 + 1 + 1 + 1, "safari #a other window": 1 + 1 + 1 + 1 + 1 + 1, "safari #a unconfirmed": 1 + 1 + 1 + 6,
  });
});

// A page-started load whose first check finds the new document complete: the
// handle's two reads, loading and url before the stamp, the stamp, one loading
// read at the gate, one check (each execute counts twice). The idle exit's
// extra check is only for an unproven commit.
test("navigate on Chrome costs a fixed count of Apple Events for a load the first check finds complete", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "c") }])], cg: [{ owner: "Google Chrome" }] });
  const h = (await listed("Google Chrome")).find((t) => t.url === "https://c1.test/").tabId;
  world.reset();
  const { o } = await call("navigate", { url: "https://next.test/", target: { tabId: h } });
  assert.equal(o.ok, true);
  assert.equal(o.waited, true);
  assert.equal(appleEvents(), 2 + 2 + 2 + 1 + 2, breakdown());
});

// A file: page loading another file: url takes the same page path, at the same cost.
test("navigate from a file: page to a file: url costs the same Apple Events as an http navigate", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "file:///tmp/p/a.html", title: "a", id: 7 }] }])], cg: [{ owner: "Finder", pid: 50 }, { owner: "Google Chrome" }] });
  const h = (await listed("Google Chrome"))[0].tabId;
  world.reset();
  const { o } = await call("navigate", { url: "file:///tmp/p/b.html", target: { tabId: h } });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.waited, true);
  assert.equal(appleEvents(), 2 + 2 + 2 + 1 + 2, breakdown());
});

// The re-read a task after an untargeted write: the resolve's read of the shown
// tab's id, then one bounded execute (so a page the write sent away costs at
// most POLL_EXEC_SECS), which the fake counts twice (NSAppleScript and
// tab.execute). Live that is 2 Apple Events; a tabId the server has listed
// needs no id read.
const REREAD = 1 + 2;

// fill {fields} on native fields is one page pass, whatever the order-dependent
// recheck finds, plus one short re-read a task later for a page that undoes a
// write. A batch ending on a custom combobox pays select's own polls, plus one
// recheck pass for the fields an earlier pass landed, which is that re-read.
test("fill {fields}: native fields cost a pass and a re-read; a batch ending on a custom combobox adds one recheck pass", async () => {
  const html = `<label>State <input id=st></label><label>Country <select id=co><option value="">Select...</option><option>Chile</option></select></label>
    <label><input type=checkbox id=ag> I agree</label>
    <label id=lab>Level</label><div class="select__control"><div role=combobox aria-labelledby=lab aria-expanded=false tabindex=0><span class=v>Choose</span></div></div><div id=menu></div>`;
  const cost = {};
  for (const [label, fields] of [
    ["native", [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "country", option: "Chile" }, { label_pattern: "agree", checked: true }]],
    ["ends on combobox", [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "level", option: "senior" }]],
  ]) {
    const dom = page(html, { url: "https://c0.test/" });
    dom.eval(`const cb = document.querySelector('[role=combobox]');
      document.querySelector('.select__control').addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !e.view) return;
        cb.setAttribute('aria-expanded', 'true');
        document.getElementById('menu').innerHTML = '<div role=option>Junior</div><div role=option>Senior</div>';
        document.querySelectorAll('[role=option]').forEach(o => o.addEventListener('click', () => { cb.querySelector('.v').textContent = o.textContent; }));
      });`);
    install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
    const { o } = await call("fill", { fields });
    assert.equal(o.ok, true, JSON.stringify(o));
    cost[label] = appleEvents();
  }
  assert.deepEqual(cost, { native: 1 + REREAD, "ends on combobox": 8 + 1 });
});

// A native form is one page pass and its re-read whether its fields come inline or from a file.
test("fill {fields} costs the same Apple Events inline and from fields_path", async (t) => {
  const html = `<label>Name <input name=n></label><label>Country <select name=c><option value="">Pick</option><option value=ar>Argentina</option></select></label>`;
  const fields = [{ label_pattern: "name", text: "Ada" }, { label_pattern: "country", option: ["Nope", "Argentina"] }];
  const p = join(tempDir("perch-perf-", t), "f.json");
  writeFileSync(p, JSON.stringify(fields));
  const cost = {};
  for (const [form, args] of [["inline", { fields }], ["path", { fields_path: p }]]) {
    const dom = page(html, { url: "https://c0.test/" });
    install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg: [{ owner: "Google Chrome" }] });
    const { o } = await call("fill", args);
    assert.equal(o.ok, true, JSON.stringify(o));
    cost[form] = appleEvents();
  }
  assert.deepEqual(cost, { inline: 1 + REREAD, path: 1 + REREAD }, breakdown());
});

// A box or radio already in the wanted state is not clicked, so the page heard
// nothing it could undo: a batch of only those has nothing to re-read.
test("fill {fields} whose boxes and radios are already set costs one Apple Event", async () => {
  const dom = page(`<label><input type=checkbox id=ag checked> I agree</label>
    <fieldset><legend>Size</legend><label><input type=radio name=sz value=s checked> Small</label><label><input type=radio name=sz value=m> Medium</label></fieldset>`, { url: "https://c0.test/" });
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg: [{ owner: "Google Chrome" }] });
  const { o } = await call("fill", { fields: [{ label_pattern: "agree", checked: true }, { label_pattern: "size", option: "Small" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(appleEvents(), 1, breakdown());
  world.reset();
  const { o: flip } = await call("fill", { fields: [{ label_pattern: "agree", checked: false }, { label_pattern: "size", option: "Small" }] });
  assert.equal(flip.ok, true, JSON.stringify(flip));
  assert.equal(appleEvents(), 1 + REREAD, breakdown());
});

// A plain field is the write and one re-read a task later; a miss (nothing
// landed) has nothing to re-read.
test("fill on a plain field costs a write and a bounded re-read, a miss one Apple Event", async () => {
  const dom = page(`<label>City <input id=c></label>`, { url: "https://c0.test/" });
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  const seen = evalsOf(dom);
  const { o } = await call("fill", { label_pattern: "city", text: "Rosario" });
  assert.deepEqual(o, { ok: true, kind: "plain", el: `textbox "City"`, len: 7 });
  assert.equal(appleEvents(), 1 + REREAD, breakdown());
  assert.ok(seen[1].length < 16000, `re-read eval'd ${seen[1].length} bytes`);
  world.reset();
  const miss = await call("fill", { label_pattern: "zzz", text: "x" });
  assert.equal(miss.o.ok, false);
  assert.equal(appleEvents(), 1, breakdown());  // A listed tabId needs no id read for the re-read.
  const h = (await listed("Google Chrome"))[0].tabId;
  world.reset();
  assert.equal((await call("fill", { label_pattern: "city", text: "Lima", target: { tabId: h } })).o.ok, true);
  assert.equal(appleEvents(), 1 + 2, breakdown());
});

// A native select is the pick and one re-read a task later, as a plain fill;
// a miss or a tie sets nothing and has nothing to re-read. Both run in the same
// runtime call on its bounded execute, which the fake counts twice
// (NSAppleScript and tab.execute), so page runs are read off tab.execute;
// untargeted, the resolve adds the shown tab's id read once.
test("select on a native <select> costs two page runs, a miss or a tie one", async () => {
  const dom = page(`<label>Plan <select id=plan><option value="">Select...</option><option>Basic plan</option><option>Basic support</option><option>Pro</option></select></label>`, { url: "https://c0.test/" });
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  const seen = evalsOf(dom);
  const { o } = await call("select", { label_pattern: "^plan", text: "Pro" });
  assert.deepEqual(o, { ok: true, selected: "Pro", el: `combobox "Plan"` });
  assert.equal(world.counts["tab.execute"], 2, breakdown());
  assert.equal(appleEvents(), 1 + 2 + 2, breakdown());
  assert.ok(seen[1].length < 16000, `re-read eval'd ${seen[1].length} bytes`);
  for (const text of ["Enterprise", "basic"]) {
    world.reset();
    const miss = await call("select", { label_pattern: "^plan", text });
    assert.equal(miss.o.ok, false, JSON.stringify(miss.o));
    assert.equal(world.counts["tab.execute"], 1, `${text} ${breakdown()}`);
    assert.equal(appleEvents(), 1 + 1 + 1, `${text} ${breakdown()}`);
  }
});

// A typeahead whose lookup answers the full text: the typing, the probe, the
// polls up to the pick and the reads up to the verified pick; nothing retyped.
test("fill on a typeahead that answers the full text costs a fixed count of Apple Events", async () => {
  const dom = page(`<div class=loc><label for=loc>Location</label><input id=loc type=text>
    <input type=hidden id=hid><div class=dropdown-container></div></div>`, { url: "https://c0.test/" });
  dom.eval(`const inp = document.getElementById('loc'), hid = document.getElementById('hid'), dd = document.querySelector('.dropdown-container');
    inp.addEventListener('input', () => {
      hid.value = '';
      dd.innerHTML = ['Rosario, Santa Fe, Argentina'].filter((c) => c.toLowerCase().startsWith(inp.value.toLowerCase())).map((c) => '<div class=dropdown-item>' + c + '</div>').join('');
      dd.querySelectorAll('.dropdown-item').forEach((o) => o.addEventListener('mousedown', () => { inp.value = o.textContent; hid.value = 'loc-0'; dd.innerHTML = ''; }));
    });`);
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  const { o } = await call("fill", { selector: "#loc", text: "Rosario" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal("query" in o, false);
  assert.equal(appleEvents(), 8, breakdown());
});

// wait {quiet} on a quiet page: one page call per 50ms sample until the window
// has passed, the first of them arming the observer.
test("wait {quiet} on a quiet page costs a fixed count of Apple Events", async () => {
  const dom = page(`<p>Idle</p>`, { url: "https://c0.test/" });
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://c0.test/", id: "c0", dom }] }])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  const { o } = await call("wait", { quiet: 200, timeout: 3000 });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(appleEvents(), 11, breakdown());
});
