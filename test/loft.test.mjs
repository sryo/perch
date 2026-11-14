// new_tab {loft:true}: a window of perch's own on loft's hidden display
// (github.com/sryo/loft), read from $LOFT_HOME/holder.json and checked against
// the display itself. It is placed in the make where the browser takes bounds,
// never activated, kept out of untargeted calls, and closed by close_tab with
// its last tab. Tool errors that need the user's window name the loft.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { JXA_PRELUDE, DAEMONS, handleCall, focus, loft, loftIdle, loftIdleClose, rooms, roomHint, INSTRUCTIONS, launchLeftovers } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { tempDir } from "../scripts/temp-dirs.mjs";

const RECT = { x: 4000, y: 0, w: 1440, h: 900 };
const LOFT_DISPLAY = { id: 77, ...RECT, vendor: 0x6c66, product: 0x7466 };
const DOWN = "error: no_browser: the loft is down; ask for a size and perch makes one: new_tab {url, loft:\"1280x800\"}";
const chrome = (windows, extra = {}) => ({ name: "Google Chrome", kind: "chrome", windows, ...extra });
const safari = (windows, extra = {}) => ({ name: "Safari", kind: "safari", windows, ...extra });
const arc = (windows, extra = {}) => ({ name: "Arc", kind: "arc", windows, ...extra });
const userWin = (p = "u") => ({ id: 1, active: 0, tabs: [{ url: `https://${p}.test/`, title: p, id: p }] });

