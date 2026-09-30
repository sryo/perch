// Place names in option matching: a comma part naming a US state, a Canadian
// province or a common country equals its abbreviation or alias ("Alabama" =
// "AL", "United States" = "USA" = "U.S."), for typeahead suggestions (taMatch)
// and select options (matchTier). The alias match ranks below every literal
// tier, so it only answers where the literal tiers found nothing or tied, and
// a typeahead comma tie keeps only the options whose first part is the typed
// first part (the place itself, not a place inside it). Page scripts carry
// only the place groups the call's own text names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_SCRIPTS, pageScript, buildEvalWrapper } from "../server.js";
import { page } from "./helpers/page.mjs";

const MATCH_LIB = PAGE_SCRIPTS.fill_ta_pick.slice(0, PAGE_SCRIPTS.fill_ta_pick.indexOf("const s = window.__perch_ta;"));
// pageScript ships the place names the args carry, as a call's own script would.
const runMatch = (w, text, body) => JSON.parse(w.eval(buildEvalWrapper(pageScript(null, { text }) + MATCH_LIB + body)));

// -> {ta, tier}: the option texts taMatch and matchTier return for text.
function match(options, text) {
  const w = page(`<ul>${options.map((o) => `<li role=option>${o}</li>`).join("")}</ul>`);
  return runMatch(w, text, `
    const list = Array.from(document.querySelectorAll("li"));
    const names = function (m) { return { hits: m.hits.map(function (x) { return x.textContent; }), exact: m.exact }; };
    return { ta: names(taMatch(list, ${JSON.stringify(text)})), tier: names(matchTier(list, function (x) { return norm(x.textContent); }, norm(${JSON.stringify(text)}))) };`);
}

test("typeahead: a state name and a country name match their abbreviations per comma part", () => {
  for (const text of ["Tuscaloosa, Alabama, United States", "Tuscaloosa, Alabama, USA", "tuscaloosa, al, united states of america", "Tuscaloosa, Alabama, U.S."]) {
    assert.deepEqual(match(["Tuscaloosa, AL, USA"], text).ta, { hits: ["Tuscaloosa, AL, USA"], exact: false }, text);
  }
  assert.deepEqual(match(["Toronto, ON, Canada"], "Toronto, Ontario, Canada").ta.hits, ["Toronto, ON, Canada"]);
  assert.deepEqual(match(["London, UK"], "London, United Kingdom").ta.hits, ["London, UK"]);
  assert.deepEqual(match(["Tuscaloosa, Alabama, EE. UU."], "Tuscaloosa, AL, United States").ta.hits, ["Tuscaloosa, Alabama, EE. UU."]);
});

test("typeahead: aliases never match another city, another state or a word inside a part", () => {
  assert.deepEqual(match(["Birmingham, AL, USA", "Tuscaloosa, AR, USA"], "Tuscaloosa, Alabama, United States").ta.hits, []);
  assert.deepEqual(match(["Tuscaloosa County, AL, USA"], "Tuscaloosa, Alabama").ta.hits, []);
  // "Canada" is not "CA" (California), and a part only matches whole.
  assert.deepEqual(match(["Toronto, ON, CA"], "Toronto, Ontario, Canada").ta.hits, []);
  assert.deepEqual(match(["Paris, USA Street"], "Paris, United States").ta.hits, []);
});

test("typeahead: a literal match still wins; an alias never makes a tie the literal tiers did not have", () => {
  // The literal comma tier answers before any alias is considered.
  assert.deepEqual(match(["Portland, Oregon, USA", "Portland, OR, USA"], "Portland, OR").ta.hits, ["Portland, OR, USA"]);
  // Two aliases of the same place tie at the alias tier; the later literal
  // tiers settle it as they did before.
  assert.deepEqual(match(["Tuscaloosa, AL, USA", "Tuscaloosa, Alabama, United States of America"], "Tuscaloosa, Alabama, United States").ta.hits,
    ["Tuscaloosa, Alabama, United States of America"]);
  // Nothing literal and two alias hits: still a tie, never a pick.
  assert.deepEqual(match(["Tuscaloosa, AL, USA", "Tuscaloosa, AL, US"], "Tuscaloosa, Alabama, United States").ta.hits,
    ["Tuscaloosa, AL, USA", "Tuscaloosa, AL, US"]);
});

test("typeahead: a comma tie goes to the one option that starts with the typed place", () => {
  const opts = ["Tuscaloosa, Alabama, EE. UU.", "Cottondale, Tuscaloosa, Alabama, EE. UU.", "Northport, Tuscaloosa, Alabama, EE. UU."];
  assert.deepEqual(match(opts, "Tuscaloosa, Alabama").ta.hits, ["Tuscaloosa, Alabama, EE. UU."]);
  assert.deepEqual(match(opts, "Tuscaloosa, AL, United States").ta.hits, ["Tuscaloosa, Alabama, EE. UU."]);
  // Several that start with it still tie.
  const two = ["Córdoba, Córdoba, Argentina", "Córdoba, Santa Fe, Argentina", "Villa, Córdoba, Argentina"];
  assert.deepEqual(match(two, "Córdoba, Argentina").ta.hits, two.slice(0, 2));
  // None that start with it: the tie stands.
  const none = ["Cottondale, Tuscaloosa, Alabama", "Northport, Tuscaloosa, Alabama"];
  assert.deepEqual(match(none, "Tuscaloosa, Alabama").ta.hits, none);
});

test("select: a country or state alias matches only where no literal tier did", () => {
  assert.deepEqual(match(["Canada", "USA", "Mexico"], "United States").tier, { hits: ["USA"], exact: false });
  assert.deepEqual(match(["Canada", "United States of America"], "USA").tier.hits, ["United States of America"]);
  assert.deepEqual(match(["AK", "AL", "AR"], "Alabama").tier.hits, ["AL"]);
  assert.deepEqual(match(["UK", "Ukraine", "United Arab Emirates"], "United Kingdom").tier.hits, ["UK"]);
  // Literal tiers first: a word-prefix hit stays the answer.
  assert.deepEqual(match(["United States Minor Outlying Islands", "USA"], "United States").tier.hits, ["United States Minor Outlying Islands"]);
  assert.deepEqual(match(["Canada", "Mexico"], "United States").tier.hits, []);
});

test("pageScript ships only the place groups a text or option names, and none to scripts that never match", () => {
  const places = (name, A) => { const m = /const PLACES = ([^\n]*);/.exec(pageScript(name, A)); return m && JSON.parse(m[1]); };
  const US = { us: "#us", usa: "#us", "united states": "#us", "united states of america": "#us", "estados unidos": "#us", "ee uu": "#us", eeuu: "#us" };
  assert.deepEqual(places("fill_ta_pick", { text: "Tuscaloosa, Alabama, U.S." }), { al: "#al", alabama: "#al", ...US });
  assert.deepEqual(places("select_start", { text: ["The Netherlands", "Other"] }), { netherlands: "#netherlands", holland: "#netherlands" });
  assert.deepEqual(places("fill_fields", { fields: [{ label_pattern: "state", option: "Texas" }, { label_pattern: "hi", text: "Ada" }] }), { tx: "#tx", texas: "#tx" });
  assert.equal(places("select_start", { text: "Argentina" }), null);
  assert.equal(places("select_start", { label_pattern: "ohio", text: "Yes" }), null);
  assert.equal(places("click", { text: "Alabama" }), null);
});
