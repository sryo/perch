// new_tab never sets a Chromium tab's url from outside the page when the page can
// load it itself: a url set through AppleScript raises the browser's windows, a
// page-started load does not. The tab is made on about:blank and its page loads
// the url; only when that page can't (JS from Apple Events off, a file: url) does
// new_tab set the url, and a raise that causes is reported, never hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const tabs = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://t${i}.test/`, title: `t${i}`, id: `t${i}` }));
const browser = (name, kind, extra = {}) => ({ name, kind, windows: [{ id: 1, active: 1, tabs: tabs(3) }], ...extra });

let world;
function install(b, state = {}) {
  world = makeWorld({ browsers: [b], cg: [{ owner: "Terminal" }, { owner: b.name }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  Object.assign(world.state, state);
}
const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  return { r, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
const loads = () => world.log.filter(([k]) => k === "newTab" || k === "navigate" || k === "assign").map(([k, , u]) => [k, u]);
const front = () => world.cg[0].owner;
const shown = (app) => world.tabsOf(app, 0)[world.winSpec(app, 0).active]?.spec.id;
const noActivate = () => assert.deepEqual(world.log.filter(([k]) => k === "activate"), []);

for (const name of ["Google Chrome", "Google Chrome Canary"]) {
  test(`new_tab in ${name} loads an http(s) url from the page and keeps the browser behind`, async () => {
    install(browser(name, "chrome", { raiseOnUrl: true, selectOnCreate: true }));
    const { r, o } = await call("new_tab", { app: name, url: "https://n.test/x" });
    assert.equal(r.isError, undefined, JSON.stringify(o));
    assert.deepEqual(loads(), [["newTab", "about:blank"], ["assign", "https://n.test/x"]]);
    assert.equal(o.warning, undefined);
    assert.equal(front(), "Terminal");
    assert.equal(shown(name), "t1");
    assert.equal(world.tabsOf(name, 0)[3].shownUrl(), "https://n.test/x");
    noActivate();
  });
}

test("new_tab about:blank in Chrome makes the tab and loads nothing more", async () => {
  install(browser("Google Chrome", "chrome", { raiseOnUrl: true }));
  const { o } = await call("new_tab", { app: "Google Chrome", url: "about:blank" });
  assert.deepEqual(loads(), [["newTab", "about:blank"]]);
  assert.equal(o.warning, undefined);
});

test("new_tab sets the url from outside when Chrome's page can't load it, and reports the raise", async () => {
  install(browser("Google Chrome", "chrome", { raiseOnUrl: true }), { jsOff: true });
  const { r, o } = await call("new_tab", { app: "Google Chrome", url: "https://n.test/x" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.deepEqual(loads(), [["newTab", "about:blank"], ["navigate", "https://n.test/x"]]);
  assert.equal(o.warning, "creating the tab brought the browser to the front");
  noActivate();
});

test("new_tab gives a file: url to Chrome directly, since about:blank can't load it", async () => {
  install(browser("Google Chrome", "chrome"));
  const { r } = await call("new_tab", { app: "Google Chrome", url: "file:///tmp/p.html" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(loads(), [["newTab", "file:///tmp/p.html"]]);
});

test("new_tab gives Safari its url directly", async () => {
  install(browser("Safari", "safari"));
  await call("new_tab", { app: "Safari", url: "https://n.test/x" });
  assert.deepEqual(loads(), [["newTab", "https://n.test/x"]]);
});

test("new_tab gives Arc its url directly (its execute hangs on a background tab)", async () => {
  install(browser("Arc", "arc"));
  await call("new_tab", { app: "Arc", url: "https://n.test/x" });
  assert.deepEqual(loads(), [["newTab", "https://n.test/x"]]);
  assert.equal(world.counts["tab.execute"], undefined);
});

test("new_tab takes a dropped reply after the page started the load as started, and sets nothing", async () => {
  install(browser("Google Chrome", "chrome", { raiseOnUrl: true }), { hangIf: (js) => /location\.replace/.test(js) ? "ran" : false });
  const { o } = await call("new_tab", { app: "Google Chrome", url: "https://n.test/x" });
  assert.deepEqual(loads(), [["newTab", "about:blank"], ["assign", "https://n.test/x"]]);
  assert.equal(o.warning, undefined);
});

test("new_tab sets the url when the page never ran the load, and reports the raise", async () => {
  install(browser("Google Chrome", "chrome", { raiseOnUrl: true }), { hangIf: (js) => /location\.replace/.test(js) });
  const { o } = await call("new_tab", { app: "Google Chrome", url: "https://n.test/x" });
  assert.deepEqual(loads(), [["newTab", "about:blank"], ["navigate", "https://n.test/x"]]);
  assert.equal(o.warning, "creating the tab brought the browser to the front");
});
