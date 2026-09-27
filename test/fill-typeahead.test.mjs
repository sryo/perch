// fill on typeaheads and reformatting inputs. A typeahead keeps only a picked
// suggestion, so fill types, waits for the control's own suggestions (polled
// JXA-side through the fake world), picks, then verifies the visible value and
// any hidden companion. Masked inputs pass on a normalized (digits) match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

// The page's async work runs on window.__q, one step per execute, standing in
// for timers that fire between JXA polls.
const QUEUE_JS = `
  window.__q = [];
  window.later = (fn, n) => { window.__q.push({ fn, n }); };
  window.__tick = () => { const due = window.__q.filter((j) => --j.n <= 0); window.__q = window.__q.filter((j) => j.n > 0); due.forEach((j) => j.fn()); };`;

function onPage(html, setup) {
  const dom = page(html);
  dom.eval(QUEUE_JS);
  if (setup) dom.eval(setup);
  const ev = dom.eval.bind(dom);
  dom.eval = (js) => { dom.__tick(); return ev(js); };
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return { dom, world };
}
const fill = async (args) => {
  const r = await handleCall("fill", args);
  return r.isError ? r.content[0].text : JSON.parse(r.content[0].text);
};
const $ = (dom, sel) => dom.document.querySelector(sel);

const CITIES = ["Rosario, Santa Fe, Argentina", "Rosario del Tala, Entre Rios", "Toronto, ON, Canada"];

// A plain input with a hidden companion and a dropdown container: a debounced
// lookup fills the dropdown, a pick sets both fields, and blur clears the text
// unless a selection is set.
const LOCATION = `<form>
  <div class=loc><label for=loc>Location</label><input id=loc name=location type=text autocomplete=off>
  <input type=hidden id=selected-location name=selectedLocation><div class=dropdown-container></div></div>
  <label>Name <input name=name></label>
</form>`;
const LOCATION_JS = (setHidden = true) => `
  const cities = ${JSON.stringify(CITIES)};
  const inp = document.getElementById('loc'), hid = document.getElementById('selected-location');
  const dd = document.querySelector('.dropdown-container');
  window.lookups = 0;
  inp.addEventListener('input', () => {
    hid.value = '';
    window.__q = [];
    const q = inp.value.toLowerCase();
    later(() => {
      window.lookups++;
      dd.innerHTML = cities.filter((c) => q && c.toLowerCase().startsWith(q)).map((c) => '<div class=dropdown-item data-id=' + cities.indexOf(c) + '>' + c + '</div>').join('');
      dd.querySelectorAll('.dropdown-item').forEach((o) => o.addEventListener('mousedown', () => {
        inp.value = o.textContent;
        ${setHidden ? "hid.value = 'loc-' + o.dataset.id;" : ""}
        dd.innerHTML = '';
      }));
    }, 3);
  });
  inp.addEventListener('blur', () => { window.__q = []; dd.innerHTML = ''; if (!hid.value) inp.value = ''; });`;

