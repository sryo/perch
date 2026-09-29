// A tab that closes while a call is running on it ends that call at once in
// `stale_tab`, the code clients branch on, never in a timeout or in the
// browser's own "Can't get object." (errAENoSuchObject). The fake world closes
// the tab right after a chosen page script returns (state.afterExecute).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const chrome = (windows) => ({ name: "Google Chrome", kind: "chrome", windows });
const arc = (windows) => ({ name: "Arc", kind: "arc", windows });
const safari = (windows) => ({ name: "Safari", kind: "safari", windows });
const tabs = (n, p = "t") => Array.from({ length: n }, (_, i) => ({ url: `https://${p}${i}.test/`, title: `${p}${i}`, id: `${p}${i}` }));

let world;
function install(spec) {
  world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
beforeEach(() => { world = null; });

const call = async (name, args) => {
  const r = await handleCall(name, args);
  return { r, t: r.content.find((c) => c.type === "text")?.text };
};
const rt = (fn, args) => world.run(`JSON.stringify(__perch.${fn}(${JSON.stringify(args)}))`);
// The message of what a runtime entry threw (a vm-realm Error), or its result.
const thrown = (fn, args) => { try { return rt(fn, args); } catch (e) { return "throws " + e.message; } };

// Removes the tab from every window of `app` that lists it.
function closeTab(app, id) {
  for (let w = 0; ; w++) {
    let list;
    try { list = world.tabsOf(app, w); } catch { return; }
    if (!list) return;
    const i = list.findIndex((t) => String(t.spec.id) === String(id));
    if (i < 0) continue;
    // The window keeps showing its shown tab, or the closed one's neighbour.
    const spec = world.winSpec(app, w), shown = list[spec.active];
    list.splice(i, 1);
    spec.active = shown && list.includes(shown) ? list.indexOf(shown) : Math.min(i, list.length - 1);
  }
}
// Closes the tab once `n` page scripts have returned.
function closeAfter(app, id, n = 1) {
  let seen = 0;
  const arm = () => { world.state.afterExecute = () => { if (++seen >= n) closeTab(app, id); else arm(); }; };
  arm();
}
const listed = async (url) => JSON.parse((await call("list_tabs", {})).t).tabs.find((t) => t.url === url).tabId;

function stale({ r, t }, t0, what) {
  assert.equal(r.isError, true, `${what}: ${t}`);
  assert.match(t, /^error: stale_tab: /, what);
  assert.ok(world.clock.t - t0 < 300, `${what} took ${world.clock.t - t0}ms`);
}

const twoChrome = (extra = {}) => install({
  browsers: [chrome([{ id: 1, active: 0, tabs: [...tabs(1, "a"), { url: "https://x.test/", id: "x", ...extra }] }])],
  cg: [{ owner: "Google Chrome" }],
});

// ---- runtime select without a start step (fill's typeahead pick) ----

const PICK = { pick: "JSON.stringify(null)", probe: "true", miss: "JSON.stringify({ok:false})", short: 1000, wait: 3000 };

test("select's pick on a listed Chrome handle whose tab closed is stale_tab, not a raw AppleScript error", async () => {
  twoChrome();
  const h = await listed("https://x.test/");
  closeTab("Google Chrome", "x");
  const t0 = world.clock.t;
  assert.match(thrown("select", { target: { tabId: h }, ...PICK }), /^throws stale_tab: /);
  assert.ok(world.clock.t - t0 < 300, `took ${world.clock.t - t0}ms`);
});

test("select's pick on a tab that closes after its start step is stale_tab", async () => {
  twoChrome();
  const h = await listed("https://x.test/");
  closeAfter("Google Chrome", "x");
  const t0 = world.clock.t;
  assert.match(thrown("select", { target: { tabId: h }, start: "JSON.stringify({pending:true})", ...PICK }), /^throws stale_tab: /);
  assert.ok(world.clock.t - t0 < 300, `took ${world.clock.t - t0}ms`);
});

test("select's pick on the default target whose tab closes mid-poll is stale_tab", async () => {
  twoChrome();
  world.winSpec("Google Chrome", 0).active = 1;
  closeAfter("Google Chrome", "x");
  const t0 = world.clock.t;
  assert.match(thrown("select", { target: {}, start: "JSON.stringify({pending:true})", ...PICK }), /^throws stale_tab: /);
  assert.ok(world.clock.t - t0 < 300, `took ${world.clock.t - t0}ms`);
});

// ---- fill on a typeahead: the tab closes between typing and the pick ----

const TYPEAHEAD = `<div class=loc><label for=loc>Location</label><input id=loc name=location type=text autocomplete=off>
  <input type=hidden id=sel name=selectedLocation><div class=dropdown-container></div></div>`;

// These two make more than one runtime call, and each call finds the default
// target afresh, so only a handle pins the tab across them.
test("fill on a typeahead whose tab closes after typing is stale_tab", async () => {
  const dom = page(TYPEAHEAD);
  twoChrome({ dom });
  const h = await listed("https://x.test/");
  closeAfter("Google Chrome", "x");
  const t0 = world.clock.t;
  stale(await call("fill", { label_pattern: "location", text: "Rosario", target: { tabId: h } }), t0, "fill");
});

// ---- wait, eval_js awaitPromise, click readback ----

test("wait on a tab that closes mid-poll is stale_tab", async () => {
  twoChrome();
  const h = await listed("https://x.test/");
  world.tabsOf("Google Chrome", 0)[1].page.ticks = 1e6;
  closeAfter("Google Chrome", "x");
  const t0 = world.clock.t;
  stale(await call("wait", { readyState: "complete", timeout: 5000, target: { tabId: h } }), t0, "wait");
});

test("wait {quiet} on a tab that closes mid-wait is stale_tab", async () => {
  twoChrome({ dom: page(`<p>x</p>`) });
  const h = await listed("https://x.test/");
  closeAfter("Google Chrome", "x", 3);
  const t0 = world.clock.t;
  stale(await call("wait", { quiet: 500, timeout: 5000, target: { tabId: h } }), t0, "wait quiet");
});

test("eval_js awaitPromise on a tab that closes after the kick is stale_tab, in every browser", async () => {
  for (const [spec, app, id] of [
    [chrome([{ id: 1, active: 1, tabs: tabs(2, "c") }]), "Google Chrome", "c1"],
    [arc([{ id: "W1", active: 1, tabs: tabs(2, "a") }]), "Arc", "a1"],
    [safari([{ id: 3, active: 1, tabs: tabs(2, "s") }]), "Safari", null],
  ]) {
    install({ browsers: [spec], cg: [{ owner: app }] });
    const h = JSON.parse((await call("list_tabs", {})).t).tabs[1].tabId;
    closeAfter(app, id ?? world.tabsOf(app, 0)[1].spec.id);
    if (id == null) {
      // Safari tabs have no id: close by position.
      world.state.afterExecute = () => { world.tabsOf(app, 0).splice(1, 1); };
    }
    const t0 = world.clock.t;
    stale(await call("eval_js", { script: "return new Promise(() => {})", awaitPromise: true, target: { tabId: h } }), t0, app);
  }
});

test("click readback on a tab that closes after the click is stale_tab", async () => {
  for (const byHandle of [false, true]) {
    const dom = page(`<button id=b>Submit</button><p id=s>Idle</p>`);
    twoChrome({ dom });
    world.winSpec("Google Chrome", 0).active = 1;
    const target = byHandle ? { tabId: await listed("https://x.test/") } : undefined;
    closeAfter("Google Chrome", "x");
    const t0 = world.clock.t;
    stale(await call("click", { selector: "#b", readback: "#s", target }), t0, byHandle ? "handle" : "default target");
  }
});

// ---- navigate ----

test("navigate on a tab that closes after the load starts is stale_tab", async () => {
  twoChrome();
  const h = await listed("https://x.test/");
  closeAfter("Google Chrome", "x");
  const t0 = world.clock.t;
  stale(await call("navigate", { url: "https://y.test/", target: { tabId: h } }), t0, "page load");
});

test("navigate on a tab that closes after its url is set is stale_tab", async () => {
  twoChrome({ url: "chrome://newtab/" });
  const h = await listed("chrome://newtab/");
  world.winSpec("Google Chrome", 0).active = 1;
  const tab = world.tabsOf("Google Chrome", 0)[1];
  const loading = Object.getOwnPropertyDescriptor(tab, "loading");
  Object.defineProperty(tab, "loading", { configurable: true, get: () => { if (world.counts["tab.url="]) closeTab("Google Chrome", "x"); return loading.get.call(tab); } });
  const t0 = world.clock.t;
  stale(await call("navigate", { url: "https://y.test/", target: { tabId: h } }), t0, "url set");
  assert.equal(world.counts["tab.url="], 1);
});

test("navigate on a Safari tab that closes after the load starts is stale_tab", async () => {
  install({ browsers: [safari([{ id: 3, active: 1, tabs: tabs(2, "s") }])], cg: [{ owner: "Safari" }] });
  const h = JSON.parse((await call("list_tabs", {})).t).tabs[1].tabId;
  world.state.afterExecute = () => { world.tabsOf("Safari", 0).splice(1, 1); };
  const t0 = world.clock.t;
  stale(await call("navigate", { url: "https://y.test/", target: { tabId: h } }), t0, "safari");
});
