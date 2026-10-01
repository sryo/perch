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
import { readFileSync } from "node:fs";

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

// A browser's focus() scrolls its field into view unless told not to, and a
// page may scroll on focus itself; either way the fill leaves the page's
// scroll where it was, window and scrolled container alike.
test("typeahead: a fill leaves the window and a scrolled container where they were", async () => {
  for (const pageScrolls of [false, true]) {
    const { dom } = onPage(`<div id=pane style="overflow:auto;height:60px">${LOCATION}</div>`, LOCATION_JS() + `
      const pane = document.getElementById('pane');
      const focus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (o) { if (!(o && o.preventScroll)) { window.scrollTo(0, 0); pane.scrollTop = 0; } return focus.call(this, o); };
      ${pageScrolls ? "document.getElementById('loc').addEventListener('focus', () => { window.scrollTo(0, 0); pane.scrollTop = 0; });" : ""}
      window.scrollTo(0, 400); pane.scrollTop = 30;`);
    const o = await fill({ label_pattern: "location", text: "Rosario" });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal($(dom, "#loc").value, "Rosario, Santa Fe, Argentina");
    assert.deepEqual([dom.scrollY, $(dom, "#pane").scrollTop], [400, 30], `page scrolls on focus: ${pageScrolls}`);
  }
});

