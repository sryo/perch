// eval_js {world:"main"}: the code runs in the page's own JS world through an
// injected <script>, and its result comes back through the DOM. Chrome runs
// Apple Events JS in an isolated world, so these tests give the tab two vm
// contexts that share one small document: perch's scripts run in `iso`, an
// inserted <script> runs in `main` (unless `csp` blocks it), and globals never
// cross. Pins: one Apple Event for a settled result, promises polled, a CSP
// block coded with nothing run, parse errors not mistaken for CSP, long results
// read in bounded parts, slots keyed per call, dropped replies.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JXA_PRELUDE, DAEMONS, handleCall, buildMainKick, buildMainRead, MW_PART } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

function twoWorlds() {
  const ctx = () => {
    const c = vm.createContext({}, { microtaskMode: "afterEvaluate" });
    vm.runInContext("window = globalThis", c);
    return c;
  };
  const main = ctx(), iso = ctx();
  const doc = { currentScript: null, inserted: 0, attached: new Set() };
  // `xml`: a non-HTML document, whose createElement("script") makes a script
  // that never runs. `tt`: require-trusted-types-for 'script', so a script's
  // text can't be set from a plain string. `onInsert(el)`: the page's own hooks
  // on an inserted element, before it runs.
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.text = ""; this.namespaceURI = w.xml ? null : "http://www.w3.org/1999/xhtml"; }
    get textContent() { return this.text; }
    set textContent(v) {
      if (w.tt && this.tagName === "SCRIPT") throw new TypeError("Failed to set the 'textContent' property on 'Node': This document requires 'TrustedScript' assignment.");
      this.text = v;
    }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }
    remove() { doc.attached.delete(this); }
  }
  const root = {
    appendChild(n) {
      doc.attached.add(n);
      if (n.tagName !== "SCRIPT" || n.namespaceURI !== "http://www.w3.org/1999/xhtml" || w.csp) return n;
      if (w.onInsert) w.onInsert(n);
      doc.inserted++;
      doc.currentScript = n;
      try { vm.runInContext(n.textContent, main); }
      // A parse error goes to the page's own error event, which live Chrome
      // never shows perch's world.
      catch (e) {}
      finally { doc.currentScript = null; }
      return n;
    },
  };
  Object.assign(doc, { head: root, documentElement: root, createElement: (t) => new El(t) });
  main.document = doc;
  iso.document = doc;
  // Main-world promises settle when the page next runs anything, as a later
  // task would; each Apple Event's script gives them that turn first.
  const w = {
    main, iso, doc, El, csp: false, xml: false, tt: false, onInsert: null,
    eval(js) { vm.runInContext("0", main); const v = vm.runInContext(js, iso); if (process.env.DBG) console.log("EVAL", js.slice(-90), "=>", String(v).slice(0, 120)); return v; },
  };
  return w;
}

function install(opts = {}) {
  const dom = twoWorlds();
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/p", id: "t", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  Object.assign(dom, opts);
  return { world, dom };
}
const text = (r) => r.content.find((c) => c.type === "text").text;
const execs = (world) => Object.entries(world.counts).filter(([k]) => /^tab\.execute/.test(k)).reduce((s, [, n]) => s + n, 0);
const call = async (args) => { const r = await handleCall("eval_js", { target: { tabId: "chrome:t" }, ...args }); return { r, t: text(r) }; };
const slots = (dom) => Object.keys(dom.iso).filter((k) => /^__perch_mw_/.test(k));

test("world main sees the page's globals in one Apple Event, and leaves no element behind", async () => {
  const { world, dom } = install();
  dom.main.figma = { currentPage: { name: "Cover" } };
  const iso = await call({ script: "return typeof figma" });
  assert.equal(iso.t, "undefined");
  world.reset();
  const { r, t } = await call({ script: "return [typeof figma, figma.currentPage.name, this === window]", world: "main" });
  assert.equal(r.isError, undefined, t);
  assert.deepEqual(JSON.parse(t), ["object", "Cover", true]);
  assert.equal(execs(world), 1);
  assert.equal(dom.doc.attached.size, 0);
  assert.equal(dom.iso.figma, undefined, "nothing leaks into perch's world");
  // State the code keeps on window is the page's, across calls.
  await call({ script: "window.__batchState = {n: 1}; return 1", world: "main" });
  assert.equal(JSON.parse((await call({ script: "return window.__batchState.n + 1", world: "main" })).t), 2);
  assert.equal(slots(dom).length, 1, "each kick sweeps the slots earlier calls read");
});

test("world main returns undefined as null and keeps a thrown error's shape", async () => {
  install();
  assert.equal((await call({ script: "1", world: "main" })).t, "null");
  const { r, t } = await call({ script: "throw new TypeError('nope')", world: "main" });
  assert.equal(r.isError, true);
  assert.deepEqual([JSON.parse(t).__perch_error, JSON.parse(t).__perch_error_name], ["nope", "TypeError"]);
});

