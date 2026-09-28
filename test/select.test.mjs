// select runs through the real JXA runtime (fake world) against a happy-dom page,
// so the start / pick / readback phases are polled JXA-side as in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

function onPage(html, setup) {
  const dom = page(html);
  if (setup) dom.eval(setup);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return { dom, world };
}
const select = async (args) => {
  const r = await handleCall("select", args);
  return { r, o: JSON.parse(r.content[0].text.replace(/^error: /, '"') + (r.isError ? '"' : "")) };
};

const NATIVE = `<label>Country <select><option value="">Pick</option><option value=ar>Argentina</option><option value=br>Brazil</option></select></label>`;

test("native select: exact text, value, word prefix, never mid-word; candidates on miss", async () => {
  onPage(NATIVE);
  assert.deepEqual((await select({ label_pattern: "country", text: "Argentina" })).o, { ok: true, selected: "Argentina", el: `combobox "Country"` });
  assert.equal((await select({ label_pattern: "country", text: "br" })).o.selected, "Brazil");
  assert.equal((await select({ label_pattern: "country", text: "braz" })).o.selected, "Brazil");
  assert.equal((await select({ label_pattern: "country", text: "razi" })).o.ok, false);
  const miss = (await select({ label_pattern: "country", text: "Chile" })).o;
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.candidates, ["Pick", "Argentina", "Brazil"]);
});

test("native select: equally good options are a tie, never settled by length or order", async () => {
  const html = `<label>Visa <select><option value="">Pick</option><option value=1>Yes, I need sponsorship</option><option value=2>Yes, I have a visa</option><option value=3>No</option></select></label>`;
  const { dom } = onPage(html);
  const { o } = await select({ label_pattern: "visa", text: "yes" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.ambiguous, true);
  assert.match(o.error, /^several options matched "yes" equally; give a more specific text/);
  assert.deepEqual(o.candidates, ["Yes, I need sponsorship", "Yes, I have a visa"]);
  assert.equal(dom.document.querySelector("select").value, "");
  // In-order words and folded accents tie too.
  onPage(`<label>City <select><option>Córdoba, Spain</option><option>Cordoba, Argentina</option></select></label>`);
  assert.equal((await select({ label_pattern: "city", text: "cordoba" })).o.ambiguous, true);
  onPage(`<label>Team <select><option>Data platform team</option><option>Data science team</option><option>Design</option></select></label>`);
  assert.equal((await select({ label_pattern: "team", text: "data team" })).o.ambiguous, true);
  // A more specific text settles it; an exact option still wins over longer ones.
  onPage(html);
  assert.equal((await select({ label_pattern: "visa", text: "yes, I have" })).o.selected, "Yes, I have a visa");
  onPage(`<label>Country <select><option>United States</option><option>United States Minor Outlying Islands</option></select></label>`);
  assert.equal((await select({ label_pattern: "country", text: "united states" })).o.selected, "United States");
  // Options equal once accents fold: the one matching as typed wins.
  for (const text of ["Cordoba", "Córdoba"]) {
    onPage(`<label>City <select><option value=a>Cordoba</option><option value=b>Córdoba</option></select></label>`);
    assert.equal((await select({ label_pattern: "city", text })).o.selected, text);
  }
});

// A react-select-like widget: opens only for a left-button press with a view,
// renders options on open, and shows the choice in the control.
const CUSTOM = `<label id=lab>Level</label><div class="select__control"><div role=combobox aria-labelledby=lab aria-expanded=false tabindex=0><span class=v>Choose</span></div></div><div id=menu></div>`;
const CUSTOM_JS = `
  const cb = document.querySelector('[role=combobox]');
  window.opens = 0;
  document.querySelector('.select__control').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.view) return;
    window.opens++;
    cb.setAttribute('aria-expanded', 'true');
    document.getElementById('menu').innerHTML = '<div role=option>Junior</div><div role=option>Senior</div>';
    document.querySelectorAll('[role=option]').forEach(o => o.addEventListener('click', () => { cb.querySelector('.v').textContent = o.textContent; }));
  });`;

test("custom combobox: opens with a real left press, picks, verifies", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS);
  const { o } = await select({ label_pattern: "level", text: "senior" });
  assert.deepEqual(o, { ok: true, selected: "Senior", el: `combobox "Level"`, value: "Senior" });
  assert.equal(dom.opens, 1);
});