test("typeahead: plain input with a hidden companion picks the suggestion and survives blur", async () => {
  const { dom } = onPage(LOCATION, LOCATION_JS());
  const o = await fill({ label_pattern: "location", text: "Rosario" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.equal(o.selected, "Rosario, Santa Fe, Argentina");
  assert.equal($(dom, "#loc").value, "Rosario, Santa Fe, Argentina");
  assert.equal($(dom, "#selected-location").value, "loc-0");
  assert.equal(dom.lookups, 1);
});

test("typeahead: an exact suggestion beats an earlier prefix match", async () => {
  const { dom } = onPage(LOCATION, LOCATION_JS().replace("const cities = ", "const cities = ['Rosario del Tala, Entre Rios', 'Rosario'].concat(").replace(";\n  const inp", ");\n  const inp"));
  const o = await fill({ selector: "#loc", text: "rosario" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Rosario");
  assert.equal($(dom, "#loc").value, "Rosario");
});

test("typeahead: no suggestion is ok:false and the typed text is withdrawn", async () => {
  const { dom } = onPage(LOCATION, LOCATION_JS());
  const o = await fill({ label_pattern: "location", text: "Zzyzx" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.match(o.error, /no suggestion/);
  assert.equal($(dom, "#loc").value, "");
  assert.equal($(dom, "#selected-location").value, "");
});

test("typeahead: a pick that leaves the hidden companion empty is not claimed", async () => {
  const { dom } = onPage(LOCATION, LOCATION_JS(false).replace("if (!hid.value) inp.value = '';", ""));
  const o = await fill({ label_pattern: "location", text: "Toronto" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /"Toronto, ON, Canada" but the hidden field stayed empty/);
  assert.equal($(dom, "#selected-location").value, "");
});

test("typeahead: a pick the widget drops on blur is reported", async () => {
  const { dom } = onPage(LOCATION, LOCATION_JS().replace("if (!hid.value) inp.value = '';", "inp.value = '';"));
  const o = await fill({ label_pattern: "location", text: "Rosario" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /doesn't show it/);
  assert.equal($(dom, "#loc").value, "");
});

test("typeahead: a hidden companion alone means a pick is required", async () => {
  const { dom } = onPage(LOCATION, LOCATION_JS().replace("if (!hid.value) inp.value = '';", ""));
  const o = await fill({ label_pattern: "location", text: "Zzyzx" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal($(dom, "#loc").value, "");
});

test("typeahead: a miss after an earlier pick puts back the text and the hidden value", async () => {
  const { dom } = onPage(LOCATION.replace("id=loc name=location type=text", "id=loc name=location type=text value='Toronto, ON, Canada'").replace("name=selectedLocation>", "name=selectedLocation value=loc-2>"), LOCATION_JS());
  const o = await fill({ label_pattern: "location", text: "Zzyzx" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal($(dom, "#loc").value, "Toronto, ON, Canada");
  assert.equal($(dom, "#selected-location").value, "loc-2");
});

// An async combobox whose own listbox fills late, beside another control's
// always-open listbox: only the combobox's own list may be pressed.
const FOREIGN = `<form>
  <div><label for=loc>Location</label><input id=loc role=combobox aria-autocomplete=list aria-controls=loc-list aria-expanded=false><ul id=loc-list role=listbox></ul></div>
  <div><span id=pl>Preferred offices</span><ul role=listbox aria-labelledby=pl aria-multiselectable=true>
    <li role=option id=o1 aria-selected=false>Buenos Aires office</li><li role=option id=o2 aria-selected=false>Rosario office</li></ul></div>
</form>`;
const FOREIGN_JS = `
  const inp = document.getElementById('loc'), ul = document.getElementById('loc-list');
  window.offClicks = [];
  document.querySelectorAll('#o1,#o2').forEach((o) => o.addEventListener('click', () => window.offClicks.push(o.id)));
  inp.addEventListener('input', () => { const q = inp.value.toLowerCase(); later(() => {
    ul.innerHTML = ['Rosario, Santa Fe, Argentina'].filter((c) => c.toLowerCase().startsWith(q)).map((c) => '<li role=option>' + c + '</li>').join('');
    ul.querySelectorAll('li').forEach((o) => o.addEventListener('mousedown', () => { inp.value = o.textContent; ul.innerHTML = ''; }));
  }, 3); });`;

test("typeahead: an empty own list is waited on, never another control's options", async () => {
  const { dom } = onPage(FOREIGN, FOREIGN_JS);
  const o = await fill({ label_pattern: "^location", text: "Rosario" });
  assert.equal(JSON.stringify(dom.offClicks), "[]");
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Rosario, Santa Fe, Argentina");
  assert.equal($(dom, "#loc").value, "Rosario, Santa Fe, Argentina");
});

test("typeahead: a free-text combobox with no suggestions keeps the text, without the long wait", async () => {
  const { dom, world } = onPage(`<form><label for=t>Job title</label><input id=t role=combobox aria-autocomplete=list aria-expanded=false></form>`);
  const t0 = world.clock.t;
  const o = await fill({ label_pattern: "job title", text: "Staff Engineer" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "plain");
  assert.match(o.note, /no suggestion/);
  assert.equal($(dom, "#t").value, "Staff Engineer");
  assert.ok(world.clock.t - t0 < 2000, "waited " + (world.clock.t - t0) + "ms");
});

test("typeahead: a combobox that clears unpicked text on blur is withdrawn", async () => {
  const { dom } = onPage(`<label for=t>Team</label><input id=t role=combobox aria-autocomplete=list>`,
    `const t = document.getElementById('t'); t.addEventListener('blur', () => { t.value = ''; });`);
  const o = await fill({ label_pattern: "team", text: "Platform" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.match(o.error, /withdrawn/);
  assert.equal($(dom, "#t").value, "");
});

// A background tab: focus() and blur() move activeElement but fire no focus
// events, and the document never has focus.
const BACKGROUND_JS = `
  document.hasFocus = () => false;
  const blur = HTMLElement.prototype.blur;
  HTMLElement.prototype.blur = function () {
    const stop = (e) => e.stopPropagation();
    window.addEventListener('blur', stop, true); window.addEventListener('focusout', stop, true);
    blur.call(this);
    window.removeEventListener('blur', stop, true); window.removeEventListener('focusout', stop, true);
  };`;

test("typeahead: in a background tab, text cleared on blur or focusout is still withdrawn", async () => {
  for (const ev of ["blur", "focusout"]) {
    const { dom } = onPage(`<label for=t>Team</label><input id=t role=combobox aria-autocomplete=list>`,
      BACKGROUND_JS + `const t = document.getElementById('t'); t.addEventListener('${ev}', () => { t.value = ''; });`);
    const o = await fill({ label_pattern: "team", text: "Platform" });
    assert.equal(o.ok, false, ev + " " + JSON.stringify(o));
    assert.match(o.error, /withdrawn/);
  }
});

// Two widgets from separate React roots can share an instance id, so both
// inputs name the same listbox id. The typeahead's own list is the one beside it.
const TWIN_IDS = `<div class=a><input role=combobox aria-label=Country aria-controls=rs-2-listbox>
    <div id=rs-2-listbox role=listbox><div role=option id=wrong>Toronto Country</div></div></div>
  <div class=b><label for=c>City</label><input id=c role=combobox aria-autocomplete=list aria-controls=rs-2-listbox>
    <div id=rs-2-listbox role=listbox class=mine></div><input type=hidden name=city></div>`;
const TWIN_IDS_JS = `
  window.wrong = 0; document.getElementById('wrong').addEventListener('click', () => window.wrong++);
  const inp = document.getElementById('c'), mine = document.querySelector('.mine');
  inp.addEventListener('input', () => { later(() => {
    mine.innerHTML = '<div role=option>Toronto, ON, Canada</div>';
    mine.firstChild.addEventListener('click', () => { inp.value = 'Toronto, ON, Canada'; document.querySelector('[name=city]').value = 'to'; });
  }, 3); });`;

test("typeahead: a duplicated list id resolves to the list beside the input", async () => {
  const { dom } = onPage(TWIN_IDS, TWIN_IDS_JS);
  const o = await fill({ label_pattern: "^city", text: "Toronto" });
  assert.equal(dom.wrong, 0);
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Toronto, ON, Canada");
});

// react-select with async loadOptions: role=combobox on an inner input that is
// emptied after a pick; the choice shows in the control and a hidden input.
const ASYNC_SELECT = `<label id=l>City</label>
  <div class="select__container"><div class="select__control"><div class="select__value-container">
    <div class="select__single-value"></div>
    <input role=combobox aria-autocomplete=list aria-labelledby=l id=react-select-2-input>
  </div></div><div class="select__menu"></div><input type=hidden name=city></div>`;
const ASYNC_SELECT_JS = `
  const cities = ${JSON.stringify(CITIES)};
  const inp = document.querySelector('input[role=combobox]'), menu = document.querySelector('.select__menu');
  inp.addEventListener('input', () => {
    window.__q = [];
    const q = inp.value.toLowerCase();
    later(() => {
      menu.innerHTML = cities.filter((c) => c.toLowerCase().includes(q)).map((c) => '<div role=option>' + c + '</div>').join('');
      menu.querySelectorAll('[role=option]').forEach((o) => o.addEventListener('click', () => {
        document.querySelector('.select__single-value').textContent = o.textContent;
        document.querySelector('input[name=city]').value = o.textContent;
        inp.value = '';
        menu.innerHTML = '';
      }));
    }, 4);
  });`;

test("typeahead: async react-select picks after the debounced lookup and reads the control", async () => {
  const { dom } = onPage(ASYNC_SELECT, ASYNC_SELECT_JS);
  const o = await fill({ label_pattern: "city", text: "Toronto" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.equal(o.selected, "Toronto, ON, Canada");
  assert.equal(o.value, "Toronto, ON, Canada");
  assert.equal($(dom, "input[name=city]").value, "Toronto, ON, Canada");
});

test("fill {fields}: a typeahead in the middle is resolved in order", async () => {
  const { dom } = onPage(LOCATION, LOCATION_JS());
  const o = await fill({ fields: [{ selector: "#loc", text: "Rosario del" }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.results.map((r) => r.kind), ["typeahead", "plain"]);
  assert.equal($(dom, "#selected-location").value, "loc-1");
  assert.equal($(dom, "[name=name]").value, "Ada");
});

// ---- page level ----

test("fill_fields: a typeahead stops the pass after typing", () => {
  const w = page(LOCATION);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "name", text: "Ada" }, { selector: "#loc", text: "Ros" }, { label_pattern: "name", text: "B" }] });
  assert.equal(o.defer, 1);
  assert.equal(o.results.length, 1);
  assert.equal(w.document.querySelector("#loc").value, "Ros");
});

// A phone mask beside a country combobox with its own hidden input: the mask
// keeps the national digits and reformats on blur.
const PHONE = `<div class=phone>
  <div class=cc><input role=combobox aria-label=Country><input type=hidden name=country value=AR><div class=dropdown></div></div>
  <input inputmode=tel autocomplete=off aria-label="Phone">
</div>`;
const PHONE_JS = `
  const p = document.querySelector('[inputmode=tel]');
  p.addEventListener('input', () => { p.value = p.value.replace(/\\D/g, '').slice(-10); });
  p.addEventListener('blur', () => { const d = p.value; p.value = d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6); });`;

test("fill: a phone mask that reformats is a digits match, not a failure", () => {
  const w = page(PHONE);
  w.eval(PHONE_JS);
  const o = run(w, "fill", { label_pattern: "phone", text: "+54 (341) 555-1234" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "plain");
  assert.equal(w.document.querySelector("[inputmode=tel]").value, "341-555-1234");
});

test("fill: a mask that drops digits still fails", () => {
  const w = page(PHONE);
  w.eval(PHONE_JS.replace("slice(-10)", "slice(0, 4)"));
  assert.equal(run(w, "fill", { label_pattern: "phone", text: "3415551234" }).ok, false);
  const text = page(`<input aria-label=Code>`);
  text.eval(`const c = document.querySelector('input'); c.addEventListener('input', () => { c.value = '1234567'; });`);
  assert.equal(run(text, "fill", { label_pattern: "code", text: "hello world" }).ok, false);
});

test("fill: a search combobox stays a plain fill", () => {
  const w = page(`<form role=search><input role=combobox aria-autocomplete=list aria-label=Search></form><input role=combobox aria-autocomplete=both name=q aria-label=Query>`);
  assert.equal(run(w, "fill", { label_pattern: "^search", text: "shoes" }).kind, "plain");
  assert.equal(run(w, "fill", { label_pattern: "query", text: "shoes" }).kind, "plain");
});
