// Page-side outputs on a large page (test/fixtures/large-dom.mjs), pinned byte
// for byte: snapshot text, get_text, fill's label search, select and typeahead
// picks, and the match tiers over a 1200-option list. Any speedup of the page
// scripts must leave all of it unchanged. PERCH_GOLDEN_WRITE=1 rewrites it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { JXA_PRELUDE, DAEMONS, PAGE_SCRIPTS, handleCall, pageScript, buildEvalWrapper } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run, runBody } from "./helpers/page.mjs";
import { build } from "./fixtures/large-dom.mjs";

const GOLDEN = new URL("./fixtures/large-dom.golden.json", import.meta.url);
// SELECT_LIB and TA_PICK_LIB (matchTier, taMatch) without fill_ta_pick's own body.
const MATCH_LIB = PAGE_SCRIPTS.fill_ta_pick.slice(0, PAGE_SCRIPTS.fill_ta_pick.indexOf("const s = window.__perch_ta;"));
const runMatch = (w, body) => JSON.parse(w.eval(buildEvalWrapper(pageScript(null, { text: "" }) + MATCH_LIB + body)));

function large() {
  const w = page("");
  build(w.document);
  return w;
}
function onLarge() {
  const dom = large();
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/p", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return dom;
}
// Long outputs are pinned by digest; the readable ones show what changed.
const digest = (v) => { const s = JSON.stringify(v); return { len: s.length, sha256: createHash("sha256").update(s).digest("hex") }; };
const text = (r) => (r.isError ? "error: " : "") + r.content.map((c) => c.text).join("\n");
// Every field's value, shadow roots included, so a fill that lands elsewhere
// shows. reset() puts them all back, so one page serves every case.
const values = (w) => runBody(w, `return deepAll("input, textarea, select").map(function (el, i) { return el.value ? i + "=" + el.value : ""; }).filter(Boolean)`);
const changed = (before, after) => after.filter((v) => before.indexOf(v) < 0);
const keep = (w) => runBody(w, `window.__init = deepAll("input, textarea, select").map(function (el) { return el.value; }); return null`);
const reset = (w) => runBody(w, `
  deepAll("input, textarea, select").forEach(function (el, i) { if (el.value !== window.__init[i]) el.value = window.__init[i]; });
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  delete window.__perch_ta; delete window.__perch_select; delete window.__perch_refs; delete window.__perch_fr;
  return null`);

const FILLS = ["full name 12", "email 7", "shipping city 14", "phone 33", "search orders 4", "notes 5", "shadow field 3",
  "inner code 5", "deep search 9", "group 20", "customer", "zzz", "monthly", "destination x"];
const SELECTS = [["country", "Toronto Canada 9"], ["country", "zurich"], ["country", "kraków 7"], ["country", "sao paulo brazil 43"],
  ["country", "nowhere"], ["country", ""], ["destination", "Córdoba, Argentina"], ["destination", "cordoba"], ["destination", "zone 1199"],
  ["destination", "reykjavik, sweden"]];
const TYPEAHEADS = ["Córdoba, Argentina", "Zone 777", "medellin, paraguay", "cordoba"];
const WANTS = ["a", "ar", "zone", "zone 12", "córdoba", "cordoba, argentina", "rosario brazil", "sao", "lodz, poland", "ZÜRICH", "zzz", ""];

