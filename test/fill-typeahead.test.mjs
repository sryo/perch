// fill on typeaheads and reformatting inputs. A typeahead keeps only a picked
// suggestion, so fill types, waits for the control's own suggestions (polled
// JXA-side through the fake world), picks, then verifies the visible value and
// any hidden companion. Masked inputs pass on a normalized (digits) match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, taQuery } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";
import { throwAt, noRaw } from "./helpers/fault.mjs";

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

const DROPS_STATE_JS = LOCATION_JS().replace("dd.innerHTML = '';\n      }));", "dd.innerHTML = '';\n        delete window.__perch_ta;\n      }));");

test("typeahead: a pick that drops the page's state is ok:false, alone and in fields", async () => {
  assert.notEqual(DROPS_STATE_JS, LOCATION_JS());
  onPage(LOCATION, DROPS_STATE_JS);
  const o = await fill({ label_pattern: "location", text: "Rosario" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.match(o.error, /^the page changed/);
  assert.equal(Object.hasOwn(o, "__perch_error"), false);
  onPage(LOCATION, DROPS_STATE_JS);
  const b = await fill({ fields: [{ label_pattern: "location", text: "Rosario" }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(b.ok, false, JSON.stringify(b));
  assert.equal(b.results[0].ok, false);
  assert.equal(b.results[0].kind, "typeahead");
  assert.match(b.results[0].error, /^the page changed/);
  assert.equal(b.results[1].ok, true);
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

// React 18 applies an onBlur state change after the blurring script ends: in a
// microtask (or a 0ms timer), which here runs before the next execute.
const DEFERRED = { microtask: "queueMicrotask", timeout: "setTimeout" };
const deferJS = (kind) => `window.${DEFERRED[kind]} = (fn) => later(fn, 1);`;

// react-select with no hidden input: blur resets the typed text.
const RS_NO_HIDDEN = `<label id=l>Team</label><div class="select__container"><div class="select__control">
  <input role=combobox aria-autocomplete=list aria-labelledby=l id=react-select-3-input></div></div>`;
const RS_NO_HIDDEN_JS = (kind) => deferJS(kind) + `
  const inp = document.getElementById('react-select-3-input');
  inp.addEventListener('blur', () => ${DEFERRED[kind]}(() => { inp.value = ''; }));`;

test("typeahead: text a React widget clears after the blur script ends is withdrawn", async () => {
  for (const kind of Object.keys(DEFERRED)) {
    const { dom } = onPage(RS_NO_HIDDEN, RS_NO_HIDDEN_JS(kind));
    const o = await fill({ label_pattern: "team", text: "Zzz" });
    assert.equal(o.ok, false, kind + " " + JSON.stringify(o));
    assert.equal(o.kind, "typeahead");
    assert.match(o.error, /withdrawn/);
    assert.equal($(dom, "#react-select-3-input").value, "");
  }
});

// Downshift's useCombobox: its own listbox filters the items, and blur with
// nothing selected resets the input to the selected item's text ("").
const DOWNSHIFT = `<label id=downshift-0-label for=downshift-0-input>Fruit</label>
  <div><input id=downshift-0-input role=combobox aria-autocomplete=list aria-controls=downshift-0-menu aria-expanded=false></div>
  <ul id=downshift-0-menu role=listbox aria-labelledby=downshift-0-label></ul>`;
const DOWNSHIFT_JS = deferJS("microtask") + `
  const inp = document.getElementById('downshift-0-input'), menu = document.getElementById('downshift-0-menu');
  inp.addEventListener('input', () => { const q = inp.value.toLowerCase();
    menu.innerHTML = ['Apple', 'Banana'].filter((f) => f.toLowerCase().includes(q)).map((f) => '<li role=option>' + f + '</li>').join(''); });
  inp.addEventListener('blur', () => queueMicrotask(() => { inp.value = ''; menu.innerHTML = ''; }));`;

test("typeahead: Downshift with no matching item withdraws the text", async () => {
  const { dom } = onPage(DOWNSHIFT, DOWNSHIFT_JS);
  const o = await fill({ label_pattern: "fruit", text: "Zzz" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /withdrawn/);
  assert.equal($(dom, "#downshift-0-input").value, "");
});

// Its own list showed suggestions, none of them the text: the widget expects a
// pick even though it keeps the typed text on blur.
test("typeahead: own suggestions that never matched are ok:false with the candidates", async () => {
  for (const hideAt of [0, 6]) {
    const { dom } = onPage(`<label for=c>City</label><input id=c role=combobox aria-autocomplete=list aria-controls=c-list><ul id=c-list role=listbox></ul>`,
      `const inp = document.getElementById('c'), ul = document.getElementById('c-list');
      inp.addEventListener('input', () => { later(() => { ul.innerHTML = '<li role=option>Zurich</li><li role=option>Zagreb</li>'; }, 2);
        if (${hideAt}) later(() => { ul.innerHTML = ''; }, ${hideAt}); });`);
    const o = await fill({ label_pattern: "city", text: "Zzz" });
    assert.equal(o.ok, false, hideAt + " " + JSON.stringify(o));
    assert.deepEqual(o.candidates, ["Zurich", "Zagreb"]);
    assert.equal($(dom, "#c").value, "");
  }
});

test("typeahead: a list id with a quote or backslash still resolves to the list beside the input", async () => {
  const { dom } = onPage(TWIN_IDS.replaceAll("rs-2-listbox", `'rs"2\\-listbox'`), TWIN_IDS_JS);
  const o = await fill({ label_pattern: "^city", text: "Toronto" });
  assert.equal(dom.wrong, 0);
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Toronto, ON, Canada");
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

// A location widget whose results wrapper holds plain item divs (no role, no
// item/option class): only the wrapper's class says "results". A pick fills a
// hidden companion with JSON; ArrowDown then Enter picks the highlighted item.
const WRAPPED = `<form><li class=application-question><label><div class=application-label>Location</div><div class=application-field>
  <input id=loc class=location-input name=location required><input type=hidden id=sel name=selectedLocation>
  <div class='x dropdown-container'><div class='dropdown-results'></div><div class=dropdown-no-results style='display:none'>No location found</div>
  <div class=dropdown-loading-results style='display:none'>Loading</div></div></div></label></li></form>`;
const WRAPPED_JS = `
  const inp = document.getElementById('loc'), hid = document.getElementById('sel'), res = document.querySelector('.dropdown-results');
  const items = ['Springfield, Region, Country A', 'Springfield, Other, Country B'];
  let hi = -1;
  const pick = (i) => { inp.value = items[i]; hid.value = JSON.stringify({ name: items[i], id: 'location-' + i }); res.innerHTML = ''; };
  inp.addEventListener('input', () => { hid.value = ''; hi = -1; window.__q = []; later(() => {
    res.innerHTML = items.map((c, i) => "<div class='dropdown-location' id=location-" + i + '>' + c + '</div>').join('');
    res.querySelectorAll('.dropdown-location').forEach((o, i) => { o.addEventListener('mousedown', () => pick(i)); o.addEventListener('click', () => pick(i)); });
  }, 3); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') hi = Math.min(hi + 1, res.children.length - 1);
    if (e.key === 'Enter' && hi >= 0) pick(hi);
  });`;

test("typeahead: a results wrapper of plain item divs offers each item, not the wrapper", async () => {
  const { dom } = onPage(WRAPPED, WRAPPED_JS);
  const miss = await fill({ selector: "#loc", text: "Zzz Nowhere" });
  assert.equal(miss.ok, false, JSON.stringify(miss));
  assert.deepEqual(miss.candidates, ["Springfield, Region, Country A", "Springfield, Other, Country B"]);
  const o = await fill({ selector: "#loc", text: "Springfield, Region, Country A" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Springfield, Region, Country A");
  assert.equal($(dom, "#loc").value, "Springfield, Region, Country A");
  assert.deepEqual(JSON.parse($(dom, "#sel").value), { name: "Springfield, Region, Country A", id: "location-0" });
});

// A combobox whose own listbox fills asynchronously with accented suggestions;
// a pick shows in the control's single-value slot.
const ACCENTS = ["Córdoba, Spain", "Córdoba, Córdoba, Argentina", "Córdoba, Veracruz, Mexico"];
const ACCENT_HTML = (companion) => `<label for=city>City</label><div class=select__container><div class=select__control>
  <div class=select__single-value></div>
  <input id=city class=select__input role=combobox aria-autocomplete=list aria-controls=city-list placeholder="Start typing...">
  </div><div id=city-list role=listbox></div>${companion ? "<input type=hidden name=city>" : ""}</div>`;
const ACCENT_JS = `
  const inp = document.getElementById('city'), ul = document.getElementById('city-list'), hid = document.querySelector('input[name=city]');
  window.picks = [];
  inp.addEventListener('input', () => { window.__q = []; const q = inp.value; later(() => {
    ul.innerHTML = q ? ${JSON.stringify(ACCENTS)}.map((c) => '<div role=option>' + c + '</div>').join('') : '';
    ul.querySelectorAll('[role=option]').forEach((o) => o.addEventListener('click', () => {
      window.picks.push(o.textContent);
      document.querySelector('.select__single-value').textContent = o.textContent;
      if (hid) hid.value = o.textContent;
      inp.value = ''; ul.innerHTML = '';
    }));
  }, 3); });`;

test("typeahead: accents fold and typed words match in order", async () => {
  for (const companion of [true, false]) {
    for (const text of ["Cordoba, Argentina", "Córdoba, Argentina"]) {
      const { dom } = onPage(ACCENT_HTML(companion), ACCENT_JS);
      const o = await fill({ selector: "#city", text });
      assert.equal(o.ok, true, text + " " + JSON.stringify(o));
      assert.equal(o.selected, "Córdoba, Córdoba, Argentina");
      assert.equal($(dom, ".select__single-value").textContent, "Córdoba, Córdoba, Argentina");
    }
    const { dom } = onPage(ACCENT_HTML(companion), ACCENT_JS);
    const o = await fill({ selector: "#city", text: "Cordoba Mexico" });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(o.selected, "Córdoba, Veracruz, Mexico");
    assert.equal(dom.picks.length, 1);
  }
});

test("typeahead: several suggestions equally matching the text pick nothing and say so", async () => {
  for (const companion of [true, false]) {
    const { dom, world } = onPage(ACCENT_HTML(companion), ACCENT_JS);
    const t0 = world.clock.t;
    const o = await fill({ selector: "#city", text: "Cordoba" });
    assert.equal(o.ok, false, JSON.stringify(o));
    assert.equal(o.ambiguous, true);
    assert.match(o.error, /^several suggestions matched "Cordoba" equally; give a more specific text/);
    assert.ok(world.clock.t - t0 < 1000, "a stable tie returns without the full wait: " + (world.clock.t - t0) + "ms");
    assert.deepEqual(o.candidates, ACCENTS);
    assert.equal(dom.picks.length, 0);
    assert.equal($(dom, "#city").value, "");
  }
});

test("typeahead: a tie that holds through a debounce still waits for the fresh list", async () => {
  // The tied list sits unchanged for several polls (a stale list during a
  // debounce) before the exact suggestion arrives.
  const { dom } = onPage(ACCENT_HTML(true), ACCENT_JS + `
    inp.addEventListener('input', () => { later(() => {
      ul.insertAdjacentHTML('beforeend', '<div role=option>Cordoba</div>');
      ul.lastChild.addEventListener('click', () => { window.picks.push('Cordoba'); document.querySelector('.select__single-value').textContent = 'Cordoba'; hid.value = 'Cordoba'; inp.value = ''; ul.innerHTML = ''; });
    }, 8); });`);
  const o = await fill({ selector: "#city", text: "Cordoba" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Cordoba");
  assert.deepEqual([...dom.picks], ["Cordoba"]);
});

test("typeahead: a tie in a list still growing waits for the list to settle", async () => {
  const { dom } = onPage(ACCENT_HTML(true), ACCENT_JS + `
    const add = (t) => {
      ul.insertAdjacentHTML('beforeend', '<div role=option>' + t + '</div>');
      ul.lastChild.addEventListener('click', () => { window.picks.push(t); document.querySelector('.select__single-value').textContent = t; hid.value = t; inp.value = ''; ul.innerHTML = ''; });
    };
    inp.addEventListener('input', () => { later(() => add('Córdoba, Chile'), 4); later(() => add('Cordoba'), 5); });`);
  const o = await fill({ selector: "#city", text: "Cordoba" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Cordoba");
  assert.deepEqual([...dom.picks], ["Cordoba"]);
});

// A lookup that answers every query but one with the same unrelated suggestion
// after `ticks` polls; `stale` shows that suggestion before anything is typed.
const SUGGEST_JS = (ticks, stale) => LOCATION_JS()
  .replace("cities.filter((c) => q && c.toLowerCase().startsWith(q))", "(q === 'zzyzx springs' ? ['Zzyzx Springs, CA'] : ['Toronto, ON, Canada'])")
  .replace("}, 3);", `}, ${ticks});`) + (stale ? `dd.innerHTML = '<div class=dropdown-item>Toronto, ON, Canada</div>';` : "");

test("typeahead: suggestions that answer the text without a match end the wait once they hold", async () => {
  const { dom, world } = onPage(LOCATION, SUGGEST_JS(3));
  const t0 = world.clock.t;
  const o = await fill({ label_pattern: "location", text: "Zzyzx" });
  const ms = world.clock.t - t0;
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /no suggestion/);
  assert.deepEqual(o.candidates, ["Toronto, ON, Canada"]);
  assert.equal($(dom, "#loc").value, "");
  assert.ok(ms < 1200, "waited " + ms + "ms");
});

test("typeahead: a list already shown when typing is waited past until it changes", async () => {
  const { dom } = onPage(LOCATION, SUGGEST_JS(14, true));
  const o = await fill({ label_pattern: "location", text: "Zzyzx Springs" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Zzyzx Springs, CA");
  assert.equal($(dom, "#loc").value, "Zzyzx Springs, CA");
});

test("typeahead: a list that empties after typing is waited on", async () => {
  onPage(LOCATION, SUGGEST_JS(14, true) + `inp.addEventListener('input', () => later(() => { dd.innerHTML = ''; }, 2));`);
  const o = await fill({ label_pattern: "location", text: "Zzyzx Springs" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Zzyzx Springs, CA");
});

// A lookup that runs only on trusted input, and a browser editing command that
// delivers one (as Chrome's insertText does in a background tab).
const TRUSTED_ONLY_JS = (lookup = LOCATION_JS()) => lookup.replace("inp.addEventListener('input', () => {", "inp.addEventListener('input', (e) => { if (!e.isTrusted) return;") + `
  document.execCommand = (_command, _ui, text) => {
    const el = document.activeElement;
    el.value = el.value.slice(0, el.selectionStart) + text + el.value.slice(el.selectionEnd);
    const ev = new Event('input', { bubbles: true });
    Object.defineProperty(ev, 'isTrusted', { value: true });
    el.dispatchEvent(ev);
    return true;
  };`;

test("typeahead: a lookup that ignores synthetic input misses on a plain fill", async () => {
  const { dom } = onPage(LOCATION, TRUSTED_ONLY_JS());
  const o = await fill({ label_pattern: "location", text: "Rosario" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(dom.lookups, 0);
  assert.equal($(dom, "#loc").value, "");
});

test("typeahead: a trusted fill types through the editing command and picks the suggestion", async () => {
  const { dom, world } = onPage(LOCATION, TRUSTED_ONLY_JS());
  const o = await fill({ label_pattern: "location", text: "Rosario", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.equal(o.trusted, true);
  assert.equal(o.selected, "Rosario, Santa Fe, Argentina");
  assert.equal($(dom, "#loc").value, "Rosario, Santa Fe, Argentina");
  assert.equal($(dom, "#selected-location").value, "loc-0");
  assert.equal(dom.lookups, 1);
  assert.equal(world.counts["win.activeTabIndex="], undefined);
  assert.equal(world.posted.length, 0);
});

test("typeahead: a trusted fill with no suggestion withdraws the text, never ok", async () => {
  const { dom } = onPage(
    LOCATION.replace("id=loc name=location type=text", "id=loc name=location type=text value=Lyon").replace("name=selectedLocation>", "name=selectedLocation value=loc-9>"),
    TRUSTED_ONLY_JS(LOCATION_JS().replace("cities.filter((c) => q && c.toLowerCase().startsWith(q))", "[]")));
  const o = await fill({ label_pattern: "location", text: "Zzyzx", trusted: true });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.equal(o.trusted, true);
  assert.match(o.error, /no suggestion/);
  assert.equal($(dom, "#loc").value, "Lyon");
  assert.equal($(dom, "#selected-location").value, "loc-9");
});

test("trusted_fill_background: a typeahead is left pending with its state recorded", () => {
  const dom = page(LOCATION);
  dom.eval(TRUSTED_ONLY_JS().replace(/later\(/g, "(fn => fn)("));
  let keyup = null;
  $(dom, "#loc").addEventListener("keyup", (e) => { keyup = e.key; });
  const o = run(dom, "trusted_fill_background", { selector: "#loc", text: "Rosario" });
  assert.deepEqual(o, { pending: true, trusted: true });
  assert.equal(keyup, "o");
  assert.equal(dom.__perch_ta.text, "Rosario");
  assert.equal(dom.__perch_ta.prior, "");
  assert.equal(dom.__perch_ta.comp, $(dom, "#selected-location"));
});

// A combobox whose own listbox offers suggestions but whose pick handler runs
// only `onPick` (nothing by default); it keeps whatever text is typed on blur.
const INERT = `<form><label for=c>City</label><input id=c role=combobox aria-autocomplete=list aria-controls=c-list><ul id=c-list role=listbox></ul>
  <label>Name <input name=name></label></form>`;
const INERT_JS = (options, onPick = "") => `
  const inp = document.getElementById('c'), ul = document.getElementById('c-list');
  inp.addEventListener('input', () => { window.__q = []; later(() => {
    ul.innerHTML = ${JSON.stringify(options)}.map((c) => '<li role=option>' + c + '</li>').join('');
    ul.querySelectorAll('li').forEach((o) => o.addEventListener('click', () => { ${onPick} }));
  }, 2); });`;

test("typeahead: a pick that leaves only the typed text in the field is not claimed", async () => {
  const { dom } = onPage(INERT, INERT_JS(["Buenos Aires"]));
  const o = await fill({ label_pattern: "^city", text: "Buenos" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.equal(o.error, 'picked "Buenos Aires" but the field still shows only the typed text');
  assert.equal($(dom, "#c").value, "Buenos");
});

test("fill {fields}: a pick that leaves only the typed text fails its entry", async () => {
  const { dom } = onPage(INERT, INERT_JS(["Buenos Aires"]));
  const o = await fill({ fields: [{ label_pattern: "^city", text: "Buenos" }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results[0].ok, false);
  assert.match(o.results[0].error, /still shows only the typed text/);
  assert.equal(o.results[1].ok, true);
  assert.equal($(dom, "[name=name]").value, "Ada");
});

test("typeahead: a pick that shortens the value to more than the typed text is proof", async () => {
  const { dom } = onPage(INERT, INERT_JS(["New York, NY, USA"], "inp.value = 'New York'; ul.innerHTML = '';"));
  const o = await fill({ label_pattern: "^city", text: "New Yo" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "New York, NY, USA");
  assert.equal($(dom, "#c").value, "New York");
});

test("typeahead: a pick the widget ignores is not claimed when the typed text equals the option", async () => {
  const { dom } = onPage(INERT, INERT_JS(["Buenos Aires"]));
  const o = await fill({ label_pattern: "^city", text: "Buenos Aires" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /still shows only the typed text/);
  assert.equal($(dom, "#c").value, "Buenos Aires");
});

test("typeahead: a list that closes without the field showing the pick is not claimed", async () => {
  const { dom } = onPage(INERT, INERT_JS(["Buenos Aires"], "ul.innerHTML = '';"));
  const o = await fill({ label_pattern: "^city", text: "Buenos" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /still shows only the typed text/);
  assert.equal($(dom, "#c").value, "Buenos");
});

test("typeahead: an exact-text pick the widget accepts by closing its list is proof", async () => {
  const { dom } = onPage(INERT, INERT_JS(["Buenos Aires"], "ul.innerHTML = '';"));
  const o = await fill({ label_pattern: "^city", text: "Buenos Aires" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Buenos Aires");
  assert.equal($(dom, "#c").value, "Buenos Aires");
});

// A prefilled companion the widget keeps while typing and never updates on a pick.
const PREFILLED_INERT_JS = LOCATION_JS().replace("hid.value = '';", "").replace("inp.value = o.textContent;", "return;")
  .replace("const cities = ", "const cities = ['Paris, France'].concat(").replace(";\n  const inp", ");\n  const inp");

test("typeahead: a pick that leaves a prefilled hidden field unchanged is not claimed", async () => {
  const { dom } = onPage(LOCATION.replace("name=selectedLocation>", "name=selectedLocation value=loc-7>"), PREFILLED_INERT_JS);
  const o = await fill({ label_pattern: "location", text: "Paris, France" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /hidden field didn't change/);
  assert.equal($(dom, "#selected-location").value, "loc-7");
  assert.equal($(dom, "#loc").value, "Paris, France");
});

test("typeahead: re-picking the value a prefilled hidden field already holds is accepted when the list closes", async () => {
  const { dom } = onPage(LOCATION.replace("name=selectedLocation>", "name=selectedLocation value=loc-2>"), LOCATION_JS().replace("hid.value = '';", ""));
  const o = await fill({ label_pattern: "location", text: "Toronto, ON, Canada" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal($(dom, "#selected-location").value, "loc-2");
});

// ---- short-query fallback ----

// A location lookup that answers only accent-free queries of 12 characters or
// less, the way many location services miss "Córdoba, Argentina" but find
// "cordoba". `typed` records only typing, not a withdraw's restore.
const SHORT_LOOKUP = (cities, answers = "q.length <= 12 && !/[^\\x00-\\x7f]/.test(q)") => `
  const cities = ${JSON.stringify(cities)};
  const inp = document.getElementById('loc'), hid = document.getElementById('selected-location');
  const dd = document.querySelector('.dropdown-container');
  const fold = (s) => s.normalize('NFD').replace(/\\p{M}+/gu, '').toLowerCase();
  window.lookups = 0; window.typed = [];
  inp.addEventListener('input', (e) => {
    if (e.inputType === 'insertText') window.typed.push(inp.value);
    hid.value = '';
    window.__q = [];
    const q = inp.value.toLowerCase();
    later(() => {
      window.lookups++;
      const hits = q && (${answers}) ? cities.filter((c) => fold(c).startsWith(fold(q))) : [];
      dd.innerHTML = hits.map((c) => '<div class=dropdown-item data-id=' + cities.indexOf(c) + '>' + c + '</div>').join('');
      dd.querySelectorAll('.dropdown-item').forEach((o) => o.addEventListener('mousedown', () => {
        inp.value = o.textContent; hid.value = 'loc-' + o.dataset.id; dd.innerHTML = '';
      }));
    }, 3);
  });
  inp.addEventListener('blur', () => { window.__q = []; dd.innerHTML = ''; if (!hid.value) inp.value = ''; });`;
const CORDOBAS = ["Córdoba, Argentina", "Córdoba, Veracruz, Mexico", "Córdoba, Andalusia, Spain"];

test("typeahead: a lookup that finds nothing for the full text retries once with a short accent-free query", async () => {
  const { dom } = onPage(LOCATION, SHORT_LOOKUP(CORDOBAS));
  const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.equal(o.query, "cordoba");
  assert.equal(o.selected, "Córdoba, Argentina");
  assert.equal($(dom, "#loc").value, "Córdoba, Argentina");
  assert.equal($(dom, "#selected-location").value, "loc-0");
  assert.deepEqual([...dom.typed], ["Córdoba, Argentina", "cordoba"]);
});

test("typeahead: a short query that finds two equal hits is ambiguous and puts back the prior value", async () => {
  const { dom } = onPage(
    LOCATION.replace("id=loc name=location type=text", "id=loc name=location type=text value=Lyon").replace("name=selectedLocation>", "name=selectedLocation value=loc-9>"),
    SHORT_LOOKUP(["Córdoba, Córdoba, Argentina", "Córdoba, Santa Fe, Argentina", "Córdoba, Spain"]));
  const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.ambiguous, true);
  assert.equal(o.query, "cordoba");
  assert.match(o.error, /^several suggestions matched "Córdoba, Argentina" equally/);
  assert.deepEqual(o.candidates, ["Córdoba, Córdoba, Argentina", "Córdoba, Santa Fe, Argentina", "Córdoba, Spain"]);
  assert.equal($(dom, "#loc").value, "Lyon");
  assert.equal($(dom, "#selected-location").value, "loc-9");
});

test("typeahead: a short query that finds nothing either withdraws once, with the query reported", async () => {
  const { dom } = onPage(LOCATION, SHORT_LOOKUP(CORDOBAS, "false"));
  const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.query, "cordoba");
  assert.match(o.error, /^no suggestion matched "Córdoba, Argentina"; the text was withdrawn/);
  assert.equal($(dom, "#loc").value, "");
  assert.equal($(dom, "#selected-location").value, "");
  assert.deepEqual([...dom.typed], ["Córdoba, Argentina", "cordoba"]);
});

test("typeahead: a lookup that answers the full text never retypes", async () => {
  const { dom } = onPage(LOCATION, SHORT_LOOKUP(CORDOBAS, "true"));
  const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal("query" in o, false);
  assert.equal(o.selected, "Córdoba, Argentina");
  assert.deepEqual([...dom.typed], ["Córdoba, Argentina"]);
  assert.equal(dom.lookups, 1);
});

test("typeahead: suggestions without a hit for the full text withdraw without a short query", async () => {
  const { dom } = onPage(LOCATION, SHORT_LOOKUP(["Zurich", "Zagreb"], "true").replace("cities.filter((c) => fold(c).startsWith(fold(q)))", "cities"));
  const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal("query" in o, false);
  assert.deepEqual(o.candidates, ["Zurich", "Zagreb"]);
  assert.deepEqual([...dom.typed], ["Córdoba, Argentina"]);
  assert.equal($(dom, "#loc").value, "");
});

test("fill {fields}: a typeahead entry gets the short-query retry too", async () => {
  const { dom } = onPage(LOCATION, SHORT_LOOKUP(CORDOBAS));
  const o = await fill({ fields: [{ selector: "#loc", text: "Córdoba, Argentina" }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.results[0].kind, "typeahead");
  assert.equal(o.results[0].query, "cordoba");
  assert.equal(o.results[0].selected, "Córdoba, Argentina");
  assert.equal($(dom, "#selected-location").value, "loc-0");
  assert.equal($(dom, "[name=name]").value, "Ada");
});


test("typeahead: a pick that throws is ok:false with the error name only", async () => {
  const { dom } = onPage(LOCATION, LOCATION_JS());
  const threw = throwAt(dom, "if (A.probe) return !!(s.comp");
  const o = await fill({ label_pattern: "location", text: "Rosario" });
  assert.ok(threw() > 0);
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.match(o.error, /\(TypeError\)/);
  assert.doesNotMatch(o.error, /page changed/);
  noRaw(o);
});

test("typeahead: a short-query retype that throws is ok:false with the error name only, alone and in fields", async () => {
  let { dom } = onPage(LOCATION, SHORT_LOOKUP(CORDOBAS));
  let threw = throwAt(dom, "taType(s.el, A.query);");
  const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina" });
  assert.equal(threw(), 1);
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.equal(o.query, "cordoba");
  assert.match(o.error, /\(TypeError\)/);
  noRaw(o);
  ({ dom } = onPage(LOCATION, SHORT_LOOKUP(CORDOBAS)));
  threw = throwAt(dom, "taType(s.el, A.query);");
  const b = await fill({ fields: [{ selector: "#loc", text: "Córdoba, Argentina" }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(threw(), 1);
  assert.equal(b.ok, false, JSON.stringify(b));
  assert.equal(b.results[0].ok, false);
  assert.equal(b.results[0].kind, "typeahead");
  assert.match(b.results[0].error, /\(TypeError\)/);
  assert.equal(b.results[1].ok, true);
  noRaw(b);
});

test("taQuery: the first comma part, accents folded, at most two words when long; null when nothing shorter", () => {
  assert.equal(taQuery("Córdoba, Argentina"), "cordoba");
  assert.equal(taQuery("  São  Paulo , SP, Brazil"), "sao paulo");
  assert.equal(taQuery("Córdoba"), "cordoba");
  assert.equal(taQuery("Ñuñoa, Santiago"), "nunoa");
  assert.equal(taQuery("San Miguel de Tucumán, Argentina"), "san miguel");
  assert.equal(taQuery("Rio Grande do Sul"), "rio grande");
  assert.equal(taQuery("Buenos Aires Province, Argentina"), "buenos aires");
  assert.equal(taQuery("Mar del Plata, Argentina"), "mar del plata");
  assert.equal(taQuery("Rosario"), null);
  assert.equal(taQuery("rosario"), null);
  assert.equal(taQuery("  Rosario  "), null);
  assert.equal(taQuery("A, Argentina"), null);
  assert.equal(taQuery(", Argentina"), null);
  assert.equal(taQuery(""), null);
});

// Two typeaheads with hidden companions on one page, each with its own lookup.
const TWO_TA = `<form>
  <div><label for=org>Origin</label><input id=org name=origin autocomplete=off><input type=hidden id=org-id name=originId><div class=dropdown-container id=org-dd></div></div>
  <div><label for=dst>Destination</label><input id=dst name=destination autocomplete=off><input type=hidden id=dst-id name=destinationId><div class=dropdown-container id=dst-dd></div></div>
</form>`;
const TWO_TA_JS = `
  const cities = ['Rome, Italy', 'Paris, France', 'Porto, Portugal'];
  for (const k of ['org', 'dst']) {
    const inp = document.getElementById(k), hid = document.getElementById(k + '-id'), dd = document.getElementById(k + '-dd');
    inp.addEventListener('input', () => {
      hid.value = '';
      const q = inp.value.toLowerCase();
      later(() => {
        dd.innerHTML = cities.filter((c) => q && c.toLowerCase().startsWith(q)).map((c) => '<div class=dropdown-item data-id=' + cities.indexOf(c) + '>' + c + '</div>').join('');
        dd.querySelectorAll('.dropdown-item').forEach((o) => o.addEventListener('mousedown', () => { inp.value = o.textContent; hid.value = k + '-' + o.dataset.id; dd.innerHTML = ''; }));
      }, 3);
    });
    inp.addEventListener('blur', () => { dd.innerHTML = ''; if (!hid.value) inp.value = ''; });
  }`;

test("typeahead: two concurrent fills on one tab each pick and report their own field", async () => {
  const { dom } = onPage(TWO_TA, TWO_TA_JS);
  const [a, b] = await Promise.all([fill({ label_pattern: "origin", text: "Rome" }), fill({ label_pattern: "destination", text: "Paris" })]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(a.selected, "Rome, Italy");
  assert.equal(b.selected, "Paris, France");
  assert.equal($(dom, "#org").value, "Rome, Italy");
  assert.equal($(dom, "#org-id").value, "org-0");
  assert.equal($(dom, "#dst").value, "Paris, France");
  assert.equal($(dom, "#dst-id").value, "dst-1");
});
