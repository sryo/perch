// click {readback}: one call clicks and reports what the page showed afterwards.
// Runs through the real JXA runtime (fake world, virtual clock) against a
// happy-dom page, so the settle wait is polled JXA-side as in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, TOOLS } from "../server.js";
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
const click = async (args) => {
  const r = await handleCall("click", args);
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};
// Runs `fn` on the page after the nth script evaluation: an update that lands
// between polls, the way a fetch-then-render does.
function afterEvals(dom, n, fn) {
  const orig = dom.eval.bind(dom);
  let count = 0;
  dom.eval = (js) => { const r = orig(js); if (++count === n) fn(); return r; };
  return () => count;
}

const FORM = `<button id=b>Submit</button><p id=s>Idle</p>`;
const SAVE = `document.getElementById('b').addEventListener('click', () => { document.getElementById('s').textContent = 'Saved'; });`;

test("click without readback keeps its result shape", async () => {
  onPage(FORM, SAVE);
  assert.deepEqual(await click({ selector: "#b" }), { ok: true, el: `button "Submit"` });
});

test("readback returns the element's text after the click", async () => {
  const { dom } = onPage(FORM, SAVE);
  assert.deepEqual(await click({ selector: "#b", readback: "#s" }), { ok: true, el: `button "Submit"`, readback: "Saved", changed: true });
  assert.equal(dom.__perch_rb, undefined, "readback state is cleaned up");
});

test("readback waits for a change that lands after the click, polling from outside the page", async () => {
  const { dom } = onPage(FORM);
  const evals = afterEvals(dom, 4, () => { dom.document.getElementById("s").textContent = "Saved"; });
  const o = await click({ selector: "#b", readback: "#s" });
  assert.deepEqual(o, { ok: true, el: `button "Submit"`, readback: "Saved", changed: true });
  assert.ok(evals() >= 4);
});

test("readback that never changes returns the current text with changed:false", async () => {
  onPage(FORM);
  assert.deepEqual(await click({ selector: "#b", readback: "#s" }), { ok: true, el: `button "Submit"`, readback: "Idle", changed: false });
});

test("readback settle is bounded (about 2s of virtual time)", async () => {
  const { world } = onPage(FORM);
  const t0 = world.clock.t;
  await click({ selector: "#b", readback: "#s" });
  const spent = world.clock.t - t0;
  assert.ok(spent >= 1500 && spent <= 2600, `spent ${spent}ms`);
});

test("readback element that appears after the click counts as a change", async () => {
  onPage(`<button id=b>Submit</button><div id=out></div>`,
    `document.getElementById('b').addEventListener('click', () => { document.getElementById('out').innerHTML = '<p class=err>Email is required</p>'; });`);
  assert.deepEqual(await click({ selector: "#b", readback: ".err" }), { ok: true, el: `button "Submit"`, readback: "Email is required", changed: true });
});

test("readback selector that matches nothing returns readback:null", async () => {
  onPage(FORM);
  assert.deepEqual(await click({ selector: "#b", readback: "#nope" }), { ok: true, el: `button "Submit"`, readback: null, changed: false });
});

test("readback reports a URL change", async () => {
  onPage(FORM, `document.getElementById('b').addEventListener('click', () => { history.pushState({}, '', '/done'); });`);
  const o = await click({ selector: "#b", readback: "#s" });
  assert.equal(o.changed, true);
  assert.equal(o.url, "https://a.test/done");
  assert.equal(o.readback, "Idle");
});

test("readback after the document was replaced reports navigated", async () => {
  // A fresh document has none of perch's state; dropping it stands in for a navigation.
  const { dom } = onPage(FORM);
  afterEvals(dom, 1, () => { delete dom.__perch_rb; dom.document.getElementById("s").textContent = "Welcome"; });
  const o = await click({ selector: "#b", readback: "#s" });
  assert.equal(o.navigated, true);
  assert.equal(o.changed, true);
  assert.equal(o.readback, "Welcome");
});

test("readback text is clipped", async () => {
  onPage(`<button id=b>Go</button><p id=s>${"word ".repeat(200)}</p>`);
  const o = await click({ selector: "#b", readback: "#s" });
  assert.ok(o.readback.length <= 301, `len ${o.readback.length}`);
  assert.ok(o.readback.endsWith("…"));
});

test("a bad readback selector refuses before clicking", async () => {
  const { dom } = onPage(FORM, SAVE);
  const o = await click({ selector: "#b", readback: "[[" });
  assert.equal(o.ok, false);
  assert.match(o.error, /readback/);
  assert.equal(dom.document.getElementById("s").textContent, "Idle", "nothing was clicked");
});

test("a missing click target with readback is still {ok:false}", async () => {
  onPage(FORM);
  const o = await click({ selector: "#missing", readback: "#s" });
  assert.equal(o.ok, false);
  assert.match(o.error, /no element/);
});