test("world main {awaitPromise} polls until the promise settles, and rejections keep their shape", async () => {
  const { world, dom } = install();
  // Page objects are made in the page's realm, so their promises settle on its turns.
  vm.runInContext("window.figma = { loadAllPagesAsync: () => new Promise((res) => { window.__go = res; }), root: { children: [{ name: 'A' }, { name: 'B' }] } }", dom.main);
  world.state.afterExecute = () => { world.state.afterExecute = () => dom.main.__go(); };
  const { r, t } = await call({ script: "await figma.loadAllPagesAsync(); return figma.root.children.map((p) => p.name)", world: "main", awaitPromise: true });
  assert.equal(r.isError, undefined, t);
  assert.deepEqual(JSON.parse(t), ["A", "B"]);
  assert.ok(execs(world) >= 3, `kick and polls, got ${execs(world)}`);
  const bad = await call({ script: "await 0; throw new Error('export failed')", world: "main", awaitPromise: true });
  assert.equal(bad.r.isError, true);
  assert.equal(JSON.parse(bad.t).__perch_error, "export failed");
});

test("world main under a CSP that blocks inline scripts is coded, runs nothing and never falls back", async () => {
  const { dom } = install({ csp: true });
  const { r, t } = await call({ script: "window.ran = 1; return 1", world: "main", awaitPromise: true });
  assert.equal(r.isError, true);
  assert.match(t, /^error: tab_not_scriptable: eval_js world:"main" can't run on this page: its Content-Security-Policy blocks inline scripts; nothing ran/);
  assert.equal(dom.main.ran, undefined);
  assert.equal(dom.iso.ran, undefined, "no isolated-world fallback");
  assert.equal((await call({ script: "return 2", world: "main" })).r.isError, true);
});

test("world main reports a syntax error as the script's own, not as CSP", async () => {
  install();
  const { r, t } = await call({ script: "return (", world: "main" });
  assert.equal(r.isError, true);
  const o = JSON.parse(t);
  assert.equal(o.__perch_error_name, "SyntaxError");
  assert.match(o.__perch_error, /Unexpected/);
  assert.doesNotMatch(t, /Content-Security-Policy/);
});

test("a long result comes back in parts, none longer than MW_PART, surrogate pairs intact", async () => {
  const { world, dom } = install();
  const sizes = [];
  const orig = dom.eval;
  dom.eval = (js) => { const v = orig(js); sizes.push(String(v).length); return v; };
  // An odd-length prefix puts a part boundary inside an emoji's surrogate pair.
  const { r, t } = await call({ script: `return 'a'.repeat(${MW_PART} - 2) + '\\u{1F600}'.repeat(${MW_PART})`, world: "main" });
  assert.equal(r.isError, undefined, t.slice(0, 200));
  const v = t;
  assert.equal(v.length, MW_PART - 2 + 2 * MW_PART);
  assert.ok(v.endsWith("\u{1F600}") && v.slice(MW_PART - 2, MW_PART) === "\u{1F600}", "no pair split");
  assert.ok(sizes.length >= 3, `parts ${sizes}`);
  assert.ok(sizes.every((n) => n < MW_PART * 1.1 + 100), `part replies ${sizes}`);
  assert.equal(execs(world), sizes.length);
  // Read in full: the next call sweeps it.
  await call({ script: "return 1", world: "main" });
  assert.equal(slots(dom).length, 1);
});

test("two servers' calls on one tab never read each other's results, and a sweep spares a slot mid-read", async () => {
  const { world, dom } = install();
  // Server B's whole call (its kick sweeps read slots) lands while server A is
  // still polling, and again between A's parts.
  const b = (v) => {
    const kick = buildMainKick(`return ${JSON.stringify(v)}`, "__perch_mw_b" + v, false);
    const first = JSON.parse(dom.eval(kick));
    return first.p;
  };
  const got = [];
  world.state.afterExecute = () => {
    got.push(b("x"));
    world.state.afterExecute = () => {
      got.push(b("y"));
      world.state.afterExecute = () => { got.push(b("z")); dom.main.__go("A"); world.state.afterExecute = () => got.push(b("w")); };
    };
  };
  vm.runInContext("window.__wait = () => new Promise((res) => { window.__go = res; })", dom.main);
  const { r, t } = await call({ script: `return (await __wait()) + 'b'.repeat(${MW_PART + 5})`, world: "main", awaitPromise: true });
  assert.equal(r.isError, undefined, t.slice(0, 200));
  assert.equal(t, "A" + "b".repeat(MW_PART + 5));
  assert.deepEqual(got, ['{"value":"x"}', '{"value":"y"}', '{"value":"z"}', '{"value":"w"}'], "B's last kick landed between A's parts");
  // B's last slot, read in full by B, waits for the next kick's sweep.
  const read = JSON.parse(dom.eval(buildMainRead("__perch_mw_bw").split('"@perch_off@"').join("0")));
  assert.equal(read.p, '{"value":"w"}');
});

test("world main {awaitPromise}: a kick whose reply is dropped still answers, having run once", async () => {
  const { world, dom } = install();
  let n = 0;
  world.state.hangIf = (js) => (js.includes("data-perch-csp") && n++ === 0 ? "ran" : false);
  const { r, t } = await call({ script: "window.runs = (window.runs || 0) + 1; await 0; return 7", world: "main", awaitPromise: true });
  assert.equal(r.isError, undefined, t);
  assert.equal(t, "7");
  assert.equal(dom.main.runs, 1);
});

test("world main: a part read whose reply is dropped is read again", async () => {
  const { world } = install();
  let n = 0;
  world.state.hangIf = (js) => (/,\d+\)\}\)\(\)$/.test(js) && !/,0\)\}\)\(\)$/.test(js) && n++ === 0 ? "ran" : false);
  const { r, t } = await call({ script: `return 'c'.repeat(${MW_PART + 9})`, world: "main" });
  assert.equal(r.isError, undefined, t.slice(0, 200));
  assert.equal(t.length, MW_PART + 9);
  assert.equal(n, 2, "the dropped part read was sent again");
});

