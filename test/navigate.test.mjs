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
