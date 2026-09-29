// click {readback}: one call clicks and reports what the page showed afterwards.
// Runs through the real JXA runtime (fake world, virtual clock) against a
// happy-dom page, so the settle wait is polled JXA-side as in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, TOOLS } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, deliverPress } from "./helpers/page.mjs";
import { readFileSync } from "node:fs";

function onPage(html, setup, { frameMs = 0 } = {}) {
  const dom = page(html);
  if (setup) dom.eval(setup);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
    frameMs,
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

test("readback on a page gone quiet ends after 10 quiet polls, not the 2s cap", async () => {
  const { world } = onPage(FORM, "", { frameMs: 16 });
  const t0 = world.clock.t;
  assert.equal((await click({ selector: "#b", readback: "#s" })).changed, false);
  const spent = world.clock.t - t0;
  assert.ok(spent >= 450 && spent <= 900, `spent ${spent}ms`);
});

test("DOM activity anywhere on the page keeps readback waiting, up to the 2s cap", async () => {
  const { dom, world } = onPage(FORM + `<div id=spin></div>`);
  let n = 0;
  const orig = dom.eval.bind(dom);
  dom.eval = (js) => { dom.document.getElementById("spin").textContent = String(n++); return orig(js); };
  const t0 = world.clock.t;
  assert.equal((await click({ selector: "#b", readback: "#s" })).changed, false);
  const spent = world.clock.t - t0;
  assert.ok(spent >= 1900 && spent <= 2600, `spent ${spent}ms`);
});

// Completed fetch/XHR requests show up as resource timing entries.
function fetches(dom, every) {
  const entries = [];
  const orig = dom.eval.bind(dom);
  let n = 0;
  dom.performance.getEntriesByType = (t) => (t === "resource" ? entries.slice() : []);
  dom.eval = (js) => { if (++n % every === 0) entries.push({ initiatorType: n % 2 ? "fetch" : "xmlhttprequest" }); return orig(js); };
  return entries;
}

test("fetch or XHR requests completing keep readback waiting; other resources don't", async () => {
  let { dom, world } = onPage(FORM);
  fetches(dom, 3);
  let t0 = world.clock.t;
  assert.equal((await click({ selector: "#b", readback: "#s" })).changed, false);
  assert.ok(world.clock.t - t0 >= 1900, `spent ${world.clock.t - t0}ms`);
  ({ dom, world } = onPage(FORM));
  const entries = [];
  dom.performance.getEntriesByType = (t) => (t === "resource" ? entries.slice() : []);
  const orig = dom.eval.bind(dom);
  dom.eval = (js) => { entries.push({ initiatorType: "img" }); return orig(js); };
  t0 = world.clock.t;
  await click({ selector: "#b", readback: "#s" });
  assert.ok(world.clock.t - t0 < 900, `spent ${world.clock.t - t0}ms`);
});

test("a change that lands after a long stretch of page activity is still caught", async () => {
  const { dom } = onPage(FORM + `<div id=spin></div>`);
  let n = 0;
  const orig = dom.eval.bind(dom);
  dom.eval = (js) => {
    if (++n < 25) dom.document.getElementById("spin").textContent = String(n);
    else if (n === 25) dom.document.getElementById("s").textContent = "Saved";
    return orig(js);
  };
  assert.deepEqual(await click({ selector: "#b", readback: "#s" }), { ok: true, el: `button "Submit"`, readback: "Saved", changed: true });
});

// Every MutationObserver the page script creates, and whether it was disconnected.
function observers(dom) {
  const made = [];
  const MO = dom.MutationObserver;
  dom.MutationObserver = class extends MO {
    constructor(cb) { super(cb); made.push(this); this.live = false; }
    observe(...a) { this.live = true; return super.observe(...a); }
    disconnect() { this.live = false; return super.disconnect(); }
  };
  return made;
}

test("readback's MutationObserver is disconnected whatever the outcome", async () => {
  for (const [html, js] of [[FORM, SAVE], [FORM, ""], [FORM + `<div id=spin></div>`, null]]) {
    const { dom } = onPage(html, js || "");
    const made = observers(dom);
    if (js === null) {
      const orig = dom.eval.bind(dom);
      let n = 0;
      dom.eval = (s) => { dom.document.getElementById("spin").textContent = String(n++); return orig(s); };
    }
    await click({ selector: "#b", readback: "#s" });
    assert.ok(made.length >= 1, "an observer was installed");
    assert.deepEqual(made.map((m) => m.live), made.map(() => false));
  }
  // A bad selector installs none.
  const { dom } = onPage(FORM);
  const made = observers(dom);
  await click({ selector: "#b", readback: "[[" });
  assert.deepEqual(made.map((m) => m.live), made.map(() => false));
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

// A navigation stand-in: the first eval arms, then the document loses perch's
// state and its body is replaced with `body`.
async function navigatedTo(body, readback = "body") {
  const { dom } = onPage(FORM);
  afterEvals(dom, 1, () => { delete dom.__perch_rb; dom.document.body.innerHTML = body; });
  return click({ selector: "#b", readback });
}
const NAV = `<nav>${"Jobs Teams About ".repeat(24)}</nav>`;

test("a navigated readback reports the new page's h1 past a long nav, readback still the first 300 chars", async () => {
  const o = await navigatedTo(`${NAV}<h1>Thank you for applying</h1><p>We will be in touch.</p>`);
  assert.equal(o.navigated, true);
  assert.deepEqual(o.page, { heading: "Thank you for applying" });
  assert.ok(o.readback.startsWith("Jobs Teams About"));
  assert.ok(o.readback.length <= 301, `len ${o.readback.length}`);
});

test("a navigated readback with no h1 takes the page heading from the first visible h2", async () => {
  const o = await navigatedTo(`<h2>Application received</h2><h2>Next steps</h2>`);
  assert.deepEqual(o.page, { heading: "Application received" });
});

test("a navigated readback skips a hidden h1 for a visible h2", async () => {
  const o = await navigatedTo(`<h1 style="display:none">Apply now</h1><h2>Application received</h2>`);
  assert.deepEqual(o.page, { heading: "Application received" });
});

test("a navigated readback reports the new page's alert text", async () => {
  const o = await navigatedTo(`<form><div role=alert>Please enter your location</div><input name=loc></form>`);
  assert.deepEqual(o.page, { alert: "Please enter your location" });
});

test("a navigated readback with no heading or alert keeps the old shape", async () => {
  const o = await navigatedTo(`<p id=s>Welcome</p>`, "#s");
  assert.deepEqual(o, { ok: true, el: `button "Submit"`, readback: "Welcome", changed: true, navigated: true, url: "https://a.test/p" });
});

test("a same-document readback reports no page key, even with a heading and alert on the page", async () => {
  onPage(`<h1>Apply</h1><div role=alert>Heads up</div>${FORM}`, SAVE);
  const o = await click({ selector: "#b", readback: "#s" });
  assert.equal(o.readback, "Saved");
  assert.equal(o.page, undefined);
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

test("readback sees a lasting state class such as active or open", async () => {
  onPage(`<button id=b>Go</button><div id=t><span class=tab>One</span></div>`,
    `document.getElementById('b').addEventListener('click', () => { document.querySelector('#t .tab').classList.add('active'); });`);
  assert.equal((await click({ selector: "#b", readback: "#t" })).changed, true);
});

test("readback ignores a state class that is gone by the next poll", async () => {
  const { dom } = onPage(`<button id=b>Go</button><div id=t><span class=tab>One</span></div>`,
    `document.getElementById('b').addEventListener('click', () => { document.querySelector('#t .tab').classList.add('open'); });`);
  // The class shows for one poll only, like a transient effect.
  let polls = 0;
  const orig = dom.eval.bind(dom);
  dom.eval = (js) => { if (js.includes("__perch_rb") && ++polls === 3) dom.document.querySelector("#t .tab").classList.remove("open"); return orig(js); };
  assert.equal((await click({ selector: "#b", readback: "#t" })).changed, false);
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

// ---- validation errors ----

const APPLY = `<form onsubmit="return false">
  <div class=f><label for=loc>Location</label><input id=loc><div id=loc-e class=error></div></div>
  <div class=f><label for=ph>Phone</label><input id=ph><div id=ph-e class=error></div></div>
  <button id=b type=button>Next</button><p id=s>Step 1</p></form>`;
const REJECT = `(() => {
  document.getElementById('loc').setAttribute('aria-invalid', 'true');
  document.getElementById('loc-e').textContent = 'Please enter your location';
  document.getElementById('ph').setAttribute('aria-invalid', 'true');
  document.getElementById('ph-e').textContent = 'Phone is required';
})`;

test("readback lists the fields a Next click marked invalid, with their messages", async () => {
  onPage(APPLY, `document.getElementById('b').addEventListener('click', ${REJECT});`);
  const o = await click({ selector: "#b", readback: "#s" });
  assert.deepEqual(o, { ok: true, el: `button "Next"`, readback: "Step 1", changed: true,
    invalid: ["Location: Please enter your location", "Phone: Phone is required"] });
});

test("readback catches errors that render a tick after the click", async () => {
  const { dom } = onPage(APPLY);
  afterEvals(dom, 3, () => dom.eval(`${REJECT}()`));
  const o = await click({ selector: "#b", readback: "#s" });
  assert.equal(o.changed, true);
  assert.equal(o.navigated, undefined);
  assert.deepEqual(o.invalid, ["Location: Please enter your location", "Phone: Phone is required"]);
});

test("a click that clears the errors reads changed with no invalid key", async () => {
  onPage(APPLY, `${REJECT}(); document.getElementById('b').addEventListener('click', () => {
    document.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    document.querySelectorAll('.error').forEach((el) => { el.textContent = ''; });
  });`);
  assert.deepEqual(await click({ selector: "#b", readback: "#s" }), { ok: true, el: `button "Next"`, readback: "Step 1", changed: true });
});

test("errors already on the page before the click are not reported again", async () => {
  onPage(APPLY, `${REJECT}(); document.getElementById('b').addEventListener('click', () => { document.getElementById('s').textContent = 'Step 1 of 3'; });`);
  assert.deepEqual(await click({ selector: "#b", readback: "#s" }), { ok: true, el: `button "Next"`, readback: "Step 1 of 3", changed: true });
});

test("readback caps the invalid list at 5 and counts the rest", async () => {
  const fields = Array.from({ length: 7 }, (_, i) => `<div><label for=f${i}>Field ${i}</label><input id=f${i}></div>`).join("");
  onPage(`<form>${fields}<button id=b type=button>Submit</button><p id=s>x</p></form>`,
    `document.getElementById('b').addEventListener('click', () => document.querySelectorAll('input').forEach((el) => el.setAttribute('aria-invalid', 'true')));`);
  const o = await click({ selector: "#b", readback: "#s" });
  assert.deepEqual(o.invalid, ["Field 0", "Field 1", "Field 2", "Field 3", "Field 4"]);
  assert.equal(o.invalidCount, 7);
});

test("a radio group marked invalid reports its question", async () => {
  onPage(`<form><div role=radiogroup aria-label="Authorized to work?"><label><input type=radio name=w> Yes</label><label><input type=radio name=w> No</label><span class=error-text></span></div>
    <button id=b type=button>Submit</button><p id=s>x</p></form>`,
    `document.getElementById('b').addEventListener('click', () => { const g = document.querySelector('[role=radiogroup]'); g.setAttribute('aria-invalid', 'true'); g.querySelector('.error-text').textContent = 'Pick one'; });`);
  assert.deepEqual((await click({ selector: "#b", readback: "#s" })).invalid, ["Authorized to work?: Pick one"]);
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
  const { world, dom } = trustedTab(FORM);
  deliverPress(world, dom);
  const o = await click({ trusted: true, raise: true, x: 60, y: 167, readback: "#s" });
  assert.equal(o.ok, true);
  assert.equal(o.readback, "Saved");
  assert.equal(o.changed, true);
});

test("trusted click with readback reports fields the click marked invalid", async () => {
  const { world, dom } = trustedTab(APPLY.replace("<p id=s>Step 1</p>", "<p id=s>Idle</p>"));
  world.state.onPost = (e) => { if (e.type === 2 && e.pt.x >= 0) dom.eval(`${REJECT}()`); };
  const o = await click({ trusted: true, raise: true, selector: "#b", readback: "#s" });
  assert.equal(o.changed, true);
  assert.deepEqual(o.invalid, ["Location: Please enter your location", "Phone: Phone is required"]);
});

test("trusted click with a bad readback selector posts nothing", async () => {
  const { world } = trustedTab(FORM);
  const o = await click({ trusted: true, raise: true, selector: "#b", readback: "[[" });
  assert.equal(o.ok, false);
  assert.match(o.error, /readback/);
  assert.equal(world.posted.filter((e) => e.type === 1).length, 0);
});

// ---- hidden tabs ----

// A background tab runs its timers about once a second, so a validation error
// set by setTimeout(..., 300) lands up to a second after the click. The page's
// own clock follows the fake world's here.
function hiddenTimer(dom, world, ms, fn) {
  Object.defineProperty(dom.document, "visibilityState", { value: "hidden", configurable: true });
  dom.Date.now = () => world.clock.t;
  const at = world.clock.t + ms, orig = dom.eval.bind(dom);
  let done = false;
  dom.eval = (js) => { if (!done && world.clock.t >= at) { done = true; fn(); } return orig(js); };
}

test("in a hidden tab readback waits out a throttled timer tick before settling", async () => {
  const { dom, world } = onPage(FORM, "", { frameMs: 16 });
  hiddenTimer(dom, world, 1000, () => { dom.document.getElementById("s").textContent = "Email is required"; });
  const o = await click({ selector: "#b", readback: "#s" });
  assert.deepEqual(o, { ok: true, el: `button "Submit"`, readback: "Email is required", changed: true });
});

test("a quiet hidden tab settles after about 1.2s, not the 2s cap", async () => {
  const { dom, world } = onPage(FORM, "", { frameMs: 16 });
  hiddenTimer(dom, world, Infinity, () => {});
  const t0 = world.clock.t;
  assert.equal((await click({ selector: "#b", readback: "#s" })).changed, false);
  const spent = world.clock.t - t0;
  assert.ok(spent >= 1200 && spent <= 1500, `spent ${spent}ms`);
});

test("a visible tab keeps the short quiet window", async () => {
  const { dom, world } = onPage(FORM, "", { frameMs: 16 });
  dom.Date.now = () => world.clock.t;
  const t0 = world.clock.t;
  assert.equal((await click({ selector: "#b", readback: "#s" })).changed, false);
  assert.ok(world.clock.t - t0 <= 900, `spent ${world.clock.t - t0}ms`);
});

// ---- schema ----

test("click schema: readback costs at most 150 chars", () => {
  const c = TOOLS.find((t) => t.name === "click");
  assert.ok(c.inputSchema.properties.readback, "readback is declared");
  const added = JSON.stringify({ readback: c.inputSchema.properties.readback }).length - 2;
  assert.ok(added <= 150, `readback property is ${added} chars`);
});

// ---- form outcome ----

// test/fixtures/wizard.html: markup, then its script run with page timers
// driven by the fake world's clock (checked before each page script runs).
const WIZ = readFileSync(new URL("./fixtures/wizard.html", import.meta.url), "utf8");
const WIZ_BODY = WIZ.slice(WIZ.indexOf("<body>") + 6, WIZ.indexOf("<script>"));
const WIZ_JS = WIZ.slice(WIZ.indexOf("<script>") + 8, WIZ.indexOf("</script>"));
function wizard(prep = "") {
  const { dom, world } = onPage(WIZ_BODY, "", { frameMs: 16 });
  const timers = [];
  dom.setTimeout = (fn, ms) => { timers.push({ fn, at: world.clock.t + (ms || 0) }); return timers.length; };
  const orig = dom.eval.bind(dom);
  dom.eval = (js) => {
    for (const t of timers.filter((x) => !x.done && world.clock.t >= x.at)) { t.done = true; t.fn(); }
    return orig(js);
  };
  orig(WIZ_JS + prep);
  return { dom, world };
}
const FILLED = `document.getElementById('name').value = 'Ada'; document.getElementById('email').value = 'a@b.c';`;

test("form: a Next that advances the wizard reports the new step", async () => {
  wizard(FILLED);
  const o = await click({ selector: "#next", readback: "#count" });
  assert.deepEqual(o, { ok: true, el: `button "Next"`, readback: "Step 2 of 3", changed: true, form: { step: "2/3" } });
});

test("form: a blocked Next reports the alert banner beside the invalid fields, no step", async () => {
  wizard();
  const o = await click({ selector: "#next", readback: "#count" });
  assert.equal(o.changed, true);
  assert.deepEqual(o.form, { alert: "Please fix 2 errors" });
  assert.deepEqual(o.invalid, ["Name: This field is required", "Email: This field is required"]);
});

test("form: a submit that shows Submitting... then replaces the form reads gone, not the transient text", async () => {
  wizard(`show(3);`);
  const o = await click({ selector: "#send", readback: "#send" });
  assert.deepEqual(o, { ok: true, el: `button "Submitting..."`, readback: null, changed: true, form: { gone: true } });
});

for (const target of ["#wiz", "body"]) {
  test(`form: with readback on ${target}, a submit's transient Submitting... still waits for the form to go`, async () => {
    wizard(`show(3);`);
    const o = await click({ selector: "#send", readback: target });
    assert.equal(o.changed, true);
    assert.deepEqual(o.form, { gone: true }, JSON.stringify(o));
    if (target === "#wiz") assert.equal(o.readback, null);
    else assert.match(o.readback, /Thanks, we received your application/);
  });
}

test("form: with readback on the form, a change beside the relabeled submit button ends the wait", async () => {
  const { world } = wizard(`show(3); document.getElementById('wiz').addEventListener('submit', function (e) { e.stopImmediatePropagation(); e.preventDefault(); document.getElementById('send').textContent = 'Submitting...'; document.getElementById('banner').textContent = 'Saved as draft'; }, true);`);
  const t0 = world.clock.t;
  const o = await click({ selector: "#send", readback: "#wiz" });
  assert.equal(o.changed, true);
  assert.match(o.readback, /Saved as draft/, JSON.stringify(o));
  assert.ok(world.clock.t - t0 < 450, `spent ${world.clock.t - t0}ms ${JSON.stringify(o)}`);
});

test("form: a submit button that only relabels itself settles on the quiet window with its last text", async () => {
  const { world } = wizard(`show(3); document.getElementById('wiz').addEventListener('submit', function (e) { e.stopImmediatePropagation(); e.preventDefault(); document.getElementById('send').textContent = 'Submitting...'; }, true);`);
  const t0 = world.clock.t;
  const o = await click({ selector: "#send", readback: "#send" });
  assert.deepEqual(o, { ok: true, el: `button "Submitting..."`, readback: "Submitting...", changed: true });
  assert.ok(world.clock.t - t0 >= 450, `spent ${world.clock.t - t0}ms`);
});

// A submit handler that sets busy flags on the form while posting: `busy` runs
// at submit, `after` 400ms later (none: the post never resolves).
function busyForm(busy, after) {
  return wizard(`show(3); document.getElementById('wiz').addEventListener('submit', function (e) { e.stopImmediatePropagation(); e.preventDefault(); ${busy} ${after ? `setTimeout(function () { ${after} }, 400);` : ""} }, true);`);
}
const FIELDSET_BUSY = `document.querySelector('fieldset[data-step="3"]').disabled = true; document.getElementById('send').textContent = 'Submitting...';`;
const REPLACE = `var d = document.createElement('div'); d.textContent = 'Thanks'; document.getElementById('wiz').replaceWith(d);`;
for (const target of ["#wiz", "body"]) {
  test(`form: with readback on ${target}, a submit that disables its fieldset still waits for the form to go`, async () => {
    busyForm(FIELDSET_BUSY, REPLACE);
    const o = await click({ selector: "#send", readback: target });
    assert.equal(o.changed, true);
    assert.deepEqual(o.form, { gone: true }, JSON.stringify(o));
    assert.doesNotMatch(String(o.readback), /Submitting/);
  });
}

const FIELDS = `document.querySelectorAll('#wiz input, #wiz textarea')`;
test("form: aria-busy on the form with every field disabled waits for the alert it shows", async () => {
  busyForm(`document.getElementById('wiz').setAttribute('aria-busy', 'true'); ${FIELDS}.forEach(function (f) { f.disabled = true; });`,
    `var a = document.createElement('div'); a.setAttribute('role', 'alert'); a.textContent = 'Email taken'; document.getElementById('wiz').appendChild(a); document.getElementById('wiz').removeAttribute('aria-busy'); ${FIELDS}.forEach(function (f) { f.disabled = false; });`);
  const o = await click({ selector: "#send", readback: "#wiz" });
  assert.equal(o.changed, true);
  assert.deepEqual(o.form, { alert: "Email taken" }, JSON.stringify(o));
});

test("form: a form that only disables itself and never resolves claims no outcome and ends within the cap", async () => {
  const { world } = busyForm(`document.getElementById('wiz').setAttribute('aria-busy', 'true'); document.querySelector('fieldset[data-step="3"]').disabled = true;`);
  const t0 = world.clock.t;
  const o = await click({ selector: "#send", readback: "#wiz" });
  assert.deepEqual(o, { ok: true, el: `button "Submit"`, readback: o.readback, changed: false }, JSON.stringify(o));
  assert.ok(world.clock.t - t0 >= 450 && world.clock.t - t0 <= 2300, `spent ${world.clock.t - t0}ms`);
});

test("form: a disable that clears again with nothing else ends changed:false", async () => {
  busyForm(`${FIELDS}.forEach(function (f) { f.disabled = true; });`, `${FIELDS}.forEach(function (f) { f.disabled = false; });`);
  const o = await click({ selector: "#send", readback: "#wiz" });
  assert.equal(o.changed, false, JSON.stringify(o));
  assert.equal(o.form, undefined);
});

for (const target of ["#wiz", "fieldset[data-step=\"1\"]"]) {
  test(`form: with readback on ${target}, a type=button that disables a fieldset reads changed at once`, async () => {
    const { world } = wizard(`var b = document.createElement('button'); b.type = 'button'; b.id = 'same'; b.textContent = 'Same as mailing address'; document.getElementById('next').before(b); b.addEventListener('click', function () { document.querySelector('fieldset[data-step="1"]').disabled = true; });`);
    const t0 = world.clock.t;
    const o = await click({ selector: "#same", readback: target });
    assert.equal(o.changed, true, JSON.stringify(o));
    assert.ok(world.clock.t - t0 < 200, `spent ${world.clock.t - t0}ms`);
  });
}

test("form: a modal holding the fields in plain divs reads gone once Next removes it", async () => {
  wizard();
  const o = await click({ selector: "#qnext", readback: "#quick" });
  assert.deepEqual(o, { ok: true, el: `button "Next"`, readback: null, changed: true, form: { gone: true } });
});

test("form: with no form or modal, the nearest container of 2 fields is the scope", async () => {
  wizard();
  const o = await click({ selector: "#lnext", readback: "#loose" });
  assert.deepEqual(o, { ok: true, el: `button "Continue"`, readback: "Code accepted", changed: true, form: { gone: true } });
});

test("form: a click with no form scope adds no form key and ends on the first change", async () => {
  const { world } = wizard();
  const t0 = world.clock.t;
  assert.deepEqual(await click({ selector: "#help", readback: "#helpout" }), { ok: true, el: `button "Help"`, readback: "Open", changed: true });
  assert.ok(world.clock.t - t0 < 200, `spent ${world.clock.t - t0}ms`);
});

test("trusted click with readback reports the form outcome too", async () => {
  const { world, dom } = trustedTab(WIZ_BODY + `<p id=s>Idle</p>`);
  dom.eval(WIZ_JS + FILLED);
  world.state.onPost = (e) => { if (e.type === 2 && e.pt.x >= 0) dom.document.getElementById("next").click(); };
  const o = await click({ trusted: true, raise: true, selector: "#next", readback: "#count" });
  assert.equal(o.readback, "Step 2 of 3");
  assert.deepEqual(o.form, { step: "2/3" });
});

test("a disabled button with readback refuses and arms nothing", async () => {
  const { dom } = onPage(`<button id=save disabled>Save</button><p id=out>Idle</p>`);
  const o = await click({ selector: "#save", readback: "#out" });
  assert.equal(o.ok, false);
  assert.match(o.error, /is disabled; nothing was clicked/);
  assert.equal(dom.__perch_rb, undefined);
});

test("a readback read that throws is ok:false with the error name only", async () => {
  const { dom } = onPage(FORM, SAVE);
  const ev = dom.eval.bind(dom);
  const marker = "const text = rbText();";
  dom.eval = (js) => ev(js.includes(marker) ? js.replace(marker, "throw new TypeError('secret-internal detail');" + marker) : js);
  const o = await click({ selector: "#b", readback: "#s" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.error, "click: the click was sent; the page script failed reading it back (TypeError); outcome unverified");
  assert.equal(o.el, `button "Submit"`);
  assert.equal(dom.document.getElementById("s").textContent, "Saved", "the click itself ran");
  for (const k of ["secret-internal", "__perch", "stack"]) assert.ok(!JSON.stringify(o).includes(k), JSON.stringify(o));
});