test("custom combobox: no matching option lists what was there", async () => {
  onPage(CUSTOM, CUSTOM_JS);
  const { o } = await select({ label_pattern: "level", text: "principal" });
  assert.equal(o.ok, false);
  assert.deepEqual(o.candidates, ["Junior", "Senior"]);
});

test("custom combobox that never shows the choice is flagged unverified", async () => {
  onPage(CUSTOM, CUSTOM_JS.replace("cb.querySelector('.v').textContent = o.textContent;", ""));
  const { o } = await select({ label_pattern: "level", text: "junior" });
  assert.equal(o.ok, true);
  assert.equal(o.unverified, true);
});

test("select validates its arguments before touching the page", async () => {
  onPage(NATIVE);
  assert.match((await handleCall("select", { text: "x" })).content[0].text, /requires `ref`, `selector`, or `label_pattern`/);
  assert.match((await handleCall("select", { label_pattern: "(", text: "x" })).content[0].text, /invalid label_pattern/);
});

// react-select v5: role=combobox sits on the inner <input>, which is emptied after a
// pick; the chosen value shows in a sibling single-value element.
const REACT_SELECT = `<label id=lab>Seniority</label>
  <div class="select__control"><div class="select__value-container">
    <div class="select__single-value"></div>
    <input role=combobox aria-labelledby=lab aria-expanded=false>
  </div></div><div id=menu></div>`;
const REACT_SELECT_JS = `
  const input = document.querySelector('input');
  document.querySelector('.select__control').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.view) return;
    input.setAttribute('aria-expanded', 'true');
    document.getElementById('menu').innerHTML = '<div role=option>Staff engineer with a very long title that runs past eighty characters for sure</div><div role=option>Senior</div>';
    document.querySelectorAll('[role=option]').forEach(o => o.addEventListener('click', () => {
      document.querySelector('.select__single-value').textContent = o.textContent;
      input.value = '';
    }));
  });`;

test("react-select v5: readback comes from the control, not the emptied input", async () => {
  onPage(REACT_SELECT, REACT_SELECT_JS);
  const { o } = await select({ label_pattern: "seniority", text: "senior" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value, "Senior");
  assert.equal(o.unverified, undefined);
});

test("readback verifies options longer than the 80-char display clip", async () => {
  onPage(REACT_SELECT, REACT_SELECT_JS);
  const { o } = await select({ label_pattern: "seniority", text: "staff engineer" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.unverified, undefined, JSON.stringify(o));
});

test("custom combobox: accents fold, and typed words match in order as a last resort", async () => {
  const js = CUSTOM_JS.replace("'<div role=option>Junior</div><div role=option>Senior</div>'",
    "'<div role=option>Córdoba, Spain</div><div role=option>Córdoba, Córdoba, Argentina</div><div role=option>México</div>'");
  onPage(CUSTOM, js);
  assert.equal((await select({ label_pattern: "level", text: "Cordoba Argentina" })).o.selected, "Córdoba, Córdoba, Argentina");
  onPage(CUSTOM, js);
  assert.equal((await select({ label_pattern: "level", text: "mexico" })).o.selected, "México");
  onPage(CUSTOM, js);
  assert.equal((await select({ label_pattern: "level", text: "Argentina Cordoba" })).o.ok, false);
});

// A plain text input whose suggestions appear only after typing, with a hidden
// companion; Escape clears both the query and the companion.
const TYPED_LIST = `<form><div class=field><label for=loc>Location</label><input id=loc name=location value=Spring>
  <input type=hidden id=sel name=selectedLocation value=keep><div class=dropdown-container><div class=dropdown-results></div></div></div></form>`;
const TYPED_LIST_JS = `
  const inp = document.getElementById('loc');
  inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { inp.value = ''; document.getElementById('sel').value = ''; } });`;

test("listing a typeahead whose list opens only on typing leaves its text alone", async () => {
  const { dom } = onPage(TYPED_LIST, TYPED_LIST_JS);
  const { o } = await select({ selector: "#loc", text: "" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(dom.document.querySelector("#loc").value, "Spring");
  assert.equal(dom.document.querySelector("#sel").value, "keep");
});
