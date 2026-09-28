// fill {fields}: a whole form in one tool call. Page-level behavior runs the
// fill_fields script in happy-dom; the Node orchestration (custom comboboxes
// handed to the select runtime, in order) runs through the fake JXA world.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, TOOLS } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run, runBody } from "./helpers/page.mjs";

const FORM = `<form>
  <label>Name <input name=name></label>
  <label>Email <input type=email name=email></label>
  <label>Message <textarea name=msg></textarea></label>
  <label>Country <select name=country><option value="">Pick</option><option value=ar>Argentina</option><option value=br>Brazil</option></select></label>
  <label><input type=checkbox name=agree> I agree</label>
</form>`;

const FIVE = [
  { label_pattern: "name", text: "Ada Lovelace" },
  { label_pattern: "email", text: "ada@example.test" },
  { label_pattern: "message", text: "Hello there" },
  { label_pattern: "country", option: "Argentina" },
  { label_pattern: "agree", checked: true },
];

const val = (w, sel) => w.document.querySelector(sel);

// ---- page script ----

test("fill_fields: the 5-field form in one pass", () => {
  const w = page(FORM);
  const o = run(w, "fill_fields", { fields: FIVE });
  assert.equal(o.defer, undefined);
  assert.deepEqual(o.results.map((r) => [r.ok, r.kind]), [[true, "plain"], [true, "plain"], [true, "plain"], [true, "select"], [true, "check"]]);
  assert.equal(o.results[3].selected, "Argentina");
  assert.equal(o.results[4].checked, true);
  assert.equal(o.results[4].el, `checkbox "I agree"`);
  assert.equal(val(w, "[name=name]").value, "Ada Lovelace");
  assert.equal(val(w, "[name=email]").value, "ada@example.test");
  assert.equal(val(w, "textarea").value, "Hello there");
  assert.equal(val(w, "select").value, "ar");
  assert.equal(val(w, "[name=agree]").checked, true);
});

test("fill_fields: checked is idempotent and clicks only when the state differs", () => {
  const w = page(`<label><input type=checkbox id=c> Subscribe</label>`);
  runBody(w, `window.clicks = 0; window.changes = 0; const c = document.getElementById('c');
    c.addEventListener('click', () => window.clicks++); c.addEventListener('change', () => window.changes++); return 1`);
  const on = { label_pattern: "subscribe", checked: true };
  assert.equal(run(w, "fill_fields", { fields: [on] }).results[0].ok, true);
  assert.equal(run(w, "fill_fields", { fields: [on] }).results[0].ok, true);
  assert.equal(val(w, "#c").checked, true);
  assert.deepEqual(runBody(w, "return [window.clicks, window.changes]"), [1, 1]);
  const off = run(w, "fill_fields", { fields: [{ selector: "#c", checked: false }] }).results[0];
  assert.deepEqual(off, { ok: true, kind: "check", el: `checkbox "Subscribe"`, checked: false });
  assert.equal(runBody(w, "return window.clicks"), 2);
});

test("fill_fields: checked drives an ARIA checkbox through its click handler", () => {
  const w = page(`<div role=checkbox aria-checked=false tabindex=0>Remember me</div>`);
  runBody(w, `const d = document.querySelector('[role=checkbox]');
    d.addEventListener('click', () => d.setAttribute('aria-checked', d.getAttribute('aria-checked') === 'true' ? 'false' : 'true')); return 1`);
  const r = run(w, "fill_fields", { fields: [{ label_pattern: "remember", checked: true }] }).results[0];
  assert.deepEqual(r, { ok: true, kind: "check", el: `checkbox "Remember me"`, checked: true });
  assert.equal(val(w, "[role=checkbox]").getAttribute("aria-checked"), "true");
});

test("fill_fields: a checkbox that refuses the click is reported, not claimed", () => {
  const w = page(`<label><input type=checkbox id=c> Locked</label>`);
  runBody(w, `document.getElementById('c').addEventListener('click', (e) => e.preventDefault()); return 1`);
  const r = run(w, "fill_fields", { fields: [{ label_pattern: "locked", checked: true }] }).results[0];
  assert.equal(r.ok, false);
  assert.equal(r.kind, "check");
  assert.match(r.error, /did not change/);
  assert.equal(val(w, "#c").checked, false);
});