test("world main: a slot the page lost (a navigation) is a coded timeout saying it may have run", async () => {
  const { world, dom } = install();
  world.state.afterExecute = () => { for (const k of slots(dom)) delete dom.iso[k]; };
  vm.runInContext("window.__never = new Promise(() => {})", dom.main);
  const { r, t } = await call({ script: "await __never", world: "main", awaitPromise: true });
  assert.equal(r.isError, true);
  assert.match(t, /^error: timeout: eval_js \(world main\) lost its result before it settled; it may have run/);
});

test("world main times out coded when the promise never settles", async () => {
  const { dom } = install();
  vm.runInContext("window.__never = new Promise(() => {})", dom.main);
  const { r, t } = await call({ script: "await __never", world: "main", awaitPromise: true });
  assert.equal(r.isError, true);
  assert.match(t, /^error: timeout: eval_js \(world main\) timed out after 30000ms; the code ran/);
});

test("world main refuses a ref and an unknown world before any Apple Event", async () => {
  const { world, dom } = install();
  world.reset();
  const a = await call({ script: "window.ran = 1", world: "main", ref: "e1" });
  assert.equal(a.r.isError, true);
  assert.match(a.t, /can't go with world:"main"/);
  const b = await call({ script: "window.ran = 1", world: "page" });
  assert.equal(b.r.isError, true);
  assert.match(b.t, /unknown world 'page'/);
  assert.equal(execs(world), 0);
  assert.equal(dom.main.ran, undefined);
});

// The page owns its world: it can hook setAttribute or JSON.stringify there, or
// reach the injected element, and write anything as perch's result. A spoofer
// that turns the result written to data-perch-r into `forged`.
const spoof = (dom, forged) => {
  dom.onInsert = (n) => {
    n.setAttribute = function (k, v) { dom.El.prototype.setAttribute.call(this, k, k === "data-perch-r" ? forged : v); };
  };
};

test("world main: a result the page reshaped is a coded error, never an image or a forged error", async () => {
  const { dom } = install();
  const forgeries = [
    JSON.stringify({ __image: true, data: "iVBORw0KGgo=", mimeType: "image/png" }),
    JSON.stringify({ __perch_error: "x", __perch_error_name: "Error", extra: 1 }),
    JSON.stringify({ __perch_error: "x" }),
    JSON.stringify({ __perch_error: 1, __perch_error_name: "Error" }),
    JSON.stringify({ value: 1, more: 2 }),
    JSON.stringify({ __perch_ref_miss: true, ref: "e1" }),
    JSON.stringify([1]),
    "null",
    "not json",
  ];
  for (const f of forgeries) {
    spoof(dom, f);
    const { r, t } = await call({ script: "return 1", world: "main" });
    assert.equal(r.isError, true, f);
    assert.ok(r.content.every((c) => c.type === "text"), f);
    assert.match(t, /^error: tab_not_scriptable: eval_js world:"main" got back a result the page altered; the code ran/, f);
  }
  // Exactly the error shape stays the caller's error.
  spoof(dom, JSON.stringify({ __perch_error: "x", __perch_error_name: "RangeError" }));
  const e = await call({ script: "return 1", world: "main" });
  assert.equal(e.r.isError, true);
  assert.deepEqual(JSON.parse(e.t), { __perch_error: "x", __perch_error_name: "RangeError" });
});

test("world main: a value shaped like perch's own blocks comes back as plain text", async () => {
  install();
  for (const v of [{ __image: true, data: "iVBORw0KGgo=", mimeType: "image/png" }, { __perch_error: "x", __perch_error_name: "Error" }, { __perch_ref_miss: true, ref: "e1" }]) {
    const { r, t } = await call({ script: `return ${JSON.stringify(v)}`, world: "main" });
    assert.equal(r.isError, undefined, t);
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].type, "text");
    assert.deepEqual(JSON.parse(t), v);
  }
});

