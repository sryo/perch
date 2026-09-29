// A Safari handle names its tab by window, index and URL hash, so a tab that is
// gone can look like another tab at the same URL. Across windows a handle
// resolves only to a URL no other tab shows; close_tab never leaves the
// recorded window and refuses any tab it can't single out.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const safari = (windows) => ({ name: "Safari", kind: "safari", windows });
const U = "https://u.test/";
const form = () => page(`<input id="i"><button id="b">Go</button>`);
const at = (id) => ({ url: U, title: "u", id, dom: form() });
const other = (id) => ({ url: `https://${id}.test/`, title: id, id, dom: form() });

let world;
function install(windows) {
  world = makeWorld({ browsers: [safari(windows)], cg: [{ owner: "Safari" }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
}
beforeEach(() => { world = null; });

const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  return { r, t, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
const handleIn = async (winId, url) => (await call("list_tabs", {})).o.tabs.find((t) => t.url === url && t.tabId.startsWith(`safari:${winId}.`)).tabId;
const ids = (w) => world.tabsOf("Safari", w).map((t) => t.spec.id);
const closes = () => world.log.filter(([k]) => k === "close");
// Safari moves a dragged tab to another window; the fake keeps its page.
function dragOut(from, i, to) {
  const [moved] = world.tabsOf("Safari", from).splice(i, 1);
  world.openTab("Safari", to, moved.spec.url);
  world.tabsOf("Safari", to).at(-1).spec.dom = moved.spec.dom;
}
const hits = (w, i) => world.tabsOf("Safari", w)[i].spec.dom.hits ?? 0;
const HIT = "window.hits = (window.hits || 0) + 1; return 1";
const stale = ({ r, t }, what, re = /^error: stale_tab: /) => {
  assert.equal(r.isError, true, `${what}: ${t}`);
  assert.match(t, re, what);
};

test("close_tab on a gone tab's handle refuses the user's tab at the same URL in another window", async () => {
  install([{ id: 3, active: 1, tabs: [at("agent"), other("a1")] }, { id: 4, active: 0, tabs: [at("user"), other("b1")] }]);
  const h = await handleIn(3, U);
  world.tabsOf("Safari", 0).splice(0, 1);
  world.winSpec("Safari", 0).active = 0;
  stale(await call("close_tab", { tabId: h }), "close_tab");
  assert.deepEqual(ids(1), ["user", "b1"]);
  assert.deepEqual(closes(), []);
});

test("a gone tab's handle is stale_tab when several tabs elsewhere show its URL", async () => {
  install([{ id: 3, active: 1, tabs: [at("agent"), other("a1")] }, { id: 4, active: 0, tabs: [at("user1"), other("b1"), at("user2")] }]);
  const h = await handleIn(3, U);
  world.tabsOf("Safari", 0).splice(0, 1);
  world.winSpec("Safari", 0).active = 0;
  stale(await call("eval_js", { script: HIT, target: { tabId: h } }), "eval_js", /^error: stale_tab: .*several tabs/);
  stale(await call("fill", { selector: "#i", text: "x", target: { tabId: h } }), "fill", /several tabs/);
  stale(await call("click", { selector: "#b", target: { tabId: h } }), "click", /several tabs/);
  stale(await call("close_tab", { tabId: h }), "close_tab");
  assert.deepEqual(ids(1), ["user1", "b1", "user2"]);
  assert.deepEqual(closes(), []);
  assert.equal(hits(1, 0), 0);
  assert.equal(hits(1, 2), 0);
});

test("a tab dragged out to another window, the only one at its URL, still resolves for page tools", async () => {
  install([{ id: 3, active: 1, tabs: [other("a0"), at("agent")] }, { id: 4, active: 0, tabs: [other("b0")] }]);
  const h = await handleIn(3, U);
  dragOut(0, 1, 1);
  world.winSpec("Safari", 0).active = 0;
  const e = await call("eval_js", { script: HIT, target: { tabId: h } });
  assert.notEqual(e.r.isError, true, e.t);
  assert.equal(hits(1, 1), 1);
  const f = await call("fill", { selector: "#i", text: "hi", target: { tabId: h } });
  assert.notEqual(f.r.isError, true, f.t);
  assert.equal(f.o.ok, true, f.t);
});

test("close_tab still closes the right tab when its index moved but its URL is unique in the window", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), other("a1"), at("agent")] }, { id: 4, active: 0, tabs: [other("b0")] }]);
  const h = await handleIn(3, U);
  world.tabsOf("Safari", 0).splice(0, 1);
  const { r, o } = await call("close_tab", { tabId: h });
  assert.notEqual(r.isError, true, JSON.stringify(o));
  assert.equal(o.ok, true);
  assert.deepEqual(ids(0), ["a1"]);
  assert.deepEqual(closes(), [["close", "Safari", "agent"]]);
});

test("close_tab refuses a tab that now lives only in another window", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), other("a1"), at("agent")] }, { id: 4, active: 0, tabs: [other("b0")] }]);
  const h = await handleIn(3, U);
  dragOut(0, 2, 1);
  world.reset();
  stale(await call("close_tab", { tabId: h }), "close_tab", /no longer in its window/);
  assert.equal(ids(1).length, 2);
  assert.deepEqual(closes(), []);
});

test("close_tab refuses when the recorded index moved and several tabs in the window show the URL", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), other("a2"), at("user")] }]);
  const h = await handleIn(3, U);
  world.tabsOf("Safari", 0).splice(0, 1);
  stale(await call("close_tab", { tabId: h }), "close_tab", /can't tell which tab/);
  assert.deepEqual(ids(0), ["agent", "a2", "user"]);
  assert.deepEqual(closes(), []);
});

test("close_tab closes the tab at the recorded index even when another tab in the window shares its URL", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), at("user")] }]);
  const h = (await call("list_tabs", {})).o.tabs.find((t) => t.url === U).tabId;
  const { o } = await call("close_tab", { tabId: h });
  assert.equal(o.ok, true);
  assert.deepEqual(closes(), [["close", "Safari", "agent"]]);
});

test("page tools keep the nearest same-URL tab in the recorded window when the index drifted", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), other("a2"), at("user")] }]);
  const h = await handleIn(3, U);
  world.tabsOf("Safari", 0).splice(0, 1);
  const { r, t } = await call("eval_js", { script: HIT, target: { tabId: h } });
  assert.notEqual(r.isError, true, t);
  assert.equal(hits(0, 0), 1);
  assert.equal(hits(0, 2), 0);
});
