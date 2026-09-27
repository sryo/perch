// navigate must end within its own timeout even when page JS never answers.
// Live, Chrome dropped the reply to the first readyState check in about 7% of
// same-URL reloads (the execute landed while the navigation replaced the
// document); JXA has no per-command timeout, so that check blocked until the
// daemon killed the REPL at 20s. The fake world models the unanswered execute
// by advancing its clock by the caller's Apple Event timeout (2 minutes when
// the caller set none).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const NAV_TIMEOUT = 15000;
const chrome = (windows) => ({ name: "Google Chrome", kind: "chrome", windows });
const fixture = () => ({
  browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "http://127.0.0.1:8787/fixture.html", id: 7 }] }])],
  cg: [{ owner: "Google Chrome" }],
});

let world;
function install(spec) {
  world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
// The runtime result carries `waited`, which the tool result doesn't expose.
const runtimeNavigate = (url) =>
  world.run(`__perch.navigate(${JSON.stringify({ target: null, url, timeout: NAV_TIMEOUT })})`);

beforeEach(() => { world = null; });

test("navigate: holds page JS while the tab is loading, so no check lands before the reload commits", () => {
  install(fixture());
  world.state.commitMs = 60;
  world.state.dropWhilePending = true;
  const t0 = world.clock.t;
  const r = runtimeNavigate("http://127.0.0.1:8787/fixture.html");
  const took = world.clock.t - t0;
  assert.equal(r.waited, true);
  assert.ok(took < 300, `took ${took}ms; a check sent mid-navigation went unanswered`);
  assert.equal(world.counts["tab.execute"], 2, "one stamp, one check");
  assert.equal(world.page("Google Chrome", 0, 0).__perch_nav, undefined, "the check ran in the new document");
});

test("navigate: a check that gets no reply costs one short Apple Event timeout, not the 2-minute default", () => {
  install(fixture());
  // loading() stays true until an execute arrives, so the gate runs out and the
  // first check lands before the reload commits.
  world.state.linger = 1;
  world.state.dropWhilePending = true;
  const t0 = world.clock.t;
  const r = runtimeNavigate("http://127.0.0.1:8787/fixture.html");
  const took = world.clock.t - t0;
  assert.equal(r.waited, true);
  // 2000ms loading gate + one 500ms unanswered check + the next check.
  assert.ok(took < 3000, `took ${took}ms; an unbounded execute waits out the 2-minute Apple Event default`);
  assert.ok(world.counts["NSAppleScript"] >= 2, "page JS went through the bounded execute");
  // Live, reading the error Ref after the timed-out execute crashed osascript
  // (SIGSEGV in objc_retain) in about half the timeouts.
  assert.equal(world.state.segv, undefined, "read the error Ref of a failed NSAppleScript");
});

test("navigate: never outlives its timeout when no page JS call is ever answered", () => {
  install(fixture());
  world.state.linger = 1e9;
  world.state.hung = true;
  const t0 = world.clock.t;
  const r = runtimeNavigate("https://next.test/");
  const took = world.clock.t - t0;
  assert.equal(r.waited, false);
  assert.equal(r.tabId, "chrome:7");
  assert.ok(took >= NAV_TIMEOUT && took <= NAV_TIMEOUT + 200, `took ${took}ms`);
});

test("navigate tool: an unanswered page JS call is not an error and ends at the timeout", async () => {
  install(fixture());
  world.state.linger = 1e9;
  world.state.hung = true;
  const t0 = world.clock.t;
  const res = await handleCall("navigate", { url: "https://next.test/" });
  assert.equal(res.isError, undefined);
  assert.ok(world.clock.t - t0 <= NAV_TIMEOUT + 200, `took ${world.clock.t - t0}ms`);
  assert.deepEqual(world.log.filter((l) => l[0] === "navigate"), [["navigate", "Google Chrome", "https://next.test/"]]);
});

test("navigate: page JS reaches the tab through AppleScript with its ids and JS quoted", () => {
  install(fixture());
  const url = String.raw`http://127.0.0.1:8787/fixture.html?q="a\b"`;
  const r = runtimeNavigate(url);
  assert.equal(r.waited, true);
  assert.equal(world.page("Google Chrome", 0, 0).location.href, url);
});

// Live on Safari (macOS 27.2), doJavaScript runs in a tab the window isn't
// showing, and a url set on that tab loads it in place.
const safari = (windows) => ({ name: "Safari", kind: "safari", windows });
const safariFixture = () => ({
  browsers: [safari([{ id: 3, active: 0, tabs: [{ url: "https://shown.test/" }, { url: "https://bg.test/" }] }])],
  cg: [{ owner: "Safari" }],
});

test("navigate on Safari: loads a background tab in place and never changes the tab its window shows", () => {
  install(safariFixture());
  const r = world.run(`__perch.navigate(${JSON.stringify({ target: { app: "Safari", tabIndex: 1 }, url: "https://next.test/", timeout: NAV_TIMEOUT })})`);
  assert.equal(r.waited, true);
  assert.equal(world.counts["win.currentTab="], undefined);
  assert.equal(world.winSpec("Safari", 0).active, 0);
  assert.equal(world.page("Safari", 0, 1).location.href, "https://next.test/");
  assert.equal(world.page("Safari", 0, 0).location.href, "https://shown.test/");
});

// Live on Chrome Canary (2026-09), setting a tab's url through AppleScript
// brought Chrome's window to the front, from any page and for a tab its window
// wasn't showing; a navigation the page started did not. So navigate starts it
// from page JS and sets the url only when page JS can't run or won't navigate.
const RAISE = "navigating from outside the page may bring the browser to the front";
const paths = () => world.log.filter((l) => l[0] === "navigate" || l[0] === "assign");
const bgFixture = () => ({
  browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://shown.test/", id: 6 }, { url: "http://127.0.0.1:8787/fixture.html", id: 7 }] }])],
  cg: [{ owner: "Google Chrome" }],
});

test("navigate on Chrome: starts the load from page JS, never through the tab's url", async () => {
  install(bgFixture());
  world.state.commitMs = 60;
  const o = JSON.parse((await handleCall("navigate", { url: "https://next.test/", target: { tabId: "chrome:7" } })).content[0].text);
  assert.deepEqual(o, { ok: true, url: "https://next.test/", waited: true, tabId: "chrome:7" });
  assert.deepEqual(paths(), [["assign", "Google Chrome", "https://next.test/"]]);
  assert.equal(world.counts["tab.url="], undefined);
  assert.equal(world.page("Google Chrome", 0, 1).location.href, "https://next.test/");
  assert.equal(world.page("Google Chrome", 0, 0).location.href, "https://shown.test/");
  assert.equal(world.winSpec("Google Chrome", 0).active, 0);
});

test("navigate on Chrome: a same-document #hash moves from page JS without a load wait", () => {
  install(fixture());
  const r = runtimeNavigate("http://127.0.0.1:8787/fixture.html#sec");
  assert.equal(r.waited, true);
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths(), [["assign", "Google Chrome", "http://127.0.0.1:8787/fixture.html#sec"]]);
  assert.equal(world.counts["tab.execute"], 1);
});

