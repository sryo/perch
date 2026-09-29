// A Safari handle names its tab by window, index and URL hash, so a tab that is
// gone can look like another tab at the same URL. Across windows a handle
// resolves only to a URL no other tab shows; close_tab never leaves the
// recorded window and closes only the tab at the recorded index.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const safari = (windows) => ({ name: "Safari", kind: "safari", windows });
const U = "https://u.test/";
const form = (url) => {
  const w = page(`<input id="i"><button id="b">Go</button>`, { url });
  w.document.getElementById("b").addEventListener("click", () => { w.clicks = (w.clicks || 0) + 1; });
  return w;
};
const at = (id) => ({ url: U, title: "u", id, dom: form(U) });
const other = (id) => ({ url: `https://${id}.test/`, title: id, id, dom: form(`https://${id}.test/`) });

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
const dom = (w, i) => world.tabsOf("Safari", w)[i].spec.dom;
const hits = (w, i) => dom(w, i).hits ?? 0;
// No body ran on the tab: no eval hit, no click, nothing typed.
const untouched = (w, i, what) => {
  assert.equal(hits(w, i), 0, what + ": eval_js");
  assert.equal(dom(w, i).clicks ?? 0, 0, what + ": click");
  assert.equal(dom(w, i).document.getElementById("i").value, "", what + ": fill");
};
// A document perch touched under another handle.
const stampedElsewhere = (w, i) => { dom(w, i).__perch_h = "3.9.other"; };
const NOT_AE = /^(win\.tabs|tabs\.byId|win\.activeTab|windows\[\d+\]\(.*\)|Application\(.*\)|running\(.*\)|deepUnwrap|CGWindowList)$/;
const events = () => Object.entries(world.counts).filter(([k]) => !NOT_AE.test(k)).reduce((s, [, n]) => s + n, 0);
const meta = (r) => JSON.parse(r.content.filter((c) => c.type === "text").at(-1).text);
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
  assert.equal(meta(e.r).tabId, h.replace("safari:3.1.", "safari:4.1."));
  // The old handle still reaches it: the page's stamp names the refreshed one.
  const f = await call("fill", { selector: "#i", text: "hi", target: { tabId: h } });
  assert.notEqual(f.r.isError, true, f.t);
  assert.equal(f.o.ok, true, f.t);
});

test("a tab dragged out to a window whose id can't be read keeps its handle and reports no move", async () => {
  install([{ id: 3, active: 1, tabs: [other("a0"), at("agent")] }, { id: 4, active: 0, tabs: [other("b0")] }]);
  const h = await handleIn(3, U);
  dragOut(0, 1, 1);
  world.winSpec("Safari", 0).active = 0;
  world.winSpec("Safari", 1).idFails = true;
  const e = await call("eval_js", { script: HIT, target: { tabId: h } });
  assert.notEqual(e.r.isError, true, e.t);
  assert.equal(hits(1, 1), 1);
  const m = meta(e.r);
  assert.equal(m.tabId ?? h, h, e.t);
  assert.equal(m.moved, undefined, e.t);
  assert.doesNotMatch(JSON.stringify(e.r.content), /safari:null/);
});

test("close_tab refuses when its index moved, even with its URL unique in the window", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), other("a1"), at("agent")] }, { id: 4, active: 0, tabs: [other("b0")] }]);
  const h = await handleIn(3, U);
  world.tabsOf("Safari", 0).splice(0, 1);
  stale(await call("close_tab", { tabId: h }), "close_tab", /can't tell which tab/);
  assert.deepEqual(ids(0), ["a1", "agent"]);
  assert.deepEqual(closes(), []);
});

test("close_tab on a gone tab's handle refuses the user's tab at the same URL at another index in its window", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), other("a2"), at("user")] }]);
  const h = await handleIn(3, U);
  world.tabsOf("Safari", 0).splice(1, 1);
  stale(await call("close_tab", { tabId: h }), "close_tab", /can't tell which tab/);
  assert.deepEqual(ids(0), ["a0", "a2", "user"]);
  assert.deepEqual(closes(), []);
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

test("page tools keep the same-URL tab carrying their stamp in the recorded window when the index drifted", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), other("a2"), at("user")] }]);
  const h = await handleIn(3, U);
  assert.notEqual((await call("eval_js", { script: "return 1", target: { tabId: h } })).r.isError, true);
  world.tabsOf("Safari", 0).splice(0, 1);
  const { r, t } = await call("eval_js", { script: HIT, target: { tabId: h } });
  assert.notEqual(r.isError, true, t);
  assert.equal(hits(0, 0), 1);
  assert.equal(hits(0, 2), 0);
});

