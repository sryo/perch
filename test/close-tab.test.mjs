// close_tab closes exactly the tab a handle names, never by default, never the
// last tab of a window, and never selects, raises or activates anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const chrome = (windows) => ({ name: "Google Chrome", kind: "chrome", windows });
const safari = (windows) => ({ name: "Safari", kind: "safari", windows });
const arc = (windows) => ({ name: "Arc", kind: "arc", windows });
const tabs = (n, p = "t") => Array.from({ length: n }, (_, i) => ({ url: `https://${p}${i}.test/`, title: `${p}${i}`, id: `${p}${i}` }));

let world;
function install(spec) {
  world = makeWorld(spec);
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
const handleFor = async (app, url) => (await call("list_tabs", { app, urlContains: url })).o.tabs[0].tabId;
const urls = (app, w = 0) => world.tabsOf(app, w).map((t) => t.shownUrl());
const noFocus = () => {
  assert.deepEqual(world.log.filter(([k]) => k === "activate"), []);
  for (const k of ["tab.select", "win.activeTabIndex=", "win.currentTab=", "win.index="]) assert.equal(world.counts[k], undefined, k);
};

// Same accounting as perf-budget.test.mjs: specifiers, Application(), CGWindowList
// and running() are not Apple Events.
const NOT_AE = /^(win\.tabs|tabs\.byId|win\.activeTab|windows\[\d+\]\(.*\)|Application\(.*\)|running\(.*\)|deepUnwrap|CGWindowList)$/;
const appleEvents = () => Object.entries(world.counts).filter(([k]) => !NOT_AE.test(k)).reduce((s, [, n]) => s + n, 0);
const breakdown = () => JSON.stringify(Object.fromEntries(Object.entries(world.counts).filter(([k]) => !NOT_AE.test(k))));

for (const [label, make, app] of [["Chrome", chrome, "Google Chrome"], ["Arc", arc, "Arc"], ["Safari", safari, "Safari"]]) {
  test(`close_tab closes the handle's ${label} tab and keeps the shown tab shown`, async () => {
    install({ browsers: [make([{ id: 1, active: 0, tabs: tabs(3) }])], cg: [{ owner: "Finder" }, { owner: app }] });
    const h = await handleFor(app, "t1.test");
    world.reset();
    const { r, o } = await call("close_tab", { tabId: h });
    assert.equal(r.isError, undefined, JSON.stringify(o));
    assert.deepEqual(o, { ok: true, closed: h });
    assert.deepEqual(urls(app), ["https://t0.test/", "https://t2.test/"]);
    assert.equal(world.winSpec(app, 0).active, 0, "the window still shows t0");
    assert.deepEqual(world.log.filter(([k]) => k === "close"), [["close", app, "t1"]]);
    noFocus();
  });

  test(`close_tab refuses a window's last ${label} tab and closes nothing`, async () => {
    install({ browsers: [make([{ id: 1, active: 0, tabs: tabs(1) }])], cg: [{ owner: app }] });
    const h = await handleFor(app, "t0.test");
    const { r, o } = await call("close_tab", { tabId: h });
    assert.notEqual(r.isError, true);
    assert.deepEqual(o, { ok: false, error: "last tab in its window; closing it would close the window" });
    assert.equal(world.counts["tab.close"], undefined);
    assert.deepEqual(urls(app), ["https://t0.test/"]);
  });

  test(`close_tab on a closed ${label} tab's handle is stale_tab`, async () => {
    install({ browsers: [make([{ id: 1, active: 0, tabs: tabs(3) }])], cg: [{ owner: app }] });
    const h = await handleFor(app, "t2.test");
    assert.equal((await call("close_tab", { tabId: h })).o.ok, true);
    const { r, t } = await call("close_tab", { tabId: h });
    assert.equal(r.isError, true);
    assert.match(t, /^error: stale_tab/);
    assert.equal(world.counts["tab.close"], 1, "the second call closed nothing");
    assert.deepEqual(urls(app), ["https://t0.test/", "https://t1.test/"]);
  });
}

test("close_tab can close the tab a window shows; the browser picks what shows next", async () => {
  install({ browsers: [chrome([{ id: 1, active: 1, tabs: tabs(3) }])], cg: [{ owner: "Google Chrome" }] });
  const h = await handleFor("Google Chrome", "t1.test");
  world.reset();
  assert.equal((await call("close_tab", { tabId: h })).o.ok, true);
  assert.deepEqual(urls("Google Chrome"), ["https://t0.test/", "https://t2.test/"]);
  noFocus();
});

test("close_tab closes in the handle's window, not in another window of the same browser", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2, "a") }, { id: 2, active: 0, tabs: tabs(2, "b") }])], cg: [{ owner: "Google Chrome" }] });
  const h = await handleFor("Google Chrome", "b1.test");
  assert.equal((await call("close_tab", { tabId: h })).o.ok, true);
  assert.deepEqual(urls("Google Chrome", 0), ["https://a0.test/", "https://a1.test/"]);
  assert.deepEqual(urls("Google Chrome", 1), ["https://b0.test/"]);
});

test("close_tab requires an explicit tabId and never falls back to the active tab", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(3) }])], cg: [{ owner: "Google Chrome" }] });
  for (const args of [{}, { tabId: "" }, { tabId: 7 }, { target: { tabId: "chrome:t0" } }]) {
    const { r, t } = await call("close_tab", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(t, /close_tab requires `tabId`/);
  }
  assert.equal(world.counts["tab.close"], undefined);
  assert.equal(urls("Google Chrome").length, 3);
});

test("the runtime refuses a close with no target, so a default target can't leak in", () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(3) }])], cg: [{ owner: "Google Chrome" }] });
  assert.throws(() => world.run("__perch.closeTab({})"), /close_tab requires `tabId`/);
  assert.equal(world.counts["tab.close"], undefined);
});

test("close_tab on a Chrome handle from list_tabs is three Apple Events", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(3, "x") }, { id: 2, active: 0, tabs: tabs(4) }])], cg: [{ owner: "Google Chrome" }] });
  const h = await handleFor("Google Chrome", "t2.test");
  world.reset();
  assert.equal((await call("close_tab", { tabId: h })).o.ok, true);
  // tabs.id() to find the hinted tab, tabs.length for the last-tab guard, close.
  assert.equal(appleEvents(), 3, breakdown());
});

test("close_tab on a Safari handle from list_tabs is three Apple Events", async () => {
  install({ browsers: [safari([{ id: 5, active: 0, tabs: tabs(2, "x") }, { id: 3, active: 0, tabs: tabs(3) }])], cg: [{ owner: "Safari" }] });
  const h = await handleFor("Safari", "t1.test");
  world.reset();
  assert.equal((await call("close_tab", { tabId: h })).o.ok, true);
  assert.deepEqual(urls("Safari", 1), ["https://t0.test/", "https://t2.test/"]);
  // tabs.url() in the recorded window, tabs.length, close.
  assert.equal(appleEvents(), 3, breakdown());
});
