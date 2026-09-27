// new_tab never changes which tab a window shows: a browser that switches to the
// tab it just made gets its previous tab back. A window raise it cannot undo
// without activating an app is reported as a warning, never hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const chrome = (windows, extra = {}) => ({ name: "Google Chrome", kind: "chrome", windows, ...extra });
const arc = (windows, extra = {}) => ({ name: "Arc", kind: "arc", windows, ...extra });
const safari = (windows, extra = {}) => ({ name: "Safari", kind: "safari", windows, ...extra });
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
const shown = (app) => world.tabsOf(app, 0)[world.winSpec(app, 0).active]?.spec.id;
const noActivate = () => assert.deepEqual(world.log.filter(([k]) => k === "activate"), []);

const cases = [
  ["Chrome", chrome, "Google Chrome", "t1", "win.activeTabIndex="],
  ["Arc", arc, "Arc", "t1", "tab.select"],
  ["Safari", safari, "Safari", "t1", "win.currentTab="],
];

for (const [label, make, app, prev, setter] of cases) {
  test(`new_tab puts back the ${label} tab its window showed when the browser selects the new one`, async () => {
    install({ browsers: [make([{ id: 1, active: 1, tabs: tabs(3) }], { selectOnCreate: true })], cg: [{ owner: "Terminal" }, { owner: app }] });
    const { r, o } = await call("new_tab", { app, url: "about:blank" });
    assert.equal(r.isError, undefined, JSON.stringify(o));
    assert.equal(world.tabsOf(app, 0).length, 4, "the tab was made");
    assert.equal(shown(app), prev, "the window still shows the tab it showed before");
    assert.equal(world.counts[setter], 1);
    assert.equal(o.warning, undefined);
    noActivate();
  });

  test(`new_tab leaves the ${label} shown tab alone when the browser keeps it`, async () => {
    install({ browsers: [make([{ id: 1, active: 1, tabs: tabs(3) }])], cg: [{ owner: "Terminal" }, { owner: app }] });
    const { r } = await call("new_tab", { app, url: "https://n.test/" });
    assert.equal(r.isError, undefined);
    assert.equal(shown(app), prev);
    assert.equal(world.counts[setter], undefined, "no selection is sent when nothing moved");
    noActivate();
  });

  test(`new_tab reports a window raise it could not prevent (${label})`, async () => {
    install({ browsers: [make([{ id: 1, active: 0, tabs: tabs(2) }], { selectOnCreate: true, raiseOnCreate: true })], cg: [{ owner: "Terminal" }, { owner: app }] });
    const { o } = await call("new_tab", { app, url: "about:blank" });
    assert.equal(o.warning, "creating the tab brought the browser to the front");
    assert.equal(shown(app), "t0");
    noActivate();
  });
}

test("new_tab adds no warning when the browser was already in front", async () => {
  install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2) }], { raiseOnCreate: true })], cg: [{ owner: "Google Chrome" }, { owner: "Terminal" }] });
  const { o } = await call("new_tab", { url: "about:blank" });
  assert.deepEqual(o, { app: "Google Chrome", tabId: "chrome:new2" });
});

test("new_tab in an Arc window that shows no tab creates the tab and selects nothing", async () => {
  install({ browsers: [arc([{ id: "A", active: null, tabs: tabs(1, "a") }])], cg: [{ owner: "Terminal" }, { owner: "Arc" }] });
  const { r, o } = await call("new_tab", { app: "Arc", url: "https://n.test/" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.tabId, "arc:new1");
  assert.equal(world.counts["tab.select"], undefined);
});