// Only the scroll focusing caused is undone: a page that scrolls as the text
// comes in (to show its suggestions) keeps that scroll.
test("typeahead: a scroll the page makes on input is kept", async () => {
  const { dom } = onPage(LOCATION, LOCATION_JS() + `
    document.getElementById('loc').addEventListener('input', () => window.scrollTo(0, 250));
    window.scrollTo(0, 400);`);
  const o = await fill({ label_pattern: "location", text: "Rosario" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(dom.scrollY, 250);
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
  assert.equal(o.value ?? o.selected, "Toronto, ON, Canada");
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

// Lever's location lookup answers the city alone with its abbreviated form.
test("typeahead: a state and country typed in full pick their abbreviated suggestion", async () => {
  const { dom } = onPage(LOCATION, SHORT_LOOKUP(["Tuscaloosa, AL, USA"]));
  const o = await fill({ label_pattern: "location", text: "Tuscaloosa, Alabama, United States" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Tuscaloosa, AL, USA");
  assert.equal($(dom, "#loc").value, "Tuscaloosa, AL, USA");
  assert.equal($(dom, "#selected-location").value, "loc-0");
});

// Rippling's lookup lists places inside the city after the city itself.
test("typeahead: of suggestions naming the typed place, the one that starts with it is picked", async () => {
  const opts = ["Tuscaloosa, Alabama, EE. UU.", "Cottondale, Tuscaloosa, Alabama, EE. UU.", "Northport, Tuscaloosa, Alabama, EE. UU."];
  const { dom } = onPage(LOCATION, LOCATION_JS().replace(JSON.stringify(CITIES), JSON.stringify(opts)).replace("cities.filter((c) => q && c.toLowerCase().startsWith(q))", "(q ? cities : [])"));
  const o = await fill({ label_pattern: "location", text: "Tuscaloosa, Alabama" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Tuscaloosa, Alabama, EE. UU.");
  assert.equal($(dom, "#selected-location").value, "loc-0");
});

// Lever's location field (its retrieveLocations.js): a keydown starts a
// debounced lookup that empties the results, shows a spinner row (text
// "Loading") while the request runs, then appends one div per result inside a
// .dropdown-results wrapper. A pick is a document-level mousedown delegated to
// .dropdown-location, read from event.target's id and text; blur with the list
// shown clears both fields.
const LEVER = `<div class=application-field><input id=location-input class=location-input name=location type=text>
  <input type=hidden id=selected-location name=selectedLocation>
  <div class=dropdown-container style="display:none"><div class=dropdown-results></div>
  <div class=dropdown-no-results style="display:none">No location found. Try entering a different location</div>
  <div class=dropdown-loading-results style="display:none"><svg class="icon icon-loading-spinner"></svg><span>Loading</span></div></div></div>
  <label>Name <input name=name></label>`;
const LEVER_JS = (answer, ticks = 6) => `
  const inp = document.getElementById('location-input'), hid = document.getElementById('selected-location');
  const box = document.querySelector('.dropdown-container'), res = box.querySelector('.dropdown-results');
  const none = box.querySelector('.dropdown-no-results'), spin = box.querySelector('.dropdown-loading-results');
  let searched;
  window.picks = 0;
  const empty = () => { res.innerHTML = ''; none.style.display = 'none'; spin.style.display = 'none'; searched = undefined; };
  inp.addEventListener('input', () => { box.style.display = 'flex'; });
  inp.addEventListener('keydown', () => {
    window.__q = [];
    later(() => {
      empty();
      if (!inp.value) return;
      spin.style.display = 'flex';
      later(() => {
        spin.style.display = 'none';
        searched = ${JSON.stringify(answer)}.map((name, i) => ({ name, id: 'id' + i }));
        searched.forEach((l, i) => res.insertAdjacentHTML('beforeend', '<div class="break-word dropdown-location" id="location-' + i + '">' + l.name + '</div>'));
        if (!searched.length) none.style.display = 'flex';
      }, ${ticks});
    }, 2);
  });
  inp.addEventListener('blur', () => { if (box.style.display !== 'none') { box.style.display = 'none'; empty(); inp.value = ''; hid.value = ''; } });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.classList || !e.target.classList.contains('dropdown-location')) return;
    window.picks++;
    box.style.display = 'none';
    inp.value = e.target.textContent;
    hid.value = JSON.stringify(searched[e.target.id.split('-')[1]]);
    empty();
  });`;

test("typeahead: a lone suggestion inside a results wrapper is pressed itself, not the wrapper", async () => {
  const { dom } = onPage(LEVER, LEVER_JS(["Tuscaloosa, AL, USA"]));
  const o = await fill({ selector: "#location-input", text: "Tuscaloosa, Alabama, United States" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Tuscaloosa, AL, USA");
  assert.equal($(dom, "#location-input").value, "Tuscaloosa, AL, USA");
  assert.equal($(dom, "#selected-location").value, JSON.stringify({ name: "Tuscaloosa, AL, USA", id: "id0" }));
  assert.equal(dom.picks, 1);
});

test("typeahead: suggestions are not read while the list shows a loading row", async () => {
  const { dom } = onPage(LEVER, LEVER_JS(["Tuscaloosa, AL, USA", "Tuscaloosa County, AL, USA"], 25));
  const o = await fill({ selector: "#location-input", text: "Tuscaloosa, Alabama, United States" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Tuscaloosa, AL, USA");
  assert.equal(dom.picks, 1);
});

test("typeahead: a loading row is never a candidate", async () => {
  const { dom } = onPage(LEVER, LEVER_JS(["Birmingham, AL, USA"], 80));
  const o = await fill({ selector: "#location-input", text: "Tuscaloosa, Alabama, United States" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.ok(!(o.candidates || []).includes("Loading"), JSON.stringify(o));
  assert.equal(dom.picks, 0);
  assert.equal($(dom, "#selected-location").value, "");
});

// Rippling's location field: no role and no aria-expanded, only
// aria-haspopup=listbox; a slow lookup renders the list (and aria-controls)
// well past a second.
const RIPPLING = `<label id=loc-label for=loc>Location</label><div class=a><span class=icon></span>
  <input id=loc aria-labelledby=loc-label aria-autocomplete=list aria-haspopup=listbox autocomplete=off></div><div class=b></div>
  <input type=hidden name=externalPlaceId><label>Name <input name=name></label>`;
const RIPPLING_JS = (ticks) => `
  const inp = document.getElementById('loc'), hold = document.querySelector('.b'), hid = document.querySelector('[name=externalPlaceId]');
  const places = ${JSON.stringify(["Tuscaloosa, Alabama, EE. UU.", "Cottondale, Tuscaloosa, Alabama, EE. UU.", "Northport, Tuscaloosa, Alabama, EE. UU."])};
  inp.addEventListener('input', () => { window.__q = []; hold.innerHTML = ''; later(() => {
    inp.setAttribute('aria-controls', 'loc-list');
    hold.innerHTML = '<ul id=loc-list role=listbox>' + places.map((p, i) => '<li role=option id=loc-list-option-' + i + '><p>' + p + '</p></li>').join('') + '</ul>';
    hold.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => { inp.value = li.textContent; hid.value = 'place-' + li.id.slice(-1); hold.innerHTML = ''; }));
  }, ${ticks}); });`;

test("typeahead: a field that declares a popup list waits past the short bound for a slow lookup", async () => {
  const { dom } = onPage(RIPPLING, RIPPLING_JS(30));
  const o = await fill({ label_pattern: "^location", text: "Tuscaloosa, Alabama" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Tuscaloosa, Alabama, EE. UU.");
  assert.equal($(dom, "#loc").value, "Tuscaloosa, Alabama, EE. UU.");
  assert.equal($(dom, "[name=externalPlaceId]").value, "place-0");
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
  assert.ok(o.error.endsWith("; retry with fill {trusted:true}"), o.error);
  assert.equal(dom.lookups, 0);
  assert.equal($(dom, "#loc").value, "");
});

test("typeahead: a list of other suggestions or a tie names no trusted retry", async () => {
  onPage(LOCATION, SUGGEST_JS(3));
  const miss = await fill({ label_pattern: "location", text: "Zzyzx" });
  assert.equal(miss.ok, false, JSON.stringify(miss));
  assert.ok(miss.candidates.length);
  assert.doesNotMatch(miss.error, /trusted/);
  onPage(ACCENT_HTML(true), ACCENT_JS);
  const tie = await fill({ selector: "#city", text: "Cordoba" });
  assert.equal(tie.ambiguous, true, JSON.stringify(tie));
  assert.doesNotMatch(tie.error, /trusted/);
});

test("fill {fields}: a lookup that ignores synthetic input names the trusted retry in its own slot", async () => {
  const { dom } = onPage(LOCATION + "<label>Email <input name=email></label>", TRUSTED_ONLY_JS());
  const o = await fill({ fields: [{ label_pattern: "^name", text: "Ada" }, { label_pattern: "location", text: "Rosario" }, { label_pattern: "email", text: "a@b.co" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results[0].ok, true);
  assert.ok(o.results[1].error.endsWith("; retry with fill {trusted:true}"), o.results[1].error);
  assert.equal(o.results[2].ok, true);
  assert.equal($(dom, "[name=email]").value, "a@b.co");
});

// A controlled input that puts back what it held after every write, trusted or not.
const REVERT = `<label>Code <input id=code value=A1></label>`;
const REVERT_JS = `const c = document.getElementById('code');
  for (const t of ['input', 'change']) c.addEventListener(t, () => { c.value = 'A1'; });
  document.execCommand = (_command, _ui, text) => {
    const el = document.activeElement;
    el.value = text;
    const ev = new Event('input', { bubbles: true });
    Object.defineProperty(ev, 'isTrusted', { value: true });
    el.dispatchEvent(ev);
    return true;
  };`;

test("fill: a write the page reverts names the trusted retry, but not after a trusted one", async () => {
  onPage(REVERT, REVERT_JS);
  const o = await fill({ label_pattern: "code", text: "B2" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.ok(o.error.endsWith("the page reverted the write; retry with fill {trusted:true}"), o.error);
  onPage(REVERT, REVERT_JS);
  const t = await fill({ label_pattern: "code", text: "B2", trusted: true });
  assert.equal(t.ok, false, JSON.stringify(t));
  assert.doesNotMatch(t.error, /retry with fill/);
});

// A page that empties the field one task after the write: a batch's re-read
// sees it (a single fill's is the next call's check: late.test.mjs).
const LATE_REVERT = `<form><label>Zip <input id=zip name=zip></label><label>City <input id=city name=city></label></form>`;
const LATE_REVERT_JS = `const z = document.getElementById('zip');
  z.addEventListener('input', () => { later(() => { z.value = ''; }, 1); });`;

test("fill {fields}: a field the page undoes a task after the batch is reverted; the others stay ok", async () => {
  const { dom } = onPage(LATE_REVERT, LATE_REVERT_JS);
  const o = await fill({ fields: [{ label_pattern: "zip", text: "2000" }, { label_pattern: "city", text: "Rosario" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results[0].ok, false);
  assert.equal(o.results[0].reverted, true);
  assert.match(o.results[0].error, /^textbox "Zip" was cleared after it was filled; the page reverted the write/);
  assert.equal(o.results[1].ok, true);
  assert.equal($(dom, "#city").value, "Rosario");
});

test("fill {fields}: a box or select the page flips back a task later is reverted too", async () => {
  const { dom } = onPage(`<label><input type=checkbox id=ag> I agree</label><label>Country <select id=co><option value="">Pick</option><option>Chile</option></select></label>`,
    `const ag = document.getElementById('ag'), co = document.getElementById('co');
    ag.addEventListener('change', () => { later(() => { ag.checked = false; }, 1); });
    co.addEventListener('change', () => { later(() => { co.selectedIndex = 0; }, 1); });`);
  const o = await fill({ fields: [{ label_pattern: "agree", checked: true }, { label_pattern: "country", option: "Chile" }] });
  assert.deepEqual(o.results.map((x) => [x.ok, x.reverted]), [[false, true], [false, true]], JSON.stringify(o));
  assert.match(o.results[0].error, /was cleared after it was filled; the page reverted the write$/);
  assert.match(o.results[1].error, /changed to "Pick" after it was filled; the page reverted the write$/);
  assert.equal(dom.document.getElementById("ag").checked, false);
});

// A page that formats what was typed a task later changed it to a value that is
// neither what it held before nor empty: the batch stands, with a note.
const FORMATS_LATER = `<label>Postcode <input id=pc></label><label>Amount <input id=am></label><label>Start <input id=sd></label>`;
const FORMATS_LATER_JS = `const fmt = { pc: (v) => v.toUpperCase(), am: (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 }), sd: (v) => v.split('-').reverse().join('/') };
  for (const id of Object.keys(fmt)) { const e = document.getElementById(id); e.addEventListener('input', () => { later(() => { e.value = fmt[id](e.value); }, 1); }); }`;

test("fill {fields}: a field the page formats a task later keeps ok, with a note", async () => {
  onPage(FORMATS_LATER, FORMATS_LATER_JS);
  const o = await fill({ fields: [{ label_pattern: "postcode", text: "sw1a 1aa" }, { label_pattern: "start", text: "2024-01-05" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.results.map((x) => [x.ok, x.reverted]), [[true, undefined], [true, undefined]]);
  assert.match(o.results[0].note, /changed to "SW1A 1AA" after it was filled; another value replaced it/);
  assert.match(o.results[1].note, /changed to "05\/01\/2024" after it was filled; another value replaced it/);
});

test("fill {fields}: a select the page rebuilds a task later with the same choice holds", async () => {
  onPage(`<label>Country <select id=co><option value="">Pick</option><option value=cl>Chile</option></select></label>`,
    `const co = document.getElementById('co');
    co.addEventListener('change', () => { later(() => { const v = co.value, o = document.createElement('option'); o.value = 'ar'; o.textContent = 'Argentina'; co.insertBefore(o, co.options[1]); co.value = v; }, 1); });`);
  const o = await fill({ fields: [{ label_pattern: "country", option: "Chile" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.results[0], { ok: true, kind: "select", el: o.results[0].el, selected: o.results[0].selected }, JSON.stringify(o));
});

test("fill {fields}: a select a later field's handler rebuilds with the same choice holds", async () => {
  onPage(`<label>Country <select id=co><option value="">Pick</option><option value=cl>Chile</option></select></label><label>City <input id=ci></label>`,
    `const co = document.getElementById('co');
    document.getElementById('ci').addEventListener('input', () => { const v = co.value, o = document.createElement('option'); o.value = 'ar'; o.textContent = 'Argentina'; co.insertBefore(o, co.options[1]); co.value = v; });`);
  const o = await fill({ fields: [{ label_pattern: "country", option: "Chile" }, { label_pattern: "city", text: "Santiago" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.results[0].error, undefined);
});

// A dependent list an earlier field's change rebuilds a task later (a country
// that reloads its regions) comes back on its placeholder: the page did not
// refuse the write, the list was reset under it, so the error names that field.
test("fill {fields}: a select an earlier field's change rebuilds and resets says so and to fill it again", async () => {
  const REGIONS = `<label>Country <select id=co><option value="">Pick</option><option value=ar>Argentina</option><option value=ca>Canada</option></select></label>
    <label>Region <select id=re><option value="">Pick</option><option>Cordoba</option><option>Ontario</option></select></label>`;
  const JS = `const co = document.getElementById('co'), re = document.getElementById('re');
    co.addEventListener('change', () => { later(() => { re.innerHTML = '<option value="">Pick</option>' + (co.value === 'ar' ? ['Cordoba', 'Santa Fe'] : ['Ontario']).map((r) => '<option>' + r + '</option>').join(''); }, 1); });`;
  const { dom } = onPage(REGIONS, JS);
  const o = await fill({ fields: [{ label_pattern: "country", option: "Argentina" }, { label_pattern: "region", option: "Cordoba" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results[0].ok, true);
  const r = o.results[1];
  assert.deepEqual([r.ok, r.reverted, r.kept], [false, true, "Pick"], JSON.stringify(r));
  assert.equal(r.error, `combobox "Region" changed to "Pick" after it was filled; the page rebuilt its options, and fields[0] (combobox "Country") may have changed them; fill it again once that settles`);
  assert.doesNotMatch(r.error, /reverted the write/);
  assert.equal(dom.document.getElementById("re").value, "");
  // Alone, a list rebuilt onto its placeholder is the plain revert: no earlier field to name.
  onPage(REGIONS, JS.replace("co.addEventListener('change'", "re.addEventListener('change'"));
  const a = await fill({ fields: [{ label_pattern: "region", option: "Cordoba" }] });
  assert.match(a.results[0].error, /changed to "Pick" after it was filled; the page reverted the write$/);
  // A checkbox before it drives no list: a select rebuilding its own options is
  // not blamed on it.
  onPage(`<label><input type=checkbox id=ag> I agree</label>` + REGIONS, JS.replace("co.addEventListener('change'", "re.addEventListener('change'"));
  const b = await fill({ fields: [{ label_pattern: "agree", checked: true }, { label_pattern: "region", option: "Cordoba" }] });
  assert.equal(b.results[0].ok, true, JSON.stringify(b));
  assert.match(b.results[1].error, /changed to "Pick" after it was filled; the page reverted the write$/);
});

// A select or radio showing an option other than the one asked for is a miss,
// never a note: unlike text, no page formats one option into another.
test("fill {fields}: a select the page moves to another option a task later is ok:false, a radio too", async () => {
  onPage(`<label>Country <select id=co><option value="">Pick</option><option>Chile</option><option>Peru</option></select></label>
    <fieldset><legend>Size</legend><label><input type=radio name=sz value=s> Small</label><label><input type=radio name=sz value=m> Medium</label><label><input type=radio name=sz value=l> Large</label></fieldset>`,
    `const co = document.getElementById('co'), rs = document.querySelectorAll('[name=sz]');
    co.addEventListener('change', () => { later(() => { co.selectedIndex = 2; }, 1); });
    rs[0].addEventListener('change', () => { later(() => { rs[2].checked = true; }, 1); });`);
  const o = await fill({ fields: [{ label_pattern: "country", option: "Chile" }, { label_pattern: "size", option: "Small" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.results.map((x) => [x.ok, x.reverted, x.note]), [[false, undefined, undefined], [false, undefined, undefined]], JSON.stringify(o));
  assert.match(o.results[0].error, /changed to "Peru" after it was filled; the page chose another option$/);
  assert.equal(o.results[0].kept, "Peru");
  assert.match(o.results[1].error, /changed to "Large" after it was filled; the page chose another option$/);
});

test("fill {fields}: a radio checked by label that the page moves back a task later is reverted, elsewhere a miss", async () => {
  const RADIOS = `<label><input type=radio name=sz value=s checked> Small</label><label><input type=radio name=sz value=m> Medium</label><label><input type=radio name=sz value=l> Large</label>`;
  for (const [to, reverted] of [[0, true], [2, false]]) {
    onPage(RADIOS, `const rs = document.querySelectorAll('[name=sz]');
      rs[1].addEventListener('change', () => { later(() => { rs[${to}].checked = true; }, 1); });`);
    const o = await fill({ fields: [{ label_pattern: "medium", checked: true }] });
    const r = o.results[0];
    if (reverted) assert.deepEqual([r.ok, r.reverted, /is no longer selected after it was filled; the page reverted the write$/.test(r.error)], [false, true, true], JSON.stringify(o));
    else assert.deepEqual([r.ok, r.reverted, r.note, /is no longer selected after it was filled; the page chose another option$/.test(r.error)], [false, undefined, undefined, true], JSON.stringify(o));
  }
});

// A write whose change handler navigates (a jump menu, a form.submit()) leaves
// the re-read unanswered: Chrome drops an execute that lands while a new
// document replaces the old. The re-read is bounded like select's reads, and a
// dropped one keeps the write's answer, never a two-minute wait; the record
// waits for the next call's check (late.test.mjs).
const isReread = (js) => js.includes("items = m && m[A.tok]");
for (const [name, html, args, check] of [
  ["fill {fields}", `<form><label>Search <input id=q></label><label>Sort <select id=so><option>Name</option><option>Price</option></select></label></form>`,
    ["fill", { fields: [{ label_pattern: "search", text: "shoes" }, { label_pattern: "sort", option: "Price" }] }],
    (o) => { assert.equal(o.ok, true, JSON.stringify(o)); assert.deepEqual(o.results.map((r) => r.note), [undefined, undefined]); }],
]) {
  test(`${name}: a re-read whose reply the page drops returns within the poll bound, keeping the write's answer`, async () => {
    for (const target of [undefined, { tabId: "chrome:x" }]) {
      const { world } = onPage(html);
      if (target) await handleCall("list_tabs", {});
      world.state.hangIf = isReread;
      const t0 = world.clock.t;
      const r = await handleCall(args[0], { ...args[1], target });
      const o = JSON.parse(r.content[0].text);
      check(o);
      const took = world.clock.t - t0;
      assert.ok(took <= 2 * 2000 + 500, `${name} ${target ? "targeted" : "untargeted"} took ${took}ms of virtual time`);
      console.log(`# ${name} ${target ? "targeted" : "untargeted"}: ${took}ms virtual`);
    }
  });
}

// Arc and Safari have no bounded page call; a single fill or select sends no
// re-read of its own (the next call's check reads it), so a navigating change
// handler never leaves one waiting.
for (const [name, browser] of [
  ["Arc", { name: "Arc", kind: "arc", windows: [{ id: "W1", active: 0, tabs: [{ url: "https://a.test/", id: "x" }] }] }],
  ["Safari", { name: "Safari", kind: "safari", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x" }] }] }],
]) {
  test(`${name}: fill and select answer from the write alone, with no note`, async () => {
    for (const [tool, html, args, want] of [
      ["fill", `<label>Search <input id=q></label>`, { label_pattern: "search", text: "shoes" }, { ok: true, kind: "plain", el: `textbox "Search"`, len: 5 }],
      ["select", `<label>Sort <select><option>Name</option><option>Price</option></select></label>`, { label_pattern: "sort", text: "Price" }, { ok: true, selected: "Price", el: `combobox "Sort"` }],
    ]) {
      const dom = page(html);
      const spec = structuredClone(browser);
      spec.windows[0].tabs[0].dom = dom;
      const world = makeWorld({ browsers: [spec], cg: [{ owner: name }] });
      world.run(JXA_PRELUDE);
      DAEMONS.fast = world.daemon;
      DAEMONS.slow = world.daemon;
      world.state.hangIf = isReread;
      const t0 = world.clock.t;
      const r = await handleCall(tool, args);
      assert.deepEqual(JSON.parse(r.content[0].text), want, `${name} ${tool}`);
      assert.ok(world.clock.t - t0 < 1000, `${name} ${tool} took ${world.clock.t - t0}ms`);
    }
  });
}

test("fill {fields}: a re-read that finds no record (a new document) keeps the write's answer, with no note", async () => {
  onPage(LATE_REVERT, `document.getElementById('city').addEventListener('input', () => { later(() => { delete window.__perch_fr; }, 1); });`);
  const f = await fill({ fields: [{ label_pattern: "zip", text: "2000" }, { label_pattern: "city", text: "Rosario" }] });
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.deepEqual(f.results.map((r) => r.note), [undefined, undefined]);
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
  assert.doesNotMatch(o.error, /retry with fill/);
  assert.equal($(dom, "#loc").value, "Lyon");
  assert.equal($(dom, "#selected-location").value, "loc-9");
});

test("trusted_fill_background: a typeahead is left pending with its state recorded", () => {
  const dom = page(LOCATION);
  dom.eval(TRUSTED_ONLY_JS().replace(/later\(/g, "(fn => fn)("));
  let keyup = null;
  $(dom, "#loc").addEventListener("keyup", (e) => { keyup = e.key; });
  const o = run(dom, "trusted_fill_background", { selector: "#loc", text: "Rosario", trusted: true });
  assert.deepEqual(o, { pending: true, trusted: true, tok: dom.__perch_ta.tok });
  assert.equal(keyup, "o");
  assert.equal(dom.__perch_ta.text, "Rosario");
  assert.equal(dom.__perch_ta.prior, "");
  assert.equal(dom.__perch_ta.comp, $(dom, "#selected-location"));
});


// ---- trusted entries in fill {fields} ----

const LOC_FORM = LOCATION.replace("</form>", "<label>Email <input name=email></label></form>");
const TRUSTED_ENTRIES = [{ label_pattern: "name", text: "Ada" }, { label_pattern: "location", text: "Rosario", trusted: true }, { label_pattern: "email", text: "a@b.test" }];
const evalCount = (dom) => { const ev = dom.eval.bind(dom), n = { calls: 0 }; dom.eval = (js) => { n.calls++; return ev(js); }; return n; };

test("fill {fields}: a trusted entry types through the editing command and picks its suggestion, in order", async () => {
  const { dom, world } = onPage(LOC_FORM, TRUSTED_ONLY_JS());
  const o = await fill({ fields: TRUSTED_ENTRIES });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.results.map((r) => r.kind), ["plain", "typeahead", "plain"]);
  assert.equal(o.results[1].trusted, true);
  assert.equal(o.results[0].trusted, undefined);
  assert.equal(o.results[1].selected, "Rosario, Santa Fe, Argentina");
  assert.equal($(dom, "#selected-location").value, "loc-0");
  assert.equal($(dom, "[name=name]").value, "Ada");
  assert.equal($(dom, "[name=email]").value, "a@b.test");
  assert.equal(dom.lookups, 1);
  assert.equal(world.counts["win.activeTabIndex="], undefined);
  assert.equal(world.posted.length, 0);
});

test("fill {fields}: the same entry without trusted misses a trusted-only lookup, and the rest land", async () => {
  const { dom } = onPage(LOC_FORM, TRUSTED_ONLY_JS());
  const o = await fill({ fields: TRUSTED_ENTRIES.map(({ trusted, ...f }) => f) });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.results.map((r) => r.ok), [true, false, true]);
  assert.equal(dom.lookups, 0);
});

test("fill {fields}: raise, top-level trusted/raise, and trusted without text refuse before any page call", async () => {
  const { dom } = onPage(LOC_FORM, TRUSTED_ONLY_JS());
  const n = evalCount(dom);
  const at = (i, x) => TRUSTED_ENTRIES.map((e, k) => (k === i ? { ...e, ...x } : e));
  assert.match(await fill({ fields: at(2, { raise: true }) }), /^error: fill: fields\[2\]: raise is not taken inside fields; fill that field alone with raise:true/);
  assert.match(await fill({ fields: at(1, { raise: true }) }), /fields\[1\]: raise/);
  assert.match(await fill({ fields: TRUSTED_ENTRIES, trusted: true }), /fill: `fields` takes trusted per entry, and no raise/);
  assert.match(await fill({ fields: TRUSTED_ENTRIES, raise: true }), /fill: `fields` takes trusted per entry, and no raise/);
  assert.match(await fill({ fields: at(0, { text: "", trusted: true }) }), /fields\[0\]: clearing \(text:""\) does not take trusted/);
  assert.match(await fill({ fields: [{ label_pattern: "agree", checked: true, trusted: true }] }), /fields\[0\]: trusted takes `text`/);
  assert.match(await fill({ fields: [{ label_pattern: "c", option: "x", trusted: true }] }), /fields\[0\]: trusted takes `text`/);
  assert.match(await fill({ fields: [{ label_pattern: "c", text: "x", trusted: "yes" }] }), /fields\[0\]: `trusted` must be a boolean/);
  assert.equal(n.calls, 0);
  assert.equal($(dom, "[name=name]").value, "");
});

test("fill {fields}: a trusted entry on a rich editor fails its slot and later entries land", async () => {
  const { dom } = onPage(LOC_FORM.replace("<form>", "<form><div id=bio contenteditable=true></div>"), TRUSTED_ONLY_JS());
  const o = await fill({ fields: [{ selector: "#bio", text: "Hi", trusted: true }, { label_pattern: "email", text: "a@b.test" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results[0].ok, false);
  assert.match(o.results[0].error, /fill \{trusted:true\} supports plain inputs\/textareas only/);
  assert.equal(o.results[1].ok, true);
  assert.equal($(dom, "#bio").textContent, "");
  assert.equal($(dom, "[name=email]").value, "a@b.test");
});

test("fill {fields}: a trusted entry naming a bot trap is refused or skipped exactly as an untrusted one", async () => {
  const TRAP = LOC_FORM.replace("<form>", `<form><label for=hp>Website</label><input id=hp name=website tabindex=-1 autocomplete=off style="opacity:0">`);
  for (const only_empty of [false, true]) {
    const out = [];
    for (const trusted of [false, true]) {
      const { dom } = onPage(TRAP, TRUSTED_ONLY_JS());
      const o = await fill({ fields: [{ label_pattern: "website", text: "x.test", ...(trusted ? { trusted } : {}) }, { label_pattern: "email", text: "a@b.test" }], only_empty });
      assert.equal($(dom, "#hp").value, "", JSON.stringify(o));
      assert.equal($(dom, "[name=email]").value, "a@b.test");
      out.push(o);
    }
    assert.deepEqual(out[1], out[0]);
    if (only_empty) assert.equal(out[0].results[0].skipped, "trap");
    else assert.match(out[0].results[0].error, /bot trap/);
  }
});

test("fill {fields, only_empty}: a prefilled trusted entry is skipped with no trusted write", async () => {
  const { dom } = onPage(LOC_FORM.replace("<label>Email <input name=email>", "<label>Email <input name=email value=old@b.test>"), TRUSTED_ONLY_JS());
  let edits = 0;
  const ex = dom.document.execCommand;
  dom.document.execCommand = (...a) => { edits++; return ex(...a); };
  const o = await fill({ fields: [{ label_pattern: "email", text: "a@b.test", trusted: true }, { label_pattern: "name", text: "Ada" }], only_empty: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual([o.results[0].skipped, o.results[0].value], ["has value", "old@b.test"]);
  assert.equal(edits, 0);
  assert.equal($(dom, "[name=email]").value, "old@b.test");
  assert.equal($(dom, "[name=name]").value, "Ada");
});

test("fill {fields}: a trusted entry last still gets the final re-read of the fields before it", async () => {
  const { dom } = onPage(LOC_FORM, TRUSTED_ONLY_JS() + `
    document.querySelector('.dropdown-container').addEventListener('mousedown', () => { document.querySelector('[name=name]').value = ''; }, true);`);
  const o = await fill({ fields: [{ label_pattern: "name", text: "Ada" }, { label_pattern: "location", text: "Rosario", trusted: true }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results[0].ok, false);
  // Between passes an earlier field's async effect may be the cause too, so
  // nothing is named.
  assert.match(o.results[0].error, /was cleared after a later field changed; fill it again$/);
  assert.equal(o.results[1].ok, true);
  assert.equal(o.results[1].trusted, true);
  assert.equal($(dom, "#selected-location").value, "loc-0");
});

test("fill {fields}: a plain trusted entry lands through the editing command", async () => {
  const { dom, world } = onPage(LOC_FORM, TRUSTED_ONLY_JS());
  const o = await fill({ fields: [{ label_pattern: "email", text: "a@b.test", trusted: true }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual([o.results[0].kind, o.results[0].trusted, o.results[0].el], ["plain", true, 'textbox "Email"']);
  assert.equal($(dom, "[name=email]").value, "a@b.test");
  assert.equal($(dom, "[name=name]").value, "Ada");
  assert.equal(world.counts["win.activeTabIndex="], undefined);
});

test("fill {fields}: a trusted entry whose editing command gives untrusted input is not claimed trusted", async () => {
  const { dom } = onPage(LOC_FORM, TRUSTED_ONLY_JS().replace("Object.defineProperty(ev, 'isTrusted', { value: true });", ""));
  const o = await fill({ fields: [{ label_pattern: "email", text: "a@b.test", trusted: true }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual([o.results[0].ok, o.results[0].trusted], [false, false]);
  assert.match(o.results[0].error, /did not produce the requested trusted input/);
  assert.equal($(dom, "[name=name]").value, "Ada");
});

test("trusted_fill_background {held}: the field fill_fields held is used once; a changed page is not filled", () => {
  const dom = page(LOC_FORM);
  dom.eval(TRUSTED_ONLY_JS().replace(/later\(/g, "(fn => fn)("));
  const o = run(dom, "fill_fields", { fields: [{ label_pattern: "email", text: "a@b.test", trusted: true }] });
  assert.equal(o.defer, 0);
  assert.equal($(dom, "[name=email]").value, "");
  const K = { label_pattern: "email", text: "a@b.test", trusted: true };
  const s = run(dom, "trusted_fill_background", { held: true, ...K });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.tok, o.tok, "the held state's token");
  assert.equal($(dom, "[name=email]").value, "a@b.test");
  const gone = { ok: false, error: "the page changed before the trusted entry; not filled" };
  assert.deepEqual(run(dom, "trusted_fill_background", { held: true, ...K }), gone);
  assert.deepEqual(run(dom, "trusted_fill_background", { held: true, ...K, text: "x" }), { lost: true, tok: o.tok }, "another entry's held state");
  run(dom, "fill_fields", { fields: [{ label_pattern: "name", text: "Ada", trusted: true }] });
  $(dom, "[name=name]").remove();
  assert.deepEqual(run(dom, "trusted_fill_background", { held: true, label_pattern: "name", text: "Ada", trusted: true }), gone);
});
test("fill {fields}: a trusted entry whose page script throws stays kind plain, in neutral words", async () => {
  const { dom } = onPage(LOC_FORM, TRUSTED_ONLY_JS());
  const threw = throwAt(dom, "if (A.held) {");
  const o = await fill({ fields: [{ label_pattern: "email", text: "a@b.test", trusted: true }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(threw(), 1);
  assert.deepEqual(o.results[0], { ok: false, kind: "plain", error: "fill: the page script failed on this page (TypeError); nothing verified" });
  assert.equal(o.results[1].ok, true);
  noRaw(o);
});

test("fill {fields}: a trusted entry a later field clears is rechecked like any other", async () => {
  const { dom } = onPage(LOC_FORM, TRUSTED_ONLY_JS() + `
    document.querySelector('[name=name]').addEventListener('input', () => { document.querySelector('[name=email]').value = ''; });`);
  const o = await fill({ fields: [{ label_pattern: "email", text: "a@b.test", trusted: true }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results[0].ok, false);
  assert.equal(o.results[0].kind, "plain");
  assert.match(o.results[0].error, /was cleared after a later field changed, and fields\[1\] \(textbox "Name"\) may have changed it; fill it again$/);
  assert.equal(o.results[1].ok, true);
});

test("fill {fields}: a trusted entry that fails is never told to retry with trusted", async () => {
  const { dom } = onPage(LOC_FORM, TRUSTED_ONLY_JS());
  const o = await fill({ fields: [{ label_pattern: "location", text: "Zurich", trusted: true }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(o.results[0].ok, false, JSON.stringify(o));
  assert.match(o.results[0].error, /^no suggestion matched/);
  assert.ok(!o.results[0].error.includes("retry with fill {trusted:true}"), o.results[0].error);
  assert.equal($(dom, "[name=name]").value, "Ada");
});

// test/fixtures/trusted-select.html's react-select-like location field: a pick
// empties the text box and shows the choice in the control's value span.
const TS_FIXTURE = readFileSync(new URL("./fixtures/trusted-select.html", import.meta.url), "utf8");
const LOC_CTL = /<div class="field"><label id="loc-label"[\s\S]*?<\/ul><\/div>/.exec(TS_FIXTURE)[0] + "<label>Name <input name=name></label>";
const LOC_CTL_JS = /<script>([\s\S]*?)<\/script>/.exec(TS_FIXTURE)[1] + TRUSTED_ONLY_JS("");

test("fill {trusted}: a pick the control shows in its value span while the text box empties is verified", async () => {
  for (const fields of [false, true]) {
    const { dom } = onPage(LOC_CTL, LOC_CTL_JS);
    const one = { label_pattern: "location", text: "Córdoba, Argentina", trusted: true };
    const o = fields ? await fill({ fields: [one, { label_pattern: "name", text: "Ada" }] }) : await fill(one);
    const r = fields ? o.results[0] : o;
    assert.equal(r.ok, true, JSON.stringify(o));
    assert.deepEqual([r.kind, r.selected, r.trusted], ["typeahead", "Córdoba, Argentina", true]);
    assert.equal($(dom, "#loc-input").value, "");
    assert.equal($(dom, ".loc__value").textContent, "Córdoba, Argentina");
    assert.deepEqual([...dom.pickerLog], ["loc:Córdoba, Argentina"]);
  }
});

test("fill {trusted}: a control that shows something other than the pick fails closed", async () => {
  const { dom } = onPage(LOC_CTL, LOC_CTL_JS.replace("shown.textContent = li.textContent;", "shown.textContent = 'Córdoba, Argentina (closed)';"));
  const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina", trusted: true });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /^picked "Córdoba, Argentina" but the field doesn't show it/);
  assert.equal($(dom, "#loc-input").value, "");
});

// The location field with other suggestions, and a pick that shows `show` (an
// expression over li) in place of the option's text.
const locVariant = (items, show = "li.textContent") => [LOC_CTL.replace(/data-typed="[^"]*"/, `data-typed="${items.join("|")}"`),
  LOC_CTL_JS.replace("shown.textContent = li.textContent;", `shown.textContent = ${show};`)];

test("fill {trusted}: a two-line option whose value span shows only its main label is verified", async () => {
  const [html, js] = locVariant(["Córdoba, Argentina", "Rosario, Argentina"], "li.firstChild.textContent");
  for (const fields of [false, true]) {
    const { dom } = onPage(html, js.replace(`'<li role="option">' + x + "</li>"`, `'<li role="option">' + x.replace(', ', '<small style="display:block">') + "</small></li>"`));
    const one = { label_pattern: "location", text: "Córdoba", trusted: true };
    const o = fields ? await fill({ fields: [one, { label_pattern: "name", text: "Ada" }] }) : await fill(one);
    const r = fields ? o.results[0] : o;
    assert.equal(r.ok, true, JSON.stringify(o));
    assert.equal($(dom, ".loc__value").textContent, "Córdoba");
  }
});

test("fill {trusted}: a multi-value control already holding a chip verifies the chip it gains", async () => {
  const [html, js] = locVariant(["Córdoba, Argentina", "Rosario, Argentina"]);
  const chips = html.replace('<span class="loc__value placeholder">Type a city</span>', '<span class="loc__multi-value__label">Rosario, Argentina</span>');
  const add = "box.insertBefore(Object.assign(document.createElement('span'), { className: 'loc__multi-value__label', textContent: li.textContent }), input);";
  const { dom } = onPage(chips, js.replace("shown.textContent = li.textContent;", add).replace('shown.className = "loc__value";', ""));
  const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(dom.document.querySelectorAll(".loc__multi-value__label").length, 2);
});

test("fill {trusted}: a multi-value control that shows only its earlier chip fails closed", async () => {
  const [html, js] = locVariant(["Córdoba", "Córdoba, Argentina"]);
  const chips = html.replace('<span class="loc__value placeholder">Type a city</span>', '<span class="loc__multi-value__label">Córdoba</span><span class="loc__multi-value__label">Mendoza</span>');
  const { dom } = onPage(chips, js.replace("shown.textContent = li.textContent;", "").replace('shown.className = "loc__value";', ""));
  const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina", trusted: true });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /the field doesn't show it/);
});

test("fill {trusted}: a single value that already showed the pick's main label before the press fails closed", async () => {
  const [html, js] = locVariant(["Córdoba, Argentina", "Rosario, Argentina"]);
  const prior = html.replace('<span class="loc__value placeholder">Type a city</span>', '<span class="loc__single-value">Córdoba</span>');
  const { dom } = onPage(prior, js.replace("shown.textContent = li.textContent;", "").replace('shown.className = "loc__value";', ""));
  const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina", trusted: true });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /the field doesn't show it/);
  assert.equal($(dom, ".loc__single-value").textContent, "Córdoba");
});

test("fill {trusted}: an option over 200 characters in a single-value span is verified", async () => {
  const long = "Córdoba, " + Array(30).fill("Barrio Alto").join(" ");
  const [html, js] = locVariant([long, "Rosario, Argentina"]);
  const { dom } = onPage(html.replace("loc__value placeholder", "loc__single-value placeholder"), js.replace('shown.className = "loc__value";', 'shown.className = "loc__single-value";'));
  const o = await fill({ label_pattern: "location", text: "Córdoba, Barrio", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal($(dom, ".loc__single-value").textContent, long);
});

test("fill {trusted}: a value span showing another option, a cut word or extra text fails closed", async () => {
  for (const show of ["'Córdoba, Spain'", "'Córd'", "'Córdoba, Argentina, Spain'", "li.textContent + ' (closed)'"]) {
    const [html, js] = locVariant(["Córdoba, Argentina", "Rosario, Argentina"], show);
    const { dom } = onPage(html, js);
    const o = await fill({ label_pattern: "location", text: "Córdoba, Argentina", trusted: true });
    assert.equal(o.ok, false, show + " " + JSON.stringify(o));
    assert.match(o.error, /^picked "Córdoba, Argentina" but the field doesn't show it/);
    assert.equal($(dom, "#loc-input").value, "");
  }
});

// A pick verified in both fill {trusted} and a trusted fill {fields} entry.
const fillLoc = async (one, fields) => {
  const o = fields ? await fill({ fields: [one, { label_pattern: "name", text: "Ada" }] }) : await fill(one);
  return [fields ? o.results[0] : o, o];
};
const LI = `'<li role="option">' + x + "</li>"`;

test("fill {trusted}: a flat option whose control settles on a shorter sibling option fails closed", async () => {
  const [html, js] = locVariant(["New York City", "New York"], "'New York'");
  // A row flex option lays its blockified children side by side, on one line.
  const flex = `'<li role="option" style="display:flex">' + x.replace(/^New York/, '<span style="display:block">New York</span><span style="display:block">') + "</span></li>"`;
  for (const [li, fields] of [[LI, false], [LI, true], [flex, false], [flex, true]]) {
    const { dom } = onPage(html, js.replace(LI, li));
    const [r, o] = await fillLoc({ label_pattern: "location", text: "New York City", trusted: true }, fields);
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.match(r.error, /^picked "New York City" but the field doesn't show it/);
    assert.equal($(dom, "#loc-input").value, "");
  }
});

test("fill {trusted}: an option whose leading unit is its own element or line verifies that unit", async () => {
  const shapes = {
    block: `'<li role="option">' + x.replace(', ', ' <small style="display:block">') + "</small></li>"`,
    inline: `'<li role="option"><span>' + x.replace(', ', '</span><span class=sub>, ') + "</span></li>"`,
  };
  for (const [name, li] of Object.entries(shapes)) {
    const [html, js] = locVariant(["Paris, Texas", "Rosario, Argentina"], "li.firstChild.textContent.trim()");
    for (const fields of [false, true]) {
      const { dom } = onPage(html, js.replace(LI, li));
      const [r, o] = await fillLoc({ label_pattern: "location", text: "Paris", trusted: true }, fields);
      assert.equal(r.ok, true, name + " " + JSON.stringify(o));
      assert.equal(r.value ?? r.selected, "Paris");
      assert.equal($(dom, ".loc__value").textContent, "Paris");
    }
  }
});

test("fill {trusted}: an option's leading unit that the control already showed before the press fails closed", async () => {
  const [html, js] = locVariant(["Paris, Texas", "Rosario, Argentina"]);
  const prior = html.replace('<span class="loc__value placeholder">Type a city</span>', '<span class="loc__single-value">Paris</span>');
  const li = `'<li role="option"><span>' + x.replace(', ', '</span><span class=sub>, ') + "</span></li>"`;
  for (const fields of [false, true]) {
    const { dom } = onPage(prior, js.replace(LI, li).replace("shown.textContent = li.textContent;", "").replace('shown.className = "loc__value";', ""));
    const [r, o] = await fillLoc({ label_pattern: "location", text: "Paris", trusted: true }, fields);
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.match(r.error, /the field doesn't show it/);
    assert.equal($(dom, ".loc__single-value").textContent, "Paris");
  }
});

// The place names a text carries (PLACES) are args too.
test("fill {trusted}: the typeahead pick and read scripts differ by text only in their args", async () => {
  const [html, js] = locVariant(["New York City", "Paris, Texas"]);
  const ta = [];
  for (const text of ["New York City", "Paris, Texas"]) {
    const { dom } = onPage(html, js);
    const ev = dom.eval;
    const seen = [];
    dom.eval = (s) => { if (/s\.pickedN|const pk = /.test(s)) seen.push(s.replace(/\nconst A = .*;\n(const PLACES = .*;\n)?/, "\n")); return ev(s); };
    const o = await fill({ label_pattern: "location", text, trusted: true });
    assert.equal(o.ok, true, JSON.stringify(o));
    ta.push([...new Set(seen)].sort());
  }
  assert.ok(ta[0].length >= 2, "saw " + ta[0].length);
  assert.deepEqual(ta[1], ta[0]);
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

test("the trusted-retry hint is one literal in server.js", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.equal(src.split("retry with fill {trusted:true}").length - 1, 1);
});

// Another perch server's fill on this tab replaces the state a pass held for a
// trusted entry before the entry types: under other args, or identical ones
// (caught by the held state's token).
for (const [name, B] of [["other args", { label_pattern: "location", text: "Toronto" }], ["identical args", { label_pattern: "location", text: "Rosario", trusted: true }]]) {
  test(`fill {fields}: a trusted entry whose held state another call replaced types nothing (${name})`, async () => {
    const { dom } = onPage(LOC_FORM, TRUSTED_ONLY_JS());
    const ev = dom.eval;
    let b = null;
    dom.eval = (js) => { if (!b && js.includes('"held":true')) b = run(dom, "fill", B); return ev(js); };
    const o = await fill({ fields: TRUSTED_ENTRIES });
    assert.ok(b && b.pending, JSON.stringify(b));
    assert.equal(o.ok, false, JSON.stringify(o));
    assert.deepEqual(o.results[1], { ok: false, kind: "typeahead", error: "another perch call on this tab took over this fill's suggestions; not verified" });
    assert.equal($(dom, "#selected-location").value, "");
    assert.equal(dom.lookups, 0, "A typed nothing");
  });
}

// A local-then-remote typeahead: its own list filters the typed text at once
// (a tie here), then the lookup's results land after a debounce with the exact
// suggestion. The tie in the local list is not the site's answer yet.
test("typeahead: a local tie followed by the lookup's exact suggestion waits for the lookup", async () => {
  for (const n of [6, 8]) {
    const { dom } = onPage(ACCENT_HTML(true), ACCENT_JS.replace("}, 3); });", "}, 2); });") + `
      inp.addEventListener('input', () => { later(() => {
        ul.insertAdjacentHTML('beforeend', '<div role=option>Cordoba</div>');
        ul.lastChild.addEventListener('click', () => { window.picks.push('Cordoba'); document.querySelector('.select__single-value').textContent = 'Cordoba'; hid.value = 'Cordoba'; inp.value = ''; ul.innerHTML = ''; });
      }, ${n}); });`);
    const o = await fill({ selector: "#city", text: "Cordoba" });
    assert.equal(o.ok, true, n + " " + JSON.stringify(o));
    assert.deepEqual([...dom.picks], ["Cordoba"], String(n));
  }
});

// A suggestion whose text starts with "Loading" is a suggestion, not a busy list.
test("typeahead: a suggestion named \"Loading ...\" is picked at once, never taken for a loading row", async () => {
  const { dom, world } = onPage(`<label for=job>Role</label><input id=job role=combobox aria-autocomplete=list aria-controls=job-list><ul id=job-list role=listbox></ul><input type=hidden name=jobId>`, `
    const inp = document.getElementById('job'), ul = document.getElementById('job-list'), hid = document.querySelector('[name=jobId]');
    inp.addEventListener('input', () => { window.__q = []; later(() => {
      ul.innerHTML = ['Loading Dock Worker', 'Warehouse Lead'].map((t) => '<li class=item>' + t + '</li>').join('');
      ul.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => { inp.value = li.textContent; hid.value = li.textContent; ul.innerHTML = ''; }));
    }, 2); });`);
  const t0 = world.clock.t;
  const o = await fill({ label_pattern: "role", text: "Loading Dock Worker" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Loading Dock Worker");
  assert.equal($(dom, "[name=jobId]").value, "Loading Dock Worker");
  assert.ok(world.clock.t - t0 < 1000, "waited " + (world.clock.t - t0) + "ms");
});

// A results wrapper holding only a "No results" note offers no suggestion.
test("typeahead: a no-results note is never a suggestion or a candidate", async () => {
  const { dom } = onPage(LOCATION, LOCATION_JS().replace(
    "dd.innerHTML = cities.filter((c) => q && c.toLowerCase().startsWith(q)).map((c) => '<div class=dropdown-item data-id=' + cities.indexOf(c) + '>' + c + '</div>').join('');",
    "dd.innerHTML = '<div class=dropdown-results><div>No results for ' + q + '</div></div>';"));
  const o = await fill({ label_pattern: "location", text: "Zzyzx" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.ok(!(o.candidates || []).some((c) => /no results/i.test(c)), JSON.stringify(o));
  assert.equal($(dom, "#loc").value, "");
});
