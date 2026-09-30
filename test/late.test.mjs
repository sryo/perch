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
    assert.deepEqual(Object.keys(dom.__perch_fr || {}), [], "the check drops the record");
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
  assert.deepEqual(Object.keys(dom.__perch_fr || {}), []);
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
  assert.deepEqual(Object.keys(dom.__perch_fr), ["theirs"]);
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
    assert.match(held.o.error, new RegExp(`^nothing ${verb}: `));
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

// A targeted fill is checked by the next call on that tabId, not by an
// untargeted one (each is its own key, as the tab locks key them).
test("a targeted fill is checked by the next call on the same tabId", async () => {
  onPage(ZIP, ZIP_CLEARS);
  const tabId = JSON.parse((await handleCall("list_tabs", {})).content[0].text).tabs[0].tabId;
  await call("fill", { label_pattern: "zip", text: "2000", target: { tabId } });
  assert.equal(lateOf(await call("get_text", {})), undefined);
  assert.deepEqual(lateOf(await call("get_text", { target: { tabId } })), [ZIP_LATE]);
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
test("a trusted click, a click {readback} and a trusted press hold before posting anything", async () => {
  const target = { app: "Google Chrome", windowId: 1, tabIndex: 1 };
  for (const args of [["click", { selector: "#b", trusted: true, target }], ["click", { selector: "#b", readback: "#i", target }], ["press", { key: "Enter", selector: "#i", trusted: true, target }]]) {
    const { world, dom } = background();
    assert.equal((await call("fill", { selector: "#i", text: "Lima", target })).o.ok, true);
    dom.document.getElementById("i").value = "";
    world.reset();
    const held = await call(...args);
    assert.equal(held.o.ok, false, JSON.stringify(held.o));
    assert.deepEqual(held.o.late, [{ el: `textbox "City"`, error: "was cleared after it was filled; the page reverted the write; retry with fill {trusted:true}" }], JSON.stringify(held.o));
    assert.equal(world.posted.length, 0, `${args[0]} posted input`);
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
