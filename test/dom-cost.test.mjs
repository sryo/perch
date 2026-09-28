// Page-side DOM costs: deepAll, accName's name from content, fill's label
// fallback and the select/typeahead match tiers. The goldens pin their output on
// every fixture the page tests use, byte for byte; the cost tests count the DOM
// reads each one makes. PERCH_GOLDEN_WRITE=1 rewrites the goldens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { PAGE_SCRIPTS, pageScript, buildEvalWrapper } from "../server.js";
import { page, run, runBody } from "./helpers/page.mjs";

const GOLDEN = new URL("./goldens/dom.json", import.meta.url);
// SELECT_LIB and TA_PICK_LIB (matchTier, taMatch), without fill_ta_pick's own body.
const MATCH_LIB = PAGE_SCRIPTS.fill_ta_pick.slice(0, PAGE_SCRIPTS.fill_ta_pick.indexOf("const s = window.__perch_ta;"));
const FILL_BODY = PAGE_SCRIPTS.fill.slice(0, PAGE_SCRIPTS.fill.lastIndexOf("return fillOne(A);"));
const runMatch = (w, body) => JSON.parse(w.eval(buildEvalWrapper(pageScript(null, { text: "" }) + MATCH_LIB + body)));
const safe = (f) => { try { return f(); } catch (e) { return "throws: " + e.message; } };

const PATTERNS = ["name", "mail", "search", "city", "."];
const WANTS = ["a", "ar", "new", "united", "b c", "córdoba"];
function outputs({ html, url }) {
  const out = {};
  out.snapshot = safe(() => run(page(html, { url }), "snapshot", { max: 500 }));
  out.names = safe(() => runBody(page(html, { url }), `return Array.from(document.body.querySelectorAll("*")).map(function (el) { return accName(el); })`));
  out.fill = PATTERNS.map((p) => safe(() => run(page(html, { url }), "fill", { label_pattern: p, text: "Ab 12 x" })));
  out.match = safe(() => runMatch(page(html, { url }), `
    const list = Array.from(document.querySelectorAll("[role=option], option, li"));
    const idx = function (m) { return { hits: m.hits.map(function (x) { return list.indexOf(x); }), exact: m.exact }; };
    const first = list.length ? wordsOf(list[0].textContent)[0] || "" : "";
    return ${JSON.stringify(WANTS)}.concat([first]).map(function (w) {
      return { tier: idx(matchTier(list, function (x) { return norm(x.textContent); }, norm(w))), ta: idx(taMatch(list, w)) };
    });`));
  return out;
}

if (process.env.PERCH_GOLDEN_WRITE) {
  const g = JSON.parse(readFileSync(GOLDEN, "utf8"));
  writeFileSync(GOLDEN, JSON.stringify(g.map((f) => ({ html: f.html, url: f.url, out: outputs(f) })), null, 0).replace(/\},\{"html"/g, "},\n{\"html\"") + "\n");
}

test("goldens: snapshot, names, fill and match tiers are unchanged on every page fixture", () => {
  const g = JSON.parse(readFileSync(GOLDEN, "utf8"));
  assert.ok(g.length > 100);
  for (const f of g) assert.deepEqual(outputs(f), f.out, f.html.slice(0, 200));
});

test("deepAll: open shadow matches follow their host, before its light children, nested too", () => {
  const w = page(`<x-a class=m><i class=m>light</i></x-a><b class=m>after</b>`);
  const d = w.document;
  const sa = d.querySelector("x-a").attachShadow({ mode: "open" });
  sa.innerHTML = `<u class=m>s1</u><x-b></x-b><s class=m>s3</s>`;
  sa.querySelector("x-b").attachShadow({ mode: "open" }).innerHTML = `<q class=m>s2</q>`;
  assert.deepEqual(runBody(w, `return deepAll(".m").map(function (e) { return e.tagName; })`), ["X-A", "U", "Q", "S", "I", "B"]);
  assert.deepEqual(runBody(w, `return deepAll("x-b, q").map(function (e) { return e.tagName; })`), ["X-B", "Q"]);
  assert.match(runBody(w, `try { deepAll("##"); return "no"; } catch (e) { return "threw"; }`), /threw/);
});

test("deepAll matches through the native query, not element by element", () => {
  const w = page(`<div>${"<p><span>x</span><button>b</button></p>".repeat(100)}</div>`);
  const calls = runBody(w, `
    let n = 0; const m = Element.prototype.matches;
    Element.prototype.matches = function (s) { n++; return m.call(this, s); };
    const len = deepAll("button").length;
    Element.prototype.matches = m;
    return [len, n];`);
  assert.deepEqual(calls, [100, 0]);
});

// A wrapper role around a large subtree: innerText would lay out and serialize
// all of it for a 120-character name.
const BIG = `<div id=big role=button><b>Open</b> the <i>panel</i>${"<span> item</span>".repeat(600)}</div>`;

test("accName: a large container's name comes from a bounded walk, never its full text", () => {
  const w = page(BIG + `<div id=small role=button><b>Open</b> the <i>panel</i></div>`);
  const r = runBody(w, `
    const big = document.getElementById("big"), small = document.getElementById("small");
    let reads = 0;
    const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");
    Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get: function () { if (this === big) reads++; return d.get.call(this); } });
    const out = [accName(big), accName(small), reads];
    Object.defineProperty(HTMLElement.prototype, "innerText", d);
    return out;`);
  assert.equal(r[0], ("Open the panel" + " item".repeat(30)).slice(0, 120) + "…");
  assert.equal(r[1], "Open the panel");
  assert.equal(r[2], 0);
});

test("accName: the bounded walk skips hidden and script text and spaces block children", () => {
  const w = page(`<div id=big role=button><div>Top</div>mid<div>Row</div><span hidden>secret</span><span style="display:none">gone</span><script>var x</script>${"<span></span>".repeat(500)}<b>tail</b></div>`);
  assert.equal(runBody(w, `return accName(document.getElementById("big"))`), "Top mid Row");
});

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
  const w = page(`<section id=f><div id=d><p>Shipping</p>${"<input>".repeat(10)}</div></section>`);
  const r = runBody(w, FILL_BODY + `
    const f = document.getElementById("f"), d = document.getElementById("d");
    const n = { f: 0, d: 0 };
    [["f", f], ["d", d]].forEach(function (p) {
      const t = p[1].textContent;
      Object.defineProperty(p[1], "textContent", { configurable: true, get: function () { n[p[0]]++; return t; } });
    });
    const miss = fillOne({ label_pattern: "zzz", text: "x" }).ok;
    const reads = n.d;
    const hit = fillOne({ label_pattern: "shipping", text: "x" });
    return [miss, reads, hit.ok, n.d];`);
  assert.deepEqual(r, [false, 1, true, 2]);
});