async function outputs() {
  const out = {};
  let w = large();
  out.snapshot = run(w, "snapshot", { max: 500 });
  out.snapshotAll = digest(run(w, "snapshot", { max: 100000 }));
  out.snapshotQuery = run(w, "snapshot", { max: 50, query: "city|zone 1[0-9]{2}\\b|deep" });
  out.snapshotRole = digest(run(w, "snapshot", { max: 100000, role: ["textbox", "checkbox"] }));
  out.text = digest(run(w, "get_text", { offset: 0, maxChars: 1e7 }));
  out.textSel = digest(run(w, "get_text", { selector: "form", offset: 0, maxChars: 1e7 }));
  out.names = digest(runBody(w, `return deepAll("input, textarea, select, button, a, [role]").map(accName)`));
  const dom = onLarge();
  keep(dom);
  const before = values(dom);
  out.fill = FILLS.map((p) => {
    reset(dom);
    const r = run(dom, "fill", { label_pattern: p, text: "Ab 12 x" });
    return { p, r, changed: changed(before, values(dom)) };
  });
  out.select = [];
  for (const [label_pattern, t] of SELECTS) {
    reset(dom);
    out.select.push({ label_pattern, text: t, r: text(await handleCall("select", { label_pattern, text: t })), changed: changed(before, values(dom)) });
  }
  out.typeahead = [];
  for (const t of TYPEAHEADS) {
    reset(dom);
    out.typeahead.push({ text: t, r: text(await handleCall("fill", { label_pattern: "destination", text: t })), value: dom.document.getElementById("dest").value });
  }
  out.match = runMatch(large(), `
    const list = Array.from(document.querySelectorAll("[role=option], option"));
    const idx = function (m) { return { hits: m.hits.map(function (x) { return list.indexOf(x); }), exact: m.exact }; };
    return ${JSON.stringify(WANTS)}.map(function (w) {
      return { w: w, tier: idx(matchTier(list, function (x) { return norm(x.textContent); }, norm(w))), ta: idx(taMatch(list, w)) };
    });`);
  return out;
}

if (process.env.PERCH_GOLDEN_WRITE) writeFileSync(GOLDEN, JSON.stringify(await outputs(), null, 1) + "\n");

test("large page: snapshot, text, names, fill, select, typeahead and match tiers match the golden", async () => {
  const g = JSON.parse(readFileSync(GOLDEN, "utf8"));
  const o = await outputs();
  for (const k of Object.keys(g)) assert.deepEqual(o[k], g[k], k);
  assert.deepEqual(Object.keys(o), Object.keys(g));
});

const FILL_BODY = PAGE_SCRIPTS.fill.slice(0, PAGE_SCRIPTS.fill.lastIndexOf("return fillOne(A);"));

test("matchTier folds each item's key once, not once per tier", () => {
  const w = page(`<ul>${Array.from({ length: 50 }, (_, i) => `<li>Item ${i}</li>`).join("")}</ul>`);
  const r = runMatch(w, `
    const list = Array.from(document.querySelectorAll("li"));
    let n = 0;
    const m = matchTier(list, function (x) { n++; return norm(x.textContent); }, "zzz");
    const m2 = matchTier(list, function (x) { return norm(x.textContent); }, "item 7");
    return [m.hits.length, n, m2.hits.length, m2.exact];`);
  assert.deepEqual(r, [0, 50, 1, true]);
});

test("taMatch reads each option's text once, not once per tier", () => {
  const w = page(`<ul>${Array.from({ length: 40 }, (_, i) => `<li role=option>City ${i}, Region</li>`).join("")}</ul>`);
  const r = runMatch(w, `
    const list = Array.from(document.querySelectorAll("li"));
    let n = 0;
    list.forEach(function (o) {
      const t = o.textContent;
      Object.defineProperty(o, "textContent", { configurable: true, get: function () { n++; return t; } });
    });
    const miss = taMatch(list, "zzz").hits.length, reads = n;
    const hit = taMatch(list, "city 12, region");
    return [miss, reads, hit.hits.length, hit.exact];`);
  assert.deepEqual(r, [0, 40, 1, true]);
});

