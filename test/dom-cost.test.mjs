// Page-side DOM costs: deepAll, accName's name from content, fill's label
// fallback and the select/typeahead match tiers. The goldens pin their output on
// every fixture the page tests use, byte for byte. PERCH_GOLDEN_WRITE=1
// rewrites the goldens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { PAGE_SCRIPTS, pageScript, buildEvalWrapper } from "../server.js";
import { page, run, runBody } from "./helpers/page.mjs";

const GOLDEN = new URL("./goldens/dom.json", import.meta.url);
// SELECT_LIB and TA_PICK_LIB (matchTier, taMatch), without fill_ta_pick's own body.
const MATCH_LIB = PAGE_SCRIPTS.fill_ta_pick.slice(0, PAGE_SCRIPTS.fill_ta_pick.indexOf("const s = window.__perch_ta;"));
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
