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

// Goal 1: with the user in another app, navigate never sets the tab's url
// unless the call passed raise:true. Where the page can't start the load it
// refuses with a code saying how to opt in.
const away = (f) => ({ ...f, cg: [{ owner: "Finder", pid: 50 }, ...f.cg] });
const navWith = (args) => world.run(`__perch.navigate(${JSON.stringify({ target: null, timeout: NAV_TIMEOUT, ...args })})`);
const OPT_IN = /raise:true.*activate_tab/;
const cancelLoads = () => {
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
};

for (const [name, setup, url, code] of [
  ["the page refuses", () => { world.page("Google Chrome", 0, 0).location.assign = () => { throw new Error("SecurityError"); }; }, "https://next.test/", /^tab_not_visible: /],
  // The Navigation API lets the page cancel a load it starts (a `navigate`
  // listener calling preventDefault); a url set through AppleScript is not
  // cancelable that way.
  ["the page cancels the load", cancelLoads, "https://next.test/", /^tab_not_visible: /],
  ["the url is not http(s) or about:blank", () => {}, "data:text/html,<p>x</p>", /^tab_not_visible: /],
  ["the url is relative", () => {}, "/next.html", /^tab_not_visible: /],
  ["page JS is off", () => { world.state.jsOff = true; }, "https://next.test/", /turned off/],
  ["the page never answers", () => { world.state.hung = true; world.state.linger = 1e9; }, "https://next.test/", /^timeout: /],
]) {
  test(`navigate on Chrome: refuses rather than set the tab's url when ${name}`, () => {
    install(away(fixture()));
    setup();
    const t0 = world.clock.t;
    assert.throws(() => navWith({ url }), (e) => code.test(e.message) && (code.source.includes("turned") || OPT_IN.test(e.message)));
    assert.ok(world.clock.t - t0 <= NAV_TIMEOUT, `took ${world.clock.t - t0}ms`);
    assert.equal(world.counts["tab.url="], undefined, "set the tab's url, which raises the browser");
    assert.deepEqual(world.cg.map((c) => c.owner), ["Finder", "Google Chrome"]);
  });

  test(`navigate on Chrome: raise:true sets the tab's url and warns when ${name}`, () => {
    install(away(fixture()));
    setup();
    const r = navWith({ url, raise: true });
    assert.equal(r.warning, RAISE);
    assert.equal(paths().filter((l) => l[0] === "navigate").length, 1);
  });
}

test("navigate on Chrome: with its window already in front, the tab's url is set without raise:true", () => {
  install(fixture());
  const r = runtimeNavigate("data:text/html,<p>x</p>");
  assert.equal(r.warning, RAISE);
  assert.deepEqual(paths(), [["navigate", "Google Chrome", "data:text/html,<p>x</p>"]]);
});

test("navigate on Chrome: the browser in front is not enough when the tab's window is behind another of its windows", () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://front.test/", id: 5 }] }, { id: 2, active: 0, tabs: [{ url: "https://back.test/", id: 7 }] }])],
    cg: [{ owner: "Google Chrome" }],
  });
  assert.throws(() => navWith({ url: "data:text/html,x", target: { tabId: "chrome:7" } }), (e) => /^tab_not_visible: /.test(e.message));
  assert.equal(world.counts["tab.url="], undefined);
});

test("navigate on Chrome: another of its windows raised while the page doesn't answer is refused, nothing set", () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://front.test/", id: 5 }] }, { id: 2, active: 0, tabs: [{ url: "https://other.test/", id: 7 }] }])],
    cg: [{ owner: "Google Chrome" }],
  });
  world.state.hung = true;
  let n = 0;
  world.state.onExecute = () => { if (++n === 2) world.apps["Google Chrome"].windows[1].index = 1; };
  assert.throws(() => navWith({ url: "https://next.test/", target: { tabId: "chrome:5" } }), (e) => /^timeout: .*raise:true/.test(e.message));
  assert.ok(n >= 2, "the page was asked again");
  assert.equal(world.counts["tab.url="], undefined, "set the url of a tab whose window is no longer in front");
});

test("navigate on Chrome: a bounded execute that fails fast loads from page JS on the plain path, once", () => {
  install(away(fixture()));
  world.state.compileFails = true;
  const r = navWith({ url: "https://next.test/" });
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths(), [["assign", "Google Chrome", "https://next.test/"]]);
  assert.equal(world.counts["tab.url="], undefined);
  assert.equal(world.page("Google Chrome", 0, 0).location.href, "https://next.test/");
});