test("fill's label fallback reads each shared ancestor's text once", () => {
  const w = page(`<section>Order<div id=d><p>Shipping</p>${"<input>".repeat(10)}<small>All required</small></div></section>`);
  const r = runBody(w, FILL_BODY + `
    const t = document.getElementById("d").textContent;
    let n = 0;
    const test = RegExp.prototype.test;
    RegExp.prototype.test = function (s) { if (s === t) n++; return test.call(this, s); };
    const miss = fillOne({ label_pattern: "zzz", text: "x" }).ok, reads = n;
    const hit = fillOne({ label_pattern: "shipping", text: "x" });
    return [miss, reads, hit.ok, n];`);
  assert.deepEqual(r, [false, 1, true, 2]);
});

// el.labels is a document-wide label[for] lookup on every read.
function countLabels(w) {
  const c = { n: 0 };
  for (const C of [w.HTMLInputElement, w.HTMLTextAreaElement]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, "labels");
    Object.defineProperty(C.prototype, "labels", { configurable: true, get() { c.n++; return d.get.call(this); } });
  }
  return c;
}
const rowsOf = (s) => s.split("\n").slice(1).map((l) => l.slice(l.indexOf(" ") + 1));

test("a snapshot names fields from one label[for] scan, reading el.labels only where that can't settle it", () => {
  const w = page(`<form><label for=a>Alpha</label><input id=a name=a><label>Beta <input name=b></label>
    <label for=c>Gamma</label><textarea id=c></textarea><input name=d placeholder=Delta><input id=e placeholder=Echo></form>`);
  const c = countLabels(w);
  assert.deepEqual(rowsOf(run(w, "snapshot", { max: 500 })),
    [`textbox "Alpha" name="a"`, `textbox "Beta" name="b"`, `textbox "Gamma" type="textarea"`, `textbox "Delta" name="d"`, `textbox "Echo"`]);
  assert.equal(c.n, 2, "only the two fields without an id");
  c.n = 0;
  assert.deepEqual(runBody(w, `return [document.getElementById("a"), document.getElementById("c")].map(accName)`), ["Alpha", "Gamma"]);
  assert.equal(c.n, 2, "other tools read el.labels once per name");
});

test("a snapshot's label scan names tricky fields as el.labels does", () => {
  const w = page(`<label for=dup>First dup</label><input id=dup name=one><input id=dup name=two>
    <label for=two>Two A</label><label for=two>Two B</label><input id=two>
    <label for=wr>Outer for</label><label>Wrapped <input id=wr name=wr></label>
    <label>Only wrap <input id=ow name=ow></label><div id=host></div>`);
  const sr = w.document.getElementById("host").attachShadow({ mode: "open" });
  sr.innerHTML = `<label for=s>Shadow label</label><input id=s name=s>`;
  const want = runBody(w, `return deepAll("input").map(accName)`);
  const got = rowsOf(run(w, "snapshot", { max: 500 })).map((l) => JSON.parse(l.slice(l.indexOf(" ") + 1).match(/^"(?:[^"\\]|\\.)*"/)[0]));
  assert.deepEqual(got, want);
});

test("a snapshot checks native validity only on fields holding a value", () => {
  const w = page(`<form><input name=a required pattern="[0-9]+"><input type=email name=b value="nope"><textarea name=c></textarea></form>`);
  const seen = [];
  for (const C of [w.HTMLInputElement, w.HTMLTextAreaElement]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, "validity");
    Object.defineProperty(C.prototype, "validity", { configurable: true, get() { seen.push(this.name); return d.get.call(this); } });
  }
  const lines = run(w, "snapshot", { max: 500 }).split("\n").slice(1);
  assert.match(lines[1], / name="b" type="email" value="nope" invalid/);
  assert.deepEqual([...new Set(seen)], ["b"]);
});

test("the snapshot counts each form's fields once to pick the biggest", () => {
  const w = page(`<form id=small><input name=a></form><form id=big><input name=b><input name=c></form>`);
  const seen = [];
  const qsa = w.Element.prototype.querySelectorAll;
  w.Element.prototype.querySelectorAll = function (s) { if (this.tagName === "FORM" && s === "input, textarea, select, [contenteditable]:not([contenteditable=false])") seen.push(this.id); return qsa.call(this, s); };
  const head = JSON.parse(run(w, "snapshot", { max: 500 }).split("\n")[0].slice(2));
  assert.deepEqual(head.form, { fields: 2, requiredEmpty: 0 });
  assert.deepEqual(seen, ["small", "big", "big"], "one count each, then the census");
});

