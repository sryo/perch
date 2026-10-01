// select picks only from the target control's own list: other open menus never
// supply candidates, a mid-word substring never matches, and an open menu stays open.
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
  dom.world = world;
  return dom;
}
const select = async (args) => {
  const r = await handleCall("select", args);
  return JSON.parse(r.content[0].text.replace(/^error: /, '"') + (r.isError ? '"' : ""));
};
const $ = (dom, sel) => dom.document.querySelector(sel);

// A react-select v5 look-alike: role=combobox on the inner input, the menu linked by
// aria-controls only while open, a press on an open control closes it, typing filters.
// o.strict: a filter with parentheses or commas empties the list. o.async: options only after typing.
// o.portal: the menu renders at the end of body. o.syntheticIgnored: never opens from page JS.
// o.sticky: ignores Escape. o.remote: a typed filter shows "Loading..." and a loading
// indicator until window.load<id>() adds these options and renders.
const RS_JS = `
window.log = [];
window.mkRS = function (id, options, o) {
  o = o || {};
  const box = document.getElementById('c' + id);
  const ctl = box.querySelector('.select__control');
  const input = document.getElementById('react-select-' + id + '-input');
  let open = false;
  function close() {
    window.closes = (window.closes || 0) + 1;
    open = false;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-controls');
    const m = document.getElementById('m' + id);
    if (m) m.remove();
  }
  function render() {
    let m = document.getElementById('m' + id);
    if (!m) { m = document.createElement('div'); m.id = 'm' + id; m.className = 'select__menu'; (o.portal ? document.body : box).appendChild(m); }
    const q = input.value.toLowerCase();
    const strict = o.strict && /[(),]/.test(q);
    const list = o.async && !q ? [] : options.filter(x => !strict && x.toLowerCase().includes(q));
    m.innerHTML = '<div role=listbox id="react-select-' + id + '-listbox">' + (list.length ? list.map(x => '<div role=option>' + x + '</div>').join('') : '<div class="select__menu-notice select__menu-notice--no-options">No options</div>') + '</div>';
    m.querySelectorAll('[role=option]').forEach(el => el.addEventListener('click', () => {
      window.log.push(id + ':' + el.textContent);
      if (o.multi) { const c = document.createElement('div'); c.className = 'select__multi-value'; c.textContent = el.textContent; box.querySelector('.select__value-container').prepend(c); }
      else box.querySelector('.select__single-value').textContent = el.textContent;
      input.value = '';
      close();
    }));
  }
  function openMenu() { open = true; input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'react-select-' + id + '-listbox'); render(); }
  ctl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.view || o.syntheticIgnored) return;
    if (open && e.target !== input) close(); else if (!open) openMenu();
  });
  function loading() {
    document.getElementById('react-select-' + id + '-listbox').innerHTML = '<div class="select__menu-notice select__menu-notice--loading">Loading...</div>';
    ctl.insertAdjacentHTML('beforeend', '<div class=select__loading-indicator><span></span></div>');
    window['load' + id] = () => { ctl.querySelector('.select__loading-indicator').remove(); options = options.concat(o.remote); o.remote = null; render(); };
  }
  input.addEventListener('input', () => { if (o.syntheticIgnored) return; if (!open) openMenu(); else render(); if (o.remote && input.value) loading(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !o.sticky) close(); });
  if (o.open) openMenu();
};`;
const rs = (id, label) => `<div class="select__container" id=c${id}><label id=l${id}>${label}</label><div class="select__control"><div class="select__value-container"><div class="select__single-value"></div><input id=react-select-${id}-input role=combobox aria-labelledby=l${id} aria-expanded=false></div></div></div>`;

// An intl-tel-input country list left open; it ignores Escape.
const ITI = `<div class=iti><button type=button role=combobox aria-haspopup=listbox aria-expanded=true aria-controls=iti-0__country-listbox aria-label="Phone country">+1</button>
  <ul id=iti-0__country-listbox role=listbox><li role=option>Jersey</li><li role=option>Luxembourg</li><li role=option>United Kingdom</li></ul><input type=tel></div>`;