// With the handler not compiling, the stamp goes on the plain path, which has no
// Apple Event timeout. Live the runtime's own timeout ends that first (coded
// timeout:); either way the error must carry the code.
test("navigate on Chrome: a page that hangs after the bounded execute failed fast is refused as a timeout", () => {
  install(away(fixture()));
  world.state.compileFails = true;
  world.state.hung = true;
  assert.throws(() => navWith({ url: "https://next.test/" }), (e) => /^timeout: /.test(e.message) && OPT_IN.test(e.message));
  assert.equal(world.counts["tab.url="], undefined);
});

// A one-off fast failure says nothing about the page; the resend stays bounded.
test("navigate on Chrome: after a one-off fast failure, a hung page costs a bounded resend, not the 2-minute default", () => {
  install(fixture());
  let n = 0;
  world.state.onExecute = () => { if (++n === 1) { world.state.hung = true; throw new Error("Some other AppleScript error."); } };
  const t0 = world.clock.t;
  const r = navWith({ url: "data:text/html,x" });
  assert.equal(r.warning, RAISE);
  assert.ok(world.clock.t - t0 <= NAV_TIMEOUT + 200, `took ${world.clock.t - t0}ms`);
  assert.deepEqual(paths(), [["navigate", "Google Chrome", "data:text/html,x"]]);
});

test("navigate on Chrome: a url the page can't load, refused because its window left the front, says so", () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://front.test/", id: 5 }] }, { id: 2, active: 0, tabs: [{ url: "https://other.test/", id: 7 }] }])],
    cg: [{ owner: "Google Chrome" }],
  });
  world.state.onExecute = () => { world.apps["Google Chrome"].windows[1].index = 1; };
  assert.throws(() => navWith({ url: "data:text/html,x", target: { tabId: "chrome:5" } }),
    (e) => /^tab_not_visible: .*no longer in front/.test(e.message) && !/refused or cancelled/.test(e.message) && OPT_IN.test(e.message));
  assert.equal(world.counts["tab.url="], undefined);
});

// Chromium's own pages run no page JS, so navigate sends none from one: in the
// background it refuses up front, as for Arc's arc: pages.
const newTabFixture = () => ({
  browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "chrome://newtab/", id: 7 }] }])],
  cg: [{ owner: "Google Chrome" }],
});
test("navigate on Chrome: from its own new-tab page in the background is refused as not scriptable, naming raise:true", () => {
  install(away(newTabFixture()));
  assert.throws(() => navWith({ url: "https://next.test/" }), (e) => /^tab_not_scriptable: /.test(e.message) && OPT_IN.test(e.message));
  assert.equal(world.counts["tab.url="], undefined);
  assert.equal(world.counts["tab.execute"] || 0, 0);
  const r = navWith({ url: "https://next.test/", raise: true });
  assert.equal(r.warning, RAISE);
  assert.equal(r.waited, true);
  assert.deepEqual(paths(), [["navigate", "Google Chrome", "https://next.test/"]]);
  assert.equal(world.state.internalExecs || 0, 0, "page JS sent to the new-tab page");
});

test("navigate on Chrome: from its own new-tab page with its window in front sets the url and waits", () => {
  install(newTabFixture());
  const r = navWith({ url: "https://next.test/" });
  assert.equal(r.waited, true);
  assert.equal(r.warning, RAISE);
  assert.deepEqual(paths(), [["navigate", "Google Chrome", "https://next.test/"]]);
  assert.equal(world.state.internalExecs || 0, 0, "page JS sent to the new-tab page");
});

test("navigate tool: refusal is an error naming the opt-in, and raise:true passes through with the warning", async () => {
  install(away(fixture()));
  const res = await handleCall("navigate", { url: "data:text/html,x" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^error: tab_not_visible: .*raise:true/);
  assert.equal(world.counts["tab.url="], undefined);
  const o = JSON.parse((await handleCall("navigate", { url: "data:text/html,x", raise: true })).content[0].text);
  assert.equal(o.warning, RAISE);
  assert.equal(o.ok, true);
});

// http to http must never reach the url-setting path, whatever happens to the
// stamp call's reply.
test("navigate on Chrome: a page too busy to answer in time still loads from page JS, once", () => {
  install(away(fixture()));
  world.state.lateRun = true;
  world.tabsOf("Google Chrome", 0)[0].busyUntil = world.clock.t + 1500;
  const r = navWith({ url: "http://127.0.0.1:8787/next.html" });
  assert.equal(r.waited, true);
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths(), [["assign", "Google Chrome", "http://127.0.0.1:8787/next.html"]]);
});

test("navigate on Chrome: a lost reply on a page that still reports loading does not set the tab's url", () => {
  install(away({ ...fixture(), loadTicks: 3 }));
  world.state.commitMs = 60;
  world.state.dropAfterAssign = true;
  const r = navWith({ url: "http://127.0.0.1:8787/next.html" });
  assert.equal(r.waited, true);
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths(), [["assign", "Google Chrome", "http://127.0.0.1:8787/next.html"]]);
});