// form.elements re-runs a document-wide search for form= fields on every read.
test("the form census finds form= fields outside the form without reading form.elements", () => {
  const w = page(`<form id=f1><input name=a required></form><input name=ph form=f1 required><input name=other form=f2 required>
    <form><input name=b></form>`);
  let n = 0;
  const d = Object.getOwnPropertyDescriptor(w.HTMLFormElement.prototype, "elements");
  Object.defineProperty(w.HTMLFormElement.prototype, "elements", { configurable: true, get() { n++; return d.get.call(this); } });
  const head = JSON.parse(run(w, "snapshot", { max: 500 }).split("\n")[0].slice(2));
  assert.deepEqual(head.form, { fields: 1, requiredEmpty: 2 });
  assert.equal(n, 0);
});

test("the invalid-field census scans the document once, finding ARIA and native failures alike", () => {
  const w = page(`<form><input name=a aria-invalid=true><input type=email name=b value=nope><input name=c aria-invalid=true style="display:none"><input name=d></form>`);
  const seen = [];
  const qsa = w.document.querySelectorAll;
  w.document.querySelectorAll = function (s) { if (/aria-invalid|input, textarea, select/.test(s)) seen.push(s); return qsa.call(this, s); };
  const head = JSON.parse(run(w, "snapshot", { max: 500 }).split("\n")[0].slice(2));
  assert.equal(head.form.invalid, 2);
  assert.equal(seen.length, 1, seen.join(" | "));
});

test("a snapshot reads a shown required-empty field's style no more often than an optional field's", () => {
  const w = page(`<form><label for=r>Req</label><input id=r name=r required><label for=o>Opt</label><input id=o name=o></form>`);
  const n = new Map(), gcs = w.getComputedStyle.bind(w);
  w.getComputedStyle = (el, p) => { n.set(el.id, (n.get(el.id) || 0) + 1); return gcs(el, p); };
  const head = JSON.parse(run(w, "snapshot", { max: 500 }).split("\n")[0].slice(2));
  assert.deepEqual(head.form, { fields: 2, requiredEmpty: 1 });
  assert.equal(n.get("r"), n.get("o"));
});

test("a snapshot finds the page's forms and dialogs in one document search", () => {
  const w = page(`<form><input name=a></form><div role=dialog aria-label=Hi><button>Ok</button></div><form role=dialog aria-label=Both><input name=b></form>`);
  const seen = [];
  const qsa = w.document.querySelectorAll;
  w.document.querySelectorAll = function (s) { if (/form|dialog/.test(s)) seen.push(s); return qsa.call(this, s); };
  const head = JSON.parse(run(w, "snapshot", { max: 500 }).split("\n")[0].slice(2));
  assert.deepEqual(head.dialogs, ["Hi", "Both"]);
  assert.deepEqual(head.form, { fields: 1, requiredEmpty: 0 });
  assert.equal(seen.length, 1, seen.join(" | "));
});

test("the step lookup searches the form's outermost scope once when the page has no step marker", () => {
  const w = page(`<main><section><form><input name=a></form></section></main>`);
  const seen = [];
  const qs = w.Element.prototype.querySelector;
  w.Element.prototype.querySelector = function (s) { if (/aria-current=step|progressbar/.test(s)) seen.push(this.tagName + " " + s); return qs.call(this, s); };
  run(w, "snapshot", { max: 500 });
  assert.deepEqual(seen, ["MAIN [aria-current=step], [role=progressbar][aria-valuenow][aria-valuemax]"]);
});