let world, home;
function holder(h) {
  writeFileSync(join(home, "holder.json"), JSON.stringify({ pid: process.pid, cmd: "osascript -l JavaScript holder.js", displayId: 77, ...RECT, started: "2026-11-09T10:00:00Z", ...h }));
}
function install(spec, { displays = [LOFT_DISPLAY] } = {}) {
  world = makeWorld(spec);
  world.state.displays = displays;
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
}
const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  return { r, t, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
const made = () => world.log.filter(([k]) => k === "makeWindow");
const activations = () => Object.keys(world.counts).filter((k) => /^activate\(/.test(k));

beforeEach((t) => {
  home = tempDir("perch-loft-", t);
  process.env.LOFT_HOME = home;
  // No rooms here: the user's own registry would add room hints to errors.
  rooms.home = join(home, "rooms");
  focus.granted = true;
  loft.wins.clear();
  loft.owned.clear();
  loft.winLoft.clear();
  loft.tabWin.clear();
  loftIdle.closed.clear();
  loftIdle.ms = 3600000;
  loft.safari = { launch: async () => {} };
});

test("R1 a down loft is no_browser naming loft up, before any Apple Event", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Google Chrome" }] });
  let { t } = await call("new_tab", { url: "https://a.test/", loft: true });
  assert.equal(t, DOWN, "no holder.json");
  holder({ pid: 99999999 });
  ({ t } = await call("new_tab", { url: "https://a.test/", loft: true }));
  assert.equal(t, DOWN, "the holder's pid is gone");
  assert.deepEqual(world.aeLog, []);
  // A down loft needs no focus: the call is refused before the grant is asked for.
  focus.granted = false;
  ({ t } = await call("new_tab", { url: "https://a.test/", loft: true }));
  assert.equal(t, DOWN);
});

test("R1 a holder whose display is gone or isn't loft's makes no window", async () => {
  for (const displays of [[], [{ ...LOFT_DISPLAY, vendor: 0x610 }]]) {
    install({ browsers: [chrome([userWin()])], cg: [{ owner: "Google Chrome" }] }, { displays });
    holder();
    const { t } = await call("new_tab", { url: "https://a.test/", loft: true });
    assert.match(t, /^error: no_browser: the loft is down \(its display is gone\); ask for a size and perch makes one: new_tab \{url, loft:"1280x800"\}$/);
    assert.deepEqual(made(), []);
  }
});

test("R1 Chrome: a new window made with the loft's live bounds, its tab at the url, nothing activated", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  // holder.json's bounds are frozen at `loft up`; the display's own are read live.
  holder({ x: 10, y: 10, w: 100, h: 100 });
  const { r, o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.deepEqual(made().map(([, , via, p]) => [via, p]), [["window", { bounds: { x: 4000, y: 0, width: 1440, height: 900 } }]]);
  assert.equal(world.counts["win.bounds="], undefined, "placed in the make, never moved after");
  const w = world.winSpec("Google Chrome", 0);
  assert.deepEqual([w.x, w.y, w.w, w.h], [4000, 0, 1440, 900]);
  assert.equal(world.tabsOf("Google Chrome", 0)[w.active].page.url, "https://job.test/");
  assert.deepEqual(o, { app: "Google Chrome", tabId: "chrome:w901" });
  assert.deepEqual(activations(), []);
  assert.equal(world.counts["win.index="], undefined, "no window raised");
  assert.deepEqual(world.tabsOf("Google Chrome", 1).map((t) => t.spec.id), ["u"], "the user's window is untouched");
});

test("R1 a browser that ignores bounds in the make has its window moved onto the loft at once", async () => {
  install({ browsers: [chrome([userWin()], { makeBounds: false })], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  const { r, o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.deepEqual(world.log.filter(([k]) => k === "bounds").map(([, , id, b]) => [id, b]), [[901, { x: 4000, y: 0, width: 1440, height: 900 }]]);
});

test("R1 a window that won't sit on the loft is closed again, and the call fails", async () => {
  install({ browsers: [chrome([userWin()], { makeBounds: false, boundsStuck: true })], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  const { t } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.match(t, /^error: no_browser: Google Chrome would not place its window on the loft; nothing was left open/);
  assert.deepEqual(world.log.filter(([k]) => k === "closeWindow").map(([, , id]) => id), [901]);
  assert.equal(loft.wins.size, 0);
});

test("R1 Safari: a document window moved onto the loft, and no focus grant needed", async () => {
  focus.granted = false;
  install({ browsers: [safari([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Safari" }] });
  holder();
  const { r, o } = await call("new_tab", { app: "Safari", url: "https://job.test/", loft: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.deepEqual(made().map(([, , via, p]) => [via, p]), [["document", { url: "https://job.test/" }]]);
  const w = world.winSpec("Safari", 0);
  assert.deepEqual([w.x, w.y, w.w, w.h], [4000, 0, 1440, 900]);
  assert.match(o.tabId, /^safari:901\.0\./);
  assert.deepEqual(activations(), []);
});

test("R1 Safari: never its window make, which leaves a window with no tab; one document window, sized to the loft", async () => {
  install({ browsers: [safari([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Safari" }] });
  holder();
  const { r, o } = await call("new_tab", { app: "Safari", url: "https://job.test/", loft: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.deepEqual(made().map(([, , via]) => via), ["document"]);
  assert.equal(world.winCount("Safari"), 2);
  const w = world.winSpec("Safari", 0);
  assert.deepEqual([w.x, w.y, w.w, w.h, w.tabs.length], [4000, 0, 1440, 900, 1]);
});

test("R1 a window whose center is on the loft but hangs onto the user's display is moved fully onto it", async () => {
  install({ browsers: [safari([userWin()], { docAt: { x: 3800, y: 38, width: 574, height: 1074 } })], cg: [{ owner: "Terminal" }, { owner: "Safari" }] });
  holder();
  const { r, o } = await call("new_tab", { app: "Safari", url: "https://job.test/", loft: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  const w = world.winSpec("Safari", 0);
  assert.deepEqual([w.x, w.y, w.w, w.h], [4000, 0, 1440, 900]);
});

// The agent does its job without interrupting the user: a browser that would come
// to the front making the window (Chromium) isn't asked for the focus grant; the
// window opens in Safari instead, which makes one without taking focus, started in
// the background when it isn't running. The result says so: Safari has its own logins.
test("F1 without the focus grant, a loft window opens in Safari instead of asking, and says so", async () => {
  focus.granted = false;
  install({ browsers: [chrome([userWin()]), safari([userWin("s")])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }, { owner: "Safari" }] });
  holder();
  let asked = 0;
  const { r, o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.app, "Safari");
  assert.match(o.note, /^opened in Safari: Google Chrome would have come to the front, and the user hasn't allowed focus; Safari has its own sign-ins/);
  assert.deepEqual(made().map(([, app, via]) => [app, via]), [["Safari", "document"]]);
  assert.deepEqual(activations(), []);
  void asked;
});

test("F1 a named browser falls back too, Arc included; with the grant, the named browser is used", async () => {
  for (const [app, spec] of [["Google Chrome", chrome([userWin()])], ["Arc", arc([userWin()])]]) {
    focus.granted = app === "Arc";
    install({ browsers: [spec, safari([userWin("s")])], cg: [{ owner: "Terminal" }, { owner: app }, { owner: "Safari" }] });
    holder();
    const { r, o } = await call("new_tab", { app, url: "https://job.test/", loft: true });
    assert.equal(r.isError, undefined, `${app}: ${JSON.stringify(o)}`);
    assert.equal(o.app, "Safari", app);
    assert.match(o.note, app === "Arc" ? /^opened in Safari: Arc can't place a window on the loft/ : /^opened in Safari: Google Chrome would have come/, app);
  }
  focus.granted = true;
  install({ browsers: [chrome([userWin()]), safari([userWin("s")])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  const { o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(o.app, "Google Chrome");
  assert.equal(o.note, undefined);
});

test("A1 without the grant, while the user is away, the loft window opens in their Chromium browser and the app they left gets the front back", async () => {
  focus.granted = false;
  install({ browsers: [chrome([userWin()], { raiseOnMake: true }), safari([userWin("s")])], cg: [{ owner: "Terminal", pid: 200 }, { owner: "Google Chrome", pid: 300 }, { owner: "Safari", pid: 400 }] });
  world.state.idleSecs = 301;
  holder();
  const { r, o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.app, "Google Chrome");
  assert.equal(o.note, undefined);
  assert.equal(o.warning, undefined, "a raise nobody saw, undone, is not reported");
  assert.deepEqual(made().map(([, app, via]) => [app, via]), [["Google Chrome", "window"]]);
  assert.deepEqual(activations(), []);
  assert.deepEqual(world.log.filter(([k]) => k === "activatePid"), [["activatePid", 200]]);
});

test("A1 a locked screen counts as away; nothing raised means nothing is given back", async () => {
  focus.granted = false;
  install({ browsers: [chrome([userWin()]), safari([userWin("s")])], cg: [{ owner: "Terminal", pid: 200 }, { owner: "Google Chrome", pid: 300 }] });
  world.state.locked = true;
  holder();
  const { o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(o.app, "Google Chrome", JSON.stringify(o));
  assert.deepEqual(world.log.filter(([k]) => k === "activatePid"), []);
});

test("A1 the new loft window topping the window list is no raise: nothing is given back or warned", async () => {
  focus.granted = false;
  install({ browsers: [chrome([userWin()], { newOnTop: true }), safari([userWin("s")])], cg: [{ owner: "Terminal", pid: 200 }, { owner: "Google Chrome", pid: 300 }] });
  world.state.idleSecs = 600;
  holder();
  const { o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(o.app, "Google Chrome", JSON.stringify(o));
  assert.equal(o.warning, undefined);
  assert.deepEqual(world.log.filter(([k]) => k === "activatePid"), []);
});

test("A2 a user idle under five minutes is present: Safari, as without the grant", async () => {
  focus.granted = false;
  install({ browsers: [chrome([userWin()]), safari([userWin("s")])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }, { owner: "Safari" }] });
  world.state.idleSecs = 299;
  holder();
  const { o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(o.app, "Safari", JSON.stringify(o));
  assert.match(o.note, /^opened in Safari: Google Chrome would have come to the front, and the user hasn.t allowed focus/);
});

test("A2 a user watching a video is present however long the input was quiet; an agent's caffeinate is not them", async () => {
  focus.granted = false;
  install({ browsers: [chrome([userWin()]), safari([userWin("s")])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }, { owner: "Safari" }] });
  world.state.idleSecs = 3600;
  world.state.holds = [{ "Process Name": "caffeinate", AssertType: "PreventUserIdleDisplaySleep" }, { "Process Name": "Arc Helper", AssertType: "PreventUserIdleDisplaySleep" }];
  holder();
  let { o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(o.app, "Safari", JSON.stringify(o));
  world.state.holds = [{ "Process Name": "caffeinate", AssertType: "PreventUserIdleDisplaySleep" }, { "Process Name": "Claude", AssertType: "NoIdleSleepAssertion" }];
  ({ o } = await call("new_tab", { url: "https://job2.test/", loft: true }));
  assert.equal(o.app, "Google Chrome", JSON.stringify(o));
});

test("A2 Arc goes to Safari even while the user is away: it can't place a window", async () => {
  focus.granted = false;
  install({ browsers: [arc([userWin()]), safari([userWin("s")])], cg: [{ owner: "Terminal" }, { owner: "Arc" }, { owner: "Safari" }] });
  world.state.idleSecs = 900;
  holder();
  const { o } = await call("new_tab", { app: "Arc", url: "https://job.test/", loft: true });
  assert.equal(o.app, "Safari");
});

test("F2 Safari not running is started in the background first; a launch that fails says so", async () => {
  focus.granted = false;
  const saf = safari([], { running: false });
  install({ browsers: [chrome([userWin()]), saf], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  const launched = [];
  loft.safari = { launch: async () => { launched.push("launch Safari"); saf.running = true; } };
  let { r, o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.deepEqual(launched, ["launch Safari"]);
  assert.equal(o.app, "Safari");
  saf.running = false;
  loft.safari = { launch: async () => { throw new Error("LSOpen failed"); } };
  ({ o } = await call("new_tab", { url: "https://job.test/", loft: true }));
  assert.match(o, /^error: no_browser: Google Chrome would come to the front without the user's focus grant, and Safari, which wouldn't, could not be started \(LSOpen failed\)/);
});

test("R1 the browser in front gets the user's window back in front of the loft window", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Google Chrome" }, { owner: "Terminal" }] });
  holder();
  const { r } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(r.isError, undefined);
  assert.equal(world.winSpec("Google Chrome", 0).id, 1, "the user's window is the app's front window again");
  assert.deepEqual(activations(), []);
});

test("R1 a raise perch couldn't prevent is reported", async () => {
  install({ browsers: [chrome([userWin()], { raiseOnMake: true })], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  const { o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.equal(o.warning, "creating the window brought the browser to the front");
});

test("R1 Arc can't place a window, so with no Safari to fall back to it is refused with nothing made", async () => {
  loft.safari = { launch: async () => { throw new Error("no Safari"); } };
  install({ browsers: [arc([userWin()])], cg: [{ owner: "Arc" }] });
  holder();
  const { t } = await call("new_tab", { app: "Arc", url: "https://job.test/", loft: true });
  assert.match(t, /^error: no_browser: Arc can't place a window, so it can't open one on the loft; use another browser/);
  assert.deepEqual(made(), []);
});

test("R1 loft:true takes no from, label or room", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Google Chrome" }] });
  holder();
  for (const extra of [{ from: "chrome:u" }, { label: "x" }, { app: "room:main" }]) {
    const { t } = await call("new_tab", { url: "https://a.test/", loft: true, ...extra });
    assert.match(t, /^error: bad_args: new_tab loft:true opens a browser window; it takes no from, label or room/, JSON.stringify(extra));
  }
  assert.deepEqual(world.aeLog, []);
});

// The loft window is the browser's front window and sits highest in CG's order,
// but the user can't see it: "the topmost window" is theirs.
for (const [label, make, app] of [["Chrome", chrome, "Google Chrome"], ["Safari", safari, "Safari"]]) {
  test(`R2 untargeted calls skip perch's loft window (${label})`, async () => {
    install({ browsers: [make([userWin()])], cg: [{ owner: "Terminal" }, { owner: app, wid: 1 }] });
    holder();
    const { r, o } = await call("new_tab", { app, url: "https://job.test/", loft: true });
    assert.equal(r.isError, undefined, JSON.stringify(o));
    assert.equal(world.winSpec(app, 0).id, 901, "the loft window is the browser's front window");
    // CG lists it above the user's app, which is in front.
    world.cg.unshift({ owner: app, wid: 9, ...RECT });
    world.state.displays = [];
    const e = await call("eval_js", { script: "return location.href" });
    assert.equal(e.t, "https://u.test/");
    const w = await call("wait", { expression: "location.href === 'https://u.test/'", timeout: 200 });
    assert.equal(w.r.isError, undefined, w.t);
    const n = await call("new_tab", { url: "https://other.test/" });
    assert.equal(n.r.isError, undefined, n.t);
    const at = (id) => [0, 1].find((i) => world.winSpec(app, i).id === id);
    assert.equal(world.tabsOf(app, at(901)).length, 1, "nothing added to the loft window");
    assert.deepEqual(world.tabsOf(app, at(1)).map((t) => t.page.url), ["https://u.test/", "https://other.test/"]);
    // Targeted, the loft tab is reachable as any other.
    const j = await call("eval_js", { script: "return location.href", target: { tabId: o.tabId } });
    assert.equal(j.t, "https://job.test/");
  });
}

test("R2 a browser whose only window is perch's loft window has no default tab", async () => {
  install({ browsers: [chrome([])], cg: [{ owner: "Google Chrome", wid: 9, ...RECT }] });
  holder();
  const { r } = await call("new_tab", { app: "Google Chrome", url: "https://job.test/", loft: true });
  assert.equal(r.isError, undefined);
  const e = await call("eval_js", { script: "return location.href" });
  assert.match(e.t, /^error: no_browser: /);
});

test("R3 close_tab on the last tab of perch's loft window closes that window", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  const { o } = await call("new_tab", { url: "https://job.test/", loft: true });
  const c = await call("close_tab", { tabId: o.tabId });
  assert.deepEqual(c.o, { ok: true, closed: o.tabId, window: true });
  assert.deepEqual(world.log.filter(([k]) => k === "closeWindow").map(([, , id]) => id), [901]);
  assert.equal(loft.wins.size, 0, "perch forgets the window");
  // The user's last tab is still refused.
  const u = await call("close_tab", { tabId: "chrome:u" });
  assert.deepEqual(u.o, { ok: false, error: "last tab in its window; closing it would close the window" });
});

test("R3 Safari: close_tab closes perch's loft window with its last tab", async () => {
  install({ browsers: [safari([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Safari" }] });
  holder();
  const { o } = await call("new_tab", { app: "Safari", url: "https://job.test/", loft: true });
  const c = await call("close_tab", { tabId: o.tabId });
  assert.equal(c.o.window, true, c.t);
  assert.deepEqual(world.log.filter(([k]) => k === "closeWindow").map(([, , id]) => id), [901]);
});

test("R3 a loft window with more tabs loses only the tab", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  const { o } = await call("new_tab", { url: "https://job.test/", loft: true });
  world.openTab("Google Chrome", 0, "https://pop.test/");
  const c = await call("close_tab", { tabId: o.tabId });
  assert.deepEqual(c.o, { ok: true, closed: o.tabId });
  assert.deepEqual(world.log.filter(([k]) => k === "closeWindow"), []);
  assert.equal(loft.wins.size, 1);
});

test("R4 errors that need the user's window name the loft beside rooms, live or not", async () => {
  const hint = "or new_tab {url, loft:true}";
  assert.ok(roomHint("tab_not_visible: hidden", {}).includes(hint));
  assert.ok(roomHint("window_offscreen: minimized", {}).includes(hint));
  assert.equal(roomHint("stale_tab: gone", {}), "stale_tab: gone");
  // Nothing on the loft has the keyboard.
  assert.ok(!roomHint("tab_not_visible: a background trusted press needs the keyboard in the target's page", {}).includes("loft"));
  assert.equal(roomHint("tab_not_visible: x", { target: { tabId: "room:main:T1" } }), "tab_not_visible: x");
  focus.granted = false;
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Google Chrome" }] });
  const a = await call("activate_tab", { target: { tabId: "chrome:u" } });
  assert.match(a.t, /^error: needs_focus: .*new_tab \{url, loft:true\}/);
  const n = await call("new_tab", { url: "https://a.test/" });
  assert.match(n.t, /^error: needs_focus: .*new_tab \{url, loft:true\}/);
  assert.match(INSTRUCTIONS, /tab_not_visible \([^)]*loft:true/);
});

// Named lofts (loft up WxH --id <name>): loft:"<name>" reads $LOFT_HOME/lofts/<name>.json
// and sizes the window to that loft.
const WIDE = { x: -1280, y: 0, w: 1280, h: 800 };
const WIDE_DISPLAY = { id: 79, ...WIDE, vendor: 0x6c66, product: 0x7466 };
function named(id, h = {}) {
  mkdirSync(join(home, "lofts"), { recursive: true });
  writeFileSync(join(home, "lofts", `${id}.json`), JSON.stringify({ pid: process.pid, cmd: "holder.js", displayId: 79, ...WIDE, serial: 2, started: "2026-11-10T10:00:00Z", ...h }));
}

test("M1 loft:\"<id>\" opens a window the size of that loft", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] }, { displays: [LOFT_DISPLAY, WIDE_DISPLAY] });
  holder();
  named("wide");
  const { r, o } = await call("new_tab", { url: "https://job.test/", loft: "wide" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.deepEqual(made().map(([, , , p]) => p), [{ bounds: { x: -1280, y: 0, width: 1280, height: 800 } }]);
  assert.deepEqual(o, { app: "Google Chrome", tabId: "chrome:w901" });
});

test("M1 a named loft that is down says how to make it, before any Apple Event", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Google Chrome" }] }, { displays: [LOFT_DISPLAY] });
  holder();
  focus.granted = false;
  const { t } = await call("new_tab", { url: "https://a.test/", loft: "wide" });
  assert.equal(t, "error: no_browser: loft wide is down; make it with loft up WIDTHxHEIGHT --id wide (github.com/sryo/loft), then retry");
  assert.deepEqual(world.aeLog, []);
});

test("M1 a bad loft id is bad_args", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Google Chrome" }] });
  for (const loftArg of ["../x", "A", "", 3]) {
    const { t } = await call("new_tab", { url: "https://a.test/", loft: loftArg });
    assert.match(t, /^error: bad_args: new_tab loft takes true, a loft id or WxH/, JSON.stringify(loftArg));
  }
  const { t } = await call("new_tab", { url: "https://a.test/", loft: "default" });
  assert.equal(t, DOWN, "\"default\" is the default loft");
  assert.deepEqual(world.aeLog, []);
});

test("M2 untargeted calls skip perch's windows on every loft", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome", wid: 1 }] }, { displays: [LOFT_DISPLAY, WIDE_DISPLAY] });
  holder();
  named("wide");
  const a = await call("new_tab", { url: "https://one.test/", loft: true });
  const b = await call("new_tab", { url: "https://two.test/", loft: "wide" });
  assert.equal(b.r.isError, undefined, b.t);
  world.cg.unshift({ owner: "Google Chrome", wid: 8, ...RECT }, { owner: "Google Chrome", wid: 9, ...WIDE });
  const e = await call("eval_js", { script: "return location.href" });
  assert.equal(e.t, "https://u.test/");
  for (const o of [a.o, b.o]) assert.equal((await call("close_tab", { tabId: o.tabId })).o.window, true);
  assert.equal(loft.wins.size, 0);
});

test("M3 the tool schema and instructions say when an agent makes a loft", () => {
  assert.match(INSTRUCTIONS, /Where: the user.s logins, localhost, a set size or unseen painting: new_tab \{url, loft:"1280x800"\}[^\n]*a login of its own, a phone or a locked Mac: a room. Neither: perch picks. Blocked: take the next path. None left: tell the user and propose a session to find one./);
});

// new_tab {loft:"WxH"}: perch makes a loft that size itself (loft up WxH --new
// --owner <perch's pid>), reuses it for the same size, and removes it when its
// last window closes. The owner pid takes it down with perch however perch ends.
const FAKE_LOFT = join(import.meta.dirname, "fakes", "fake-loft.mjs");
const SIZED = { id: 81, x: -1280, y: 0, w: 1280, h: 800, vendor: 0x6c66, product: 0x7466 };
function sized() {
  const log = join(home, "loft.log");
  writeFileSync(log, "");
  process.env.LOFT_BIN = FAKE_LOFT;
  process.env.FAKE_LOFT_LOG = log;
  delete process.env.FAKE_LOFT;
  return () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

test("S1 loft:\"WxH\" makes a loft that size, owned by perch, and opens the window there", async () => {
  const runs = sized();
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] }, { displays: [LOFT_DISPLAY, SIZED] });
  const { r, o } = await call("new_tab", { url: "https://job.test/", loft: "1280x800" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.deepEqual(runs(), [`up 1280x800 --new --owner ${process.pid} --label ${basename(process.cwd())} --json`]);
  assert.deepEqual(made().map(([, , , p]) => p), [{ bounds: { x: -1280, y: 0, width: 1280, height: 800 } }]);
  assert.deepEqual(o, { app: "Google Chrome", tabId: "chrome:w901", loft: "loft-1" });
});

test("S2 each loft:\"WxH\" call gets a loft of its own, so two windows of one size never share a frame; each goes with its window", async () => {
  const runs = sized();
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] }, { displays: [LOFT_DISPLAY, SIZED] });
  const a = await call("new_tab", { url: "https://one.test/", loft: "1280x800" });
  const b = await call("new_tab", { url: "https://two.test/", loft: "1280x800" });
  assert.equal(b.r.isError, undefined, b.t);
  assert.deepEqual([a.o.loft, b.o.loft], ["loft-1", "loft-2"]);
  assert.equal(runs().length, 2, "a loft each");
  await call("close_tab", { tabId: a.o.tabId });
  assert.deepEqual(runs().slice(2), ["down loft-1"]);
  await call("close_tab", { tabId: b.o.tabId });
  assert.deepEqual(runs().slice(2), ["down loft-1", "down loft-2"]);
});

test("S5 calls for one size at once each get their own loft, and every one goes with its window", async () => {
  const runs = sized();
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] }, { displays: [LOFT_DISPLAY, SIZED] });
  const tabs = await Promise.all([1, 2, 3].map((n) => call("new_tab", { url: `https://job${n}.test/`, loft: "1280x800" })));
  assert.deepEqual(tabs.map((x) => x.o.loft).sort(), ["loft-1", "loft-2", "loft-3"], tabs.map((x) => x.t).join(" "));
  for (const x of tabs) await call("close_tab", { tabId: x.o.tabId });
  assert.deepEqual(runs().filter((l) => l.startsWith("down ")).sort(), ["down loft-1", "down loft-2", "down loft-3"]);
  assert.equal(loft.owned.size + loft.winLoft.size, 0);
});

test("S6 a loft perch's map lost still goes with its last window: its record names perch as owner", async () => {
  const runs = sized();
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] }, { displays: [LOFT_DISPLAY, SIZED] });
  const { o } = await call("new_tab", { url: "https://job.test/", loft: "1280x800" });
  loft.owned.clear();
  await call("close_tab", { tabId: o.tabId });
  assert.deepEqual(runs().slice(1), ["down loft-1"]);
});

test("S3 without loft installed, or when loft fails, the error says so and nothing is made", async () => {
  sized();
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Google Chrome" }] }, { displays: [LOFT_DISPLAY] });
  process.env.LOFT_BIN = join(home, "no-such-loft");
  let { t } = await call("new_tab", { url: "https://a.test/", loft: "1280x800" });
  assert.equal(t, "error: no_browser: loft:\"1280x800\" makes a loft, which needs loft installed (github.com/sryo/loft)");
  process.env.LOFT_BIN = FAKE_LOFT;
  process.env.FAKE_LOFT = "fail";
  ({ t } = await call("new_tab", { url: "https://a.test/", loft: "1280x800" }));
  assert.equal(t, "error: no_browser: loft up 1280x800 failed: could not add the display: CGVirtualDisplay returned no display");
  process.env.FAKE_LOFT = "bad_size";
  ({ t } = await call("new_tab", { url: "https://a.test/", loft: "9999x9999" }));
  assert.equal(t, "error: bad_args: size must be WIDTHxHEIGHT, from 640x480 to 5120x2880 (got 9999x9999)");
  assert.deepEqual(made(), []);
  delete process.env.FAKE_LOFT;
});

test("S4 loft ids follow rooms' pattern, so a size is never an id", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Google Chrome" }] });
  const { t } = await call("new_tab", { url: "https://a.test/", loft: "9a" });
  assert.match(t, /^error: bad_args: new_tab loft takes true, a loft id or WxH/);
});

test("F3 after starting Safari itself, perch closes only the start-page windows that launch opened", () => {
  const wins = [
    { id: 1, urls: ["favorites://"] },
    { id: 2, urls: ["topsites://"] },
    { id: 3, urls: [""] },
    { id: 4, urls: ["https://restored.test/"] },
    { id: 5, urls: ["favorites://", "https://kept.test/"] },
    { id: 6, urls: ["about:blank"] },
  ];
  assert.deepEqual(launchLeftovers(wins), [1, 2, 3, 6]);
  assert.deepEqual(launchLeftovers([]), []);
});

// Safari has none of the user's sign-ins, so for a site a room is signed in to, the
// handoff to Safari would leave a signed-out page that reads as "the loft can't do this".
// Nothing opens, and the error names the room. With the grant the browser itself is used.
test("F5 a site a room is signed in to is not handed to Safari: no_browser naming the room, nothing made", async () => {
  mkdirSync(rooms.home, { recursive: true });
  writeFileSync(join(rooms.home, "rooms.json"), JSON.stringify({ version: 1, rooms: { main: { name: "main", cdp: { host: "127.0.0.1", port: 1, token: "t" }, sites: [{ origin: "https://www.figma.com", url: "https://www.figma.com/files" }] } } }));
  const WHY = /^error: no_browser: (Google Chrome would have come to the front, and the user hasn't allowed focus|Arc can't place a window on the loft), and Safari, which wouldn't, has none of the user's sign-ins; room:main is signed in to www\.figma\.com, so open it there: new_tab \{url, app:"room:main"\}$/;
  for (const [app, spec, loftArg] of [["Google Chrome", chrome([userWin()]), true], ["Arc", arc([userWin()]), true]]) {
    focus.granted = app === "Arc";
    install({ browsers: [spec, safari([userWin("s")])], cg: [{ owner: "Terminal" }, { owner: app }, { owner: "Safari" }] });
    holder();
    const { t } = await call("new_tab", { app, url: "https://www.figma.com/design/abc", loft: loftArg });
    assert.match(t, WHY, app);
    assert.deepEqual(made(), [], app);
    // Another site still goes to Safari, with its note.
    const { o } = await call("new_tab", { app, url: "https://job.test/", loft: true });
    assert.equal(o.app, "Safari", app);
  }
  focus.granted = true;
  install({ browsers: [chrome([userWin()]), safari([userWin("s")])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  const { o } = await call("new_tab", { url: "https://www.figma.com/design/abc", loft: true });
  assert.equal(o.app, "Google Chrome", "with the grant the user's own browser, and their sign-ins, take it");
});

// A hidden app's windows don't paint, the loft's included, so a hidden Safari is no
// path: the call says so and names the next one (a room), and makes nothing.
test("F4 a hidden Safari is no path for a loft window: no_browser, nothing made, the room named next", async () => {
  focus.granted = false;
  install({ browsers: [chrome([userWin()]), safari([userWin("s")])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }, { owner: "Safari" }] });
  world.state.pids = { "com.apple.Safari": [4242] };
  world.state.hidden = [4242];
  holder();
  let { t } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.match(t, /^error: no_browser: Google Chrome would have come to the front, and the user hasn't allowed focus, and Safari, which wouldn't, is hidden \(Cmd-H\), so its window wouldn't paint/);
  ({ t } = await call("new_tab", { app: "Safari", url: "https://job.test/", loft: true }));
  assert.match(t, /^error: no_browser: Safari is hidden \(Cmd-H\), so its window on the loft wouldn't paint/);
  assert.deepEqual(made(), []);
});

// A session that opened a loft window and went quiet leaves it there for good: the
// loft lives while perch does. After loftIdle.ms with no call to this server, perch
// closes the windows it made on a loft (only those still on one), and takes down a
// loft it made; the agent's old handle then says what happened and how to reopen.
const closedWins = () => world.log.filter(([k]) => k === "closeWindow").map(([, , id]) => id);
const until = async (f, ms = 1000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return f(); };

test("I1 a loft window no call has used for loftIdle.ms is closed, and its handle says how to reopen it", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  loftIdle.ms = 40;
  const { o } = await call("new_tab", { url: "https://job.test/", loft: true });
  assert.ok(await until(() => closedWins().length), "closed once idle");
  assert.deepEqual(closedWins(), [901]);
  assert.equal(loft.wins.size, 0, "perch forgets the window");
  const e = await call("eval_js", { script: "return 1", target: { tabId: o.tabId } });
  assert.match(e.t, /^error: stale_tab: perch closed this tab's loft window after it went unused; reopen it with new_tab \{url, loft\}/);
  assert.deepEqual(world.log.filter(([k, a]) => k === "closeWindow" && a !== "Google Chrome"), [], "nothing else closed");
});

test("I2 calls keep a loft window open; idle counts from the last one", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  loftIdle.ms = 80;
  await call("new_tab", { url: "https://job.test/", loft: true });
  for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 30)); await call("list_tabs", {}); }
  assert.deepEqual(closedWins(), [], "used every 30ms");
  assert.ok(await until(() => closedWins().length), "closed once the calls stop");
});

test("I3 a loft perch made goes down with its idle windows", async () => {
  const runs = sized();
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] }, { displays: [LOFT_DISPLAY, SIZED] });
  loftIdle.ms = 3600000;
  await call("new_tab", { url: "https://job.test/", loft: "1280x800" });
  await loftIdleClose();
  assert.deepEqual(closedWins(), [901]);
  assert.deepEqual(runs().slice(1), ["down loft-1"]);
});

test("I4 a window no longer on a loft is never closed for idle, and perch stops counting it as its own", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  await call("new_tab", { url: "https://job.test/", loft: true });
  world.run('Application("Google Chrome").windows.byId(901).bounds = {x: 0, y: 0, width: 800, height: 600}');
  await loftIdleClose();
  assert.deepEqual(closedWins(), []);
  assert.equal(loft.wins.size, 0);
});

test("I5 PERCH_LOFT_IDLE_MS=0 never closes a loft window for idle", async () => {
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  holder();
  loftIdle.ms = 0;
  await call("new_tab", { url: "https://job.test/", loft: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(closedWins(), []);
});

test("I6 a loft perch made goes down after idle even when its window was closed some other way", async () => {
  const runs = sized();
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] }, { displays: [LOFT_DISPLAY, SIZED] });
  await call("new_tab", { url: "https://job.test/", loft: "1280x800" });
  world.run('Application("Google Chrome").windows.byId(901).close()');
  await loftIdleClose();
  assert.deepEqual(runs().slice(1), ["down loft-1"]);
  assert.equal(loft.wins.size + loft.owned.size, 0);
});