test("another control's open list never supplies candidates or a pick", async () => {
  const dom = onPage(ITI + rs(1, "English level"), RS_JS + `mkRS(1, ["Basic", "Conversational", "Fluent", "Native"]);`);
  const o = await select({ label_pattern: "english", text: "Jersey" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.candidates, ["Basic", "Conversational", "Fluent", "Native"]);
  assert.deepEqual([...dom.log], []);
  assert.equal($(dom, "#react-select-1-input").value, "", "typed filter is cleared after a miss");
  const hit = await select({ label_pattern: "english", text: "fluent" });
  assert.equal(hit.ok, true, JSON.stringify(hit));
  assert.equal(hit.value ?? hit.selected, "Fluent");
});

test("a mid-word substring never matches, and other open menus close first", async () => {
  const dom = onPage(rs(3, "City") + rs(7, "Skills"), RS_JS + `mkRS(3, ["Luxembourg", "Lisbon"], { multi: true, open: true }); mkRS(7, ["Business Analysis", "UX/UI Design"], { multi: true });`);
  const o = await select({ selector: "#react-select-7-input", text: "UX" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "UX/UI Design");
  assert.deepEqual([...dom.log], ["7:UX/UI Design"]);
  assert.equal($(dom, "#react-select-3-input").getAttribute("aria-expanded"), "false");
});

test("no own match is a miss even when another open menu has a substring hit", async () => {
  const dom = onPage(rs(3, "City") + rs(7, "Skills"), RS_JS + `mkRS(3, ["Luxembourg", "UX Lab"], { multi: true, open: true, sticky: true }); mkRS(7, ["Business Analysis", "Data"], { multi: true });`);
  const o = await select({ selector: "#react-select-7-input", text: "UX" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.candidates, ["Business Analysis", "Data"]);
  assert.deepEqual([...dom.log], []);
  assert.equal(dom.document.querySelectorAll(".select__multi-value").length, 0);
});

test("an already open menu is used as is, not toggled closed", async () => {
  const dom = onPage(rs(2, "Experience"), RS_JS + `mkRS(2, ["Junior", "Senior"], { open: true });`);
  const o = await select({ selector: "#c2 .select__control", text: "Senior" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value ?? o.selected, "Senior");
  assert.deepEqual([...dom.log], ["2:Senior"]);
  assert.equal(dom.closes, 1, "closed only by the pick");
});

test("long option text is matched on the unfiltered list, curly apostrophes included", async () => {
  const LONG = ["Less than 1 year", "Senior (7+ years)", "I’m not sure"];
  let dom = onPage(rs(4, "Years"), RS_JS + `mkRS(4, ${JSON.stringify(LONG)}, { strict: true });`);
  let o = await select({ label_pattern: "years", text: "Senior (7+ years)" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value ?? o.selected, "Senior (7+ years)");
  dom = onPage(rs(4, "Years"), RS_JS + `mkRS(4, ${JSON.stringify(LONG)}, { strict: true });`);
  o = await select({ label_pattern: "years", text: "I'm not sure" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "I’m not sure");
});

test("an async list gets a typed filter; a miss clears it", async () => {
  let dom = onPage(rs(5, "Location"), RS_JS + `mkRS(5, ["Berlin, Germany", "Bern, Switzerland"], { async: true, strict: true });`);
  let o = await select({ label_pattern: "location", text: "Berlin, Germany" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value ?? o.selected, "Berlin, Germany");
  dom = onPage(rs(5, "Location"), RS_JS + `mkRS(5, ["Berlin, Germany"], { async: true });`);
  o = await select({ label_pattern: "location", text: "Atlantis" });
  assert.equal(o.ok, false);
  assert.equal($(dom, "#react-select-5-input").value, "");
});

test("a typed filter answered at once with react-select's No options settles as a miss in about 0.25s", async () => {
  const dom = onPage(rs(9, "Department"), RS_JS + `mkRS(9, ["Engineering", "Design", "Sales"]);`);
  const t0 = dom.world.clock.t;
  const o = await select({ label_pattern: "department", text: "zz" });
  const ms = dom.world.clock.t - t0;
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.candidates, ["Engineering", "Design", "Sales"]);
  assert.equal($(dom, "#react-select-9-input").value, "", "typed filter is cleared after a miss");
  assert.equal($(dom, "#react-select-9-input").getAttribute("aria-expanded"), "false");
  assert.equal(ms, 250, "typed at 150ms, then 2 empty polls saying No options");
});

test("react-select's Loading... message keeps an emptied list waited on until the answer lands", async () => {
  const dom = onPage(rs(9, "Department"), RS_JS + `mkRS(9, ["Engineering", "Sales"], { remote: ["Design lead"] });`);
  const orig = dom.eval.bind(dom);
  let n = 0;
  dom.eval = (js) => { if (dom.load9 && ++n === 16) dom.load9(); return orig(js); };
  const t0 = dom.world.clock.t;
  const o = await select({ label_pattern: "department", text: "Design lead" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value ?? o.selected, "Design lead");
  assert.equal(dom.world.clock.t - t0, 950, "the answer lands on the 16th page call after Loading... shows");
});

test("a portaled menu is found through aria-controls, by a snapshot ref", async () => {
  const STRAY = `<ul role=listbox aria-label=Suggestions><li role=option>Senior</li></ul>`;
  const dom = onPage(STRAY + rs(6, "Seniority"), RS_JS + `mkRS(6, ["Junior", "Senior staff"], { portal: true });`);
  const snap = (await handleCall("accessibility_snapshot", { role: "combobox" })).content[0].text;
  const ref = /^(\d+) combobox "Seniority"/m.exec(snap)[1];
  const o = await select({ ref, text: "senior" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Senior staff");
  assert.deepEqual([...dom.log], ["6:Senior staff"]);
});

test("empty text lists the control's own options and picks nothing", async () => {
  const dom = onPage(ITI + rs(1, "English level"), RS_JS + `mkRS(1, ["Basic", "Fluent"]);`);
  const o = await select({ label_pattern: "english", text: "" });
  assert.equal(o.ok, false);
  assert.deepEqual(o.candidates, ["Basic", "Fluent"]);
  assert.deepEqual([...dom.log], []);
  assert.equal($(dom, "#react-select-1-input").getAttribute("aria-expanded"), "false", "the menu it opened is closed again");
});

test("a menu that never opens from page events says so", async () => {
  onPage(rs(8, "Material"), RS_JS + `mkRS(8, ["Steel"], { syntheticIgnored: true });`);
  const o = await select({ label_pattern: "material", text: "Steel" });
  assert.equal(o.ok, false);
  assert.match(o.error, /did not open.*trusted/);
});

// Downshift: the menu is linked by aria-controls and opens only on input events.
const DOWNSHIFT = `<span id=dl>Department</span><div class=dwrap><input id="downshift-:r0:-input" role=combobox aria-expanded=false aria-controls="downshift-:r0:-menu" aria-labelledby=dl></div><ul id="downshift-:r0:-menu" role=listbox></ul>`;
const DOWNSHIFT_JS = `
  const input = document.getElementById('downshift-:r0:-input');
  const menu = document.getElementById('downshift-:r0:-menu');
  const items = ['Engineering', 'Design', 'Product design lead'];
  const close = () => { menu.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); };
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    menu.innerHTML = items.filter(x => x.toLowerCase().includes(q)).map(x => '<li role=option>' + x + '</li>').join('');
    input.setAttribute('aria-expanded', 'true');
    menu.querySelectorAll('li').forEach(li => li.addEventListener('click', () => { input.value = li.textContent; close(); }));
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });`;

test("Downshift: opens by typing, picks, and a miss leaves no typed text", async () => {
  let dom = onPage(DOWNSHIFT, DOWNSHIFT_JS);
  let o = await select({ label_pattern: "department", text: "Design" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Design");
  assert.equal(o.unverified, undefined, JSON.stringify(o));
  dom = onPage(DOWNSHIFT, DOWNSHIFT_JS);
  o = await select({ label_pattern: "department", text: "zz" });
  assert.equal(o.ok, false);
  assert.equal(dom.document.getElementById("downshift-:r0:-input").value, "");
});

// Radix Popover + cmdk: a dialog trigger whose aria-controls names the popper content;
// cmdk's input is an expanded combobox, and Escape inside the content closes it.
const RADIX = `<span id=ql>Languages</span><button id=trigger type=button aria-haspopup=dialog aria-expanded=false aria-controls="radix-:r5:" aria-labelledby=ql>Select all that apply</button>
  <div role=listbox><div role=option>Spanish</div></div>`;
const RADIX_JS = `
  const t = document.getElementById('trigger');
  const chosen = [];
  window.opens = 0;
  t.addEventListener('click', () => {
    const w = document.querySelector('[data-radix-popper-content-wrapper]');
    if (w) { w.remove(); t.setAttribute('aria-expanded', 'false'); return; }
    window.opens++;
    const d = document.createElement('div');
    d.setAttribute('data-radix-popper-content-wrapper', '');
    d.innerHTML = '<div role=dialog id="radix-:r5:"><div cmdk-root><input cmdk-input role=combobox aria-expanded=true placeholder=Search><div cmdk-list role=listbox>' +
      ['English', 'Spanish', 'Portuguese'].map(x => '<div cmdk-item data-value="' + x.toLowerCase() + '">' + x + '</div>').join('') + '</div></div></div>';
    document.body.appendChild(d);
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { d.remove(); t.setAttribute('aria-expanded', 'false'); } });
    t.setAttribute('aria-expanded', 'true');
    d.querySelectorAll('[cmdk-item]').forEach(it => it.addEventListener('click', () => { chosen.push(it.textContent); t.textContent = chosen.join(', '); }));
  });`;

test("Radix popover + cmdk multi-select: picks items and closes the popover it opened, from inside it", async () => {
  const dom = onPage(RADIX, RADIX_JS);
  let o = await select({ selector: "#trigger", text: "spanish" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value ?? o.selected, "Spanish");
  assert.equal($(dom, "#trigger").getAttribute("aria-expanded"), "false");
  o = await select({ selector: "#trigger", text: "English" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value, "Spanish, English", "value stays when the control shows more than the pick");
  assert.equal(o.unverified, undefined, "a value that grew by the pick verifies it");
  assert.equal(dom.opens, 2);
  assert.equal($(dom, "[data-radix-popper-content-wrapper]"), null);
});

// A React 18 control: its focused state comes from its own focus event and lands a
// microtask later, and a mousedown while unfocused only focuses the input, opening
// the menu from the focus event that follows. o.hidden: focus() moves focus but fires
// no focus event, as in a background tab.
const GATED = `<div><label for=gin>Priority</label><div class="x-control" id=gc><span class=gv></span><input id=gin role=combobox aria-expanded=false></div></div>`;
const gatedJs = (hidden) => `
  if (${hidden}) {
    let active = null;
    HTMLElement.prototype.focus = function () { active = this; };
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => active || document.body });
  }
  const input = document.getElementById('gin'), ctl = document.getElementById('gc');
  let focused = false, open = false, after = false;
  function openMenu() {
    open = true;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'gl');
    const m = document.createElement('div');
    m.id = 'gl'; m.setAttribute('role', 'listbox');
    m.innerHTML = '<div role=option>Low</div><div role=option>High</div>';
    document.body.appendChild(m);
    m.querySelectorAll('[role=option]').forEach(o => o.addEventListener('click', () => { ctl.querySelector('.gv').textContent = o.textContent; m.remove(); open = false; }));
  }
  input.addEventListener('focus', () => { queueMicrotask(() => { focused = true; }); if (after) { after = false; openMenu(); } });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { document.getElementById('gl').remove(); open = false; } });
  ctl.addEventListener('mousedown', () => { if (!focused) { after = true; input.focus(); } else if (!open) openMenu(); });`;

for (const hidden of [false, true]) {
  test(`a control that opens from its own focus event opens${hidden ? " in a background tab" : ""}`, async () => {
    let dom = onPage(GATED, gatedJs(hidden));
    let o = await select({ label_pattern: "priority", text: "" });
    assert.deepEqual(o.candidates, ["Low", "High"], JSON.stringify(o));
    dom = onPage(GATED, gatedJs(hidden));
    o = await select({ label_pattern: "priority", text: "High" });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(o.value ?? o.selected, "High");
  });
}

test("a combobox input sharing its wrapper with its label reads back its own value", async () => {
  const dom = onPage(`<div><label for=fr>Fruit</label>${DOWNSHIFT.replace(/<span id=dl>Department<\/span>/, "")}</div>`.replace("<div class=dwrap>", "").replace("</div><ul", "<ul"), DOWNSHIFT_JS);
  dom.document.getElementById("downshift-:r0:-input").id = "fr";
  const o = await select({ selector: "#fr", text: "Design" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value ?? o.selected, "Design");
  assert.equal(o.unverified, undefined, JSON.stringify(o));
});

// SmartRecruiters' phone country picker (spl-select, Lit): the combobox button and
// the listbox it names sit in spl-select's shadow root; the options are
// spl-select-option children of spl-select, slotted into that listbox, each
// rendering its role=option two shadow roots down, its text slotted back in from
// the light DOM. The trigger shows the choice as a flag image and "+code", also
// slotted. Their own text is only Lit's whitespace; each row also holds text
// it never shows (visibility:hidden, opacity:0). A click on the button
// opens it; a click on an option picks it.
// o.never: the button ignores page events (opens only on a trusted click).
// o.slow: the list renders only when the test calls window.splShow() (aria-expanded true at once).
const SPL = `<form><label>Phone number</label><spl-phone-field id=pf></spl-phone-field><input type=tel aria-label="Phone number"></form>`;
const SPL_JS = (o = {}) => `
  const C = [["EG", "Egypt", "20"], ["CA", "Canada", "1"], ["US", "United States", "1"], ["UM", "United States Minor Outlying Islands", "1"], ["GB", "United Kingdom", "44"]];
  const shadow = (el, html) => { const r = el.attachShadow({ mode: "open" }); r.innerHTML = html; return r; };
  const pf = shadow(document.getElementById("pf"), '<div class=wrap><spl-select id=sel value=EG><div slot=triggerPrefix class=sel-shown></div>' +
    C.map(c => '<spl-select-option value=' + c[0] + ' label="' + c[1] + '"><div class=row><spl-country-flag alt=""></spl-country-flag> <span>' + c[1] + '</span> <span>+' + c[2] + '</span> <span style="visibility:hidden">tooltip</span><span style="opacity:0">focus ring</span></div></spl-select-option>').join("") +
    '</spl-select></div>');
  const sel = pf.querySelector("#sel");
  const flag = (el, alt) => shadow(el, '<img alt="' + alt + '" src="data:,">');
  const show = (code) => {
    const c = C.find(x => x[0] === code);
    sel.setAttribute("value", code);
    const t = sel.querySelector(".sel-shown");
    t.innerHTML = '<spl-country-flag></spl-country-flag><spl-typography-body>+' + c[2] + '</spl-typography-body>';
    flag(t.querySelector("spl-country-flag"), c[1]);
    shadow(t.querySelector("spl-typography-body"), "<span><slot></slot></span>");
  };
  show("EG");
  const sr = shadow(sel, '<spl-dropdown><button role=combobox slot=trigger aria-haspopup=listbox aria-label="Country code" aria-controls=sel-menu aria-expanded=false>  <div><slot name=triggerPrefix></slot></div>  </button><div slot=menu id=sel-menu role=listbox><slot></slot></div></spl-dropdown>');
  const dd = shadow(sr.querySelector("spl-dropdown"), '<span><slot name=trigger></slot></span><div class=menu style="display:none"><slot name=menu></slot></div>');
  const btn = sr.querySelector("button"), menu = dd.querySelector(".menu");
  window.log = [];
  window.splCalls = 0;
  const close = () => { menu.style.display = "none"; btn.setAttribute("aria-expanded", "false"); };
  const open = () => { btn.setAttribute("aria-expanded", "true"); if (${!!o.slow}) window.splShow = () => { menu.style.display = ""; }; else menu.style.display = ""; };
  sel.querySelectorAll("spl-select-option").forEach(opt => {
    const item = shadow(opt, '<spl-dropdown-item><slot><span>' + opt.getAttribute("label") + '</span></slot></spl-dropdown-item>').querySelector("spl-dropdown-item");
    const ir = shadow(item, '<div role=option aria-selected=false aria-disabled=false>  <slot name=prefix></slot>  <spl-typography-body><slot></slot></spl-typography-body>  </div>');
    shadow(ir.querySelector("spl-typography-body"), "<span><slot></slot></span>");
    ir.querySelector("[role=option]").addEventListener("click", () => { window.log.push(opt.getAttribute("value")); show(opt.getAttribute("value")); close(); });
  });
  btn.addEventListener("click", () => { if (${!!o.never}) return; if (btn.getAttribute("aria-expanded") === "true") close(); else open(); });
  btn.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });`;
const splBtn = (dom) => dom.document.getElementById("pf").shadowRoot.querySelector("#sel").shadowRoot.querySelector("button");

test("a web component's list in its shadow root, options slotted in from the light DOM, is opened, picked and read back", async () => {
  const dom = onPage(SPL, SPL_JS());
  let o = await select({ selector: '[aria-label="Country code"]', text: "" });
  assert.deepEqual(o.candidates, ["Egypt +20", "Canada +1", "United States +1", "United States Minor Outlying Islands +1", "United Kingdom +44"], JSON.stringify(o));
  assert.equal(splBtn(dom).getAttribute("aria-expanded"), "false", "the list it opened is closed again");
  o = await select({ selector: '[aria-label="Country code"]', text: "United States" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "United States +1");
  assert.deepEqual([...dom.log], ["US"]);
  assert.equal(dom.document.getElementById("pf").shadowRoot.querySelector("#sel").getAttribute("value"), "US");
});

test("a shadow-root list that renders a second after the press is still picked", async () => {
  const dom = onPage(SPL, SPL_JS({ slow: true }));
  const orig = dom.eval.bind(dom);
  let n = 0;
  dom.eval = (js) => { if (dom.splShow && ++n === 20) dom.splShow(); return orig(js); };
  const o = await select({ selector: '[aria-label="Country code"]', text: "United Kingdom" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual([...dom.log], ["GB"]);
});

test("a control the press leaves shut, with no list anywhere, misses after a short step, not the full bound", async () => {
  const dom = onPage(SPL, SPL_JS({ never: true }));
  const t0 = dom.world.clock.t;
  const o = await select({ selector: '[aria-label="Country code"]', text: "United States" });
  const ms = dom.world.clock.t - t0;
  assert.equal(o.ok, false);
  assert.match(o.error, /did not open.*trusted/);
  assert.deepEqual([...dom.log], []);
  assert.ok(ms < 1000, "waited " + ms + "ms");
});

// A custom dropdown that never says whether it is open (no aria-expanded) and
// renders its list a while after the press, with no loading sign: a slow list,
// not a shut control, so it keeps the full bound.
for (const n of [15, 25, 40]) {
  test(`a control without aria-expanded whose list shows ${n} page calls after the press is still picked`, async () => {
    const dom = onPage(`<form><label id=pl>Plan</label><div class=dd><div role=button tabindex=0 aria-haspopup=listbox aria-labelledby=pl class=trig>Choose</div></div><input name=other></form>`);
    const trig = $(dom, ".trig");
    let pressed = false;
    trig.addEventListener("click", () => { pressed = true; });
    const orig = dom.eval.bind(dom);
    let k = 0;
    dom.eval = (js) => {
      if (pressed && ++k === n) {
        const ul = dom.document.createElement("ul");
        ul.setAttribute("role", "listbox");
        ul.innerHTML = "<li role=option>Basic</li><li role=option>Pro</li>";
        ul.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => { trig.textContent = li.textContent; ul.remove(); }));
        $(dom, ".dd").appendChild(ul);
      }
      return orig(js);
    };
    const o = await select({ selector: ".trig", text: "Pro" });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(trig.textContent, "Pro");
  });
}
