// Late reverts: a page can undo a write a task after the page script that made
// it returned. A plain fill or a native select keeps what landed on the page
// and answers at once; the next perch page call on that tab reads the record
// first, inside its own execute, and reports a revert or another option as
// `late`, then drops it. A reformat is no revert and is not reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const QUEUE_JS = `
  window.__q = [];
  window.later = (fn, n) => { window.__q.push({ fn, n }); };
  window.__tick = () => { const due = window.__q.filter((j) => --j.n <= 0); window.__q = window.__q.filter((j) => j.n > 0); due.forEach((j) => j.fn()); };`;

const BROWSERS = {
  chrome: { name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x" }] }] },
  arc: { name: "Arc", kind: "arc", windows: [{ id: "W1", active: 0, tabs: [{ url: "https://a.test/", id: "x" }] }] },
  safari: { name: "Safari", kind: "safari", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x" }] }] },
};

function onPage(html, setup, browser = "chrome") {
  const dom = page(html);
  dom.eval(QUEUE_JS);
  if (setup) dom.eval(setup);
  const ev = dom.eval.bind(dom);
  const scripts = [];
  dom.eval = (js) => { scripts.push(js); dom.__tick(); return ev(js); };
  const spec = structuredClone(BROWSERS[browser]);
  spec.windows[0].tabs[0].dom = dom;
  const world = makeWorld({ browsers: [spec], cg: [{ owner: spec.name }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return { dom, world, scripts };
}
const call = async (name, args = {}) => {
  const r = await handleCall(name, args);
  const texts = r.content.filter((c) => c.type === "text").map((c) => c.text);
  const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
  return { r, o: parse(texts[0]), rest: texts.slice(1).map(parse) };
};
// The late list a call reported: a key of an object result, else a second text item.
const lateOf = ({ o, rest }) => (o && typeof o === "object" && !Array.isArray(o) && o.late) || rest.map((x) => x && x.late).find(Boolean);
const execs = (world) => (world.counts["tab.execute"] || 0) + (world.counts["doJavaScript"] || 0);

const ZIP = `<form><label>Zip <input id=zip name=zip></label><label>City <input id=city name=city></label><button id=go type=button>Go</button></form>`;
const ZIP_CLEARS = `const z = document.getElementById('zip');
  z.addEventListener('input', () => { later(() => { z.value = ''; }, 1); });
  window.clicks = 0; document.getElementById('go').addEventListener('click', () => { window.clicks++; });`;
const ZIP_LATE = { el: `textbox "Zip"`, error: "was cleared after it was filled; the page reverted the write; retry with fill {trusted:true}" };

for (const browser of ["chrome", "arc", "safari"]) {
  test(`${browser}: a fill the page undoes a task later answers ok, and the next page call reports it once as late`, async () => {
    const { dom } = onPage(ZIP, ZIP_CLEARS, browser);
    const f = await call("fill", { label_pattern: "zip", text: "2000" });
    assert.deepEqual(f.o, { ok: true, kind: "plain", el: `textbox "Zip"`, len: 4 });
    const next = await call("get_text", { selector: "form" });
    assert.deepEqual(lateOf(next), [ZIP_LATE], JSON.stringify(next.o));
    assert.equal(dom.document.getElementById("zip").value, "");
    assert.equal(Object.keys(dom.__perch_fr || {}).length, 1, "the check never deletes a record in the page");
    assert.equal(lateOf(await call("get_text", { selector: "form" })), undefined, "reported once");
  });

  test(`${browser}: a native select the page moves to another option a task later is late on the next call`, async () => {
    onPage(`<label>Country <select id=co><option value="">Pick</option><option>Chile</option><option>Peru</option></select></label>`,
      `const co = document.getElementById('co'); co.addEventListener('change', () => { later(() => { co.selectedIndex = 2; }, 1); });`, browser);
    const s = await call("select", { label_pattern: "country", text: "Chile" });
    assert.deepEqual(s.o, { ok: true, selected: "Chile", el: `combobox "Country"` });
    const next = await call("eval_js", { script: "return 1" });
    assert.equal(next.o, 1, "eval_js's own value is untouched");
    assert.deepEqual(lateOf(next), [{ el: `combobox "Country"`, error: `changed to "Peru" after it was filled; the page chose another option` }]);
  });
}

test("a write that holds, and a value the page reformats, are never reported", async () => {
  const { dom } = onPage(`<label>Postcode <input id=pc></label><label>City <input id=city></label>`,
    `const pc = document.getElementById('pc'); pc.addEventListener('input', () => { later(() => { pc.value = pc.value.toUpperCase(); }, 1); });`);
  assert.deepEqual((await call("fill", { label_pattern: "postcode", text: "sw1a 1aa" })).o, { ok: true, kind: "plain", el: `textbox "Postcode"`, len: 8 });
  assert.deepEqual((await call("fill", { label_pattern: "city", text: "Leeds" })).o, { ok: true, kind: "plain", el: `textbox "City"`, len: 5 });
  const next = await call("get_text", {});
  assert.equal(lateOf(next), undefined, JSON.stringify(next.o));
  assert.equal(dom.document.getElementById("pc").value, "SW1A 1AA");
});

test("a field put back to its prior value is late with that value; a clear the page refills is too", async () => {
  onPage(`<label>Code <input id=code value=A1></label>`, `const c = document.getElementById('code');
    c.addEventListener('input', () => { later(() => { c.value = 'A1'; }, 1); });`);
  assert.equal((await call("fill", { label_pattern: "code", text: "B2" })).o.ok, true);
  assert.deepEqual(lateOf(await call("get_text", {})), [{ el: `textbox "Code"`, error: `changed to "A1" after it was filled; the page reverted the write; retry with fill {trusted:true}` }]);
  assert.equal((await call("fill", { label_pattern: "code", text: "" })).o.ok, true);
  assert.deepEqual(lateOf(await call("get_text", {})), [{ el: `textbox "Code"`, error: `changed to "A1" after it was filled; the page reverted the write` }]);
});

// The check runs first in the next call's own execute: a fill of the next field
// reports the earlier one, and its own record waits for the call after it.
test("the next fill reports the earlier write's revert and keeps its own record for the call after", async () => {
  onPage(ZIP, ZIP_CLEARS + `const ci = document.getElementById('city'); ci.addEventListener('input', () => { later(() => { ci.value = ''; }, 1); });`);
  await call("fill", { label_pattern: "zip", text: "2000" });
  const city = await call("fill", { label_pattern: "city", text: "Rosario" });
  assert.equal(city.o.ok, true);
  assert.deepEqual(city.o.late, [ZIP_LATE]);
  assert.deepEqual(lateOf(await call("get_text", {})), [{ el: `textbox "City"`, error: ZIP_LATE.error }]);
});

// No extra Apple Event: the write is one execute, and the check rides the next
// call's execute.
test("a plain fill and a native select cost one page run, and the next call carries the check for free", async () => {
  const { world } = onPage(ZIP + `<label>Plan <select id=plan><option>Basic</option><option>Pro</option></select></label>`, ZIP_CLEARS);
  world.reset();
  await call("fill", { label_pattern: "zip", text: "2000" });
  assert.equal(execs(world), 1);
  world.reset();
  const next = await call("eval_js", { script: "return 2" });
  assert.equal(execs(world), 1);
  assert.deepEqual(lateOf(next), [ZIP_LATE]);
  world.reset();
  await call("select", { label_pattern: "^plan", text: "Pro" });
  assert.equal(execs(world), 1);
});

// Records are keyed by an owner token: a record another perch server left on
// the page is never reported as this server's, and never dropped by it.
test("another server's record on the page is not reported or dropped", async () => {
  const { dom } = onPage(ZIP, ZIP_CLEARS);
  await call("fill", { label_pattern: "city", text: "Rosario" });
  dom.eval(`const z = document.getElementById('zip'); z.value = '2000';
    window.__perch_fr.theirs = [{ i: 0, el: z, id: 'textbox "Zip"', kind: "plain", rich: false, text: "2000", want: "2000", prior: "" }];
    z.value = '';`);
  assert.equal(lateOf(await call("get_text", {})), undefined);
  assert.ok(Object.keys(dom.__perch_fr).includes("theirs"));
});

// A record lives in its document: a call on another tab finds nothing and the
// token is dropped without a word; the tab keeps the record.
test("a check that finds no record (another tab, a new document) reports nothing", async () => {
  const { dom } = onPage(ZIP, ZIP_CLEARS);
  await call("fill", { label_pattern: "zip", text: "2000" });
  dom.eval(`delete window.__perch_fr;`);
  const next = await call("get_text", {});
  assert.equal(lateOf(next), undefined);
  assert.equal(next.rest.length, 0);
});

// A click or key press after an earlier write the page undid would act on a
// form that no longer holds what was filled (a submit with an empty field), so
// it is held: nothing is clicked or pressed, and the late list says why. The
// check dropped the record, so the next click runs.
test("click and press hold after a late revert, then run on the next call", async () => {
  for (const [tool, args, verb] of [["click", { selector: "#go" }, "clicked"], ["press", { key: "Enter", selector: "#go" }, "pressed"]]) {
    const { dom } = onPage(ZIP, ZIP_CLEARS);
    await call("fill", { label_pattern: "zip", text: "2000" });
    const held = await call(tool, args);
    assert.equal(held.o.ok, false, JSON.stringify(held.o));
    assert.equal(held.o.error, `nothing ${verb}: a field filled earlier no longer holds its value (late); fill it again (fill {trusted:true} if the page converts or clears it on blur), then retry`);
    assert.deepEqual(held.o.late, [ZIP_LATE]);
    assert.equal(dom.clicks, 0, `${tool} acted on a held call`);
    const again = await call(tool, args);
    assert.equal(again.o.ok, true, JSON.stringify(again.o));
    assert.equal(dom.clicks, 1);
  }
});

test("a click after writes that held runs at once", async () => {
  const { dom } = onPage(ZIP, ZIP_CLEARS);
  await call("fill", { label_pattern: "city", text: "Rosario" });
  const c = await call("click", { selector: "#go" });
  assert.deepEqual(c.o, { ok: true, el: `button "Go"` });
  assert.equal(dom.clicks, 1);
});

// Pending tokens are the server's, not a target's: a call on the tab by any
// target checks them, and a call on another tab first leaves them pending.
test("an untargeted fill is checked by a {tabId} call on the tab, and the reverse", async () => {
  for (const [first, then] of [[false, true], [true, false]]) {
    onPage(ZIP, ZIP_CLEARS);
    const tabId = JSON.parse((await handleCall("list_tabs", {})).content[0].text).tabs[0].tabId;
    await call("fill", { label_pattern: "zip", text: "2000", ...(first ? { target: { tabId } } : {}) });
    assert.deepEqual(lateOf(await call("get_text", then ? { target: { tabId } } : {})), [ZIP_LATE], `${first} -> ${then}`);
  }
});

test("a call on another tab first leaves the token pending; the fill's tab then reports it", async () => {
  const dom = page(ZIP);
  dom.eval(QUEUE_JS);
  dom.eval(ZIP_CLEARS);
  const ev = dom.eval.bind(dom);
  dom.eval = (js) => { dom.__tick(); return ev(js); };
  const other = page(`<p>Other</p>`);
  const world = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }, { url: "https://b.test/", id: "y", dom: other }] }] }], cg: [{ owner: "Google Chrome" }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  const tabs = JSON.parse((await handleCall("list_tabs", {})).content[0].text).tabs;
  const [a, b] = ["https://a.test/", "https://b.test/"].map((u) => tabs.find((t) => t.url === u).tabId);
  await call("fill", { label_pattern: "zip", text: "2000", target: { tabId: a } });
  assert.equal(lateOf(await call("get_text", { target: { tabId: b } })), undefined);
  assert.equal(lateOf(await call("eval_js", { script: "return 1", target: { tabId: b } })), undefined);
  assert.deepEqual(lateOf(await call("get_text", { target: { tabId: a } })), [ZIP_LATE]);
  assert.equal(lateOf(await call("get_text", { target: { tabId: a } })), undefined, "reported once");
});

// A call that fails after its check ran still reports the list; one whose
// check answer was lost leaves the tokens for the next call, which re-reports.
test("a call that errors after the check carries late in its error; a lost answer is re-reported next call", async () => {
  onPage(ZIP, ZIP_CLEARS);
  await call("fill", { label_pattern: "zip", text: "2000" });
  const w = await call("wait", { selector: "#city", timeout: 1000 });
  assert.equal(w.r.isError, true);
  assert.match(w.o, /^error: timeout: /);
  assert.deepEqual(lateOf(w), [ZIP_LATE]);
  assert.equal(lateOf(await call("get_text", {})), undefined, "not reported twice");
  const { world } = onPage(ZIP, ZIP_CLEARS);
  await call("fill", { label_pattern: "zip", text: "2000" });
  world.state.hangIf = (js) => js.includes("@perch_late") || js.includes("fill_late") || js.includes("A.toks");
  const lost = await call("eval_js", { script: "return 1" });
  assert.equal(lost.r.isError, true);
  world.state.hangIf = null;
  assert.deepEqual(lateOf(await call("get_text", {})), [ZIP_LATE]);
});

// A snapshot's result is text, so late rides a second text item.
test("a snapshot after a late revert carries late in its own text item", async () => {
  onPage(ZIP, ZIP_CLEARS);
  await call("fill", { label_pattern: "zip", text: "2000" });
  const s = await call("accessibility_snapshot", {});
  assert.match(s.o, /^# \{/);
  assert.deepEqual(s.rest, [{ late: [ZIP_LATE] }]);
});

// Trusted input: the hold comes before any event is posted.
const WIN = { x: 10, y: 0, w: 800, h: 620 };
const AREA = { x: 10, y: 20, w: 800, h: 600 };
function background() {
  const dom = page(`<input id=i aria-label="City"><button id=b>Go</button>`);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 1, x: 10, y: 20, w: 800, h: 600, tabs: [{ url: "about:blank", id: "front" }, { url: "about:blank", id: "scratch", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 5, wid: 77, ...WIN, ax: { web: [AREA] } }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.state.focus = { window: WIN, chain: [{ role: "AXTextField", box: { x: 20, y: 40, w: 100, h: 20 } }, { role: "AXGroup" }, { role: "AXWebArea", box: AREA }, { role: "AXGroup" }, { role: "AXWindow", box: WIN }] };
  return { world, dom };
}
test("trusted, point, readback and hover clicks, and trusted and plain presses, hold before posting anything", async () => {
  const target = { app: "Google Chrome", windowId: 1, tabIndex: 1 };
  for (const args of [["click", { selector: "#b", trusted: true, target }], ["click", { x: 300, y: 200, trusted: true, target }], ["click", { selector: "#b", readback: "#i", target }],
    ["click", { selector: "#b", hover: true, target }], ["press", { key: "Enter", selector: "#i", trusted: true, target }], ["press", { key: "Tab", target }]]) {
    const { world, dom } = background();
    assert.equal((await call("fill", { selector: "#i", text: "Lima", target })).o.ok, true);
    dom.document.getElementById("i").value = "";
    world.reset();
    const held = await call(...args);
    assert.equal(held.o.ok, false, JSON.stringify(held.o));
    assert.deepEqual(held.o.late, [{ el: `textbox "City"`, error: "was cleared after it was filled; the page reverted the write; retry with fill {trusted:true}" }], JSON.stringify(held.o));
    assert.equal(world.posted.length, 0, `${args[0]} posted input`);
    assert.equal(dom.document.activeElement.id === "b", false, `${args[0]} moved focus`);
  }
});

// The check rides whatever page JS the next call sends first: navigate's own
// page call on the old document, and wait's first poll.
test("navigate and wait carry the check too", async () => {
  for (const [tool, args] of [["navigate", { url: "https://b.test/" }], ["wait", { expression: "document.getElementById('zip') !== null", timeout: 1000 }]]) {
    onPage(ZIP, ZIP_CLEARS);
    await call("fill", { label_pattern: "zip", text: "2000" });
    const next = await call(tool, args);
    assert.deepEqual(lateOf(next), [ZIP_LATE], `${tool}: ${JSON.stringify(next.o)}`);
  }
});

// A batch keeps its own re-read where one is bounded (Chrome). On Arc and
// Safari none can run, so the batch's record waits for the next call's check,
// as a single fill's does; the fields carry no note.
for (const browser of ["arc", "safari"]) {
  test(`${browser}: a fill {fields} field the page undoes later is late on the next call, with no note on the batch`, async () => {
    onPage(ZIP, ZIP_CLEARS, browser);
    const f = await call("fill", { fields: [{ label_pattern: "zip", text: "2000" }, { label_pattern: "city", text: "Rosario" }] });
    assert.deepEqual(f.o.results, [{ ok: true, kind: "plain", el: `textbox "Zip"`, len: 4 }, { ok: true, kind: "plain", el: `textbox "City"`, len: 7 }]);
    assert.equal(f.o.ok, true);
    assert.deepEqual(lateOf(await call("get_text", {})), [ZIP_LATE]);
  });
}

// A re-read whose reply never came (the page may be navigating) leaves the
// record for the next call's check too; one that finds no record says nothing.
test("fill {fields}: a dropped re-read defers to the next call; a missing record is silent", async () => {
  const { world, dom } = onPage(ZIP, ZIP_CLEARS);
  world.state.hangIf = (js) => js.includes("items = m && m[A.tok]");
  const f = await call("fill", { fields: [{ label_pattern: "zip", text: "2000" }, { label_pattern: "city", text: "Rosario" }] });
  assert.deepEqual(f.o.results.map((r) => [r.ok, r.note]), [[true, undefined], [true, undefined]], JSON.stringify(f.o));
  world.state.hangIf = null;
  assert.deepEqual(lateOf(await call("get_text", {})), [ZIP_LATE]);
  assert.equal(lateOf(await call("get_text", {})), undefined, "reported once");
  onPage(ZIP, `document.getElementById('city').addEventListener('input', () => { later(() => { delete window.__perch_fr; }, 1); });`);
  const g = await call("fill", { fields: [{ label_pattern: "zip", text: "2000" }, { label_pattern: "city", text: "Rosario" }] });
  assert.deepEqual(g.o.results.map((r) => [r.ok, r.note]), [[true, undefined], [true, undefined]], JSON.stringify(g.o));
});

// A token whose record no check finds (a new document, a tab never called
// again) stops riding page calls after LATE_TRIES checks.
test("a token never found stops riding page calls after 20 checks", async () => {
  const { dom, scripts } = onPage(ZIP, ZIP_CLEARS);
  await call("fill", { label_pattern: "zip", text: "2000" });
  dom.eval(`delete window.__perch_fr;`);
  for (let i = 0; i < 20; i++) await call("eval_js", { script: "return 1" });
  assert.ok(scripts.at(-1).includes("A.toks") || scripts.at(-1).length > 5000, "the 20th check still ran");
  await call("eval_js", { script: "return 1" });
  assert.ok(scripts.at(-1).length < 2000, `the 21st call still carried the check (${scripts.at(-1).length} bytes)`);
});

// Workable's yes/no questions: a div role=radio holding a <label> around a
// hidden input radio and the option text, both drawn from React state. Only the
// input's change reaches React (a click on the div itself does nothing, as on
// the live page), and React 18 renders the new state in a microtask, after the
// page script that clicked returned: the radio reads unchanged right after its
// click and checked a moment later. The controlled input is put back at once.
// `render`: how many ticks the render takes (0: never, the page ignores it).
const WK_OPT = (id, v, t) => `<div role=radio id=${id}d aria-checked=false tabindex=0 aria-label="Are you comfortable working in person? ${t}"><label><input type=radio id=${id}i name=QA_1 value=${v} tabindex=-1 aria-hidden=true style="opacity:0;position:absolute"><div><span>${t}</span></div></label></div>`;
const WK_RADIO = `<form><fieldset role=radiogroup aria-label="Are you comfortable working in person?">${WK_OPT("y", "true", "YES")}${WK_OPT("n", "false", "NO")}</fieldset><label>Name <input id=name name=name></label></form>`;
const WK_RADIO_JS = (render = 1) => `
  let state = null;
  window.divClicks = 0;
  const draw = () => { for (const [d, i, v] of [['yd', 'yi', 'true'], ['nd', 'ni', 'false']]) {
    document.getElementById(d).setAttribute('aria-checked', String(state === v)); document.getElementById(i).checked = state === v; } };
  for (const [i, v] of [['yi', 'true'], ['ni', 'false']]) document.getElementById(i).addEventListener('change', () => {
    draw();
    if (${render}) later(() => { state = v; draw(); }, ${render});
  });
  document.getElementById('yd').addEventListener('click', () => { window.divClicks++; });`;

test("fill {fields}: a radio whose click renders a microtask later is checked, not refused", async () => {
  for (const [what, fields] of [
    ["the div radio", [{ selector: "#yd", checked: true }]],
    ["the hidden input radio", [{ selector: "#yi", checked: true }]],
    ["both, as the bench fills them", [{ selector: "#yd", checked: true }, { selector: "#yi", checked: true }, { label_pattern: "^name", text: "Ada" }]],
  ]) {
    const { dom } = onPage(WK_RADIO, WK_RADIO_JS());
    const f = await call("fill", { fields });
    assert.equal(f.o.ok, true, what + " " + JSON.stringify(f.o));
    for (const r of f.o.results.slice(0, fields.length).filter((r) => r.kind === "check")) assert.deepEqual(Object.keys(r).sort(), ["checked", "el", "kind", "ok"], what);
    assert.equal(dom.document.getElementById("yd").getAttribute("aria-checked"), "true", what);
  }
  // A radio group answered by its question takes the same path.
  onPage(WK_RADIO, WK_RADIO_JS());
  const g = await call("fill", { fields: [{ label_pattern: "comfortable working", option: "Yes" }, { label_pattern: "^name", text: "Ada" }] });
  assert.equal(g.o.ok, true, JSON.stringify(g.o));
  assert.match(g.o.results[0].selected, /YES$/);
  onPage(WK_RADIO, WK_RADIO_JS(0));
  assert.equal((await call("fill", { fields: [{ label_pattern: "comfortable working", option: "Yes" }, { label_pattern: "^name", text: "Ada" }] })).o.results[0].ok, false, "a group that never takes it");
  // A single fill {checked} takes the same path.
  onPage(WK_RADIO, WK_RADIO_JS());
  const one = await call("fill", { selector: "#yd", checked: true });
  assert.equal(one.o.ok, true, JSON.stringify(one.o));
});

test("fill {fields}: a radio that never takes the click stays refused", async () => {
  for (const browser of ["chrome", "arc", "safari"]) {
    const { dom } = onPage(WK_RADIO, WK_RADIO_JS(0), browser);
    const f = await call("fill", { fields: [{ selector: "#yd", checked: true }, { label_pattern: "^name", text: "Ada" }] });
    assert.equal(f.o.ok, false, browser);
    assert.deepEqual(f.o.results[0], { ok: false, kind: "check", el: `radio "Are you comfortable working in person? YES"`, error: "state did not change after click", checked: false }, browser);
    assert.equal(dom.document.getElementById("yd").getAttribute("aria-checked"), "false", browser);
  }
});