test("navigate on Chrome: about:blank loads from page JS too", () => {
  install(fixture());
  const r = runtimeNavigate("about:blank");
  assert.equal(r.waited, true);
  assert.deepEqual(paths(), [["assign", "Google Chrome", "about:blank"]]);
});

test("navigate on Chrome: a reply lost as the page navigates does not load the url a second time", () => {
  install(fixture());
  world.state.commitMs = 60;
  world.state.dropAfterAssign = true;
  const r = runtimeNavigate("https://next.test/");
  assert.equal(r.waited, true);
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths(), [["assign", "Google Chrome", "https://next.test/"]]);
});

for (const [name, setup, url] of [
  ["the page refuses", () => { world.page("Google Chrome", 0, 0).location.assign = () => { throw new Error("SecurityError"); }; }, "https://next.test/"],
  ["page JS is off", () => { world.state.jsOff = true; }, "https://next.test/"],
  ["the page never answers", () => { world.state.hung = true; world.state.linger = 1e9; }, "https://next.test/"],
  ["the url is not http(s) or about:blank", () => {}, "data:text/html,<p>x</p>"],
]) {
  test(`navigate on Chrome: sets the tab's url and warns of a raise when ${name}`, () => {
    install(fixture());
    setup();
    const r = runtimeNavigate(url);
    assert.equal(r.warning, RAISE);
    assert.deepEqual(paths(), [["navigate", "Google Chrome", url]]);
  });
}

test("navigate tool: passes the raise warning through", async () => {
  install(fixture());
  world.state.jsOff = true;
  const o = JSON.parse((await handleCall("navigate", { url: "https://next.test/" })).content[0].text);
  assert.equal(o.warning, RAISE);
  assert.equal(o.ok, true);
});

const arc = (windows) => ({ name: "Arc", kind: "arc", windows });
const arcFixture = () => ({
  browsers: [arc([{ id: "A", active: 0, tabs: [{ url: "https://a0.test/", id: "a0" }, { url: "https://a1.test/", id: "a1" }] }])],
  cg: [{ owner: "Arc" }],
});
const arcNavigate = (i) => world.run(`__perch.navigate(${JSON.stringify({ target: { app: "Arc", tabIndex: i }, url: "https://next.test/", timeout: NAV_TIMEOUT })})`);

test("navigate on Arc: the shown tab loads from page JS", () => {
  install(arcFixture());
  const r = arcNavigate(0);
  assert.equal(r.waited, true);
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths(), [["assign", "Arc", "https://next.test/"]]);
});