test("an unstamped handle whose index drifted between two same-URL tabs is stale_tab and runs nothing", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), other("a2"), at("user")] }]);
  const h = await handleIn(3, U);
  world.tabsOf("Safari", 0).splice(0, 1);
  stale(await call("eval_js", { script: HIT, target: { tabId: h } }), "eval_js", /can't tell which tab .*several tabs show its URL/);
  untouched(0, 0, "agent");
  untouched(0, 2, "user");
});

for (const [label, mark] of [["unstamped", () => {}], ["stamped by another handle", stampedElsewhere]]) {
  test(`a stamped tab that shifted left runs, not the ${label} same-URL tab now at its recorded index`, async () => {
    install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), at("user")] }]);
    const h = await handleIn(3, U);
    assert.notEqual((await call("eval_js", { script: HIT, target: { tabId: h } })).r.isError, true);
    mark(0, 2);
    world.tabsOf("Safari", 0).splice(0, 1);
    const e = await call("eval_js", { script: HIT, target: { tabId: h } });
    assert.notEqual(e.r.isError, true, e.t);
    assert.equal(hits(0, 0), 2);
    untouched(0, 1, "user");
    const m = meta(e.r);
    assert.equal(m.moved, true);
    assert.equal(m.tabId, h.replace("safari:3.1.", "safari:3.0."));
    assert.match(m.warning, /tab moved; tabId refreshed/);
  });
}

test("a closed tab's handle is stale_tab when two unstamped same-URL tabs remain in its window", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), at("user1"), at("user2")] }]);
  const h = await handleIn(3, U);
  assert.notEqual((await call("eval_js", { script: "return 1", target: { tabId: h } })).r.isError, true);
  world.tabsOf("Safari", 0).splice(1, 1);
  stale(await call("click", { selector: "#b", target: { tabId: h } }), "click", /can't tell which tab .*several tabs show its URL/);
  stale(await call("fill", { selector: "#i", text: "x", target: { tabId: h } }), "fill", /several tabs/);
  stale(await call("eval_js", { script: HIT, target: { tabId: h } }), "eval_js", /several tabs/);
  untouched(0, 1, "user1");
  untouched(0, 2, "user2");
  assert.equal(dom(0, 1).__perch_h, undefined);
  assert.equal(dom(0, 2).__perch_h, undefined);
});

test("a closed tab's handle refuses a same-URL tab stamped by another handle that slid into its index", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), at("user"), other("a3")] }]);
  const h = await handleIn(3, U);
  assert.notEqual((await call("eval_js", { script: "return 1", target: { tabId: h } })).r.isError, true);
  stampedElsewhere(0, 2);
  world.tabsOf("Safari", 0).splice(1, 1);
  stale(await call("eval_js", { script: HIT, target: { tabId: h } }), "eval_js");
  stale(await call("click", { selector: "#b", target: { tabId: h } }), "click");
  stale(await call("fill", { selector: "#i", text: "x", target: { tabId: h } }), "fill");
  untouched(0, 1, "user");
  assert.equal(dom(0, 1).__perch_h, "3.9.other");
});

// A handle that has stamped takes an unstamped page only at its recorded index,
// and only while its window's tab counts match the last read at a stamp.
test("a closed stamped tab's handle refuses the only other same-URL tab once it slid into its index", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), at("user"), other("a3")] }]);
  const h = await handleIn(3, U);
  assert.notEqual((await call("eval_js", { script: "return 1", target: { tabId: h } })).r.isError, true);
  world.tabsOf("Safari", 0).splice(1, 1);
  stale(await call("eval_js", { script: HIT, target: { tabId: h } }), "eval_js", /can't tell which tab/);
  stale(await call("click", { selector: "#b", target: { tabId: h } }), "click", /can't tell which tab/);
  stale(await call("fill", { selector: "#i", text: "x", target: { tabId: h } }), "fill", /can't tell which tab/);
  untouched(0, 1, "user");
  assert.equal(dom(0, 1).__perch_h, undefined);
});

test("a closed stamped tab's handle refuses the only other same-URL tab at another index", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("user"), at("agent")] }]);
  const h = (await call("list_tabs", {})).o.tabs.filter((t) => t.url === U)[1].tabId;
  assert.notEqual((await call("eval_js", { script: "return 1", target: { tabId: h } })).r.isError, true);
  assert.equal(hits(0, 1), 0);
  world.tabsOf("Safari", 0).splice(2, 1);
  stale(await call("eval_js", { script: HIT, target: { tabId: h } }), "eval_js", /can't tell which tab/);
  stale(await call("click", { selector: "#b", target: { tabId: h } }), "click", /can't tell which tab/);
  stale(await call("fill", { selector: "#i", text: "x", target: { tabId: h } }), "fill", /can't tell which tab/);
  untouched(0, 1, "user");
});

test("a stamped tab that reloaded, the only one at its URL, still runs in place", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), other("a2")] }]);
  const h = await handleIn(3, U);
  assert.notEqual((await call("eval_js", { script: "return 1", target: { tabId: h } })).r.isError, true);
  world.tabsOf("Safari", 0)[1].spec.dom = form(U);
  const e = await call("eval_js", { script: HIT, target: { tabId: h } });
  assert.notEqual(e.r.isError, true, e.t);
  assert.equal(hits(0, 1), 1);
  assert.equal(e.r.content.length, 1, "no moved note");
  world.tabsOf("Safari", 0)[1].spec.dom = form(U);
  const f = await call("fill", { selector: "#i", text: "hi", target: { tabId: h } });
  assert.equal(f.o.ok, true, f.t);
  assert.equal(f.o.moved, undefined, f.t);
  world.reset();
  assert.notEqual((await call("eval_js", { script: HIT, target: { tabId: h } })).r.isError, true);
  assert.equal(events(), 1, JSON.stringify(world.counts));
});