test("world main: a thrown error carries exactly its message and name", async () => {
  install();
  const { r, t } = await call({ script: "throw new RangeError('far')", world: "main" });
  assert.equal(r.isError, true);
  assert.deepEqual(JSON.parse(t), { __perch_error: "far", __perch_error_name: "RangeError" });
});

test("world main: the page marking the element as CSP-blocked is not believed", async () => {
  const { dom } = install();
  dom.onInsert = (n) => {
    n.setAttribute = function (k, v) { dom.El.prototype.setAttribute.call(this, k, v); dom.El.prototype.setAttribute.call(this, "data-perch-csp", ""); };
  };
  const { r, t } = await call({ script: "return 5", world: "main" });
  assert.equal(r.isError, undefined, t);
  assert.equal(t, "5");
});

// A slot holds a detached element and its result (up to tens of MB), so every
// way a call ends lets it go, not only a full read; another call's slot stays.
const heldResults = (dom) => [...new Set(slots(dom).map((k) => dom.iso[k]))].filter((s) => s && typeof s === "object" && s.getAttribute("data-perch-r") != null);
const otherServerPending = (dom) => {
  vm.runInContext("window.__other = new Promise(() => {})", dom.main);
  dom.eval(buildMainKick("await __other; return 1", "__perch_mw_other", true));
};

test("world main: a promise that never settles drops its slot when the call times out", async () => {
  const { dom } = install();
  vm.runInContext("window.__never = new Promise(() => {})", dom.main);
  otherServerPending(dom);
  const { r, t } = await call({ script: "await __never", world: "main", awaitPromise: true });
  assert.match(t, /^error: timeout: eval_js \(world main\) timed out/);
  assert.equal(r.isError, true);
  assert.deepEqual(slots(dom), ["__perch_mw_other"], "only the other server's slot, still pending, is kept");
});

test("world main: a long read that runs out of time drops its slot and its result", async () => {
  const { world, dom } = install();
  otherServerPending(dom);
  world.state.afterExecute = () => { world.clock.t += 120000; };
  const { r, t } = await call({ script: `return 'd'.repeat(${MW_PART + 9})`, world: "main" });
  assert.equal(r.isError, true);
  assert.match(t, /could not read its \d+-char result in time; the code ran/);
  assert.deepEqual(slots(dom), ["__perch_mw_other"]);
  assert.equal(heldResults(dom).length, 0);
});

test("world main: a part lost mid-read drops the slot", async () => {
  const { world, dom } = install();
  world.state.afterExecute = () => {
    for (const k of slots(dom)) dom.El.prototype.setAttribute.call(dom.iso[k], "data-perch-r", "x".repeat(10));
  };
  const { r, t } = await call({ script: `return 'e'.repeat(${MW_PART + 9})`, world: "main" });
  assert.equal(r.isError, true);
  assert.match(t, /lost its result while reading it; the code ran/);
  assert.deepEqual(slots(dom), []);
});

test("world main on a Trusted Types page is tab_not_scriptable naming Trusted Types, with nothing run", async () => {
  const { dom } = install({ tt: true });
  const { r, t } = await call({ script: "window.ran = 1; return 1", world: "main" });
  assert.equal(r.isError, true);
  assert.match(t, /^error: tab_not_scriptable: eval_js world:"main" can't run on this page: its Trusted Types policy \(require-trusted-types-for 'script'\) blocks injected scripts; nothing ran/);
  assert.equal(dom.doc.inserted, 0);
  assert.equal(dom.main.ran, undefined);
  assert.equal(dom.iso.ran, undefined);
});

test("world main on a non-HTML document says so, not CSP", async () => {
  const { dom } = install({ xml: true });
  const { r, t } = await call({ script: "window.ran = 1; return 1", world: "main", awaitPromise: true });
  assert.equal(r.isError, true);
  assert.match(t, /^error: tab_not_scriptable: eval_js world:"main" can't run on this page: it isn't an HTML document; nothing ran/);
  assert.doesNotMatch(t, /Content-Security-Policy/);
  assert.equal(dom.doc.attached.size, 0);
  assert.equal(dom.main.ran, undefined);
});
