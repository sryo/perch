// A locked screen or a sleeping display hides every window from the window
// server: screenshots find nothing and trusted input can't measure the page.
// Those failures name the cause (live: the lock shows as CGSSessionScreenIsLocked
// in the IO registry's IOConsoleUsers, the sleep as CGDisplayIsAsleep), and a trusted click
// stops waiting for a page that cannot show.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, deps } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const saved = { fast: DAEMONS.fast, slow: DAEMONS.slow, exec: deps.exec };
afterEach(() => { Object.assign(DAEMONS, { fast: saved.fast, slow: saved.slow }); Object.assign(deps, { exec: saved.exec }); });

function install(spec, state = {}) {
  const world = makeWorld(spec);
  Object.assign(world.state, state);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
// The only browser window is not on screen, as in a locked, sleeping session.
const offscreen = (state) => install({
  browsers: [{ name: "Google Chrome Canary", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: [{ url: "https://a.test/", id: "t0" }] }] }],
  cg: [],
}, state);
const shot = async () => (await handleCall("screenshot", {})).content[0].text;
const BASE = "error: window_offscreen: the browser window isn't on screen (minimized or on another Space)";

test("a screenshot that fails says the screen is locked, from the IO registry's console-session key", async () => {
  const world = offscreen({ locked: true });
  assert.equal(await shot(), BASE + "; the screen is locked");
  assert.equal(world.state.screenReads, 2, "one read of the IO registry, one of the display");
});

test("a screenshot that fails says the display is asleep, from CGDisplayIsAsleep", async () => {
  offscreen({ displayAsleep: true });
  assert.equal(await shot(), BASE + "; the display is asleep");
});

test("locked and asleep are both said", async () => {
  offscreen({ displayAsleep: true, locked: true });
  assert.equal(await shot(), BASE + "; the screen is locked and the display is asleep");
});

test("neither locked nor asleep: the error is unchanged", async () => {
  offscreen();
  assert.equal(await shot(), BASE);
});

test("an IO registry that can't be read leaves the error as it was", async () => {
  offscreen({ locked: true, unbound: ["IORegistryGetRootEntry"] });
  assert.equal(await shot(), BASE);
});

test("a call that succeeds never reads the screen state", async () => {
  const world = install({
    browsers: [{ name: "Google Chrome Canary", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: [{ url: "https://a.test/", id: "t0" }] }] }],
    cg: [{ owner: "Google Chrome Canary", pid: 4242, wid: 77, x: 10, y: 0, w: 800, h: 620 }],
  }, { helper: {}, locked: true });
  const r = await handleCall("list_tabs", {});
  assert.equal(r.isError, undefined);
  assert.equal(world.state.screenReads, undefined);
});

// A trusted click polls the page's visibility up to 20 times at 50ms.
const METRICS = { screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 };
function hiddenTab(state) {
  const dom = page(`<button id=b>Go</button>`);
  for (const [k, v] of Object.entries(METRICS)) Object.defineProperty(dom, k, { value: v, configurable: true });
  Object.defineProperty(dom.document, "visibilityState", { value: "hidden", configurable: true });
  return install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 798, h: 500 }] } }],
  }, state);
}
const click = async () => JSON.parse((await handleCall("click", { trusted: true, raise: true, selector: "#b", target: { tabIndex: 1 } })).content[0].text);

test("a trusted click on a hidden page behind a locked screen says so", async () => {
  hiddenTab({ locked: true });
  const o = await click();
  assert.equal(o.ok, false);
  assert.equal(o.error, "tab never became visible to measure; the screen is locked");
});

test("a trusted click stops waiting once the display is asleep, instead of polling for a second", async () => {
  const world = hiddenTab({ displayAsleep: true });
  const t0 = world.clock.t;
  const o = await click();
  assert.equal(o.error, "tab never became visible to measure; the display is asleep");
  assert.ok(world.clock.t - t0 < 300, `waited ${world.clock.t - t0}ms`);
});
