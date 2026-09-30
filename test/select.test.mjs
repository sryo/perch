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

test("native select: a page that reverts the pick is ok:false with what it kept", async () => {
  onPage(NATIVE, `const s = document.querySelector('select'); s.selectedIndex = 1;
    s.addEventListener('change', () => { s.selectedIndex = 1; });`);
  const { o } = await select({ label_pattern: "country", text: "Brazil" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.selected, undefined);
  assert.equal(o.kept, "Argentina");
  assert.equal(o.el, `combobox "Country"`);
  assert.equal(o.error, `combobox "Country" kept "Argentina" instead of "Brazil"; the page reverted the pick`);
  // A handler that swaps to a third option.
  const w = onPage(NATIVE, `const s = document.querySelector('select'); s.selectedIndex = 1;
    s.addEventListener('change', () => { s.selectedIndex = 0; });`);
  const c = (await select({ label_pattern: "country", text: "Brazil" })).o;
  assert.equal(c.ok, false, JSON.stringify(c));
  assert.equal(c.kept, "Pick");
  assert.match(c.error, /^combobox "Country" kept "Pick"; the page changed the pick to another option$/);
  assert.equal(w.dom.document.querySelector("select").selectedIndex, 0);
});

test("native select: options sharing a value pick the one asked for, and a forced other is ok:false", async () => {
  // Browsers set .value to the first twin, happy-dom to the last: B sits between.
  const DUP = `<label>Plan <select><option value="">Pick</option><option value=1>A</option><option value=1>B</option><option value=1>C</option></select></label>`;
  const { dom } = onPage(DUP);
  const { o } = await select({ label_pattern: "plan", text: "B" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "B");
  assert.equal(dom.document.querySelector("select").selectedIndex, 2);
  onPage(DUP, `document.querySelector('select').addEventListener('change', (e) => { e.target.selectedIndex = 1; });`);
  const f = (await select({ label_pattern: "plan", text: "B" })).o;
  assert.equal(f.ok, false, JSON.stringify(f));
  assert.equal(f.selected, undefined);
  assert.equal(f.kept, "A");
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

// The page's async work runs on window.__q, one step per execute, standing in
// for timers that fire between the page calls (as in fill-typeahead.test.mjs).
function onTickPage(html, setup) {
  const dom = page(html);
  dom.eval(`window.__q = [];
    window.later = (fn, n) => { window.__q.push({ fn, n }); };
    window.__tick = () => { const due = window.__q.filter((j) => --j.n <= 0); window.__q = window.__q.filter((j) => j.n > 0); due.forEach((j) => j.fn()); };`);
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
const PLAN = `<label>Plan <select id=plan><option value="">Select...</option><option>Basic</option><option>Pro</option></select></label>`;

// A native pick is read back in its own page call, before the page's queued
// work runs; the re-read a task later, as fill's, catches a page that moves it.
// A native pick answers at once; the next page call on the tab reads it again
// first and reports a page that moved it as late.
const lateAfter = async () => { const c = (await handleCall("eval_js", { script: "return 1" })).content; return c[1] && JSON.parse(c[1].text).late; };
test("native select: a pick the page moves to another option a task later is late on the next call", async () => {
  const { dom } = onTickPage(PLAN, `const plan = document.getElementById('plan');
    plan.addEventListener('change', () => { later(() => { if (plan.value === 'Basic') plan.value = 'Pro'; }, 1); });`);
  const { o } = await select({ label_pattern: "^Plan", text: "Basic" });
  assert.deepEqual(o, { ok: true, selected: "Basic", el: `combobox "Plan"` });
  assert.deepEqual(await lateAfter(), [{ el: `combobox "Plan"`, error: `changed to "Pro" after it was filled; the page chose another option` }]);
  assert.equal(dom.document.getElementById("plan").value, "Pro");
  assert.equal(await lateAfter(), undefined, "reported once");
});

test("native select: a pick the page puts back or empties a task later is a late revert; one that holds is not reported", async () => {
  for (const [js, kept] of [["plan.selectedIndex = 2", "Pro"], ["plan.selectedIndex = 0", "Select..."]]) {
    onTickPage(PLAN, `const plan = document.getElementById('plan'); plan.selectedIndex = 2;
      plan.addEventListener('change', () => { later(() => { ${js}; }, 1); });`);
    assert.equal((await select({ label_pattern: "^Plan", text: "Basic" })).o.ok, true);
    assert.deepEqual(await lateAfter(), [{ el: `combobox "Plan"`, error: `changed to ${JSON.stringify(kept)} after it was filled; the page reverted the write` }]);
  }
  onTickPage(PLAN, `const plan = document.getElementById('plan');
    plan.addEventListener('change', () => { later(() => { const v = plan.value, o = document.createElement('option'); o.textContent = 'Team'; plan.appendChild(o); plan.value = v; }, 1); });`);
  assert.deepEqual((await select({ label_pattern: "^Plan", text: "Basic" })).o, { ok: true, selected: "Basic", el: `combobox "Plan"` });
  assert.equal(await lateAfter(), undefined);
});

// A custom list's pick is pressed in one page call and read in a later one, so
// a page that moves it a task after the press has done so before the read.
test("custom combobox: a pick the page moves a task after the press is ok:false, never selected", async () => {
  onTickPage(CUSTOM, CUSTOM_JS.replace("cb.querySelector('.v').textContent = o.textContent;",
    "cb.querySelector('.v').textContent = o.textContent; later(() => { cb.querySelector('.v').textContent = 'Junior'; }, 1);"));
  const { o } = await select({ label_pattern: "level", text: "senior" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.selected, undefined);
  assert.equal(o.error, `pressed "Senior" but the control shows "Junior"; not verified`);
});

test("custom combobox: opens with a real left press, picks, verifies", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS);
  const { o } = await select({ label_pattern: "level", text: "senior" });
  assert.deepEqual(o, { ok: true, selected: "Senior", el: `combobox "Level"` });
  assert.equal(dom.opens, 1);
});

test("custom combobox: no matching option lists what was there", async () => {
  onPage(CUSTOM, CUSTOM_JS);
  const { o } = await select({ label_pattern: "level", text: "principal" });
  assert.equal(o.ok, false);
  assert.deepEqual(o.candidates, ["Junior", "Senior"]);
});

test("custom combobox that never shows the choice is ok:false, naming what it shows", async () => {
  onPage(CUSTOM, CUSTOM_JS.replace("cb.querySelector('.v').textContent = o.textContent;", ""));
  const { o } = await select({ label_pattern: "level", text: "junior" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /^pressed ".*" but the control shows .*; not verified$/);
  assert.equal(o.pressed, "Junior");
  assert.ok("value" in o, JSON.stringify(o));
  assert.equal(o.unverified, undefined);
});

test("a combobox the page re-renders on pick is read from its new node, not the detached one", async () => {
  const html = `<span id=color-label>Color</span> <div id=w></div>`;
  const js = `let color = "", open = false;
  window.render = () => { document.getElementById("w").innerHTML = '<div class=box><button type=button id=color role=combobox aria-labelledby=color-label aria-expanded=' + open + ' aria-controls=color-list>' + (color || "Pick a color") + '</button><ul id=color-list role=listbox>' + (open ? ["Red", "Green", "Blue"].map((c) => "<li role=option>" + c + "</li>").join("") : "") + "</ul></div>"; };
  document.addEventListener("click", (e) => { if (e.target.closest("#color")) { open = !open; render(); return; } const li = e.target.closest("#color-list li"); if (li) { color = li.textContent; open = false; render(); } });
  render();`;
  onPage(html, js);
  const { o } = await select({ label_pattern: "^color$", text: "Blue" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value ?? o.selected, "Blue");
  // By id too, when the call named the control by selector.
  onPage(html, js);
  assert.equal((await select({ selector: "#color", text: "Green" })).o.ok, true);
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
  assert.equal(o.value ?? o.selected, "Senior");
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

// Settling early: a custom list's miss ends once more polling can't change the
// answer, instead of the full 2.5s. Timings are on the fake world's clock.
const spent = async (world, args) => {
  const t0 = world.clock.t;
  const { o } = await select(args);
  return { o, ms: world.clock.t - t0 };
};

test("empty text lists a custom control's options once the list holds for a few polls", async () => {
  const { world } = onPage(CUSTOM, CUSTOM_JS);
  const { o, ms } = await spent(world, { label_pattern: "level", text: "" });
  assert.deepEqual(o.candidates, ["Junior", "Senior"]);
  assert.ok(ms < 400, `waited ${ms}ms`);
});

test("a custom list with nothing to type into and no match settles once it holds", async () => {
  const { world } = onPage(CUSTOM, CUSTOM_JS);
  const { o, ms } = await spent(world, { label_pattern: "level", text: "principal" });
  assert.deepEqual(o.candidates, ["Junior", "Senior"]);
  assert.ok(ms < 900, `waited ${ms}ms`);
});

// A search box whose list answers the typed filter with other suggestions.
const SUGGEST = `<label id=sl>Office</label><input id=so role=combobox aria-labelledby=sl aria-controls=sm aria-expanded=false><ul id=sm role=listbox></ul>`;
const SUGGEST_JS = (render) => `
  const inp = document.getElementById('so'), ul = document.getElementById('sm');
  // A pick fills the input and closes the list, as a real combobox does.
  const show = (xs) => {
    ul.innerHTML = xs.map((x) => '<li role=option>' + x + '</li>').join(''); inp.setAttribute('aria-expanded', 'true');
    ul.querySelectorAll('li').forEach((o) => o.addEventListener('click', () => { inp.value = o.textContent; ul.innerHTML = ''; inp.setAttribute('aria-expanded', 'false'); }));
  };
  inp.addEventListener('focus', () => { if (!ul.children.length) show(['Berlin', 'Madrid']); });
  inp.addEventListener('mousedown', () => { if (!ul.children.length) show(['Berlin', 'Madrid']); });
  window.show = show; window.q = () => inp.value;
  ${render}`;

test("a typed filter's miss settles once the list has answered it and held", async () => {
  const { world } = onPage(SUGGEST, SUGGEST_JS(`inp.addEventListener('input', () => show(['Lisbon', 'Porto']));`));
  const { o, ms } = await spent(world, { label_pattern: "office", text: "Oslo" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.candidates, ["Berlin", "Madrid"]);
  assert.ok(ms < 1100, `waited ${ms}ms`);
});

// Counts page evaluations, so a page update can land a set number of polls later.
function evalHook(dom, fn) {
  const orig = dom.eval.bind(dom);
  let n = 0;
  dom.eval = (js) => { fn(++n); return orig(js); };
}

test("a list unchanged since the filter was typed is still waited on (a debounce)", async () => {
  const { dom } = onPage(SUGGEST, SUGGEST_JS(`inp.addEventListener('input', () => { window.typedAt = window.evals; });`));
  evalHook(dom, (n) => { dom.evals = n; if (dom.typedAt && n === dom.typedAt + 15) dom.show(["Oslo", "Porto"]); });
  const { o } = await select({ label_pattern: "office", text: "Oslo" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Oslo");
});

// Runs fn once, ms of fake-clock time after the page set window.typed.
function afterTyping(dom, world, ms, fn) {
  const orig = dom.eval.bind(dom);
  let t0 = null, done = false;
  dom.eval = (js) => {
    if (dom.typed && t0 == null) t0 = world.clock.t;
    if (!done && t0 != null && world.clock.t - t0 >= ms) { done = true; fn(); }
    return orig(js);
  };
}

test("a typed filter that empties a list which had options settles as a miss in about 0.5s", async () => {
  const { dom, world } = onPage(SUGGEST, SUGGEST_JS(`inp.addEventListener('input', () => show(['Berlin', 'Madrid'].filter((x) => x.toLowerCase().includes(inp.value.toLowerCase()))));`));
  const { o, ms } = await spent(world, { label_pattern: "office", text: "zz" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.error, "no option of this control matched");
  assert.deepEqual(o.candidates, ["Berlin", "Madrid"]);
  assert.equal(dom.document.getElementById("so").value, "", "the typed filter is cleared");
  assert.equal(ms, 550, "typed at 150ms, then 8 empty polls");
});

test("a status saying nothing matched is no loading signal", async () => {
  const { world } = onPage(SUGGEST, SUGGEST_JS(`inp.addEventListener('input', () => { ul.innerHTML = '<li role=status>No results found</li>'; });`));
  const { o, ms } = await spent(world, { label_pattern: "office", text: "zz" });
  assert.deepEqual(o.candidates, ["Berlin", "Madrid"]);
  assert.equal(ms, 550);
});

// Loading signals on or inside the control or its list: an emptied list is still waited on.
const LOADING = {
  "aria-busy on the list": `ul.setAttribute('aria-busy', 'true'); show([]);`,
  "aria-busy on the control": `inp.setAttribute('aria-busy', 'true'); show([]);`,
  "a spinner in the list": `ul.innerHTML = '<li><span class=spinner-border></span></li>';`,
  "a status in the list": `ul.innerHTML = '<li role=status>Fetching offices</li>';`,
  "a Loading message": `ul.innerHTML = '<li class=notice>Loading...</li>';`,
  "a status that says no results yet": `ul.innerHTML = '<li role=status>Looking up offices, no results yet</li>';`,
  "a status asking for more characters": `ul.innerHTML = '<li role=status>Type 3 or more characters</li>';`,
  "a Tailwind animate-spin icon": `ul.innerHTML = '<li><svg class="motion-safe:animate-spin h-4 w-4"></svg></li>';`,
  "a Tailwind animate-pulse skeleton": `ul.innerHTML = '<li><div class="animate-pulse h-4 bg-gray-200"></div></li>';`,
  "an aria-live region saying Searching": `ul.innerHTML = '<li aria-live=polite><svg></svg>Searching <b>offices</b></li>';`,
};
for (const [name, busy] of Object.entries(LOADING)) {
  test(`an emptied list is waited on while it shows ${name}`, async () => {
    const { dom, world } = onPage(SUGGEST, SUGGEST_JS(`inp.addEventListener('input', () => { window.typed = true; ${busy} });`));
    afterTyping(dom, world, 800, () => {
      const d = dom.document;
      d.getElementById("sm").removeAttribute("aria-busy");
      d.getElementById("so").removeAttribute("aria-busy");
      dom.show(["Oslo"]);
    });
    const { o, ms } = await spent(world, { label_pattern: "office", text: "Oslo" });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(o.selected, "Oslo");
    assert.equal(ms, 1000, "the answer lands 800ms after the poll that saw the filter");
  });
}

// Neither loading nor a no-results notice: a live count, or a class word only
// containing a Tailwind animation name.
const NOT_LOADING = {
  "a status with a live result count": `ul.innerHTML = '<li role=status>2 results available</li>';`,
  "a status saying No matches": `ul.innerHTML = '<li role=status>No matches for this search</li>';`,
  "a longer class word holding animate-spin": `ul.innerHTML = '<li><span class="animate-spin-once">x</span></li>';`,
};
for (const [name, html] of Object.entries(NOT_LOADING)) {
  test(`an emptied list showing ${name} settles in about 0.5s`, async () => {
    const { world } = onPage(SUGGEST, SUGGEST_JS(`inp.addEventListener('input', () => { ${html} });`));
    const { o, ms } = await spent(world, { label_pattern: "office", text: "zz" });
    assert.deepEqual(o.candidates, ["Berlin", "Madrid"], JSON.stringify(o));
    assert.equal(ms, 550);
  });
}

test("an emptied list with no loading signal misses at 0.5s though the answer would land at 0.8s", async () => {
  const { dom, world } = onPage(SUGGEST, SUGGEST_JS(`inp.addEventListener('input', () => { window.typed = true; show([]); });`));
  afterTyping(dom, world, 800, () => dom.show(["Oslo"]));
  const { o, ms } = await spent(world, { label_pattern: "office", text: "Oslo" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.candidates, ["Berlin", "Madrid"], "the list as it was before typing");
  assert.equal(ms, 550);
});

// A portaled list the control does not name: select finds it as options that
// appeared on opening, so its loading signal is only reachable through that list.
test("a loading signal inside a list the control does not name keeps it waited on", async () => {
  const html = `<div><label id=pl>Office</label><input id=po role=combobox aria-labelledby=pl aria-expanded=false></div>`;
  const { dom, world } = onPage(html, `
    const inp = document.getElementById('po');
    let ul = null;
    const show = (xs) => {
      ul.innerHTML = xs.map((x) => '<li role=option>' + x + '</li>').join('');
      ul.querySelectorAll('[role=option]').forEach((o) => o.addEventListener('click', () => { inp.value = o.textContent; ul.remove(); inp.setAttribute('aria-expanded', 'false'); }));
    };
    const open = () => { if (ul) return; ul = document.createElement('ul'); document.body.append(ul); inp.setAttribute('aria-expanded', 'true'); show(['Berlin', 'Madrid']); };
    inp.addEventListener('focus', open); inp.addEventListener('mousedown', open);
    inp.addEventListener('input', () => { window.typed = true; ul.innerHTML = '<li><span class=spinner></span></li>'; });
    window.show = show;`);
  afterTyping(dom, world, 800, () => dom.show(["Oslo"]));
  const { o, ms } = await spent(world, { label_pattern: "office", text: "Oslo" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Oslo");
  assert.equal(ms, 1000);
});

// A command palette dialog whose spinner sits beside its list, not inside it.
test("a loading signal elsewhere in the popup dialog keeps it waited on, without walking every element", async () => {
  const html = `<label id=bl>Office</label><button id=pb type=button aria-labelledby=bl aria-haspopup=dialog aria-expanded=false>Pick one</button>`;
  const { dom, world } = onPage(html, `
    const b = document.getElementById('pb');
    let d = null;
    const show = (xs) => {
      d.querySelector('[cmdk-list]').innerHTML = xs.map((x) => '<div cmdk-item role=option>' + x + '</div>').join('');
      d.querySelectorAll('[cmdk-item]').forEach((o) => o.addEventListener('click', () => { b.textContent = o.textContent; }));
    };
    b.addEventListener('click', () => {
      if (d) return;
      d = document.createElement('div');
      d.setAttribute('role', 'dialog');
      d.innerHTML = '<input cmdk-input><div cmdk-list></div><footer></footer>' + '<p>row</p>'.repeat(50);
      document.body.append(d);
      window.dialog = d;
      show(['Berlin', 'Madrid']);
      d.querySelector('input').addEventListener('input', () => {
        window.typed = true; show([]); d.querySelector('footer').innerHTML = '<span class=spinner></span>';
        const all = d.querySelectorAll.bind(d);
        window.stars = 0;
        d.querySelectorAll = (sel) => { if (sel === '*') window.stars++; return all(sel); };
      });
    });
    window.show = (xs) => { window.starsWhileEmpty = window.stars; d.querySelector('footer').innerHTML = ''; show(xs); };`);
  afterTyping(dom, world, 800, () => dom.show(["Oslo"]));
  const { o, ms } = await spent(world, { label_pattern: "office", text: "Oslo" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Oslo");
  assert.ok(ms > 800, `answered after ${ms}ms`);
  assert.equal(dom.starsWhileEmpty, 0, "empty polls never list every element of the dialog");
});

test("a list empty before the filter was typed is waited on past 0.5s (an async list)", async () => {
  const html = `<label id=al>Office</label><input id=ao role=combobox aria-labelledby=al aria-controls=am aria-expanded=false><ul id=am role=listbox></ul>`;
  const { dom, world } = onPage(html, `
    const inp = document.getElementById('ao'), ul = document.getElementById('am');
    window.show = (xs) => {
      ul.innerHTML = xs.map((x) => '<li role=option>' + x + '</li>').join(''); inp.setAttribute('aria-expanded', 'true');
      ul.querySelectorAll('li').forEach((o) => o.addEventListener('click', () => { inp.value = o.textContent; ul.innerHTML = ''; inp.setAttribute('aria-expanded', 'false'); }));
    };
    inp.addEventListener('input', () => { window.typed = true; });`);
  afterTyping(dom, world, 800, () => dom.show(["Oslo", "Porto"]));
  const { o, ms } = await spent(world, { label_pattern: "office", text: "Oslo" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Oslo");
  assert.equal(ms, 1000, "the answer lands 800ms after the poll that saw the filter");
});

test("native select: a disabled option or a disabled select is refused and nothing changes", async () => {
  const { dom } = onPage(`<label>Size <select id=s><option value="">Pick</option><option value=m disabled>M (sold out)</option><option value=l>L</option></select></label>
    <label>Shift <select id=t disabled><option value="">Pick</option><option value=d>Day</option></select></label>`);
  const off = (await select({ selector: "#s", text: "M (sold out)" })).o;
  assert.equal(off.ok, false, JSON.stringify(off));
  assert.match(off.error, /disabled/);
  assert.equal(dom.document.querySelector("#s").value, "");
  const dis = (await select({ selector: "#t", text: "Day" })).o;
  assert.equal(dis.ok, false, JSON.stringify(dis));
  assert.match(dis.error, /is disabled/);
  assert.equal(dom.document.querySelector("#t").value, "");
  assert.equal((await select({ selector: "#s", text: "L" })).o.ok, true);
});

// A combobox whose open listbox ignores the press on an option: nothing shows
// the pick, so select never claims it. The list it names is its own even when
// the bare input sits straight in <body>, so the miss is about the pick, not
// an empty list.
test("custom combobox: a listbox that ignores the pick is ok:false and the input keeps its value", async () => {
  const { dom } = onPage(`<label for=dest>Destination</label><input id=dest role=combobox aria-controls=l aria-expanded=true><ul id=l role=listbox><li role=option>Alpha</li><li role=option>Bravo</li></ul>`);
  const { r, o } = await select({ label_pattern: "destination", text: "Bravo" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.doesNotMatch(o.error, /did not open or is empty/);
  assert.match(o.error, /Bravo/);
  assert.equal(dom.document.getElementById("dest").value, "");
});

// The same combobox inside a page-wide <form> or <main>: a parent holding the
// listbox the input names, or two or more other fields, is the page's, not the
// control's box, so its text is never read as the pick.
test("custom combobox: a page-wide form or main around the bare input is not its box", async () => {
  const input = `<label for=dest>Destination</label><input id=dest role=combobox aria-controls=l aria-expanded=true>`;
  const list = `<ul id=l role=listbox><li role=option>Alpha</li><li role=option>Bravo</li></ul>`;
  const other = `<label for=n>Name</label><input id=n role=combobox aria-expanded=true><ul role=listbox><li role=option>Bravo</li></ul><label for=e>Email</label><input id=e>`;
  for (const html of [`<form>${input}${list}</form>`, `<main>${input}${list}</main>`, `<form>${other}${input}</form>${list}`]) {
    const { dom } = onPage(html);
    const { r, o } = await select({ label_pattern: "destination", text: "Bravo" });
    assert.equal(r.isError, undefined, html + " " + JSON.stringify(o));
    assert.equal(o.ok, false, html + " " + JSON.stringify(o));
    assert.doesNotMatch(o.error, /did not open or is empty/, html);
    assert.match(o.error, /Bravo/, html);
    assert.equal(dom.document.getElementById("dest").value, "", html);
  }
});

// select opens a custom control by pressing and focusing it; that focus brings
// an offscreen control into view, as a person reaching for it would, so the
// list opens where the pick can land. Once the call answers, the page goes
// back where it was.
test("custom combobox: select brings an offscreen control into view through its focus, then scrolls back", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS.replace("cb.querySelector('.v').textContent = o.textContent;", "cb.querySelector('.v').textContent = o.textContent; window.atPick = window.scrollY;") + `
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (o) { if (!(o && o.preventScroll)) window.scrollTo(0, 900); return focus.call(this, o); };`);
  const { o } = await select({ label_pattern: "level", text: "senior" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(dom.atPick, 900);
  assert.equal(dom.scrollY, 0);
});

// select may scroll a control into view to press it (centered, every call:
// Chrome scrolls on focus() only when focus moves, so a control still focused
// from an earlier select would stay offscreen), and once the pick is verified
// or refused puts every offset it moved back, unless the page moved one since.
// Repeated identical calls end where each started.
const SCROLLS = (y) => `
    window.intoView = []; window.atPick = [];
    HTMLElement.prototype.scrollIntoView = function (o) { window.intoView.push(o && o.block); window.scrollTo(0, ${y}); };
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (o) { if (!(o && o.preventScroll) && document.activeElement !== this) window.scrollTo(0, ${y}); return focus.call(this, o); };`;
const placed = (rect) => CUSTOM.replace("tabindex=0", `tabindex=0 data-rect=${rect}`).replace('<div class="select__control">', `<div class="select__control" data-rect="${rect}">`);
const closesOn = (extra = "") => CUSTOM_JS.replace("cb.querySelector('.v').textContent = o.textContent;",
  "cb.querySelector('.v').textContent = o.textContent; cb.setAttribute('aria-expanded', 'false'); document.getElementById('menu').innerHTML = ''; window.atPick.push(window.scrollY);" + extra);

test("custom combobox: repeated selects on a control below the viewport scroll to it and back, every call alike", async () => {
  const { dom } = onPage(placed("0,3000,100,20"), closesOn() + SCROLLS(2573));
  const ys = [];
  for (const text of ["senior", "junior", "senior"]) {
    dom.scrollTo(0, 0);
    const { o } = await select({ label_pattern: "level", text });
    assert.equal(o.ok, true, text + " " + JSON.stringify(o));
    ys.push(dom.scrollY);
  }
  assert.deepEqual(ys, [0, 0, 0]);
  assert.deepEqual([...dom.atPick], [2573, 2573, 2573]);
  assert.deepEqual([...dom.intoView], ["center", "center", "center"]);
});

test("custom combobox: a control above the viewport is scrolled to and the page goes back, every call alike", async () => {
  const { dom } = onPage(placed("0,-380,100,20"), closesOn() + SCROLLS(0));
  const ys = [];
  for (const text of ["senior", "junior"]) {
    dom.scrollTo(0, 400);
    assert.equal((await select({ label_pattern: "level", text })).o.ok, true, text);
    ys.push(dom.scrollY);
  }
  assert.deepEqual(ys, [400, 400]);
  assert.deepEqual([...dom.atPick], [0, 0]);
});

test("custom combobox: a refused select scrolls back too", async () => {
  const { dom } = onPage(placed("0,3000,100,20"), closesOn() + SCROLLS(2573));
  const { o } = await select({ label_pattern: "level", text: "principal" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(dom.scrollY, 0);
});

// A page that scrolls on its own after the press (a wizard moving to its next
// step) keeps its scroll: select puts back only what nothing moved since.
test("custom combobox: a scroll the page made after select's own is kept", async () => {
  const { dom } = onPage(placed("0,3000,100,20"), closesOn(" window.scrollTo(0, 1200);") + SCROLLS(2573));
  assert.equal((await select({ label_pattern: "level", text: "senior" })).o.ok, true);
  assert.equal(dom.scrollY, 1200);
});

// Only a control above or below the viewport is scrolled to: one wider than
// the viewport, a carousel slide off to the side, or one an ancestor clips
// (overflow:hidden) is left where the page put it.
test("custom combobox: select scrolls to a control only when it is above or below the viewport and unclipped", async () => {
  const at = (html, rect) => html.replace("tabindex=0", `tabindex=0 data-rect=${rect}`).replace('<div class="select__control">', `<div class="select__control" data-rect="${rect}">`);
  for (const [name, html] of [
    ["wider than the viewport", at(CUSTOM, "-50,100,2000,20")],
    ["carousel slide", `<div style="overflow:hidden">${at(CUSTOM, "1500,100,100,20")}</div>`],
    ["clipped below", `<div style="overflow:hidden">${at(CUSTOM, "0,3000,100,20")}</div>`],
  ]) {
    const { dom } = onPage(html, CUSTOM_JS + `
      window.intoView = 0;
      HTMLElement.prototype.scrollIntoView = function () { window.intoView++; };`);
    assert.equal((await select({ label_pattern: "level", text: "senior" })).o.ok, true, name);
    assert.equal(dom.intoView, 0, name);
  }
});

test("custom combobox: a control already in view is not scrolled by select", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS + `
    window.intoView = 0;
    HTMLElement.prototype.scrollIntoView = function () { window.intoView++; };`);
  assert.equal((await select({ label_pattern: "level", text: "senior" })).o.ok, true);
  assert.equal(dom.intoView, 0);
});

// A bare input with no aria-controls, its own box inside a page-wide form, and a
// listbox after it that was rendered before the press (collapsed by CSS, its
// options already laid out): nothing ties that list to the input, so select
// refuses rather than guess, and presses nothing in it.
test("custom combobox: a bare input's pre-rendered neighbour listbox in a page-wide form is refused, never pressed", async () => {
  const list = `<ul id=cl role=listbox><li role=option>Rosario</li><li role=option>Cordoba</li></ul>`;
  const js = `const i = document.getElementById('city'), l = document.getElementById('cl');
    window.hits = 0;
    i.addEventListener('click', () => { i.setAttribute('aria-expanded', 'true'); });
    l.querySelectorAll('li').forEach((o) => o.addEventListener('mousedown', (e) => { window.hits++; e.preventDefault(); i.value = o.textContent; }));`;
  const input = `<input id=city role=combobox aria-expanded=false autocomplete=off>`;
  for (const html of [
    `<form><label>Name <input name=n></label><label>Email <input name=e></label><label for=city>City</label>${input}${list}<button>Send</button></form>`,
    `<form><label>Name <input name=n></label><label>Email <input name=e></label><label>City ${input}</label>${list}</form>`,
  ]) {
    const { dom } = onPage(html, js);
    const { o } = await select({ label_pattern: "city", text: "Cordoba" });
    assert.equal(o.ok, false, html + " " + JSON.stringify(o));
    assert.match(o.error, /^the control's option list did not open or is empty/, html);
    assert.equal(dom.hits, 0, html);
    assert.equal(dom.document.getElementById("city").value, "", html);
  }
});

// A refusal closes what select opened with Escape and nothing else. A popup
// still open after it (a widget with no Escape handler) is left open and the
// refusal says so (open, note): a blur lets a widget commit its first option,
// and a synthetic press on the page outside would fire every outside-click
// handler there, closing a drawer or panel the form sits in.
test("custom combobox: a refused select closes the popup it opened by Escape, else says it is open", async () => {
  const list = `<ul id=cl role=listbox><li role=option>Rosario</li><li role=option>Cordoba</li></ul>`;
  const input = `<input id=city role=combobox aria-expanded=false autocomplete=off>`, hid = list.replace("listbox>", "listbox hidden>");
  const pageWide = (inner) => `<form><label>Name <input name=n></label><label>Email <input name=e></label><label for=city>City</label>${inner}<button type=button>Send</button></form>`;
  const base = `const i = document.getElementById('city'), l = document.getElementById('cl');
    window.blurs = 0; window.outside = 0; window.escs = 0;
    const shut = () => { i.setAttribute('aria-expanded', 'false'); l.hidden = true; };
    i.addEventListener('click', () => { i.setAttribute('aria-expanded', 'true'); l.hidden = false; });
    i.addEventListener('blur', () => { window.blurs++; });
    document.addEventListener('mousedown', (e) => { if (!i.contains(e.target) && !l.contains(e.target)) window.outside++; });
    i.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.escs++; });`;
  for (const [name, closes, blurs, open] of [
    ["on Escape", "i.addEventListener('keydown', (e) => { if (e.key === 'Escape') shut(); });", 0, false],
    ["on blur", "i.addEventListener('blur', shut);", 0, true],
    ["on an outside press", "document.addEventListener('mousedown', (e) => { if (!i.contains(e.target) && !l.contains(e.target)) shut(); });", 0, true],
  ]) {
    for (const [shape, html, text, error] of [
      ["pre-rendered list, no aria-controls", pageWide(input + list), "Cordoba", /^the control's option list did not open or is empty/],
      ["own list, nothing matching", pageWide(input.replace("autocomplete", "aria-controls=cl autocomplete") + hid), "Mendoza", /^no option of this control matched/],
      ["own list, pick not shown", pageWide(input.replace("autocomplete", "aria-controls=cl autocomplete") + hid), "Cordoba", /^pressed "Cordoba" but the control shows nothing/],
    ]) {
      const { dom } = onPage(html, base + closes);
      const { o } = await select({ label_pattern: "city", text });
      const at = `${name}, ${shape}`;
      assert.equal(o.ok, false, at + " " + JSON.stringify(o));
      assert.match(o.error, error, at);
      assert.equal(dom.document.getElementById("city").getAttribute("aria-expanded"), String(open), at);
      assert.deepEqual([dom.escs, dom.blurs, dom.outside], [1, blurs, 0], at);
      assert.equal(o.open, open || undefined, at);
      assert.equal(o.note, undefined, `${at}: open:true says it, with no note`);
    }
  }
  // A popup that was open before select pressed anything is the page's: left open.
  const { dom: d2, } = onPage(pageWide(input.replace("aria-expanded=false", "aria-expanded=true") + list), base);
  const kept = (await select({ label_pattern: "city", text: "Cordoba" })).o;
  assert.equal(kept.ok, false);
  assert.equal(kept.open, undefined);
  assert.equal(d2.document.getElementById("city").getAttribute("aria-expanded"), "true");
  assert.deepEqual([d2.escs, d2.blurs, d2.outside], [0, 0, 0]);
});

// The form in a drawer (no dialog role) that closes on any mousedown outside
// it: a refusal leaves the drawer open, and nothing on the page is clicked.
test("custom combobox: a refused select in a drawer never presses the page outside it", async () => {
  const { dom } = onPage(`<aside id=drawer class=open><form><label>Name <input name=n></label><label>Email <input name=e></label><label for=city>City</label>
    <input id=city role=combobox aria-expanded=false autocomplete=off><ul id=cl role=listbox><li role=option>Rosario</li></ul></form></aside>`, `
    const i = document.getElementById('city'), d = document.getElementById('drawer');
    window.bodyClicks = 0;
    i.addEventListener('click', () => { i.setAttribute('aria-expanded', 'true'); });
    document.addEventListener('mousedown', (e) => { if (!d.contains(e.target)) d.className = ''; });
    document.body.addEventListener('click', (e) => { if (e.target === document.body) window.bodyClicks++; });`);
  const { o } = await select({ label_pattern: "city", text: "Cordoba" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.open, true);
  assert.equal(dom.document.getElementById("drawer").className, "open");
  assert.equal(dom.bodyClicks, 0);
});

// A bare input whose real list is a portal appended to body on open, followed
// by a neighbour listbox of its own form (a chips list of what is chosen, a
// "Recent" list): the portal's options are the ones that appeared, so the
// neighbour is never read or pressed.
test("custom combobox: a bare input's portal list wins over a neighbour listbox", async () => {
  const portal = `const t = document.getElementById('t');
    t.addEventListener('click', () => {
      if (document.getElementById('pl')) return;
      t.setAttribute('aria-expanded', 'true');
      const ul = document.createElement('ul'); ul.id = 'pl'; ul.setAttribute('role', 'listbox');
      ul.innerHTML = '<li role=option>Alpha</li><li role=option>Bravo</li>';
      ul.querySelectorAll('li').forEach((o) => o.addEventListener('click', () => { t.value = o.textContent; t.setAttribute('aria-expanded', 'false'); ul.remove(); }));
      document.body.appendChild(ul);
    });
    window.recentHits = 0;
    document.querySelectorAll('#rec li').forEach((o) => o.addEventListener('click', () => { window.recentHits++; }));`;
  const head = `<form><label>Name <input name=n></label><label>Email <input name=e></label><label for=t>Team</label>`;
  for (const exp of ["", " aria-expanded=false"]) {
    for (const [what, next] of [
      ["chips", `<div role=listbox aria-label=Selected><div role=option aria-selected=true>Alpha</div></div>`],
      ["recent", `<ul id=rec role=listbox aria-label=Recent><li role=option>Bravo</li><li role=option>Charlie</li></ul>`],
    ]) {
      const { dom } = onPage(`${head}<input id=t role=combobox${exp}>${next}</form>`, portal);
      const { o } = await select({ label_pattern: "team", text: "Bravo" });
      assert.equal(o.ok, true, `${what}${exp} ${JSON.stringify(o)}`);
      assert.equal(dom.document.getElementById("t").value, "Bravo", what + exp);
      assert.equal(dom.recentHits, 0, what + exp);
    }
  }
});

// The real list may render a few tasks after the press (an async loadOptions,
// a portal mounted on the next render): a following listbox is no stand-in
// while select is still waiting for it.
test("custom combobox: a portal list that renders tasks after the press wins; a static neighbour listbox is never pressed", async () => {
  for (const n of [2, 6, 12, 20]) {
    const { dom } = onTickPage(`<form><label>Name <input name=n></label><label>Email <input name=e></label><label for=t>Team</label><input id=t role=combobox aria-expanded=false>
      <ul id=rec role=listbox aria-label=Recent><li role=option>Bravo</li></ul></form>`, `const t = document.getElementById('t');
      window.recentHits = 0;
      document.querySelectorAll('#rec li').forEach((o) => o.addEventListener('click', () => { window.recentHits++; }));
      t.addEventListener('click', () => {
        t.setAttribute('aria-expanded', 'true');
        later(() => {
          const ul = document.createElement('ul'); ul.setAttribute('role', 'listbox');
          ul.innerHTML = '<li role=option>Alpha</li><li role=option>Bravo</li>';
          ul.querySelectorAll('li').forEach((o) => o.addEventListener('click', () => { t.value = o.textContent; t.setAttribute('aria-expanded', 'false'); ul.remove(); }));
          document.body.appendChild(ul);
        }, ${n});
      });`);
    const { o } = await select({ label_pattern: "team", text: "Bravo" });
    assert.equal(o.ok, true, `${n} ticks ${JSON.stringify(o)}`);
    assert.equal(dom.document.getElementById("t").value, "Bravo");
    assert.equal(dom.recentHits, 0, `${n} ticks`);
  }
});

// A search-as-you-type combobox: its portal list opens on input, so select types
// the pick's text as a filter. The input then shows that typed text whatever
// the option press did, so it proves nothing on its own: something else must
// move (the list closing, a hidden companion, the option marked selected).
const SEARCH = `<form><label>Name <input name=n></label><div class=team><label for=t>Team</label><input id=t role=combobox autocomplete=off><input type=hidden id=tid name=team_id></div><label>Email <input name=e></label></form>`;
const SEARCH_JS = (onPick) => `const t = document.getElementById('t'), hid = document.getElementById('tid');
  let ul = null;
  t.addEventListener('input', () => {
    if (!ul) { ul = document.createElement('ul'); ul.setAttribute('role', 'listbox'); document.body.appendChild(ul); }
    t.setAttribute('aria-expanded', 'true');
    ul.innerHTML = ['Alpha', 'Bravo'].filter((x) => x.toLowerCase().startsWith(t.value.toLowerCase())).map((x) => '<li role=option>' + x + '</li>').join('');
    ul.querySelectorAll('li').forEach((o) => o.addEventListener('click', (e) => { ${onPick} }));
  });`;

test("custom combobox: the typed filter showing in the input is not the pick", async () => {
  // Options that ignore a synthetic click: only the typed text shows.
  const { dom } = onPage(SEARCH, SEARCH_JS("if (!e.isTrusted) return; t.value = o.textContent;"));
  const { o } = await select({ label_pattern: "team", text: "Bravo" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.selected, undefined);
  assert.equal(o.error, `pressed "Bravo" but the control shows only the text select typed; not verified: retry with select {trusted:true}, or check the field (a list that stays open on pick shows this too)`);
  assert.equal(dom.document.getElementById("t").value, "");
});

// A refused read takes select's typed filter back out and restores the input
// and companion before any blur: a widget that commits its first match on blur
// (MUI autoSelect, select-first-on-blur) would otherwise pick after ok:false,
// the wrong option when the first match is not the wanted one.
test("custom combobox: a refused read leaves the field at its prior value though blur commits the first match", async () => {
  for (const [what, opts] of [["first match wanted", ["Bravo", "Bravo Company", "Alpha"]], ["first match differs", ["Bravo Company", "Bravo", "Alpha"]]]) {
    for (const prior of ["", "Alpha"]) {
      const html = SEARCH.replace("<input id=t role=combobox", `<input id=t role=combobox value="${prior}"`).replace("name=team_id>", `name=team_id value="${prior && "id-" + prior}">`);
      const { dom } = onPage(html, SEARCH_JS("if (!e.isTrusted) return; t.value = o.textContent;").replace("['Alpha', 'Bravo']", JSON.stringify(opts)) + `
        t.addEventListener('blur', () => { const f = ul && ul.querySelector('li'); if (f && t.value) { t.value = f.textContent; hid.value = 'id-' + f.textContent; } });`);
      const { o } = await select({ label_pattern: "team", text: "Bravo" });
      const at = `${what}, prior ${JSON.stringify(prior)}`;
      assert.equal(o.ok, false, at + " " + JSON.stringify(o));
      assert.match(o.error, /shows only the text select typed/, at);
      assert.equal(dom.document.getElementById("t").value, prior, at);
      assert.equal(dom.document.getElementById("tid").value, prior && "id-" + prior, at);
    }
  }
});

// A refusal blurs nothing: a widget that commits its first listed option on
// blur, whatever the input holds, would pick after ok:false once untype has
// emptied the input and the list shows everything.
test("custom combobox: a refusal never blurs the control, so blur's first-option commit never runs", async () => {
  const { dom } = onPage(SEARCH, SEARCH_JS("if (!e.isTrusted) return; t.value = o.textContent;").replace("['Alpha', 'Bravo']", '["Bravo Team", "Bravo"]') + `
    window.blurs = 0;
    t.addEventListener('blur', () => { window.blurs++; const f = ul && ul.querySelector('li'); if (f) { t.value = f.textContent; hid.value = 'id-' + f.textContent; } });`);
  const { o } = await select({ label_pattern: "team", text: "Bravo" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.open, true);
  assert.equal(dom.blurs, 0);
  assert.equal(dom.document.getElementById("t").value, "");
  assert.equal(dom.document.getElementById("tid").value, "");
});

// Only select's own typing is undone: a value the page wrote after the press
// (its pick, shown in its own format) stays, companion and all.
test("custom combobox: a refusal leaves a value the page's pick wrote", async () => {
  const { dom } = onPage(SEARCH, SEARCH_JS("t.value = 'BRV-5'; hid.value = 'id-Bravo'; t.setAttribute('aria-expanded', 'false'); ul.remove(); ul = null;"));
  const { o } = await select({ label_pattern: "team", text: "Bravo" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(dom.document.getElementById("t").value, "BRV-5");
  assert.equal(dom.document.getElementById("tid").value, "id-Bravo");
});

// An empty input whose box shows only the control's own label shows nothing.
test("custom combobox: an empty input's box showing only its label reads as nothing", async () => {
  onPage(SEARCH, SEARCH_JS("t.value = ''; t.setAttribute('aria-expanded', 'false'); ul.remove(); ul = null;"));
  const { o } = await select({ label_pattern: "team", text: "Bravo" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.error, 'pressed "Bravo" but the control shows nothing; not verified');
  assert.equal(o.value ?? o.selected, "");
});

test("custom combobox: a pick equal to the typed text holds once the list closes, the companion fills or the option is selected", async () => {
  for (const [what, onPick] of [
    ["list closes", "t.value = o.textContent; t.setAttribute('aria-expanded', 'false'); ul.remove(); ul = null;"],
    ["companion fills", "t.value = o.textContent; hid.value = 'id-' + o.textContent;"],
    ["option selected", "t.value = o.textContent; o.setAttribute('aria-selected', 'true');"],
  ]) {
    onPage(SEARCH, SEARCH_JS(onPick));
    const { o } = await select({ label_pattern: "team", text: "Bravo" });
    assert.equal(o.ok, true, what + " " + JSON.stringify(o));
    assert.equal(o.selected, "Bravo", what);
  }
});

// A list that closes by transition: the control says aria-expanded=false at once
// while the options stay mounted through a leave animation, or it holds
// aria-expanded=true a couple of tasks before closing. Either is the list
// closing on the pick, read on later reads too, before any Escape of select's own.
test("custom combobox: a typed-text pick holds when the list closes through a transition", async () => {
  for (const [what, onPick] of [
    ["leave transition", "t.value = o.textContent; t.setAttribute('aria-expanded', 'false'); later(() => { ul.remove(); ul = null; }, 2);"],
    ["late close", "t.value = o.textContent; later(() => { t.setAttribute('aria-expanded', 'false'); ul.remove(); ul = null; }, 2);"],
  ]) {
    onTickPage(SEARCH, SEARCH_JS(onPick));
    const { o } = await select({ label_pattern: "team", text: "Bravo" });
    assert.equal(o.ok, true, what + " " + JSON.stringify(o));
    assert.equal(o.selected, "Bravo", what);
  }
});

// downshift's useCombobox and MUI's clearOnEscape clear the input on an Escape
// while closed: select must not Escape a control that already says it closed,
// though its options stay mounted through a leave transition, and a value an
// Escape of its own cleared is never reported as the pick.
test("custom combobox: no Escape reaches a control that says it closed, and one that clears the pick is not ok", async () => {
  const clears = "t.addEventListener('keydown', (e) => { if (e.key === 'Escape') { window.escapes = (window.escapes || 0) + 1; if (t.getAttribute('aria-expanded') !== 'true') t.value = ''; } });";
  const { dom } = onTickPage(SEARCH, SEARCH_JS("t.value = o.textContent; t.setAttribute('aria-expanded', 'false'); later(() => { ul.remove(); ul = null; }, 3);") + clears);
  const { o } = await select({ label_pattern: "team", text: "Bravo" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(dom.document.getElementById("t").value, "Bravo");
  assert.equal(dom.escapes, undefined);
  // A widget that says it is open but clears on any Escape: the returning read
  // sees the cleared value and refuses.
  const always = "t.addEventListener('keydown', (e) => { if (e.key === 'Escape') t.value = ''; });";
  const c = onTickPage(SEARCH, SEARCH_JS("t.value = o.textContent; hid.value = 'id-' + o.textContent;") + always);
  const { o: x } = await select({ label_pattern: "team", text: "Bravo" });
  assert.equal(x.ok, false, JSON.stringify(x));
  assert.match(x.error, /^pressed "Bravo" but the control dropped it when its popup was closed/);
  assert.equal(c.dom.document.getElementById("t").value, "");
});

// A hand-rolled combobox whose aria-expanded never leaves "false": its list shows
// on click and hides only on Escape. The stale attribute says nothing, so the
// list still showing decides, and select closes the popup it opened.
test("custom combobox: a stale aria-expanded=false never keeps select from closing the list it opened", async () => {
  const { dom } = onPage(`<label id=hl>Tier</label><div id=hc role=combobox aria-labelledby=hl aria-expanded=false aria-controls=hm tabindex=0><span class=v>Choose</span></div>
    <ul id=hm role=listbox hidden><li role=option>Alpha</li><li role=option>Beta</li></ul>`, `const c = document.getElementById('hc'), m = document.getElementById('hm');
    window.escs = 0;
    c.addEventListener('click', () => { m.hidden = false; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { window.escs++; m.hidden = true; } });
    m.querySelectorAll('li').forEach((o) => o.addEventListener('click', () => { c.querySelector('.v').textContent = o.textContent; }));`);
  const { o } = await select({ label_pattern: "tier", text: "Beta" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(dom.escs, 1);
  assert.equal(dom.document.getElementById("hm").hidden, true);
});

// A pick select can't verify still closes the popup it opened, on the final read.
test("custom combobox: a refused typed-text pick still closes the list select opened", async () => {
  const { dom } = onPage(SEARCH, SEARCH_JS("t.value = o.textContent;") + "t.addEventListener('keydown', (e) => { if (e.key === 'Escape') { t.setAttribute('aria-expanded', 'false'); document.querySelector('[role=listbox]').remove(); } });");
  const { o } = await select({ label_pattern: "team", text: "Bravo" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(dom.document.querySelector("[role=listbox]"), null);
  assert.equal(dom.document.getElementById("t").getAttribute("aria-expanded"), "false");
});

test("custom combobox: a bare input re-rendered empty on pick in a form or body is ok:false", async () => {
  const input = `<label for=dest>Destination</label><input id=dest role=combobox aria-controls=l aria-expanded=true>`;
  const list = `<ul id=l role=listbox><li role=option>Alpha</li><li role=option>Bravo</li></ul>`;
  const js = `document.getElementById("l").addEventListener("click", () => { const d = document.getElementById("dest"); d.replaceWith(d.cloneNode(false)); });`;
  for (const html of [`<form><label for=n>Name</label><input id=n><label for=e>Email</label><input id=e>${input}</form>${list}`, `${input}${list}`]) {
    const { dom } = onPage(html, js);
    const { o } = await select({ label_pattern: "destination", text: "Bravo" });
    assert.equal(o.ok, false, html + " " + JSON.stringify(o));
    assert.equal(dom.document.getElementById("dest").value, "", html);
  }
  // A clone that drops aria-controls (set only while open) keeps the start's box,
  // so the wrapper holding the list is never read as the pick.
  const bare = js.replace("d.cloneNode(false)", "(() => { const c = d.cloneNode(false); c.removeAttribute('aria-controls'); return c; })()");
  for (const html of [
    `<form><div class=combo>${input}${list}</div><input name=a></form>`,
    `<form><label for=dest>Destination</label><div class=combo><input id=dest role=combobox aria-controls=l aria-expanded=true>${list}</div><input name=a></form>`,
    `<form><div class=combo>${input}<ul id=l role=listbox><li role=option>Bravo</li></ul></div><input name=a></form>`,
  ]) {
    const { dom } = onPage(html, bare);
    const { o } = await select({ label_pattern: "destination", text: "Bravo" });
    assert.equal(o.ok, false, html + " " + JSON.stringify(o));
    assert.equal(dom.document.getElementById("dest").value, "", html);
  }
});

// A control may show the pick in its own format: the option's text followed by a
// separator and detail, or the option's value. A different option whose text
// merely starts the same way is never the pick.
const FMT = (items, attrs = "") => `<label id=fl>Fruit</label><div id=fc role=combobox aria-labelledby=fl aria-expanded=false aria-controls=fm tabindex=0><span class=placeholder>Pick one</span></div>
  <ul id=fm role=listbox hidden>${items.map((t) => `<li role=option ${attrs.replace("$v", t.toLowerCase().replace(/ /g, "-"))}>${t}</li>`).join("")}</ul>`;
const FMT_JS = (show) => `const c = document.getElementById('fc'), m = document.getElementById('fm');
  c.addEventListener('click', () => { m.hidden = false; c.setAttribute('aria-expanded', 'true'); });
  m.querySelectorAll('li').forEach((o) => o.addEventListener('click', () => {
    c.innerHTML = '<span class=v></span>'; c.firstChild.textContent = (${show})(o.textContent, o);
    m.hidden = true; c.setAttribute('aria-expanded', 'false');
  }));`;

test("custom combobox: a pick shown in the control's own format holds", async () => {
  for (const [what, items, pick, show, attrs] of [
    ["parenthetical", ["Apple", "Banana", "Cherry"], "Cherry", "(t) => t + ' (' + t.toLowerCase() + ')'"],
    ["dash detail", ["Red", "Blue", "Green"], "Blue", "(t) => t + ' - #00f'"],
    ["middle dot", ["Red", "Blue", "Green"], "Blue", "(t) => t + ' · primary'"],
    ["bracketed code", ["Red", "Blue", "Green"], "Blue", "(t) => t + ' [BLU]'"],
    ["value attribute", ["Red", "Blue", "Green"], "Blue", "(t, o) => o.getAttribute('value')", "value=$v-1"],
    ["data-value", ["Red", "Blue", "Green"], "Blue", "(t, o) => o.dataset.value", "data-value=c-$v"],
    ["parenthetical beside look-alikes", ["Blue", "Blueberry", "Blue Jay"], "Blue", "(t) => t + ' (blue)'"],
  ]) {
    onPage(FMT(items, attrs), FMT_JS(show));
    const { o } = await select({ label_pattern: "fruit", text: pick });
    assert.equal(o.ok, true, what + " " + JSON.stringify(o));
    assert.equal(o.selected, pick, what);
  }
});

test("custom combobox: another option whose text starts like the pick is not the pick", async () => {
  const items = ["Blue", "Blueberry", "Blue Jay", "Blue - Navy"];
  for (const [what, show] of [
    ["longer word", "() => 'Blueberry'"],
    ["two words", "() => 'Blue Jay'"],
    ["other option formatted", "() => 'Blue Jay (bj)'"],
    ["other option with a dash", "() => 'Blue - Navy'"],
    ["other option with a dash, formatted", "() => 'Blue - Navy (nv)'"],
    ["plain extra word", "() => 'Blue Sky'"],
  ]) {
    onPage(FMT(items), FMT_JS(show));
    const { o } = await select({ label_pattern: "fruit", text: "Blue" });
    assert.equal(o.ok, false, what + " " + JSON.stringify(o));
    assert.match(o.error, /^pressed "Blue" but the control shows /, what);
  }
});

// A control inside a modal: the page's own Escape handler (on the dialog or on
// the document) closes the whole dialog, so an Escape of select's own to close
// its popup would take the form with it. The popup is closed another way, and
// a dialog that closed anyway is reported.
const MODAL = (kind) => `${kind === "dialog" ? "<dialog id=dlg open>" : "<div id=dlg role=dialog aria-modal=true>"}<label id=ml>Color</label><div id=mc role=combobox aria-labelledby=ml aria-expanded=false aria-controls=mm tabindex=0><span class=v>Choose</span></div><input name=other>${kind === "dialog" ? "</dialog>" : "</div>"}
  <ul id=mm role=listbox hidden><li role=option>Red</li><li role=option>Blue</li></ul>`;
// toggles: a press on the open control closes it. listEsc: where the page's
// list hears Escape ("document", "list", or none). dlgEsc: where the dialog's
// close-on-Escape handler listens ("document" or "dialog").
const MODAL_JS = ({ toggles, listEsc, dlgEsc, kind }) => `const c = document.getElementById('mc'), m = document.getElementById('mm'), d = document.getElementById('dlg');
  const shut = () => { m.hidden = true; c.setAttribute('aria-expanded', 'false'); };
  window.dlgCloses = 0;
  c.addEventListener('click', () => { if (${toggles} && !m.hidden) return shut(); m.hidden = false; c.setAttribute('aria-expanded', 'true'); });
  m.querySelectorAll('li').forEach((o) => o.addEventListener('click', () => { c.querySelector('.v').textContent = 'Something else'; }));
  ${listEsc === "document" ? "document" : listEsc === "list" ? "m" : "null"}?.addEventListener('keydown', (e) => { if (e.key === 'Escape') shut(); });
  ${dlgEsc === "document" ? "document" : "d"}.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    window.dlgCloses++;
    ${kind === "dialog" ? "d.removeAttribute('open');" : "d.hidden = true;"}
  });`;
const dlgOpen = (dom, kind) => { const d = dom.document.getElementById("dlg"); return kind === "dialog" ? d.hasAttribute("open") : !d.hidden; };

test("custom combobox in a modal: a refusal closes the popup without closing the dialog", async () => {
  for (const kind of ["aria", "dialog"]) {
    for (const dlgEsc of ["document", "dialog"]) {
      for (const [what, text] of [["unshown pick", "Blue"], ["miss", "Zebra"]]) {
        const at = `${kind} ${dlgEsc} ${what}`;
        const { dom } = onPage(MODAL(kind), MODAL_JS({ toggles: true, listEsc: "document", dlgEsc, kind }));
        const { o } = await select({ label_pattern: "color", text });
        assert.equal(o.ok, false, at + " " + JSON.stringify(o));
        assert.equal(dlgOpen(dom, kind), true, at);
        assert.equal(dom.dlgCloses, 0, at);
        assert.equal(dom.document.getElementById("mm").hidden, true, at);
        assert.equal(o.dialogClosed, undefined, at);
        assert.equal(o.open, undefined, at);
      }
    }
  }
});

test("custom combobox in a modal: a popup that won't toggle gets Escape on its own list, and a dialog that closes anyway is reported", async () => {
  for (const kind of ["aria", "dialog"]) {
    // The list hears Escape itself and sits outside the dialog: the dialog's own handler never hears it.
    for (const listEsc of ["list", "document"]) {
      const { dom } = onPage(MODAL(kind), MODAL_JS({ toggles: false, listEsc, dlgEsc: "dialog", kind }));
      const { o } = await select({ label_pattern: "color", text: "Blue" });
      const at = `${kind} list heard at ${listEsc}`;
      assert.equal(o.ok, false, at + " " + JSON.stringify(o));
      assert.equal(dlgOpen(dom, kind), true, at);
      assert.equal(dom.document.getElementById("mm").hidden, true, at);
      assert.equal(o.dialogClosed, undefined, at);
    }
    // A document-level handler closes the dialog on any Escape: the refusal says so.
    const { dom } = onPage(MODAL(kind), MODAL_JS({ toggles: false, listEsc: "document", dlgEsc: "document", kind }));
    const { o } = await select({ label_pattern: "color", text: "Blue" });
    assert.equal(o.ok, false, kind + " " + JSON.stringify(o));
    assert.equal(dlgOpen(dom, kind), false, kind);
    assert.equal(o.dialogClosed, true, kind);
    assert.match(o.error, /^pressed "Blue" but the control shows "Something else"; not verified/);
    // A list inside the dialog gets no Escape at all: it is left open, and the refusal says so.
    const inside = MODAL(kind).replace(/(<\/dialog>|<\/div>)\n(\s*<ul id=mm[^]*<\/ul>)/, "$2$1");
    assert.notEqual(inside, MODAL(kind));
    const w = onPage(inside, MODAL_JS({ toggles: false, listEsc: "document", dlgEsc: "dialog", kind }));
    const { o: x } = await select({ label_pattern: "color", text: "Blue" });
    assert.equal(x.ok, false, kind + " inside " + JSON.stringify(x));
    assert.equal(x.open, true, kind + " inside");
    assert.equal(x.dialogClosed, undefined, kind + " inside");
    assert.equal(dlgOpen(w.dom, kind), true, kind + " inside");
    assert.equal(w.dom.dlgCloses, 0, kind + " inside");
  }
});

// The modal rule never costs a pick outside a modal or a verified pick inside one.
test("custom combobox: outside a modal a refusal still Escapes the control; a verified pick in a modal answers as before", async () => {
  const { dom } = onPage(MODAL("aria").replace("role=dialog aria-modal=true", ""), MODAL_JS({ toggles: true, listEsc: "document", dlgEsc: "dialog", kind: "aria" }) + "window.escs = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.escs++; });");
  const { o } = await select({ label_pattern: "color", text: "Blue" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(dom.escs, 1);
  const ok = onPage(MODAL("aria"), MODAL_JS({ toggles: true, listEsc: "document", dlgEsc: "document", kind: "aria" }).replace("'Something else'", "o.textContent") + "m.querySelectorAll('li').forEach((o) => o.addEventListener('click', () => { m.hidden = true; c.setAttribute('aria-expanded', 'false'); }));");
  const { o: v } = await select({ label_pattern: "color", text: "Blue" });
  assert.deepEqual(v, { ok: true, selected: "Blue", el: `combobox "Color"` });
  assert.equal(dlgOpen(ok.dom, "aria"), true);
});

// select_start closes other open menus with Escape first; inside a modal whose
// handler closes it on any Escape, that would take the dialog down on a pick
// that verifies, so a menu there is left alone.
test("custom combobox in a modal: another open menu gets no Escape the dialog hears, and the pick holds", async () => {
  for (const kind of ["aria", "dialog"]) {
    for (const dlgEsc of ["document", "dialog"]) {
      const html = MODAL(kind).replace("<input name=other>", "<input name=other role=combobox aria-expanded=true aria-label=Other>");
      const { dom } = onPage(html, MODAL_JS({ toggles: true, listEsc: "document", dlgEsc, kind }).replace("'Something else'", "o.textContent") +
        "m.querySelectorAll('li').forEach((o) => o.addEventListener('click', () => { m.hidden = true; c.setAttribute('aria-expanded', 'false'); }));");
      const { o } = await select({ label_pattern: "color", text: "Blue" });
      const at = `${kind} ${dlgEsc}`;
      assert.deepEqual(o, { ok: true, selected: "Blue", el: `combobox "Color"` }, at);
      assert.equal(dlgOpen(dom, kind), true, at);
      assert.equal(dom.dlgCloses, 0, at);
    }
  }
  // Outside a modal the other menu still gets its Escape.
  const { dom } = onPage(`<label>Other <input role=combobox aria-expanded=true id=oth></label>` + MODAL("aria").replace("role=dialog aria-modal=true", ""),
    MODAL_JS({ toggles: true, listEsc: "none", dlgEsc: "dialog", kind: "aria" }) + "window.othEsc = 0; document.getElementById('oth').addEventListener('keydown', (e) => { if (e.key === 'Escape') window.othEsc++; });");
  await select({ label_pattern: "^color", text: "Blue" });
  assert.equal(dom.othEsc, 1);
});