test("navigate on Arc: a background tab, where page JS hangs, sets the url and warns", () => {
  install(arcFixture());
  const r = arcNavigate(1);
  assert.equal(r.waited, false);
  assert.equal(r.warning, RAISE);
  assert.deepEqual(paths(), [["navigate", "Arc", "https://next.test/"]]);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("navigate on Safari: loads from page JS, and a fallback carries no Chromium warning", () => {
  install(safariFixture());
  const nav = (i) => world.run(`__perch.navigate(${JSON.stringify({ target: { app: "Safari", tabIndex: i }, url: "https://next.test/", timeout: NAV_TIMEOUT })})`);
  assert.equal(nav(0).warning, undefined);
  assert.deepEqual(paths(), [["assign", "Safari", "https://next.test/"]]);
  world.state.safariCurrentOnly = true;
  const r = nav(1);
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths().slice(1), [["navigate", "Safari", "https://next.test/"]]);
  assert.equal(world.winSpec("Safari", 0).active, 0);
});

// A lost reply only counts as a started load when the tab wasn't already busy:
// a load still committing from an earlier navigate also shows as loading and
// replaces the stamped document.
test("navigate on Chrome: a lost reply while an earlier load commits still loads the url", () => {
  install(fixture());
  world.state.commitMs = 20000;
  assert.equal(runtimeNavigate("https://other.test/").waited, false);
  world.state.commitMs = 60;
  world.state.dropWhilePending = true;
  const r = runtimeNavigate("https://want.test/");
  assert.equal(world.page("Google Chrome", 0, 0).location.href, "https://want.test/");
  assert.equal(r.waited, true);
  assert.equal(r.warning, RAISE);
  assert.deepEqual(paths().slice(1), [["navigate", "Google Chrome", "https://want.test/"]]);
});

// A redirect lands on another URL: the stamp is gone and the tab moved.
test("navigate on Chrome: a redirected page-started load counts as loaded, even with its reply lost", () => {
  install(fixture());
  world.state.commitMs = 60;
  world.state.dropAfterAssign = true;
  const loc = world.page("Google Chrome", 0, 0).location;
  const assign = loc.assign;
  loc.assign = () => assign("https://final.test/");
  const r = runtimeNavigate("https://next.test/");
  assert.equal(r.waited, true);
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths(), [["assign", "Google Chrome", "https://final.test/"]]);
});

// The Navigation API lets the page cancel a load it starts (a `navigate`
// listener calling preventDefault); a url set through AppleScript is not
// cancelable that way.
test("navigate on Chrome: a page that cancels the load falls back to the tab's url", () => {
  install(fixture());
  const ctx = world.page("Google Chrome", 0, 0);
  const assign = ctx.location.assign;
  Object.assign(ctx, { EventTarget, Event });
  ctx.navigation = new EventTarget();
  ctx.navigation.addEventListener("navigate", (e) => e.preventDefault());
  ctx.location.assign = (u) => {
    const e = new Event("navigate", { cancelable: true });
    ctx.navigation.dispatchEvent(e);
    if (!e.defaultPrevented) assign(u);
  };
  const r = runtimeNavigate("https://next.test/");
  assert.equal(r.waited, true);
  assert.equal(r.warning, RAISE);
  assert.deepEqual(paths(), [["navigate", "Google Chrome", "https://next.test/"]]);
  assert.equal(world.page("Google Chrome", 0, 0).location.href, "https://next.test/");
});

// A load dropped without a trace (a held beforeunload the user stayed on) leaves
// the old document in place once loading settles, as a download or 204 does, so
// it isn't loaded again from outside the page: that would fetch a download twice.
test("navigate on Chrome: a page-started load that never leaves the old page is not waited", () => {
  install(fixture());
  world.page("Google Chrome", 0, 0).location.assign = () => {};
  const r = runtimeNavigate("https://next.test/");
  assert.equal(r.waited, false);
  assert.equal(world.page("Google Chrome", 0, 0).location.href, "http://127.0.0.1:8787/fixture.html");
});

test("navigate on Chrome: a lost reply on a page that is still loading sets the tab's url", () => {
  install({ ...fixture(), loadTicks: 1e9 });
  world.state.hung = true;
  const r = runtimeNavigate("https://want.test/");
  assert.equal(r.waited, false);
  assert.equal(r.warning, RAISE);
  assert.deepEqual(paths(), [["navigate", "Google Chrome", "https://want.test/"]]);
});

// A fresh document at the URL the tab already showed is the page reloading
// itself, not the load navigate asked for.
test("navigate on Chrome: a lost reply after the page reloaded itself sets the tab's url", () => {
  install(fixture());
  world.state.commitMs = 60;
  world.state.dropAfterAssign = true;
  const loc = world.page("Google Chrome", 0, 0).location;
  const assign = loc.assign;
  loc.assign = () => assign(loc.href);
  const r = runtimeNavigate("https://next.test/");
  assert.equal(r.warning, RAISE);
  assert.deepEqual(paths().slice(1), [["navigate", "Google Chrome", "https://next.test/"]]);
  assert.equal(world.page("Google Chrome", 0, 0).location.href, "https://next.test/");
});
