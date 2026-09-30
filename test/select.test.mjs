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
  assert.equal(o.value, "Blue");
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
  const show = (xs) => { ul.innerHTML = xs.map((x) => '<li role=option>' + x + '</li>').join(''); inp.setAttribute('aria-expanded', 'true'); };
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
    const show = (xs) => { ul.innerHTML = xs.map((x) => '<li role=option>' + x + '</li>').join(''); };
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
    window.show = (xs) => { ul.innerHTML = xs.map((x) => '<li role=option>' + x + '</li>').join(''); inp.setAttribute('aria-expanded', 'true'); };
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