test("a stamped tab whose index moved, the only one at its URL, runs and reports moved", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent")] }]);
  const h = await handleIn(3, U);
  assert.notEqual((await call("eval_js", { script: "return 1", target: { tabId: h } })).r.isError, true);
  world.tabsOf("Safari", 0).splice(0, 1);
  const e = await call("eval_js", { script: HIT, target: { tabId: h } });
  assert.notEqual(e.r.isError, true, e.t);
  assert.equal(hits(0, 0), 1);
  const m = meta(e.r);
  assert.equal(m.moved, true);
  assert.equal(m.tabId, h.replace("safari:3.1.", "safari:3.0."));
});

test("a new_tab handle that stamped still runs after its page reloads", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), other("a1")] }]);
  const { o } = await call("new_tab", { url: U, app: "Safari" });
  const h = o.tabId;
  world.tabsOf("Safari", 0)[2].spec.dom = form(U);
  assert.notEqual((await call("eval_js", { script: "return 1", target: { tabId: h } })).r.isError, true);
  world.tabsOf("Safari", 0)[2].spec.dom = form(U);
  const e = await call("eval_js", { script: HIT, target: { tabId: h } });
  assert.notEqual(e.r.isError, true, e.t);
  assert.equal(hits(0, 2), 1);
});

test("a single unstamped same-URL tab off the recorded index runs, and returns its refreshed tabId", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), other("a2")] }]);
  const h = await handleIn(3, U);
  world.tabsOf("Safari", 0).splice(0, 1);
  const f = await call("fill", { selector: "#i", text: "hi", target: { tabId: h } });
  assert.notEqual(f.r.isError, true, f.t);
  assert.equal(f.o.ok, true, f.t);
  assert.equal(f.o.moved, true, f.t);
  assert.match(f.o.warning, /tab moved; tabId refreshed/);
  const fresh = h.replace("safari:3.1.", "safari:3.0.");
  assert.equal(f.o.tabId, fresh);
  world.reset();
  const e = await call("eval_js", { script: HIT, target: { tabId: fresh } });
  assert.notEqual(e.r.isError, true, e.t);
  assert.equal(hits(0, 0), 1);
  assert.equal(events(), 1, JSON.stringify(world.counts));
  assert.equal(e.r.content.length, 1, "no moved note on an in-place hit");
});

test("a list_tabs handle for a tab stamped under its older handle runs in one event", async () => {
  install([{ id: 3, active: 0, tabs: [other("a0"), at("agent"), other("a2")] }]);
  const h = await handleIn(3, U);
  assert.notEqual((await call("eval_js", { script: "return 1", target: { tabId: h } })).r.isError, true);
  world.tabsOf("Safari", 0).splice(0, 1);
  const fresh = await handleIn(3, U);
  assert.notEqual(fresh, h);
  world.reset();
  const e = await call("eval_js", { script: HIT, target: { tabId: fresh } });
  assert.notEqual(e.r.isError, true, e.t);
  assert.equal(hits(0, 0), 1);
  assert.equal(events(), 1, JSON.stringify(world.counts));
});

test("a navigate handle that stamped still runs after its page reloads", async () => {
  install([{ id: 3, active: 0, tabs: [{ url: "https://a0.test/" }, { url: "https://a1.test/" }] }]);
  const h0 = await handleIn(3, "https://a1.test/");
  const n = await call("navigate", { url: U, target: { tabId: h0 } });
  assert.equal(n.o.ok, true, n.t);
  const h = n.o.tabId;
  assert.notEqual((await call("eval_js", { script: "return 1", target: { tabId: h } })).r.isError, true);
  // A reload: a fresh document, no stamp.
  delete world.page("Safari", 0, 1).__perch_h;
  const e = await call("eval_js", { script: HIT, target: { tabId: h } });
  assert.notEqual(e.r.isError, true, e.t);
  assert.equal(world.page("Safari", 0, 1).hits, 1);
});