test("fill_fields: radios can be picked, not unpicked", () => {
  const w = page(`<label><input type=radio name=p value=a id=a> Monthly</label><label><input type=radio name=p value=b id=b> Yearly</label>`);
  const r = run(w, "fill_fields", { fields: [{ label_pattern: "yearly", checked: true }] }).results[0];
  assert.deepEqual(r, { ok: true, kind: "check", el: `radio "Yearly"`, checked: true });
  assert.equal(val(w, "#b").checked, true);
  const un = run(w, "fill_fields", { fields: [{ label_pattern: "yearly", checked: false }] }).results[0];
  assert.equal(un.ok, false);
  assert.match(un.error, /radio/);
  assert.equal(val(w, "#b").checked, true);
});

test("fill_fields: checked refuses an element that isn't a checkbox or radio", () => {
  const w = page(`<button id=b>Delete</button>`);
  runBody(w, `window.clicks = 0; document.getElementById('b').addEventListener('click', () => window.clicks++); return 1`);
  const r = run(w, "fill_fields", { fields: [{ selector: "#b", checked: true }] }).results[0];
  assert.equal(r.ok, false);
  assert.match(r.error, /not a checkbox or radio/);
  assert.equal(runBody(w, "return window.clicks"), 0);
});

test("fill_fields: a failing field doesn't stop the rest", () => {
  const w = page(FORM);
  const o = run(w, "fill_fields", { fields: [
    { label_pattern: "name", text: "Ada" },
    { label_pattern: "zzz", text: "x" },
    { label_pattern: "country", option: "Chile" },
    { label_pattern: "nope", checked: true },
    { label_pattern: "email", text: "a@b.test" },
  ] });
  assert.deepEqual(o.results.map((r) => r.ok), [true, false, false, false, true]);
  assert.deepEqual(o.results.map((r) => r.kind), ["plain", "text", "select", "check", "plain"]);
  assert.match(o.results[1].error, /no fillable field/);
  assert.deepEqual(o.results[2].candidates, ["Pick", "Argentina", "Brazil"]);
  assert.match(o.results[3].error, /no checkbox\/radio matched/);
  assert.equal(val(w, "[name=email]").value, "a@b.test");
});

test("fill_fields: a stale ref fails that field with the re-snapshot hint", () => {
  const w = page(FORM);
  const o = run(w, "fill_fields", { fields: [{ ref: "9", text: "x" }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(o.results[0].ok, false);
  assert.match(o.results[0].error, /ref 9 is stale.*accessibility_snapshot/);
  assert.equal(o.results[1].ok, true);
});

test("fill_fields: a custom combobox stops the pass so select can take it", () => {
  const w = page(`<input aria-label=First><label id=l>Level</label><div role=combobox aria-labelledby=l tabindex=0>Choose</div><input aria-label=Last>`);
  const fields = [{ label_pattern: "first", text: "A" }, { label_pattern: "level", option: "Senior" }, { label_pattern: "last", text: "B" }];
  const o = run(w, "fill_fields", { fields });
  assert.equal(o.defer, 1);
  assert.equal(o.results.length, 1);
  assert.equal(val(w, "[aria-label=Last]").value, "");
  const rest = run(w, "fill_fields", { fields, from: 2 });
  assert.equal(rest.defer, undefined);
  assert.deepEqual(rest.results.map((r) => r.ok), [true]);
  assert.equal(val(w, "[aria-label=Last]").value, "B");
});

// ---- tool call, through the fake JXA world ----

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
const fill = async (args) => {
  const r = await handleCall("fill", args);
  return { r, o: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};

test("fill {fields}: the 5-field form is one tool call", async () => {
  const { dom } = onPage(FORM);
  const { r, o } = await fill({ fields: FIVE });
  assert.equal(r.isError, undefined);
  assert.equal(o.ok, true);
  assert.equal(o.results.length, 5);
  assert.ok(o.results.every((x) => x.ok && x.el));
  assert.equal(dom.document.querySelector("select").value, "ar");
  assert.equal(dom.document.querySelector("[name=agree]").checked, true);
});

test("fill {fields}: ok is false when any field fails", async () => {
  onPage(FORM);
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }, { label_pattern: "zzz", checked: true }] });
  assert.equal(o.ok, false);
  assert.deepEqual(o.results.map((x) => x.ok), [true, false]);
});

// Same react-select-like widget as test/select.test.mjs.
const CUSTOM = `<input aria-label=First><label id=lab>Level</label><div class="select__control"><div role=combobox aria-labelledby=lab aria-expanded=false tabindex=0><span class=v>Choose</span></div></div><div id=menu></div><input aria-label=Last>`;
const CUSTOM_JS = `
  const cb = document.querySelector('[role=combobox]');
  document.querySelector('.select__control').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.view) return;
    cb.setAttribute('aria-expanded', 'true');
    document.getElementById('menu').innerHTML = '<div role=option>Junior</div><div role=option>Senior</div>';
    document.querySelectorAll('[role=option]').forEach(o => o.addEventListener('click', () => { cb.querySelector('.v').textContent = o.textContent; }));
  });`;

