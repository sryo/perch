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

test("navigate on Arc: a background tab with its window already in front has its url set without raise:true", () => {
  install({ ...arcFixture(), cg: [{ owner: "Arc" }] });
  const r = arcNavigate(1);
  assert.equal(r.warning, RAISE);
  assert.deepEqual(paths(), [["navigate", "Arc", "https://next.test/"]]);
});

test("navigate on Chrome: the browser in front is not enough when the tab's window is behind another of its windows", () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "https://front.test/", id: 5 }] }, { id: 2, active: 0, tabs: [{ url: "chrome://newtab/", id: 7 }] }])],
    cg: [{ owner: "Google Chrome" }],
  });
  assert.throws(() => navWith({ url: "https://next.test/", target: { tabId: "chrome:7" } }), (e) => /^tab_not_scriptable: /.test(e.message));
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
  const r = navWith({ url: "https://next.test/" });
  assert.equal(r.warning, RAISE);
  assert.ok(world.clock.t - t0 <= NAV_TIMEOUT + 200, `took ${world.clock.t - t0}ms`);
  assert.deepEqual(paths(), [["navigate", "Google Chrome", "https://next.test/"]]);
});

// The window order is read again right before the url is set.
test("navigate on Chrome: a url set from outside the page, refused because its window left the front, says so", () => {
  install({
    browsers: [chrome([{ id: 1, active: 0, tabs: [{ url: "chrome://newtab/", id: 5 }] }, { id: 2, active: 0, tabs: [{ url: "https://other.test/", id: 7 }] }])],
    cg: [{ owner: "Google Chrome" }],
  });
  const tab = world.tabsOf("Google Chrome", 0)[0];
  const loading = Object.getOwnPropertyDescriptor(tab, "loading");
  Object.defineProperty(tab, "loading", { configurable: true, get() { world.apps["Google Chrome"].windows[1].index = 1; return loading.get.call(tab); } });
  assert.throws(() => navWith({ url: "https://next.test/", target: { tabId: "chrome:5" } }),
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
  install(away(newTabFixture()));
  const res = await handleCall("navigate", { url: "https://next.test/" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^error: tab_not_scriptable: .*raise:true/);
  assert.equal(world.counts["tab.url="], undefined);
  const o = JSON.parse((await handleCall("navigate", { url: "https://next.test/", raise: true })).content[0].text);
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

// Goal 2: the result names the URL the tab committed, not the one asked for.
const navTool = async (args) => {
  const res = await handleCall("navigate", args);
  return { res, o: JSON.parse(res.content[0].text) };
};
const redirectTo = (final) => {
  const loc = world.page("Google Chrome", 0, 0).location;
  const assign = loc.assign;
  loc.assign = () => assign(final);
};

test("navigate tool: a redirect reports the committed url and the one requested", async () => {
  install(fixture());
  world.state.commitMs = 60;
  redirectTo("https://a.test/login");
  const { o } = await navTool({ url: "https://a.test/apply" });
  assert.deepEqual(o, { ok: true, url: "https://a.test/login", requested: "https://a.test/apply", waited: true, tabId: "chrome:7" });
});

test("navigate tool: a url committed as asked, up to spelling, carries no requested key", async () => {
  install(fixture());
  world.state.commitMs = 60;
  redirectTo("https://next.test/");
  const { o } = await navTool({ url: "https://NEXT.test" });
  assert.deepEqual(o, { ok: true, url: "https://next.test/", waited: true, tabId: "chrome:7" });
});

test("navigate tool: the browser's network error page is load_failed naming the url, not ok", async () => {
  install(fixture());
  world.state.commitMs = 60;
  world.state.errorPage = /^http:\/\/127\.0\.0\.1:9\//;
  const { res, o } = await navTool({ url: "http://127.0.0.1:9/" });
  assert.equal(res.isError, undefined);
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: http:\/\/127\.0\.0\.1:9\/ /);
  assert.equal(o.tabId, "chrome:7");
  assert.equal(o.url, undefined);
});

test("navigate tool: a load that never leaves the old page is load_failed, loaded once", async () => {
  install(fixture());
  world.page("Google Chrome", 0, 0).location.assign = (u) => { world.log.push(["assign", "Google Chrome", u]); };
  const { o } = await navTool({ url: "https://next.test/" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: the tab stayed on http:\/\/127\.0\.0\.1:8787\/fixture\.html/);
  assert.deepEqual(paths(), [["assign", "Google Chrome", "https://next.test/"]]);
  assert.equal(world.counts["tab.url="], undefined);
});

// A download or 204 never replaces the document. It is never fetched a second
// time from outside the page, and the tab still shows the old page.
test("navigate tool: a download leaves the tab on its page, reported as such and fetched once", async () => {
  install(fixture());
  world.state.noContent = /\.zip$/;
  const { o } = await navTool({ url: "https://next.test/file.zip" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: the tab stayed on .*download/);
  assert.deepEqual(paths(), [["assign", "Google Chrome", "https://next.test/file.zip"]]);
  assert.equal(world.counts["tab.url="], undefined);
});

test("navigate tool: a reload that settles on the same url and a #hash move stay ok", async () => {
  install(fixture());
  world.page("Google Chrome", 0, 0).location.assign = () => {};
  let { o } = await navTool({ url: "http://127.0.0.1:8787/fixture.html" });
  assert.deepEqual(o, { ok: true, url: "http://127.0.0.1:8787/fixture.html", waited: false, tabId: "chrome:7" });
  install(fixture());
  ({ o } = await navTool({ url: "http://127.0.0.1:8787/fixture.html#sec" }));
  assert.deepEqual(o, { ok: true, url: "http://127.0.0.1:8787/fixture.html#sec", waited: true, tabId: "chrome:7" });
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
  assert.equal(r.waited, true);
  assert.equal(r.warning, RAISE);
  assert.deepEqual(paths(), [["navigate", "Arc", "https://next.test/"]]);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

// A raised background Arc tab runs no page JS (execute hangs there), so its load
// is followed through the tab's own url and loading reads.
const arcBg = (extra) => handleCall("navigate", { url: "https://next.test/", raise: true, target: { tabId: "arc:a1" }, ...extra }).then((res) => JSON.parse(res.content[0].text));

test("navigate tool on Arc: a raised background tab reports the url it settled on, and the one requested", async () => {
  install(arcFixture());
  world.state.redirects = { "https://next.test/": "https://final.test/" };
  const o = await arcBg();
  assert.equal(o.ok, true);
  assert.equal(o.url, "https://final.test/");
  assert.equal(o.requested, "https://next.test/");
  assert.equal(o.waited, true);
  assert.equal(world.counts["tab.execute"] || 0, 0);
  assert.equal(world.winSpec("Arc", 0).active, 0);
});

test("navigate tool on Arc: a raised background tab whose url never moves is load_failed", async () => {
  install(arcFixture());
  world.state.noContent = /next\.test/;
  const o = await arcBg();
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: the tab stayed on https:\/\/a1\.test\//);
  assert.equal(o.tabId, "arc:a1");
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("navigate tool on Arc: a raised background tab whose url can't be read is ok, unwaited", async () => {
  install(arcFixture());
  world.tabsOf("Arc", 0)[1].slow = { throws: Infinity, reads: Infinity, target: null };
  const o = await arcBg();
  assert.equal(o.ok, true);
  assert.equal(o.url, "https://next.test/");
  assert.equal(o.waited, false);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("navigate tool on Arc: a raised background tab still loading its old url at the deadline is a coded timeout", async () => {
  install(arcFixture());
  world.state.commitMs = 1e9;
  world.tabsOf("Arc", 0)[1].shownUrl = () => "https://a1.test/";
  const o = await arcBg();
  assert.equal(o.ok, false);
  assert.match(o.error, /^timeout: https:\/\/next\.test\/ had not committed after 15000ms; the tab shows https:\/\/a1\.test\//);
});

// Chromium shows a pending url while the old document still answers, so a moved
// url alone is not a commit.
test("navigate tool on Arc: a raised background tab that moved but is still loading at the deadline is a coded timeout", async () => {
  install(arcFixture());
  world.state.commitMs = 1e9;
  const o = await arcBg();
  assert.equal(o.ok, false);
  assert.match(o.error, /^timeout: https:\/\/next\.test\/ had not committed after 15000ms; the tab shows https:\/\/next\.test\/; it may still load/);
  assert.equal(o.tabId, "arc:a1");
});

test("navigate tool on Arc: a raised background tab that commits just before the deadline is ok, waited", async () => {
  install(arcFixture());
  world.state.commitMs = NAV_TIMEOUT - 200;
  const o = await arcBg();
  assert.equal(o.ok, true);
  assert.equal(o.url, "https://next.test/");
  assert.equal(o.waited, true);
});

// `phases(ms, tab)` gets the ms since the call and returns {busy, url}; busy
// "throw" makes the loading read fail.
const arcScripted = (phases) => {
  const tab = world.tabsOf("Arc", 0)[1], t0 = world.clock.t;
  const now = () => phases(world.clock.t - t0, tab);
  Object.defineProperty(tab, "loading", { get: () => () => { const b = now().busy; if (b === "throw") throw new Error("Can't get object."); return b; }, configurable: true });
  tab.shownUrl = () => now().url;
};

test("navigate tool on Arc: a raised background tab whose loading reads all fail is a timeout, never ok", async () => {
  install(arcFixture());
  world.state.commitMs = 1e9;
  arcScripted((ms, tab) => ({ busy: "throw", url: tab.pending ? tab.pending.url : tab.page.url }));
  const o = await arcBg();
  assert.equal(o.ok, false);
  assert.match(o.error, /^timeout: https:\/\/next\.test\/ had not committed after 15000ms; the tab shows https:\/\/next\.test\//);
});

test("navigate tool on Arc: a raised background tab slow to start loading is not taken for a failed load", async () => {
  install(arcFixture());
  world.state.commitMs = 1e9;
  arcScripted((ms) => ms < 500 ? { busy: false, url: "https://a1.test/" } : ms < 1000 ? { busy: true, url: "https://next.test/" } : { busy: false, url: "https://next.test/" });
  const o = await arcBg();
  assert.equal(o.ok, true);
  assert.equal(o.url, "https://next.test/");
  assert.equal(o.waited, true);
});

// Chromium shows a pending url before commit and Arc can read loading false
// before its load starts, so a moved url that reads idle early is not a commit.
test("navigate tool on Arc: a raised background tab whose url moved while loading read false early is ok only after the commit", async () => {
  install(arcFixture());
  world.state.commitMs = 1e9;
  const moved = (tab) => (tab.pending ? tab.pending.url : tab.page.url);
  arcScripted((ms, tab) => ({ busy: ms >= 800 && ms < 1200, url: moved(tab) }));
  const t0 = world.clock.t;
  const o = await arcBg();
  assert.equal(o.ok, true);
  assert.equal(o.url, "https://next.test/");
  assert.equal(o.waited, true);
  assert.ok(world.clock.t - t0 >= 1200, `answered at ${world.clock.t - t0}ms, before the load ended`);
});

test("navigate tool on Arc: a raised background tab whose url moved at once but whose load never ends is a coded timeout", async () => {
  install(arcFixture());
  world.state.commitMs = 1e9;
  arcScripted((ms, tab) => ({ busy: ms >= 800, url: tab.pending ? tab.pending.url : tab.page.url }));
  const o = await arcBg();
  assert.equal(o.ok, false);
  assert.match(o.error, /^timeout: https:\/\/next\.test\/ had not committed after 15000ms; the tab shows https:\/\/next\.test\/; it may still load/);
});

test("navigate tool on Arc: a raised background tab that never starts loading is load_failed soon after the start grace", async () => {
  install(arcFixture());
  world.state.noContent = /next\.test/;
  const t0 = world.clock.t;
  const o = await arcBg();
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: the tab stayed on https:\/\/a1\.test\//);
  assert.ok(world.clock.t - t0 <= 1500 + 150, `took ${world.clock.t - t0}ms`);
});

test("navigate tool on Arc: a tab still on its new-tab page at the deadline is load_failed, not ok", async () => {
  install({ ...arcFixture(), cg: [{ owner: "Arc" }] });
  world.winSpec("Arc", 0).active = 2;
  world.tabsOf("Arc", 0)[2].slow = { throws: 0, reads: Infinity, target: null };
  const o = JSON.parse((await handleCall("navigate", { url: "https://next.test/", target: { tabId: "arc:a2" } })).content[0].text);
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: the tab stayed on arc:\/\/newtab/);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

// Safari has no idle rule (its `loading` is unreliable), so a load that never
// commits is told apart at the deadline by the stamped document still answering.
const safariNav = async (args) => {
  const tabId = JSON.parse((await handleCall("list_tabs", {})).content[0].text).tabs[1].tabId;
  world.reset();
  return JSON.parse((await handleCall("navigate", { target: { tabId }, ...args })).content[0].text);
};

test("navigate tool on Safari: its error page is load_failed naming the url, loaded once", async () => {
  install(away(safariFixture()));
  world.state.errorPage = /perch-nx\.invalid/;
  world.state.errorHref = "safari-resource:/ErrorPage.html";
  const o = await safariNav({ url: "http://perch-nx.invalid/" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: http:\/\/perch-nx\.invalid\/ did not load/);
  assert.equal(paths().length, 1);
});

test("navigate tool on Safari: a load that never leaves the old page is load_failed at the deadline", async () => {
  install(away(safariFixture()));
  world.state.noContent = /\.zip$/;
  const t0 = world.clock.t;
  const o = await safariNav({ url: "https://next.test/file.zip" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: the tab stayed on https:\/\/bg\.test\//);
  assert.ok(world.clock.t - t0 <= NAV_TIMEOUT + 200, `took ${world.clock.t - t0}ms`);
  assert.equal(paths().length, 1);
});

test("navigate tool on Safari: a url shown while the old document still answers is a coded timeout", async () => {
  install(away(safariFixture()));
  world.state.commitMs = 1e9;
  const o = await safariNav({ url: "https://next.test/" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^timeout: https:\/\/next\.test\/ had not committed after 15000ms; the tab shows https:\/\/next\.test\//);
  assert.ok(o.tabId);
});

test("navigate tool on Safari: a new document still loading at the deadline stays ok, unwaited", async () => {
  install(away({ ...safariFixture(), loadTicks: 1e9 }));
  const o = await safariNav({ url: "https://next.test/" });
  assert.equal(o.ok, true);
  assert.equal(o.url, "https://next.test/");
  assert.equal(o.waited, false);
});

test("navigate tool on Chrome: a new document still loading at the deadline stays ok, unwaited", async () => {
  install({ ...fixture(), loadTicks: 1e9 });
  const { o } = await navTool({ url: "https://next.test/" });
  assert.deepEqual(o, { ok: true, url: "https://next.test/", waited: false, tabId: "chrome:7" });
});

test("navigate tool on Chrome: a redirect read once loading settles, with no check answered, reports the committed url", async () => {
  install(fixture());
  world.state.redirects = { "https://a.test/apply": "https://a.test/login" };
  let n = 0;
  world.state.onExecute = () => { if (++n === 2) world.state.hung = true; };
  const { o } = await navTool({ url: "https://a.test/apply" });
  assert.equal(o.ok, true);
  assert.equal(o.url, "https://a.test/login");
  assert.equal(o.requested, "https://a.test/apply");
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

// Chromium's tab url shows a page-started load's pending url while the old
// document keeps answering.
test("navigate tool on Chrome: a page-started load still pending at the deadline is a coded timeout", async () => {
  install(fixture());
  world.state.commitMs = 1e9;
  const { o } = await navTool({ url: "https://next.test/" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^timeout: https:\/\/next\.test\/ had not committed after 15000ms; the tab shows https:\/\/next\.test\/; it may still load, check before retrying/);
  assert.equal(o.tabId, "chrome:7");
});

test("navigate tool on Chrome: a 204 that settles only at the deadline is load_failed", async () => {
  install(fixture());
  world.state.noContent = /next\.test/;
  const tab = world.tabsOf("Google Chrome", 0)[0];
  const t0 = world.clock.t;
  Object.defineProperty(tab, "loading", { get: () => () => world.clock.t < t0 + NAV_TIMEOUT, configurable: true });
  const { o } = await navTool({ url: "https://next.test/" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: the tab stayed on http:\/\/127\.0\.0\.1:8787\/fixture\.html/);
});

// The new document committed, but no check after the commit got a reply, so the
// last answer came from the old one.
test("navigate tool on Chrome: a load that committed with every later check unanswered is ok, unwaited", async () => {
  install(fixture());
  world.state.loadTicks = 1e9;
  world.state.commitMs = 4000;
  const t0 = world.clock.t;
  world.state.onExecute = () => { if (world.clock.t >= t0 + 4000) world.state.hung = true; };
  const { o } = await navTool({ url: "https://next.test/" });
  assert.deepEqual(o, { ok: true, url: "https://next.test/", waited: false, tabId: "chrome:7" });
});

test("navigate tool on Chrome: a load that committed and answers only after the deadline is ok, unwaited", async () => {
  install(fixture());
  world.state.loadTicks = 1e9;
  world.state.commitMs = 4000;
  const t0 = world.clock.t;
  world.state.onExecute = () => { world.state.hung = world.clock.t >= t0 + 4000 && world.clock.t < t0 + NAV_TIMEOUT; };
  const { o } = await navTool({ url: "https://next.test/" });
  assert.deepEqual(o, { ok: true, url: "https://next.test/", waited: false, tabId: "chrome:7" });
});

// A page that runs no page JS after the load (an error page Chrome won't script)
// gives the loop no answer, so loading settling on a moved url proves no commit.
// The idle exit asks the page once more, bounded, before claiming a wait.
const silentAfterStamp = (answer) => {
  let n = 0, urlReads = 0;
  world.state.onExecute = (spec) => {
    if (++n !== 1) return;
    urlReads = world.counts["tab.url"] || 0;
    spec.dom = { eval: () => ((world.counts["tab.url"] || 0) > urlReads ? answer : undefined) };
  };
};
const executesAfterLastUrlRead = () => {
  const evs = world.aeBy("Google Chrome");
  return evs.slice(evs.lastIndexOf("tab.url") + 1).filter((k) => k === "tab.execute").length;
};

test("navigate on Chrome: loading settled on the asked url with no check answered is one bounded check, not waited", () => {
  install(fixture());
  silentAfterStamp(undefined);
  const r = runtimeNavigate("https://next.test/");
  assert.equal(r.waited, false);
  assert.equal(r.href, "https://next.test/");
  assert.equal(executesAfterLastUrlRead(), 1);
});

test("navigate tool on Chrome: loading settled with no check answered, then an error page, is load_failed", async () => {
  install(fixture());
  silentAfterStamp(JSON.stringify({ done: true, href: "chrome-error://chromewebdata/", old: false, err: true }));
  const { o } = await navTool({ url: "https://next.test/" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^load_failed: https:\/\/next\.test\/ did not load/);
  assert.equal(executesAfterLastUrlRead(), 1);
});

test("navigate tool on Chrome: loading settled on a moved url while the stamped document still answers is a coded timeout", async () => {
  install(fixture());
  world.state.commitMs = 1e9;
  const tab = world.tabsOf("Google Chrome", 0)[0];
  Object.defineProperty(tab, "loading", { get: () => () => false, configurable: true });
  const t0 = world.clock.t;
  const { o } = await navTool({ url: "https://next.test/" });
  assert.equal(o.ok, false);
  const ms = world.clock.t - t0;
  assert.ok(ms < 2000, `took ${ms}ms`);
  const m = /^timeout: https:\/\/next\.test\/ had not committed after (\d+)ms; the tab shows https:\/\/next\.test\//.exec(o.error);
  assert.ok(m, o.error);
  assert.ok(Number(m[1]) <= ms, "the reported wait is the time spent");
});