test("navigate on Chrome: a retry that reaches the document it stamped does not start the load again", () => {
  install(away({ ...fixture(), loadTicks: 3 }));
  world.state.commitMs = 5000;
  world.state.dropAfterAssign = true;
  const r = navWith({ url: "http://127.0.0.1:8787/next.html" });
  assert.equal(r.waited, true);
  assert.deepEqual(paths(), [["assign", "Google Chrome", "http://127.0.0.1:8787/next.html"]]);
});

// A lost reply only counts as a started load when the tab wasn't already busy:
// a load still committing from an earlier navigate also shows as loading and
// replaces the stamped document. The retried stamp then starts the load.
test("navigate on Chrome: a lost reply while an earlier load commits still loads the url from page JS", () => {
  install(away(fixture()));
  world.state.commitMs = 20000;
  assert.equal(navWith({ url: "https://other.test/" }).waited, false);
  world.state.commitMs = 60;
  world.state.dropWhilePending = true;
  const r = navWith({ url: "https://want.test/" });
  assert.equal(world.page("Google Chrome", 0, 0).location.href, "https://want.test/");
  assert.equal(r.waited, true);
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths().slice(1), [["assign", "Google Chrome", "https://want.test/"]]);
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

// A fresh document at the URL the tab already showed is the page reloading
// itself, not the load navigate asked for; the retried stamp starts it.
test("navigate on Chrome: a lost reply after the page reloaded itself loads the url from page JS", () => {
  install(away(fixture()));
  world.state.commitMs = 60;
  world.state.dropAfterAssign = true;
  const loc = world.page("Google Chrome", 0, 0).location;
  const assign = loc.assign;
  loc.assign = () => assign(loc.href);
  const r = navWith({ url: "https://next.test/" });
  assert.equal(world.counts["tab.url="], undefined);
  assert.equal(r.warning, undefined);
  assert.equal(world.page("Google Chrome", 0, 0).location.href, "https://next.test/");
});

const arc = (windows) => ({ name: "Arc", kind: "arc", windows });
const arcFixture = () => ({
  browsers: [arc([{ id: "A", active: 0, tabs: [{ url: "https://a0.test/", id: "a0" }, { url: "https://a1.test/", id: "a1" }, { url: "arc://newtab", id: "a2" }] }])],
  cg: [{ owner: "Finder", pid: 50 }, { owner: "Arc" }],
});
const arcNavigate = (i, extra) => world.run(`__perch.navigate(${JSON.stringify({ target: { app: "Arc", tabIndex: i }, url: "https://next.test/", timeout: NAV_TIMEOUT, ...extra })})`);

test("navigate on Arc: the shown tab loads from page JS", () => {
  install(arcFixture());
  const r = arcNavigate(0);
  assert.equal(r.waited, true);
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths(), [["assign", "Arc", "https://next.test/"]]);
});

test("navigate on Arc: a background tab, where page JS hangs, is refused without raise:true", () => {
  install(arcFixture());
  assert.throws(() => arcNavigate(1), (e) => /^tab_not_visible: /.test(e.message) && OPT_IN.test(e.message));
  assert.equal(world.counts["tab.url="], undefined);
  assert.equal(world.counts["tab.execute"] || 0, 0);
  const r = arcNavigate(1, { raise: true });
  assert.equal(r.waited, false);
  assert.equal(r.warning, RAISE);
  assert.deepEqual(paths(), [["navigate", "Arc", "https://next.test/"]]);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("navigate on Arc: its own new-tab page is refused without raise:true", () => {
  install(arcFixture());
  world.winSpec("Arc", 0).active = 2;
  assert.throws(() => arcNavigate(2), (e) => /^tab_not_visible: /.test(e.message));
  assert.equal(world.counts["tab.url="], undefined);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

// Live on Safari (macOS 27.2), a url set on a tab behind another app loaded it
// in place without changing the frontmost app, so Safari keeps its fallback.
test("navigate on Safari: loads from page JS, and a fallback carries no Chromium warning", () => {
  install(away(safariFixture()));
  const nav = (i) => world.run(`__perch.navigate(${JSON.stringify({ target: { app: "Safari", tabIndex: i }, url: "https://next.test/", timeout: NAV_TIMEOUT })})`);
  assert.equal(nav(0).warning, undefined);
  assert.deepEqual(paths(), [["assign", "Safari", "https://next.test/"]]);
  world.state.safariCurrentOnly = true;
  const r = nav(1);
  assert.equal(r.warning, undefined);
  assert.deepEqual(paths().slice(1), [["navigate", "Safari", "https://next.test/"]]);
  assert.equal(world.winSpec("Safari", 0).active, 0);
});