test("fill {fields}: a custom combobox goes through select, in order", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS);
  const { o } = await fill({ fields: [
    { label_pattern: "first", text: "A" },
    { label_pattern: "level", option: "senior" },
    { label_pattern: "last", text: "B" },
  ] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.results.map((x) => x.kind), ["plain", "select", "plain"]);
  assert.equal(o.results[1].selected, "Senior");
  assert.equal(o.results[1].value, "Senior");
  assert.equal(dom.document.querySelector(".v").textContent, "Senior");
  assert.equal(dom.document.querySelector("[aria-label=Last]").value, "B");
});

test("fill {fields}: arguments are validated before touching the page", async () => {
  onPage(FORM);
  const err = async (args) => (await handleCall("fill", args)).content[0].text;
  assert.match(await err({ fields: [] }), /fields: empty/);
  assert.match(await err({ fields: [{ text: "x" }] }), /fields\[0\].*`ref`, `selector`, or `label_pattern`/);
  assert.match(await err({ fields: [{ label_pattern: "a" }] }), /fields\[0\].*one of `text`, `checked`, `option`/);
  assert.match(await err({ fields: [{ label_pattern: "a", text: "x", checked: true }] }), /fields\[0\].*one of/);
  assert.match(await err({ fields: [{ label_pattern: "(", text: "x" }] }), /invalid label_pattern/);
  assert.match(await err({ fields: [{ label_pattern: "a", checked: "yes" }] }), /fields\[0\].*`checked` must be a boolean/);
  assert.match(await err({ fields: [{ label_pattern: "a", text: "x" }], text: "y" }), /`fields` OR/);
  assert.match(await err({ fields: [{ label_pattern: "a", text: "x" }], trusted: true }), /trusted/);
});

test("fill without fields keeps its single-field shape", async () => {
  onPage(FORM);
  const { o } = await fill({ label_pattern: "email", text: "a@b.test" });
  assert.deepEqual(o, { ok: true, kind: "plain", el: `textbox "Email"`, len: 8 });
});

test("fill schema advertises fields", () => {
  const t = TOOLS.find((x) => x.name === "fill");
  assert.equal(t.inputSchema.properties.fields.type, "array");
});

// A single field with checked or option returns that field's own result, the
// same flat shape a single text fill returns, rather than a {ok, results} list.
test("fill with a single checked field returns that field's result", async () => {
  const { dom } = onPage(FORM);
  const { r, o } = await fill({ label_pattern: "agree", checked: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.deepEqual(o, { ok: true, kind: "check", el: `checkbox "I agree"`, checked: true });
  assert.equal(dom.document.querySelector("[name=agree]").checked, true);
});

test("fill with a single option field picks it and returns that field's result", async () => {
  const { dom } = onPage(FORM);
  const { o } = await fill({ label_pattern: "country", option: "Brazil" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.results, undefined);
  assert.equal(dom.document.querySelector("select").value, "br");
});

test("fill with a single custom combobox option goes through select", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS);
  const { o } = await fill({ label_pattern: "level", option: "senior" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "select");
  assert.equal(dom.document.querySelector(".v").textContent, "Senior");
});

test("fill single checked/option refuses text, trusted and raise, and both at once", async () => {
  onPage(FORM);
  const err = async (args) => (await handleCall("fill", args)).content[0].text;
  assert.match(await err({ label_pattern: "agree", checked: true, text: "x" }), /checked\/option.*`text`/);
  assert.match(await err({ label_pattern: "agree", checked: true, text_path: "/tmp/x" }), /checked\/option.*`text`/);
  assert.match(await err({ label_pattern: "agree", checked: true, trusted: true }), /checked\/option.*trusted/);
  assert.match(await err({ label_pattern: "country", option: "Brazil", raise: true }), /checked\/option.*trusted/);
  assert.match(await err({ label_pattern: "agree", checked: true, option: "x" }), /one of `checked` or `option`/);
  assert.match(await err({ label_pattern: "agree", checked: "yes" }), /`checked` must be a boolean/);
  assert.match(await err({ checked: true }), /`ref`, `selector`, or `label_pattern`/);
  assert.match(await err({ selector: "#a" }), /fill requires `text` or `text_path` \(checked\/option: use fields\)/);
});