test("a stale ref with readback still errors with the re-snapshot hint", async () => {
  onPage(FORM);
  const r = await handleCall("click", { ref: "9", readback: "#s" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /accessibility_snapshot/);
});

test("readback polls on the slow lane so quick calls aren't blocked", async () => {
  const { world } = onPage(FORM, SAVE);
  DAEMONS.fast = { run: async () => { throw new Error("fast lane used"); } };
  DAEMONS.slow = world.daemon;
  assert.equal((await click({ selector: "#b", readback: "#s" })).readback, "Saved");
});

test("readback must be a non-empty string", async () => {
  onPage(FORM);
  const r = await handleCall("click", { selector: "#b", readback: "" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /readback/);
});

// A toggle whose click only flips attributes and a hidden input, not its text.
const YESNO = `<div class=yesno><button id=y aria-pressed=false data-option=yes>Yes</button><button id=n aria-pressed=false>No</button><input type=checkbox tabindex=-1 style='display:none'></div>`;
const YESNO_JS = `document.getElementById('y').addEventListener('click', (e) => {
  e.currentTarget.setAttribute('aria-pressed', 'true');
  e.currentTarget.classList.add('active');
  document.querySelector('.yesno input').checked = true;
});`;

test("readback counts an attribute-only change inside the element as changed", async () => {
  const { dom } = onPage(YESNO, YESNO_JS);
  const o = await click({ selector: "#y", readback: ".yesno" });
  assert.equal(o.changed, true);
  assert.match(o.readback, /^Yes\s*No$/, "readback stays the element's text");
  assert.deepEqual(Object.keys(o).sort(), ["changed", "el", "ok", "readback"]);
  assert.equal(dom.__perch_rb, undefined, "readback state is cleaned up");
});

test("readback ignores class flips from hover, focus or animation", async () => {
  const { dom, world } = onPage(`<button id=b>Go</button><div id=t class=idle>Tab <span class=spin></span><input type=checkbox></div>`,
    `document.getElementById('b').addEventListener('click', () => { document.getElementById('t').className = 'idle hover'; });`);
  let n = 0;
  const orig = dom.eval.bind(dom);
  dom.eval = (js) => { dom.document.querySelector("#t span").className = "spin f" + (n++ % 2); return orig(js); };
  const t0 = world.clock.t;
  const o = await click({ selector: "#b", readback: "#t" });
  assert.equal(o.changed, false, JSON.stringify(o));
  assert.ok(world.clock.t - t0 >= 1900, "waited out the settle");
});

test("readback sees an element becoming disabled", async () => {
  onPage(`<div id=t><button id=b>Send</button></div>`, `document.getElementById('b').addEventListener('click', (e) => { e.currentTarget.disabled = true; });`);
  assert.equal((await click({ selector: "#b", readback: "#t" })).changed, true);
});

test("readback sees aria-pressed alone flip on a toggle", async () => {
  onPage(YESNO, `document.getElementById('y').addEventListener('click', (e) => e.currentTarget.setAttribute('aria-pressed', 'true'));`);
  assert.equal((await click({ selector: "#y", readback: ".yesno" })).changed, true);
});

test("readback sees an input value change inside the element", async () => {
  onPage(`<button id=b>Go</button><div id=t>Amount <input value=1></div>`, `document.getElementById('b').addEventListener('click', () => document.querySelector('#t input').value = '2');`);
  assert.equal((await click({ selector: "#b", readback: "#t" })).changed, true);
});

test("readback sees a hidden checkbox inside the element being checked", async () => {
  onPage(YESNO, `document.getElementById('y').addEventListener('click', () => { document.querySelector('.yesno input').checked = true; });`);
  assert.equal((await click({ selector: "#y", readback: ".yesno" })).changed, true);
});

test("readback with no state change on the element stays changed:false", async () => {
  onPage(YESNO, `document.getElementById('n').addEventListener('click', () => document.body.classList.add('x'));`);
  const o = await click({ selector: "#n", readback: ".yesno" });
  assert.equal(o.changed, false);
  assert.match(o.readback, /^Yes\s*No$/);
});

// ---- trusted click ----

function trustedTab(html, setup) {
  const dom = page(html);
  if (setup) dom.eval(setup);
  for (const [k, v] of Object.entries({ screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 })) {
    Object.defineProperty(dom, k, { value: v, configurable: true });
  }
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 798, h: 500 }] } }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  // The OS click lands: mouse-up updates the status the way the page's handler would.
  world.state.onPost = (e) => { if (e.type === 2 && e.pt.x >= 0) dom.document.getElementById("s").textContent = "Saved"; };
  return { dom, world };
}

test("trusted click by selector reads back after the posted click", async () => {
  const { world } = trustedTab(FORM);
  const o = await click({ trusted: true, raise: true, selector: "#b", readback: "#s" });
  assert.equal(o.readback, "Saved");
  assert.equal(o.changed, true);
  assert.deepEqual(world.state.cursor, { x: 1, y: 2 }, "cursor restored");
});

test("trusted click by point reads back too", async () => {
  trustedTab(FORM);
  const o = await click({ trusted: true, raise: true, x: 60, y: 167, readback: "#s" });
  assert.equal(o.ok, true);
  assert.equal(o.readback, "Saved");
  assert.equal(o.changed, true);
});

test("trusted click with a bad readback selector posts nothing", async () => {
  const { world } = trustedTab(FORM);
  const o = await click({ trusted: true, raise: true, selector: "#b", readback: "[[" });
  assert.equal(o.ok, false);
  assert.match(o.error, /readback/);
  assert.equal(world.posted.filter((e) => e.type === 1).length, 0);
});

// ---- schema ----

test("click schema: readback costs at most 150 chars", () => {
  const c = TOOLS.find((t) => t.name === "click");
  assert.ok(c.inputSchema.properties.readback, "readback is declared");
  const added = JSON.stringify({ readback: c.inputSchema.properties.readback }).length - 2;
  assert.ok(added <= 150, `readback property is ${added} chars`);
});
