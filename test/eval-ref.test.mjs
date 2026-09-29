// eval_js {ref}: the snapshot row's element is bound as `el` inside the same
// page call, a stale ref never runs the script, and frame refs never reach page JS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

function install(html) {
  const dom = page(html, { url: "https://a.test/p" });
  const w = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/p", id: "t", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = w.daemon;
  DAEMONS.slow = w.daemon;
  w.reset();
  w.dom = dom;
  return w;
}
const text = (r) => r.content.find((c) => c.type === "text").text;
const snapRef = async (name) => {
  const s = text(await handleCall("accessibility_snapshot", {}));
  const line = s.split("\n").find((l) => l.includes(JSON.stringify(name)));
  assert.ok(line, s);
  return line.split(" ")[0];
};
const NOT_AE = /^(win\.tabs|tabs\.byId|win\.activeTab|windows\[\d+\]\(.*\)|Application\(.*\)|running\(.*\)|deepUnwrap|CGWindowList)$/;
const appleEvents = (w) => Object.entries(w.counts).filter(([k]) => !NOT_AE.test(k)).reduce((s, [, n]) => s + n, 0);

test("eval_js {ref} binds el to the snapshot row's element", async () => {
  const w = install(`<button id=a>Alpha</button><button id=b>Beta</button>`);
  const ref = await snapRef("Beta");
  const r = await handleCall("eval_js", { ref, script: "return el.id + ':' + el.tagName" });
  assert.equal(r.isError, undefined, text(r));
  assert.equal(text(r), "b:BUTTON");
  assert.equal(w.dom.document.getElementById("a").tagName, "BUTTON");
});

test("eval_js {ref} keeps `this` as the window", async () => {
  install(`<button id=b>Beta</button>`);
  const ref = await snapRef("Beta");
  const r = await handleCall("eval_js", { ref, script: "return [this === window, typeof el.click]" });
  assert.deepEqual(JSON.parse(text(r)), [true, "function"]);
});

test("a stale ref after a re-snapshot errors and the script never runs", async () => {
  const w = install(`<button id=b>Beta</button>`);
  const ref = await snapRef("Beta");
  await handleCall("accessibility_snapshot", { role: "heading" });
  const r = await handleCall("eval_js", { ref, script: "window.__ran = 1; return 1" });
  assert.equal(r.isError, true);
  assert.match(text(r), new RegExp(`ref ${ref} is stale or unknown`));
  assert.equal(w.dom.__ran, undefined);
});

test("a ref whose node was removed errors and the script never runs", async () => {
  const w = install(`<button id=b>Beta</button>`);
  const ref = await snapRef("Beta");
  w.dom.document.getElementById("b").remove();
  const r = await handleCall("eval_js", { ref, script: "window.__ran = 1; return 1" });
  assert.equal(r.isError, true, text(r));
  assert.match(text(r), /is stale or unknown/);
  assert.equal(w.dom.__ran, undefined);
});

// The fake world's plain pages flush microtasks after each execute, which
// awaitPromise needs; happy-dom pages don't, so these stand in a fake element.
function asyncWorld(connected) {
  const w = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/p", id: "t" }] }] }], cg: [{ owner: "Google Chrome" }] });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = w.daemon;
  DAEMONS.slow = w.daemon;
  w.reset();
  const p = w.page("Google Chrome", 0, 0);
  p.__perch_refs = { e4: { id: "b", tagName: "BUTTON", isConnected: connected, ownerDocument: p.document } };
  return w;
}

test("eval_js {ref, awaitPromise} awaits inside the bound body", async () => {
  asyncWorld(true);
  const r = await handleCall("eval_js", { ref: "e4", awaitPromise: true, script: "await Promise.resolve(); return el.id" });
  assert.equal(text(r), "b");
  const p = await handleCall("eval_js", { ref: "e4", awaitPromise: true, script: "return Promise.resolve(el.tagName)" });
  assert.equal(text(p), "BUTTON");
});

test("eval_js {ref, awaitPromise} on a detached element errors and never runs", async () => {
  const w = asyncWorld(false);
  const r = await handleCall("eval_js", { ref: "e4", awaitPromise: true, script: "window.__ran = 1; return 1" });
  assert.equal(r.isError, true, text(r));
  assert.match(text(r), /ref e4 is stale or unknown/);
  assert.equal(w.page("Google Chrome", 0, 0).__ran, undefined);
});

test("an unknown ref never runs the script", async () => {
  const w = install(`<button id=b>Beta</button>`);
  await snapRef("Beta");
  const r = await handleCall("eval_js", { ref: "e\"]; window.__ran = 1; //", script: "window.__ran = 2; return 1" });
  assert.equal(r.isError, true);
  assert.equal(w.dom.__ran, undefined);
});

test("a frame ref throws before any Apple Event", async () => {
  const w = install(`<button id=b>Beta</button>`);
  w.reset();
  const r = await handleCall("eval_js", { ref: "f3", script: "return 1" });
  assert.equal(r.isError, true);
  assert.match(text(r), /eval_js: frame refs need click \{trusted:true\}/);
  assert.equal(appleEvents(w), 0, JSON.stringify(w.counts));
});

test("eval_js {ref} costs the same Apple Events as plain eval_js", async () => {
  const w = install(`<button id=b>Beta</button>`);
  const ref = await snapRef("Beta");
  w.reset();
  await handleCall("eval_js", { script: "return 1" });
  const plain = appleEvents(w);
  w.reset();
  await handleCall("eval_js", { ref, script: "return el.id" });
  assert.equal(appleEvents(w), plain);
});

// A frame that navigates or reloads leaves its old document alive, so its
// nodes still read isConnected; the ref no longer names the frame's document.
test("eval_js {ref} into a same-origin frame runs, and is stale once the frame's document is replaced", async () => {
  const w = install(`<iframe id=app data-rect="0,100,600,800"></iframe>`);
  const app = w.dom.document.getElementById("app");
  app.contentDocument.body.innerHTML = `<label for=fn>First name</label><input id=fn>`;
  const ref = await snapRef("First name");
  const ok = await handleCall("eval_js", { ref, script: "return el.id" });
  assert.equal(ok.isError, undefined, text(ok));
  assert.equal(text(ok), "fn");
  const old = app.contentDocument.getElementById("fn");
  const fresh = w.dom.document.implementation.createHTMLDocument("");
  Object.defineProperty(app, "contentDocument", { get: () => fresh, configurable: true });
  assert.equal(old.isConnected, true);
  const r = await handleCall("eval_js", { ref, script: "window.__ran = 1; return 1" });
  assert.equal(r.isError, true, text(r));
  assert.match(text(r), new RegExp(`ref ${ref} is stale or unknown`));
  assert.equal(w.dom.__ran, undefined);
});
