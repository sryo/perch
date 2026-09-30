// fill {fields}: a whole form in one tool call. Page-level behavior runs the
// fill_fields script in happy-dom; the Node orchestration (custom comboboxes
// handed to the select runtime, in order) runs through the fake JXA world.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, TOOLS, deps, codeOsaError } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { tempDir } from "../scripts/temp.mjs";
import { join } from "node:path";
import { page, run, runBody } from "./helpers/page.mjs";
import { throwAt, noRaw } from "./helpers/fault.mjs";

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

test("fill {fields}: a combobox the page re-renders on pick counts as picked", async () => {
  const { dom } = onPage(`<input aria-label=First><span id=color-label>Color</span> <div id=w></div>`, `let color = "", open = false;
  window.render = () => { document.getElementById("w").innerHTML = '<button type=button id=color role=combobox aria-labelledby=color-label aria-expanded=' + open + ' aria-controls=color-list>' + (color || "Pick a color") + '</button><ul id=color-list role=listbox>' + (open ? ["Red", "Blue"].map((c) => "<li role=option>" + c + "</li>").join("") : "") + "</ul>"; };
  document.addEventListener("click", (e) => { if (e.target.closest("#color")) { open = !open; render(); return; } const li = e.target.closest("#color-list li"); if (li) { color = li.textContent; open = false; render(); } });
  render();`);
  const { o } = await fill({ fields: [{ label_pattern: "first", text: "A" }, { label_pattern: "^color$", option: "Blue" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.results[1].value, "Blue");
  assert.equal(dom.document.querySelector("#color").textContent, "Blue");
});

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

test("fill {fields}: a native select the page reverts fails that field and the whole fill", async () => {
  onPage(FORM, `document.querySelector('select').addEventListener('change', (e) => { e.target.selectedIndex = 0; });`);
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }, { selector: "select", option: "Brazil" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results[0].ok, true);
  assert.equal(o.results[1].ok, false);
  assert.equal(o.results[1].kept, "Pick");
  assert.equal(o.results[1].selected, undefined);
  assert.match(o.results[1].error, /kept "Pick" instead of "Brazil"; the page reverted the pick/);
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

// ---- option on radio groups, found by their question ----

const yesNo = (name) => `<label><input type=radio name=${name} value=y> Yes</label><label><input type=radio name=${name} value=n> No</label>`;
const QUESTIONS = `<form>
  <label>Full name <input name=full></label>
  <label>Country <select name=country><option value="">Pick</option><option value=ar>Argentina</option><option value=br>Brazil</option></select></label>
  <fieldset><legend>Do you require sponsorship?</legend>${yesNo("spons")}</fieldset>
  <fieldset><legend>Are you authorized to work?</legend>${yesNo("auth")}</fieldset>
  <fieldset><legend>Willing to relocate?</legend>${yesNo("reloc")}</fieldset>
  <div><span id=vq>Are you a veteran?</span>
    <div role=radiogroup aria-labelledby=vq><div role=radio aria-checked=false tabindex=0>Yes</div><div role=radio aria-checked=false tabindex=0>No</div></div></div>
  <div class=field><label>Preferred shift</label><div class=opts>
    <label><input type=radio name=shift value=day> Day</label><label><input type=radio name=shift value=night> Night</label></div></div>
  <div class=field><label>Remote only?</label><div class=opts>
    <label><input type=radio name=remote value=y> Yes</label><label><input type=radio name=remote value=n> No</label></div></div>
</form>`;
// The ARIA radios follow their clicks. The shift and remote groups are
// controlled: a change re-renders every radio from the component's own state,
// which only a click on an option updates (shift) or nothing updates (remote).
const QUESTIONS_JS = `
  document.querySelectorAll('[role=radio]').forEach((r) => r.addEventListener('click', () => {
    r.parentElement.querySelectorAll('[role=radio]').forEach((x) => x.setAttribute('aria-checked', String(x === r)));
  }));
  const controlled = (name, onClick) => {
    const st = { v: null };
    const radios = () => document.querySelectorAll('[name=' + name + ']');
    const render = () => radios().forEach((x) => { x.checked = x.value === st.v; });
    radios().forEach((x) => {
      x.addEventListener('click', () => onClick(st, x.value));
      x.addEventListener('change', render);
    });
  };
  controlled('shift', (st, v) => { st.v = v; });
  controlled('remote', () => {});`;

const radioState = (w) => runBody(w, `return Array.from(document.querySelectorAll('input[type=radio], [role=radio]'))
  .filter((r) => r.checked || r.getAttribute('aria-checked') === 'true').map((r) => (r.name || 'aria') + '=' + (r.value || r.textContent))`);

function questions() {
  const w = page(QUESTIONS);
  w.eval(QUESTIONS_JS);
  return w;
}
const pick = (w, label_pattern, option) => run(w, "fill_fields", { fields: [{ label_pattern, option }] }).results[0];

test("fill_fields: option answers each yes/no question in its own group", () => {
  const w = questions();
  const s = pick(w, "sponsorship", "No");
  assert.deepEqual(s, { ok: true, kind: "radio", selected: "No", el: `radiogroup "Do you require sponsorship?"` });
  assert.deepEqual(radioState(w), ["spons=n"]);
  assert.equal(pick(w, "authorized", "yes").selected, "Yes");
  assert.equal(pick(w, "relocate", "no").ok, true);
  assert.deepEqual(radioState(w), ["spons=n", "auth=y", "reloc=n"]);
  const v = pick(w, "veteran", "No");
  assert.deepEqual(v, { ok: true, kind: "radio", selected: "No", el: `radiogroup "Are you a veteran?"` });
  assert.deepEqual(radioState(w), ["spons=n", "auth=y", "reloc=n", "aria=No"]);
});

test("fill_fields: a radio option miss lists that group's options and clicks nothing", () => {
  const w = questions();
  runBody(w, `window.clicks = 0; document.addEventListener('click', () => window.clicks++, true); return 1`);
  const r = pick(w, "sponsorship", "Maybe");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "radio");
  assert.match(r.error, /no matching option/);
  assert.deepEqual(r.candidates, ["Yes", "No"]);
  assert.equal(runBody(w, "return window.clicks"), 0);
  assert.deepEqual(radioState(w), []);
});

test("fill_fields: a radio option tie at the best tier is ambiguous", () => {
  const w = page(`<fieldset><legend>Start date</legend><label><input type=radio name=s> Now, full time</label><label><input type=radio name=s> Now, part time</label><label><input type=radio name=s> Later</label></fieldset>`);
  const r = pick(w, "start", "now");
  assert.equal(r.ok, false);
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.candidates, ["Now, full time", "Now, part time", "Later"]);
  assert.deepEqual(radioState(w), []);
});

test("fill_fields: an already-checked radio option is a no-op", () => {
  const w = questions();
  assert.equal(pick(w, "relocate", "No").ok, true);
  runBody(w, `window.clicks = 0; document.addEventListener('click', () => window.clicks++, true); return 1`);
  const r = pick(w, "relocate", "No");
  assert.deepEqual(r, { ok: true, kind: "radio", selected: "No", el: `radiogroup "Willing to relocate?"` });
  assert.equal(runBody(w, "return window.clicks"), 0);
});

test("fill_fields: a controlled radio group is answered by clicking, and one that reverts is reported", () => {
  const w = questions();
  // A bare checked assignment is undone by the component's next render.
  runBody(w, `const n = document.querySelector('[name=shift][value=night]'); n.checked = true; n.dispatchEvent(new Event('change', { bubbles: true })); return 1`);
  assert.deepEqual(radioState(w), []);
  const s = pick(w, "preferred shift", "night");
  assert.deepEqual(s, { ok: true, kind: "radio", selected: "Night", el: `radiogroup "Preferred shift"` });
  assert.deepEqual(radioState(w), ["shift=night"]);
  const r = pick(w, "remote only", "No");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "radio");
  assert.match(r.error, /did not stick/);
  assert.equal(r.selected, null);
  assert.deepEqual(radioState(w), ["shift=night"]);
});

test("fill_fields: text, a native select and a radio group in one pass", () => {
  const w = questions();
  const o = run(w, "fill_fields", { fields: [
    { label_pattern: "full name", text: "Ada Lovelace" },
    { label_pattern: "country", option: "Brazil" },
    { label_pattern: "sponsorship", option: "No" },
    { label_pattern: "authorized", option: "Yes" },
  ] });
  assert.equal(o.defer, undefined);
  assert.deepEqual(o.results.map((r) => [r.ok, r.kind, r.selected]), [[true, "plain", undefined], [true, "select", "Brazil"], [true, "radio", "No"], [true, "radio", "Yes"]]);
  assert.equal(val(w, "[name=full]").value, "Ada Lovelace");
  assert.equal(val(w, "select").value, "br");
  assert.deepEqual(radioState(w), ["spons=n", "auth=y"]);
});

test("fill_fields: a question that matches a select and a radio group is ambiguous", () => {
  const w = page(`<label>Work status <select><option>Citizen</option><option>Visa</option></select></label>
    <fieldset><legend>Work status verified?</legend>${yesNo("ws")}</fieldset>`);
  const r = pick(w, "work status", "Visa");
  assert.equal(r.ok, false);
  assert.equal(r.ambiguous, true);
  assert.match(r.error, /several/);
  assert.equal(val(w, "select").value, "Citizen");
  assert.deepEqual(radioState(w), []);
});

test("fill_fields: a same-name radio set takes its question from the text before it", () => {
  const w = page(`<ul><li class=q><div class=label>Do you have a driver's license?</div><div class=f><ul>
    <li><label><input type=radio name=lic value=y> Yes</label></li><li><label><input type=radio name=lic value=n> No</label></li></ul></div></li>
    <li class=q><p>Can you travel?</p><label><input type=radio name=tr value=y> Yes</label><label><input type=radio name=tr value=n> No</label></li></ul>`);
  assert.equal(pick(w, "license", "No").ok, true);
  assert.equal(pick(w, "travel", "Yes").ok, true);
  assert.deepEqual(radioState(w), ["lic=n", "tr=y"]);
});

test("fill_fields: option on a selector naming a radio or its group's box answers that group", () => {
  const w = questions();
  const a = run(w, "fill_fields", { fields: [{ selector: "[name=reloc][value=y]", option: "No" }, { selector: "[role=radiogroup]", option: "Yes" }] });
  assert.deepEqual(a.results.map((r) => [r.ok, r.kind, r.selected]), [[true, "radio", "No"], [true, "radio", "Yes"]]);
  assert.deepEqual(radioState(w), ["reloc=n", "aria=Yes"]);
});

test("fill: a single option field answers a radio question through the tool", async () => {
  const { dom } = onPage(QUESTIONS, QUESTIONS_JS);
  const { o } = await fill({ label_pattern: "sponsorship", option: "No" });
  assert.deepEqual(o, { ok: true, kind: "radio", selected: "No", el: `radiogroup "Do you require sponsorship?"` });
  assert.equal(dom.document.querySelector("[name=spons][value=n]").checked, true);
  assert.equal(dom.document.querySelector("[name=auth][value=n]").checked, false);
});

// ---- exact values on sanitizing inputs ----

// happy-dom already applies the HTML value sanitization algorithm to date,
// month, color and a range's min/max clamp. Where it does not, sanitize()
// puts the rule on the element as an instance getter: fill writes through the
// prototype setter, then reads el.value back as the page would.
const sanitize = (w, sel, rule) => {
  const el = w.document.querySelector(sel);
  const d = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value");
  Object.defineProperty(el, "value", { configurable: true, set(v) { d.set.call(this, v); }, get() { return rule(d.get.call(this), this); } });
  return el;
};
// input type=number: "If the value of the element is not a valid floating-point
// number, then set it to the empty string instead."
const numberRule = (v) => (/^-?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(v) ? v : "");
// input type=range: a value that suffers a step mismatch is rounded to the
// nearest allowed value (step base min), preferring the larger on a tie.
const stepRule = (v, el) => {
  const min = Number(el.getAttribute("min") || 0), step = Number(el.getAttribute("step"));
  return String(min + Math.round((Number(v) - min) / step) * step);
};
// Time serialized with seconds, as a browser does when the step allows them.
const secondsRule = (v) => (/^\d\d:\d\d$/.test(v) ? v + ":00" : v);

test("fill: a range input keeps its clamp and fill says so", () => {
  const w = page(`<input type=range min=0 max=10 aria-label=Level>`);
  const o = run(w, "fill", { selector: "input", text: "15" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kept, "10");
  assert.equal(o.el, `slider "Level"`);
  assert.match(o.error, /a number between 0 and 10/);
  assert.equal(run(w, "fill", { selector: "input", text: "7" }).ok, true);
});

test("fill: a range step mismatch reports the rounded value and the step", () => {
  const w = page(`<input type=range min=0 max=10 step=5 aria-label=Level>`);
  sanitize(w, "input", stepRule);
  const o = run(w, "fill", { selector: "input", text: "7" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kept, "5");
  assert.match(o.error, /between 0 and 10 in steps of 5/);
});

test("fill: a date takes only YYYY-MM-DD", () => {
  const w = page(`<label>Start date <input type=date></label>`);
  assert.deepEqual(run(w, "fill", { label_pattern: "start", text: "2026-03-15" }), { ok: true, kind: "plain", el: `textbox "Start date"`, len: 10 });
  const o = run(w, "fill", { label_pattern: "start", text: "03/15/2026" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kept, "");
  assert.match(o.error, /expects YYYY-MM-DD/);
});

test("fill: a month and a color are checked exactly too", () => {
  const w = page(`<label>Since <input type=month></label><label>Tint <input type=color></label>`);
  const m = run(w, "fill", { label_pattern: "since", text: "3/2026" });
  assert.equal(m.ok, false);
  assert.match(m.error, /expects YYYY-MM\b/);
  assert.equal(run(w, "fill", { label_pattern: "since", text: "2026-03" }).ok, true);
  const c = run(w, "fill", { selector: "[type=color]", text: "red" });
  assert.equal(c.ok, false);
  assert.equal(c.kept, "#000000");
  assert.equal(run(w, "fill", { selector: "[type=color]", text: "#FF8800" }).ok, true);
});

test("fill: a number keeps only a number, compared by value", () => {
  const w = page(`<label>Salary <input type=number></label>`);
  sanitize(w, "input", numberRule);
  const bad = run(w, "fill", { label_pattern: "salary", text: "3,000" });
  assert.equal(bad.ok, false, JSON.stringify(bad));
  assert.equal(bad.kept, "");
  assert.match(bad.error, /expects a number/);
  assert.equal(run(w, "fill", { label_pattern: "salary", text: "3000" }).ok, true);
  assert.equal(run(w, "fill", { label_pattern: "salary", text: "3000.0" }).ok, true);
});

test("fill: a time passes with or without the seconds the browser adds", () => {
  const w = page(`<label>From <input type=time></label><label>To <input type=time id=to></label>`);
  sanitize(w, "#to", secondsRule);
  assert.equal(run(w, "fill", { label_pattern: "from", text: "09:30" }).ok, true);
  const o = run(w, "fill", { label_pattern: "^to", text: "09:30" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(w.document.querySelectorAll("input")[1].value, "09:30:00");
});

test("fill: a whole-hour time or datetime passes when the browser adds seconds", () => {
  const w = page(`<label>From <input type=time id=from></label><label>At <input type=datetime-local id=at></label>`);
  sanitize(w, "#from", secondsRule);
  sanitize(w, "#at", (v) => (/T\d\d:\d\d$/.test(v) ? v + ":00" : v));
  const t = run(w, "fill", { label_pattern: "from", text: "09:00" });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(w.document.querySelector("#from").value, "09:00:00");
  const d = run(w, "fill", { label_pattern: "^at", text: "2026-03-15T09:00" });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(w.document.querySelector("#at").value, "2026-03-15T09:00:00");
  const miss = run(w, "fill", { label_pattern: "from", text: "10:00" });
  assert.equal(miss.ok, true, JSON.stringify(miss));
  sanitize(w, "#from", () => "10:30:00");
  assert.equal(run(w, "fill", { label_pattern: "from", text: "10:00" }).ok, false);
});

test("fill: clearing a number field with empty text passes", () => {
  const w = page(`<label>Salary <input type=number value=3000></label>`);
  sanitize(w, "[type=number]", numberRule);
  const o = run(w, "fill", { label_pattern: "salary", text: "" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(w.document.querySelector("[type=number]").value, "");
});

const CLEAR = `<label>City <input id=city value=Rosario></label>
  <label>Salary <input type=number value=3000></label>
  <label>Start date <input type=date value=2026-03-15></label>
  <label>Notes <textarea>old</textarea></label>
  <label>Tag <input id=tag role=combobox aria-autocomplete=list value=blue></label>`;

test("fill {text:''} clears a field and checks it is empty", async () => {
  const { dom } = onPage(CLEAR);
  sanitize(dom, "[type=number]", numberRule);
  for (const [label_pattern, sel] of [["city", "#city"], ["salary", "[type=number]"], ["start", "[type=date]"], ["notes", "textarea"], ["tag", "#tag"]]) {
    const { r, o } = await fill({ label_pattern, text: "" });
    assert.equal(r.isError, undefined, `${label_pattern}: ${o}`);
    assert.equal(o.ok, true, `${label_pattern}: ${JSON.stringify(o)}`);
    assert.equal(o.len, 0, label_pattern);
    assert.equal(dom.document.querySelector(sel).value, "", label_pattern);
  }
});

test("fill {fields} clears fields given text:''", async () => {
  const { dom } = onPage(CLEAR);
  const { o } = await fill({ fields: [{ selector: "#city", text: "" }, { label_pattern: "salary", text: "" }, { selector: "#tag", text: "" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(["#city", "[type=number]", "#tag"].map((s) => dom.document.querySelector(s).value), ["", "", ""]);
});

test("fill {text:''} fails when the page puts the value back", () => {
  const w = page(`<label>City <input id=city value=Rosario></label>`);
  runBody(w, `const c = document.getElementById('city'); c.addEventListener('blur', () => { c.value = 'Rosario'; }); return 1`);
  const o = run(w, "fill", { label_pattern: "city", text: "" });
  assert.equal(o.ok, false, JSON.stringify(o));
});

test("fill {text:''} empties a rich editor", () => {
  const w = page(`<div contenteditable=true aria-label=Body><p>Dear team</p></div>`);
  const o = run(w, "fill", { label_pattern: "body", text: "" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "rich");
  assert.equal(w.document.querySelector("[contenteditable]").textContent, "");
});

test("fill {text:''} on a typeahead clears it without a suggestion lookup", () => {
  const w = page(`<label>Tag <input id=tag role=combobox aria-autocomplete=list value=blue></label>`);
  assert.deepEqual(run(w, "fill", { label_pattern: "tag", text: "" }), { ok: true, kind: "plain", el: `combobox "Tag"`, len: 0 });
  assert.deepEqual(run(w, "fill_fields", { fields: [{ selector: "#tag", text: "" }] }).results, [{ ok: true, kind: "plain", el: `combobox "Tag"`, len: 0 }]);
});

test("fill still rejects a missing or blank text, and a trusted clear", async () => {
  onPage(CLEAR);
  const err = async (args) => (await handleCall("fill", args)).content[0].text;
  assert.match(await err({ selector: "#city" }), /fill requires `text` or `text_path`/);
  assert.match(await err({ selector: "#city", text: null }), /fill requires `text` or `text_path`/);
  assert.match(await err({ selector: "#city", text: "  " }), /fill: empty body/);
  assert.match(await err({ selector: "#city", text: "", text_path: "/tmp/x" }), /`text` OR `text_path`/);
  assert.match(await err({ selector: "#city", text: "", trusted: true }), /clearing.*trusted/);
});

test("fill: text-like inputs keep the tolerant check", () => {
  const w = page(`<label>Phone <input type=tel></label><label>City <input id=city></label>`);
  // A phone mask that drops the country code and reformats.
  sanitize(w, "[type=tel]", (v) => { const d = v.replace(/\D/g, "").slice(-10); return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ""; });
  const p = run(w, "fill", { label_pattern: "phone", text: "+54 9 351 555 1234" });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(w.document.querySelector("[type=tel]").value, "(351) 555-1234");
  sanitize(w, "#city", (v) => v.trim());
  assert.equal(run(w, "fill", { label_pattern: "city", text: "  Rosario " }).ok, true);
});

// ---- a controlled field that snaps back to what it held ----

const revert = (w, sel) => runBody(w, `const e = document.querySelector(${JSON.stringify(sel)}); const was = e.value;
  e.addEventListener('input', () => { e.value = was; }); return 1`);

test("fill: a masked refill of the same number is ok", () => {
  const w = page(`<label>Phone <input id=p value=5493516116242></label>`);
  revert(w, "#p");
  const o = run(w, "fill", { label_pattern: "phone", text: "9 351 611 6242" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(val(w, "#p").value, "5493516116242");
});

test("fill: a field that restores a different number is not ok", () => {
  const w = page(`<label>Phone <input id=p value=5493516116242></label>`);
  revert(w, "#p");
  const o = run(w, "fill", { label_pattern: "phone", text: "9 351 555 1234" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kept, "5493516116242");
  assert.match(o.error, /kept its previous value "5493516116242"/);
});

test("fill: a same-length date revert is not ok", () => {
  const w = page(`<label>Since <input id=d value=04/03/2021></label>`);
  revert(w, "#d");
  const o = run(w, "fill", { label_pattern: "since", text: "03/04/2021" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.kept, "04/03/2021");
});

test("fill: a mask reformatting an empty field still lands", () => {
  const w = page(`<label>Phone <input type=tel></label>`);
  sanitize(w, "[type=tel]", (v) => { const d = v.replace(/\D/g, "").slice(-10); return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ""; });
  const o = run(w, "fill", { label_pattern: "phone", text: "+54 9 351 611 6242" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(w.document.querySelector("[type=tel]").value, "(351) 611-6242");
});

test("fill: a field that collapses whitespace lands", () => {
  const w = page(`<label>Name <input id=n></label>`);
  sanitize(w, "#n", (v) => v.trim().replace(/\s+/g, " "));
  assert.equal(run(w, "fill", { label_pattern: "name", text: "  a   b " }).ok, true);
  assert.equal(val(w, "#n").value, "a b");
});

test("fill: an empty field keeps its result shape", () => {
  const w = page(`<label>City <input id=c></label>`);
  assert.deepEqual(run(w, "fill", { label_pattern: "city", text: "Rosario" }), { ok: true, kind: "plain", el: `textbox "City"`, len: 7 });
});

test("fill: refilling a field with the value it holds is ok", () => {
  const w = page(`<label>City <input id=c value=Rosario></label>`);
  revert(w, "#c");
  assert.deepEqual(run(w, "fill", { label_pattern: "city", text: "Rosario" }), { ok: true, kind: "plain", el: `textbox "City"`, len: 7 });
});

test("fill_fields: only the reverting entry fails", () => {
  const w = page(`<label>Name <input id=n></label><label>Phone <input id=p value=5493516116242></label><label>City <textarea id=c></textarea></label>`);
  revert(w, "#p");
  const o = run(w, "fill_fields", { fields: [{ selector: "#n", text: "Ada" }, { selector: "#p", text: "9 351 555 1234" }, { selector: "#c", text: "Rosario" }] });
  assert.deepEqual(o.results.map((r) => r.ok), [true, false, true]);
  assert.equal(o.results[1].kept, "5493516116242");
  assert.match(o.results[1].error, /previous value/);
});

test("fill_fields: a bad date fails its own field with what the page kept", () => {
  const w = page(`<label>Company <input name=co></label><label>Start date <input type=date></label>`);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "company", text: "Acme" }, { label_pattern: "start", text: "03/15/2026" }] });
  assert.equal(o.results[0].ok, true);
  assert.deepEqual(o.results[1], { ok: false, el: `textbox "Start date"`, kept: "", error: `textbox "Start date" expects YYYY-MM-DD; the page kept ""`, kind: "text" });
});

// ---- a label miss names the button that reveals the field ----

const COVER = `<form>
  <div><label>Resume</label><button type=button>Upload file</button></div>
  <div><label>Cover letter</label><div><button type=button>Attach</button><button type=button>Enter manually</button></div></div>
  <div class=bar><button>Submit application</button></div>
</form>`;

test("fill: a label miss lists the buttons in the matching section, typing ones first", () => {
  const w = page(COVER);
  const o = run(w, "fill", { label_pattern: "cover letter", text: "Dear team" });
  assert.equal(o.ok, false);
  assert.deepEqual(o.reveal, [`button "Enter manually"`, `button "Attach"`]);
  assert.equal(o.error, "no fillable field matched /cover letter/i; it may appear after clicking one of reveal (click {label_pattern} it, then fill again)");
});

test("fill: a revealed field fills after clicking the listed button by name", () => {
  const w = page(COVER);
  runBody(w, `const b = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Enter manually');
    b.addEventListener('click', () => { const t = document.createElement('textarea'); t.setAttribute('aria-label', 'Cover letter'); b.parentElement.appendChild(t); }); return 1`);
  const miss = run(w, "fill", { label_pattern: "cover letter", text: "Dear team" });
  const name = miss.reveal[0].match(/"(.*)"/)[1];
  assert.equal(run(w, "click", { label_pattern: name }).ok, true);
  const o = run(w, "fill", { label_pattern: "cover letter", text: "Dear team" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(w.document.querySelector("textarea").value, "Dear team");
});

test("fill: a button named like the field is listed; submit-bar buttons never are", () => {
  const w = page(`<div><label>Cover letter</label><button type=submit>Send</button><button type=button>Save draft</button><button type=button>Next</button></div>
    <button type=button>Write cover letter</button>`);
  const o = run(w, "fill", { label_pattern: "cover letter", text: "x" });
  assert.deepEqual(o.reveal, [`button "Write cover letter"`]);
});

test("fill: a reveal hint never reaches past the field's own section", () => {
  const six = ["A", "B", "C", "D", "E", "F"].map((n) => `<label>${n} <input></label>`).join("");
  for (const html of [
    `<main><h2>Customer details</h2><label>Name <input></label><label>Email <input></label><div><button type=button>Expand all</button></div></main>`,
    `<div><h2>Customer details</h2><form><label>Name <input></label><label>Email <input></label></form><div><button type=button>Expand all</button></div></div>`,
    `<div role=main><h2>Customer details</h2><label>Name <input></label><label>Email <input></label><div><button type=button>Expand all</button></div></div>`,
    `<div><h2>Customer details</h2>${six}<div><button type=button>Expand all</button></div></div>`,
  ]) {
    const o = run(page(html), "fill", { label_pattern: "customer", text: "x" });
    assert.equal(o.ok, false, html);
    assert.equal(o.reveal, undefined, html);
    assert.match(o.error, /^no fillable field matched \/customer\/i; it may appear only after clicking a button/, html);
  }
});

test("fill: no candidate button leaves the plain miss", () => {
  const w = page(`<label>Name <input></label><button type=button>Help</button>`);
  const o = run(w, "fill", { label_pattern: "cover letter", text: "x" });
  assert.deepEqual(o, { ok: false, error: "no fillable field matched /cover letter/i; it may appear only after clicking a button" });
});

test("fill_fields: a label miss in a batch carries its reveal list", () => {
  // Nested past the 6 ancestors fill's label search walks, so the page text
  // around the City field doesn't match "cover letter".
  const w = page(COVER + `<div><div><div><div><label>City <input></label></div></div></div></div>`);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "city", text: "Rosario" }, { label_pattern: "cover letter", text: "x" }] });
  assert.equal(o.results[0].ok, true);
  assert.deepEqual(o.results[1].reveal, [`button "Enter manually"`, `button "Attach"`]);
});

// ---- only_empty: one verified call in place of a profile autofill script ----

const PROFILE = [
  { label_pattern: "first name", text: "Ada" },
  { label_pattern: "last name", text: "Lovelace" },
  { label_pattern: "e-?mail", text: "ada@example.test" },
  { label_pattern: "phone", text: "+1 555 010 0199" },
  { label_pattern: "linkedin", text: "https://linkedin.example/ada" },
  { label_pattern: "github", text: "https://code.example/ada" },
  { label_pattern: "portfolio|website", text: "https://ada.example" },
  { label_pattern: "city", text: "London" },
  { label_pattern: "postal|zip", text: "N1" },
  { label_pattern: "salary", text: "100" },
  { label_pattern: "pronouns", option: "she/her" },
  { label_pattern: "relocate", checked: true },
];
const PROFILE_FORM = `<form>
  <label>First name <input name=fn></label>
  <label>Last name <input name=ln></label>
  <label>Email <input type=email name=em></label>
  <label>Phone <input type=tel name=ph></label>
  <label>LinkedIn profile <input name=li></label>
  <button type=submit>Apply</button>
</form>`;

test("fill {fields, only_empty}: fields the form lacks are skipped as absent, the rest filled", async () => {
  const { dom } = onPage(PROFILE_FORM);
  const { r, o } = await fill({ fields: PROFILE, only_empty: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.skipped, 7);
  assert.deepEqual(o.results.map((x) => x.skipped || x.kind), ["plain", "plain", "plain", "plain", "plain", "absent", "absent", "absent", "absent", "absent", "absent", "absent"]);
  assert.ok(o.results.slice(5).every((x) => x.ok === true && x.kind));
  assert.deepEqual(["fn", "ln", "em", "ph", "li"].map((n) => dom.document.querySelector(`[name=${n}]`).value),
    ["Ada", "Lovelace", "ada@example.test", "+1 555 010 0199", "https://linkedin.example/ada"]);
});

test("fill {fields, only_empty}: a prefilled field keeps its value", async () => {
  const { dom } = onPage(`<label>Email <input type=email name=em value="ada@parsed.test"></label><label>Phone <input name=ph></label>`);
  const { o } = await fill({ fields: [{ label_pattern: "email", text: "other@example.test" }, { label_pattern: "phone", text: "5550100" }], only_empty: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.skipped, 1);
  assert.deepEqual(o.results[0], { ok: true, kind: "plain", skipped: "has value", el: `textbox "Email"`, value: "ada@parsed.test" });
  assert.equal(o.results[1].skipped, undefined);
  assert.equal(dom.document.querySelector("[name=em]").value, "ada@parsed.test");
  assert.equal(dom.document.querySelector("[name=ph]").value, "5550100");
});

// react-select v5 after a pick: the value shows in a single-value span and the
// role=combobox input is empty.
const PICKED = `<label id=lab>Level</label><div class="select__control"><div class="select__value-container"><div class="select__single-value">Senior</div><input role=combobox aria-labelledby=lab aria-expanded=false aria-autocomplete=list></div></div><div id=menu></div>`;
const PICKED_JS = `window.opened = 0; document.querySelector('.select__control').addEventListener('mousedown', () => window.opened++);`;

test("fill {fields, only_empty}: a combobox already showing a pick is never re-picked", async () => {
  const { dom, world } = onPage(PICKED, PICKED_JS);
  const calls = [];
  const orig = world.ctx.__perch.select;
  world.ctx.__perch.select = (...a) => { calls.push(a); return orig(...a); };
  try {
    for (const f of [{ label_pattern: "level", option: "Junior" }, { label_pattern: "level", text: "Junior" }]) {
      const { o } = await fill({ fields: [f], only_empty: true });
      assert.equal(o.ok, true, JSON.stringify(o));
      assert.equal(o.results[0].skipped, "has value");
      assert.equal(o.results[0].value, "Senior");
    }
  } finally { world.ctx.__perch.select = orig; }
  assert.equal(calls.length, 0);
  assert.equal(dom.window.opened, 0);
  assert.equal(dom.document.querySelector(".select__single-value").textContent, "Senior");
});

test("fill_fields only_empty: a chosen select and a checked radio group are kept; a select on its placeholder is filled", () => {
  const w = page(`<label>Country <select name=c><option value="">Pick</option><option value=ar>Argentina</option><option value=br selected>Brazil</option></select></label>
    <label>Degree <select name=d><option value="" disabled selected>Select...</option><option value=bs>BSc</option><option value=ms>MSc</option></select></label>
    <fieldset><legend>Need a visa?</legend><label><input type=radio name=v value=y checked> Yes</label><label><input type=radio name=v value=n> No</label></fieldset>`);
  // happy-dom ignores the selected attribute here, so set what a parser would have.
  runBody(w, `document.querySelector('[name=c]').value = 'br'; document.querySelector('[name=d]').selectedIndex = 0; return 1`);
  const o = run(w, "fill_fields", { only: true, fields: [
    { label_pattern: "country", option: "Argentina" },
    { label_pattern: "degree", option: "MSc" },
    { label_pattern: "visa", option: "No" },
  ] });
  assert.deepEqual(o.results.map((r) => [r.ok, r.skipped, r.value]), [[true, "has value", "Brazil"], [true, undefined, undefined], [true, "has value", "Yes"]]);
  assert.equal(val(w, "[name=c]").value, "br");
  assert.equal(val(w, "[name=d]").value, "ms");
  assert.equal(val(w, "[value=y]").checked, true);
});

test("fill_fields only_empty: a pattern hitting two own-labelled fields writes neither", () => {
  const w = page(`<label>Home phone <input name=a></label><label>Work phone <input name=b></label>`);
  const r = run(w, "fill_fields", { only: true, fields: [{ label_pattern: "phone", text: "5550100" }] }).results[0];
  assert.deepEqual(r, { ok: true, kind: "text", skipped: "ambiguous", candidates: [`textbox "Home phone"`, `textbox "Work phone"`] });
  assert.equal(val(w, "[name=a]").value, "");
  assert.equal(val(w, "[name=b]").value, "");
});

test("fill_fields only_empty: the honeypot fixture's trap is never written; a trap-only match is skipped", () => {
  const html = readFileSync(new URL("./fixtures/honeypot.html", import.meta.url), "utf8");
  const w = page(html.slice(html.indexOf("<style>")));
  const o = run(w, "fill_fields", { only: true, fields: [{ label_pattern: "email", text: "ada@example.test" }] });
  assert.equal(o.results[0].ok, true, JSON.stringify(o));
  assert.equal(val(w, "#email").value, "ada@example.test");
  assert.equal(val(w, "#trap").value, "");
  assert.equal(val(w, "#decoy").value, "");
  w.document.querySelectorAll("#email, #decoy").forEach((e) => e.closest(".row").remove());
  const t = run(w, "fill_fields", { only: true, fields: [{ label_pattern: "email", text: "ada@example.test" }] }).results[0];
  assert.deepEqual(t, { ok: true, kind: "text", skipped: "trap", el: `textbox "Email" hidden` });
  assert.equal(val(w, "#trap").value, "");
});

test("fill {fields} without only_empty: an absent pattern fails exactly as before", async () => {
  onPage(PROFILE_FORM);
  const { o } = await fill({ fields: [{ label_pattern: "github", text: "x" }, { label_pattern: "pronouns", option: "x" }, { label_pattern: "relocate", checked: true }] });
  assert.equal(o.ok, false);
  assert.equal(o.skipped, undefined);
  assert.deepEqual(o.results.map((x) => [x.ok, x.error]), [
    [false, "no fillable field matched /github/i; it may appear only after clicking a button"],
    [false, "no select, combobox or radio group matched /pronouns/i"],
    [false, "no checkbox/radio matched /relocate/i"],
  ]);
  assert.ok(o.results.every((x) => !("absent" in x) && !("skipped" in x)));
});

test("fill: only_empty takes fields", async () => {
  onPage(PROFILE_FORM);
  const err = async (args) => (await handleCall("fill", args)).content[0].text;
  assert.match(await err({ label_pattern: "email", text: "a@b.test", only_empty: true }), /fill: only_empty takes `fields`/);
  assert.match(await err({ label_pattern: "relocate", checked: true, only_empty: true }), /fill: only_empty takes `fields`/);
  assert.equal(TOOLS.find((x) => x.name === "fill").inputSchema.properties.only_empty.type, "boolean");
});

// ---- a batch that ends early keeps what landed ----

const NO_SHOW_JS = CUSTOM_JS.replace("cb.querySelector('.v').textContent = o.textContent;", "");
const tabOf = async () => JSON.parse((await handleCall("list_tabs", {})).content[0].text).tabs[0].tabId;
function closeTabNow(world, app, id) {
  const list = world.tabsOf(app, 0), spec = world.winSpec(app, 0);
  list.splice(list.findIndex((t) => String(t.spec.id) === String(id)), 1);
  spec.active = Math.min(spec.active, list.length - 1);
}
const TWO = [{ label_pattern: "first", text: "A" }, { label_pattern: "level", option: "senior" }];

test("fill {fields}: a pick the control never shows fails that field and the batch", async () => {
  onPage(CUSTOM, NO_SHOW_JS);
  const { o } = await fill({ fields: TWO });
  assert.equal(o.results[0].ok, true, JSON.stringify(o));
  assert.equal(o.results[1].ok, false, JSON.stringify(o));
  assert.equal(o.results[1].kind, "select");
  assert.equal(o.results[1].pressed, "Senior");
  assert.ok("value" in o.results[1], JSON.stringify(o));
  assert.equal(o.unverified, undefined);
  assert.equal(o.ok, false);
});

test("fill {fields}: a tab closing during a later select keeps the fields that landed", async () => {
  const { world } = onPage(CUSTOM, CUSTOM_JS);
  const tabId = await tabOf();
  world.state.afterExecute = () => { world.state.afterExecute = null; closeTabNow(world, "Google Chrome", "x"); };
  const { r, o } = await fill({ fields: TWO, target: { tabId } });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.ok, false);
  assert.equal(o.results.length, 2);
  assert.equal(o.results[0].ok, true);
  assert.equal(o.results[1].ok, false);
  assert.match(o.results[1].error, /^stale_tab: /);
  assert.equal(o.error, o.results[1].error);
});

test("fill {fields}: a dialog raised by an earlier field's handler keeps the fields that landed", async (t) => {
  const { dom, world } = onPage(CUSTOM, CUSTOM_JS);
  const tabId = await tabOf();
  // The handler's alert comes a tick later (after a save request), so the pass that fired it still replies.
  let alerted = false;
  dom.document.querySelector("[aria-label=First]").addEventListener("change", () => { alerted = true; });
  world.state.afterExecute = () => {
    if (!alerted) return;
    world.state.afterExecute = null;
    world.state.dialogs.push({ pid: 1, blocks: "x", texts: ["a.test says", "Saved"], buttons: ["OK"] });
  };
  const saved = deps.dialogs;
  t.after(() => { deps.dialogs = saved; });
  deps.dialogs = async () => (world.state.dialogs.length ? [{ kind: "alert", message: "Saved" }] : []);
  const { r, o } = await fill({ fields: TWO, target: { tabId } });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.ok, false);
  assert.equal(o.results.length, 2);
  assert.equal(o.results[0].ok, true);
  assert.match(o.results[1].error, /^dialog_open: /);
  assert.equal(o.error, o.results[1].error);
});

test("fill {fields}: an error on the first field still ends the call as before", async () => {
  const { world } = onPage(CUSTOM, CUSTOM_JS);
  const tabId = await tabOf();
  closeTabNow(world, "Google Chrome", "x");
  const { r, o } = await fill({ fields: TWO, target: { tabId } });
  assert.equal(r.isError, true);
  assert.match(o, /^error: stale_tab: /);
});

// Page scripts after the first one fail at the AppleScript level, not with a coded message.
const failAfterFirst = (world) => { let n = 0; world.state.onExecute = () => { if (++n > 1) throw new Error("page JS failed"); }; };
// The page pass resuming at `from` throws inside the page, so it replies with __perch_error.
const breakPassFrom = (world, dom, from) => {
  world.state.onExecute = (spec, js) => {
    if (js.includes(`"from":${from}`)) dom.eval("document.querySelector = document.querySelectorAll = () => { throw new Error('x'); };");
  };
};
const halted = (o, n) => {
  assert.equal(o.ok, false);
  assert.equal(o.results.length, n);
  assert.equal(o.results[0].ok, true);
  assert.equal(o.results[n - 1].ok, false);
  assert.equal(o.error, o.results[n - 1].error);
};

test("fill {fields}: an uncoded failure in a later select keeps the fields that landed", async () => {
  const { world } = onPage(CUSTOM, CUSTOM_JS);
  failAfterFirst(world);
  const { r, o } = await fill({ fields: TWO });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  halted(o, 2);
  assert.deepEqual(o.results[1], { ok: false, error: codeOsaError("page JS failed") });
  assert.deepEqual(Object.keys(o), ["ok", "results", "error"]);
});

test("fill {fields}: a later page pass that errors keeps the fields that landed", async () => {
  const { world, dom } = onPage(CUSTOM, CUSTOM_JS);
  breakPassFrom(world, dom, 2);
  const { r, o } = await fill({ fields: [...TWO, { label_pattern: "last", text: "B" }] });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  halted(o, 3);
  assert.equal(o.results[1].selected, "Senior");
  assert.deepEqual(o.results[2], { ok: false, error: "fill: the page script failed on this page (Error); nothing verified" });
});

test("fill {fields}: an uncoded failure on the first field still throws", async () => {
  const { world } = onPage(CUSTOM, CUSTOM_JS);
  world.state.onExecute = () => { throw new Error("page JS failed"); };
  const { r, o } = await fill({ fields: TWO });
  assert.equal(r.isError, true);
  assert.equal(o, "error: page JS failed");
});

test("fill {fields}: the first page pass erroring is ok:false as a single call would be", async () => {
  const { world, dom } = onPage(CUSTOM, CUSTOM_JS);
  breakPassFrom(world, dom, 0);
  const { r, o } = await fill({ fields: TWO });
  assert.equal(r.isError, undefined);
  assert.deepEqual(o, { ok: false, error: "fill: the page script failed on this page (Error); nothing verified" });
});

test("fill {fields}: a halted batch keeps its skipped count and the failed pick", async () => {
  const { world, dom } = onPage(CUSTOM, NO_SHOW_JS);
  breakPassFrom(world, dom, 3);
  const { o } = await fill({ only_empty: true, fields: [{ label_pattern: "zzz", text: "Z" }, ...TWO, { label_pattern: "last", text: "B" }] });
  halted(o, 4);
  assert.equal(o.results[0].skipped, "absent");
  assert.equal(o.results[2].ok, false);
  assert.equal(o.results[2].pressed, "Senior");
  assert.equal(o.skipped, 1);
  assert.equal(o.unverified, undefined);
});

test("fill {fields}: an all-green batch carries no new keys", async () => {
  onPage(CUSTOM, CUSTOM_JS);
  const { o } = await fill({ fields: [...TWO, { label_pattern: "last", text: "B" }] });
  assert.deepEqual(Object.keys(o), ["ok", "results"]);
  assert.deepEqual(Object.keys(o.results[1]), ["kind", "ok", "selected", "el", "value"]);
  assert.equal(o.ok, true);
});

// ---- disabled controls: the form never submits them ----

const SOLD_OUT = `<label>Size <select id=s><option value="">Pick</option><option value=m disabled>M (sold out)</option><option value=l>L</option></select></label>`;

test("fill_fields option: a disabled option is refused and the select keeps its value", () => {
  const w = page(SOLD_OUT);
  const r = run(w, "fill_fields", { fields: [{ selector: "#s", option: "M (sold out)" }] }).results[0];
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /disabled/);
  assert.deepEqual(r.disabled, ["M (sold out)"]);
  assert.equal(val(w, "#s").value, "");
  const m = run(w, "fill_fields", { fields: [{ selector: "#s", option: "m" }] }).results[0];
  assert.equal(m.ok, false, JSON.stringify(m));
  assert.match(m.error, /disabled/);
  assert.equal(val(w, "#s").value, "");
});

test("fill_fields option: an enabled twin of a disabled option is picked", () => {
  const w = page(`<label>Size <select id=s><option value="">Pick</option><option value=m1 disabled>M</option><option value=m2>M</option></select></label>`);
  const r = run(w, "fill_fields", { fields: [{ selector: "#s", option: "M" }] }).results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(val(w, "#s").value, "m2");
});

test("fill_fields option: a disabled option never ties with an enabled one", () => {
  const w = page(`<label>Visa <select id=s><option value="">Pick</option><option value=1 disabled>Yes, sponsored</option><option value=2>Yes, citizen</option></select></label>`);
  const r = run(w, "fill_fields", { fields: [{ selector: "#s", option: "Yes" }] }).results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(val(w, "#s").value, "2");
});

test("fill_fields option: an option in a disabled optgroup is refused", () => {
  const w = page(`<label>Shift <select id=s><option value="">Pick</option><optgroup label=Night disabled><option value=n>Night</option></optgroup><option value=d>Day</option></select></label>`);
  const r = run(w, "fill_fields", { fields: [{ selector: "#s", option: "Night" }] }).results[0];
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.error, /disabled/);
  assert.equal(val(w, "#s").value, "");
});

test("fill_fields option: a disabled select or one in a disabled fieldset is refused", () => {
  const w = page(`<label>Size <select id=s disabled><option value="">Pick</option><option value=l>L</option></select></label>
    <fieldset disabled><label>Shift <select id=t><option value="">Pick</option><option value=d>Day</option></select></label></fieldset>`);
  for (const [sel, option] of [["#s", "L"], ["#t", "Day"]]) {
    const r = run(w, "fill_fields", { fields: [{ selector: sel, option }] }).results[0];
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /is disabled/);
    assert.equal(val(w, sel).value, "");
  }
});

test("fill: a disabled input is refused by selector and by label_pattern; the value stays empty", () => {
  const w = page(`<label>Email <input id=e disabled></label>`);
  for (const a of [{ selector: "#e" }, { label_pattern: "email" }]) {
    const r = run(w, "fill", { ...a, text: "ada@example.test" });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /is disabled/);
    assert.equal(val(w, "#e").value, "");
  }
});

test("fill: an input inside a disabled fieldset is refused", () => {
  const w = page(`<fieldset disabled><label>Email <input id=e></label></fieldset>`);
  for (const a of [{ selector: "#e" }, { label_pattern: "email" }]) {
    const r = run(w, "fill", { ...a, text: "ada@example.test" });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /is disabled/);
    assert.equal(val(w, "#e").value, "");
  }
});

test("fill: a disabled winner is refused rather than falling to a weaker enabled field", () => {
  const w = page(`<label>Email <input id=e disabled></label><div>Email updates <input id=f></div>`);
  const r = run(w, "fill", { label_pattern: "email", text: "ada@example.test" });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(val(w, "#e").value, "");
  assert.equal(val(w, "#f").value, "");
});

test("fill_fields only_empty: a disabled field is skipped as disabled and the batch goes on", () => {
  const w = page(`<label>Email <input id=e disabled></label><label>Name <input id=n></label>
    <label>Size <select id=s disabled><option value="">Pick</option><option value=l>L</option></select></label>`);
  const o = run(w, "fill_fields", { only: true, fields: [
    { label_pattern: "email", text: "ada@example.test" },
    { selector: "#e", text: "ada@example.test" },
    { selector: "#s", option: "L" },
    { label_pattern: "name", text: "Ada" },
  ] });
  assert.deepEqual(o.results.map((r) => [r.ok, r.skipped]), [[true, "disabled"], [true, "disabled"], [true, "disabled"], [true, undefined]]);
  assert.equal(val(w, "#e").value, "");
  assert.equal(val(w, "#s").value, "");
  assert.equal(val(w, "#n").value, "Ada");
});

// ---- a field a later field's handler cleared or changed ----

const DEPENDENT = `<label>State <input id=st></label>
  <label>Country <select id=co><option value="">Select...</option><option value=ar>Argentina</option><option value=cl>Chile</option></select></label>`;
const CLEARS_ST = `document.getElementById('co').addEventListener('change', () => { document.getElementById('st').value = ''; });`;

test("fill_fields: a state a later country change clears comes back ok:false", () => {
  const w = page(DEPENDENT);
  runBody(w, CLEARS_ST + " return 1");
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "country", option: "Argentina" }] });
  assert.deepEqual(o.results.map((r) => r.ok), [true, true]);
  assert.deepEqual(Object.keys(o.recheck), ["0"]);
  assert.deepEqual(o.recheck[0], { ok: false, kind: "plain", el: `textbox "State"`, kept: "", error: `textbox "State" was cleared after a later field changed; fill it again` });
});

test("fill {fields}: the cleared state fails the batch and the country stays ok", async () => {
  onPage(DEPENDENT, CLEARS_ST);
  const { o } = await fill({ fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "country", option: "Argentina" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results.length, 2);
  assert.equal(o.results[0].ok, false);
  assert.match(o.results[0].error, /cleared after a later field changed/);
  assert.equal(o.results[1].ok, true);
  assert.equal(o.results[1].selected, "Argentina");
  assert.equal(o.recheck, undefined);
});

test("fill {fields}: order-independent fields stay ok and nothing extra leaks into the result", async () => {
  onPage(FORM);
  const { o } = await fill({ fields: [FIVE[0], FIVE[1], FIVE[4]] });
  assert.deepEqual(o, { ok: true, results: [
    { ok: true, kind: "plain", el: `textbox "Name"`, len: 12 },
    { ok: true, kind: "plain", el: `textbox "Email"`, len: 16 },
    { ok: true, kind: "check", el: `checkbox "I agree"`, checked: true },
  ], form: { requiredEmpty: 0 } });
});

test("fill_fields: a masked phone the page reformats after landing stays ok", () => {
  const w = page(`<label>Phone <input id=ph></label><label>Name <input id=n></label>`);
  runBody(w, `document.getElementById('n').addEventListener('change', () => {
    const p = document.getElementById('ph'), d = p.value.replace(/\\D/g, '');
    p.value = '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6); }); return 1`);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "phone", text: "5551234567" }, { label_pattern: "name", text: "Ada" }] });
  assert.equal(val(w, "#ph").value, "(555) 123-4567");
  assert.deepEqual(o.results.map((r) => r.ok), [true, true]);
  assert.equal(o.recheck, undefined);
});

test("fill_fields: a later field that unchecks an earlier checkbox flags it", () => {
  const w = page(`<label><input type=checkbox id=c> Ship to billing</label><label>Address <input id=a></label>`);
  runBody(w, `document.getElementById('a').addEventListener('change', () => { document.getElementById('c').checked = false; }); return 1`);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "ship", checked: true }, { label_pattern: "address", text: "1 Main St" }] });
  assert.equal(o.recheck[0].ok, false);
  assert.equal(o.recheck[0].kind, "check");
  assert.equal(o.recheck[0].checked, false);
  assert.match(o.recheck[0].error, /^checkbox "Ship to billing" was cleared after a later field changed/);
});

test("fill_fields: a value a later field reformats but still holds the text stays ok", () => {
  const w = page(`<label>City <input id=ci></label><label>Zip <input id=z></label>`);
  runBody(w, `document.getElementById('z').addEventListener('change', () => { const c = document.getElementById('ci'); c.value = c.value + ', AR'; }); return 1`);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "city", text: "Cordoba" }, { label_pattern: "zip", text: "5000" }] });
  assert.equal(val(w, "#ci").value, "Cordoba, AR");
  assert.equal(o.recheck, undefined);
});

test("fill_fields: a value a later field replaces with another is reported as changed", () => {
  const w = page(`<label>City <input id=ci></label><label>Zip <input id=z></label>`);
  runBody(w, `document.getElementById('z').addEventListener('change', () => { document.getElementById('ci').value = 'Rosario'; }); return 1`);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "city", text: "Cordoba" }, { label_pattern: "zip", text: "5000" }] });
  assert.equal(o.recheck[0].kept, "Rosario");
  assert.match(o.recheck[0].error, /^textbox "City" changed to "Rosario" after a later field changed; fill it again$/);
});

test("fill_fields: a field filled twice in one batch is checked against its last value", () => {
  const w = page(`<label>City <input id=ci></label>`);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "city", text: "Cordoba" }, { selector: "#ci", text: "Rosario" }] });
  assert.equal(o.recheck, undefined);
});

test("fill_fields: a select and a radio a later field resets are flagged; a removed field too", () => {
  const w = page(`<label>Size <select id=s><option value="">Select...</option><option>S</option><option>L</option></select></label>
    <fieldset><legend>Plan</legend><label><input type=radio name=p id=p1> Monthly</label><label><input type=radio name=p id=p2> Yearly</label></fieldset>
    <div id=box><label>Note <input id=no></label></div><label>Code <input id=cd></label>`);
  runBody(w, `document.getElementById('cd').addEventListener('change', () => {
    document.getElementById('s').selectedIndex = 2; document.getElementById('p1').checked = false; document.getElementById('box').innerHTML = ''; }); return 1`);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "size", option: "S" }, { label_pattern: "plan", option: "Monthly" }, { label_pattern: "note", text: "hi there" }, { label_pattern: "code", text: "X1" }] });
  assert.deepEqual(o.results.map((r) => r.ok), [true, true, true, true]);
  assert.deepEqual(Object.keys(o.recheck), ["0", "1", "2"]);
  assert.match(o.recheck[0].error, /^combobox "Size" changed to "L" after a later field changed/);
  assert.equal(o.recheck[1].kind, "radio");
  assert.match(o.recheck[1].error, /^radiogroup "Plan" was cleared after a later field changed/);
  assert.match(o.recheck[2].error, /^textbox "Note" was removed after a later field changed/);
});

const REPLACED = `<form><label>State <input id=st name=state></label><label>Code <input id=cd></label></form>`;
const replaceSt = (value) => `document.getElementById('cd').addEventListener('change', () => {
  const old = document.getElementById('st'), n = document.createElement('input');
  n.id = 'st'; n.name = 'state'; n.value = ${JSON.stringify(value)}; old.replaceWith(n); }); return 1`;
const ST_FIELDS = [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "code", text: "X1" }];

test("fill_fields: a re-rendered field that still holds the value stays ok", () => {
  const w = page(REPLACED);
  runBody(w, replaceSt("Cordoba"));
  const o = run(w, "fill_fields", { fields: ST_FIELDS });
  assert.deepEqual(o.results.map((r) => r.ok), [true, true]);
  assert.equal(o.recheck, undefined, JSON.stringify(o.recheck));
});

test("fill_fields: a re-rendered field that came back empty is flagged cleared", () => {
  const w = page(REPLACED);
  runBody(w, replaceSt(""));
  const o = run(w, "fill_fields", { fields: ST_FIELDS });
  assert.deepEqual(Object.keys(o.recheck), ["0"]);
  assert.match(o.recheck[0].error, /^textbox "State" was cleared after a later field changed; fill it again$/);
});

test("fill_fields: a re-rendered field found by name alone, or by its label, is rechecked", () => {
  const w = page(`<form><label>State <input name=state class=a></label><label>Code <input id=cd></label></form>
    <form><label>Zip <input class=z></label><label>More <input id=mo></label></form>`);
  runBody(w, `document.getElementById('cd').addEventListener('change', () => {
    const old = document.querySelector('.a'), n = document.createElement('input'); n.name = 'state'; n.value = 'Cordoba'; old.replaceWith(n); });
    document.getElementById('mo').addEventListener('change', () => {
    const old = document.querySelector('.z'), n = document.createElement('input'); n.value = ''; old.replaceWith(n); }); return 1`);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "code", text: "X1" }, { label_pattern: "zip", text: "5000" }, { label_pattern: "more", text: "y" }] });
  assert.deepEqual(Object.keys(o.recheck || {}), ["2"], JSON.stringify(o.recheck));
  assert.match(o.recheck[2].error, /^textbox "Zip" was cleared after a later field changed/);
});

test("fill_fields: a re-rendered radio group and checkbox are rechecked on their replacements", () => {
  const w = page(`<form><div id=g><fieldset><legend>Plan</legend><label><input type=radio name=p value=m> Monthly</label><label><input type=radio name=p value=y> Yearly</label></fieldset>
    <label><input type=checkbox name=t value=a> Alpha</label><label><input type=checkbox name=t value=b> Beta</label></div><label>Code <input id=cd></label></form>`);
  runBody(w, `document.getElementById('cd').addEventListener('change', () => { const g = document.getElementById('g');
    const keep = Array.from(g.querySelectorAll('input')).map((i) => i.checked); g.innerHTML = g.innerHTML;
    g.querySelectorAll('input').forEach((i, n) => { i.checked = n === 0 ? keep[0] : false; }); }); return 1`);
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "plan", option: "Monthly" }, { label_pattern: "beta", checked: true }, { label_pattern: "code", text: "X1" }] });
  assert.deepEqual(o.results.map((r) => r.ok), [true, true, true], JSON.stringify(o.results));
  assert.deepEqual(Object.keys(o.recheck || {}), ["1"], JSON.stringify(o.recheck));
  assert.match(o.recheck[1].error, /^checkbox "Beta" was cleared after a later field changed/);
});

test("fill_fields: a field removed with no replacement is reported removed", () => {
  const w = page(REPLACED);
  runBody(w, `document.getElementById('cd').addEventListener('change', () => { document.getElementById('st').closest('label').remove(); }); return 1`);
  const o = run(w, "fill_fields", { fields: ST_FIELDS });
  assert.match(o.recheck[0].error, /^textbox "State" was removed after a later field changed; fill it again$/);
});

test("fill_fields: only_empty skips are never rechecked", () => {
  const w = page(`<label>State <input id=st value=Salta></label><label>Country <select id=co><option value="">Select...</option><option>Chile</option></select></label>`);
  runBody(w, CLEARS_ST + " return 1");
  const o = run(w, "fill_fields", { only: true, fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "country", option: "Chile" }] });
  assert.equal(o.results[0].skipped, "has value");
  assert.equal(val(w, "#st").value, "");
  assert.equal(o.recheck, undefined);
});

test("fill_fields: a later pass on a page without this batch's record writes nothing", () => {
  const w = page(DEPENDENT);
  runBody(w, CLEARS_ST + " return 1");
  run(w, "fill_fields", { fields: [{ label_pattern: "state", text: "Cordoba" }] });
  const fields = [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "country", option: "Argentina" }];
  assert.deepEqual(run(w, "fill_fields", { from: 1, fields }), { gone: true, results: [] });
  assert.equal(val(w, "#st").value, "Cordoba");
  assert.equal(val(w, "#co").value, "");
  runBody(w, "document.getElementById('st').value = ''; return 1");
  assert.deepEqual(run(w, "fill_fields", { from: 2, fields }), { gone: true, results: [] });
});

// The combobox pick clears State, as a country widget clears its dependents.
const CUSTOM_CLEARS = CUSTOM.replace("<input aria-label=First>", "<label>State <input id=st></label>") + `<label>City <input id=ci></label>`;
const CUSTOM_CLEARS_JS = CUSTOM_JS.replace("cb.querySelector('.v').textContent = o.textContent;", "cb.querySelector('.v').textContent = o.textContent; document.getElementById('st').value = '';");
const passes = (world) => {
  const sent = [], d = { run: (s) => { if (s.includes("PLACEHOLDERISH")) sent.push(s); return world.daemon.run(s); } };
  DAEMONS.fast = d; DAEMONS.slow = d;
  return sent;
};

test("fill {fields}: a combobox pick that clears an earlier field is caught by the final pass", async () => {
  const { world } = onPage(CUSTOM_CLEARS, CUSTOM_CLEARS_JS);
  const sent = passes(world);
  const { o } = await fill({ fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "level", option: "senior" }, { label_pattern: "city", text: "Rio" }] });
  assert.equal(sent.length, 2);
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.results.map((x) => [x.kind, x.ok]), [["plain", false], ["select", true], ["plain", true]]);
  assert.match(o.results[0].error, /cleared after a later field changed/);
});

test("fill {fields}: a batch ending on the combobox costs one extra pass, which flags State", async () => {
  const { world } = onPage(CUSTOM_CLEARS, CUSTOM_CLEARS_JS);
  const sent = passes(world);
  const { o } = await fill({ fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "level", option: "senior" }] });
  assert.equal(sent.length, 2);
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results.length, 2);
  assert.match(o.results[0].error, /cleared after a later field changed/);
  assert.equal(o.results[1].ok, true);
});

test("fill {fields}: a batch of only the combobox has nothing to recheck and no extra pass", async () => {
  const { world } = onPage(CUSTOM_CLEARS, CUSTOM_CLEARS_JS);
  const sent = passes(world);
  const { o } = await fill({ fields: [{ label_pattern: "level", option: "senior" }] });
  assert.equal(sent.length, 1);
  assert.equal(o.ok, true, JSON.stringify(o));
});

// The first pass carries no per-call nonce, so a repeated batch is the same
// source and the browser reuses its compiled script.
test("fill {fields}: the same batch twice sends the same page script", async () => {
  const { world } = onPage(FORM);
  const sent = passes(world);
  await fill({ fields: FIVE });
  await fill({ fields: FIVE });
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
});

// A pick that starts a navigation: the page fires pagehide but its document
// still answers, at the same URL, until the new one commits. The next pass
// writes nothing into the leaving document.
test("fill {fields}: a pass after the page fired pagehide writes nothing and reports the page changed", async () => {
  const { dom } = onPage(CUSTOM_CLEARS, CUSTOM_JS);
  dom.document.getElementById("menu").addEventListener("click", () => { dom.dispatchEvent(new dom.Event("pagehide")); });
  const { o } = await fill({ fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "level", option: "senior" }, { label_pattern: "city", text: "Rio" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(val(dom, "#ci").value, "", "nothing is written after pagehide");
  assert.deepEqual(o.results.map((x) => x.ok), [true, true, false]);
  assert.equal(o.results[0].unverified, true);
  assert.equal(o.results[2].error, "the page changed after fields[1]; not filled");
  assert.equal(o.warning, "the page changed after fields[1]; earlier fields may have been cleared, check them");
});

test("fill {fields}: a batch ending on the pick that fired pagehide flags the earlier fields instead of re-reading them", async () => {
  const { dom } = onPage(CUSTOM_CLEARS, CUSTOM_JS);
  dom.document.getElementById("menu").addEventListener("click", () => { dom.dispatchEvent(new dom.Event("pagehide")); });
  const { o } = await fill({ fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "level", option: "senior" }] });
  assert.deepEqual(o.results.map((x) => [x.ok, x.unverified]), [[true, true], [true, undefined]]);
  assert.equal(o.warning, "the page changed after fields[1]; earlier fields may have been cleared, check them");
});

test("fill {fields}: a page that navigated before the extra pass is not failed, but its earlier fields are flagged", async () => {
  const { world, dom } = onPage(CUSTOM_CLEARS, CUSTOM_CLEARS_JS);
  const sent = passes(world);
  dom.document.getElementById("menu").addEventListener("click", () => { delete dom.__perch_ff; });
  const { o } = await fill({ fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "level", option: "senior" }] });
  assert.equal(sent.length, 2);
  assert.deepEqual(o.results.map((x) => [x.ok, x.unverified]), [[true, true], [true, undefined]]);
  assert.equal(o.ok, true);
  assert.equal(o.warning, "the page changed after fields[1]; earlier fields may have been cleared, check them");
  assert.equal(o.unverified, 1);
});

test("fill {fields}: a closing combobox that reloads the page flags every field before it", async () => {
  const html = `<label>Name <input id=nm></label><label>Email <input id=em></label>` + CUSTOM;
  const { world, dom } = onPage(html, CUSTOM_JS);
  passes(world);
  dom.document.getElementById("menu").addEventListener("click", () => { delete dom.__perch_ff; });
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }, { label_pattern: "email", text: "ada@example.test" }, { label_pattern: "level", option: "senior" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.results.map((x) => [x.ok, x.unverified]), [[true, true], [true, true], [true, undefined]]);
  assert.equal(o.unverified, 2);
  assert.equal(o.warning, "the page changed after fields[2]; earlier fields may have been cleared, check them");
});

// The reload also drops the select state the readback reads: the pick was
// pressed but never seen to land, a coded ok:false naming the press.
const reloadsOnPick = (dom) => dom.document.getElementById("menu").addEventListener("click", () => { delete dom.__perch_select; delete dom.__perch_ff; });

test("fill {fields}: a combobox whose pick drops the page's state is ok:false, naming the press", async () => {
  const html = `<label>Name <input id=nm></label><label>Email <input id=em></label>` + CUSTOM;
  const { world, dom } = onPage(html, CUSTOM_JS);
  passes(world);
  reloadsOnPick(dom);
  const { r, o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }, { label_pattern: "email", text: "ada@example.test" }, { label_pattern: "level", option: "senior" }] });
  assert.equal(r.isError, undefined);
  assert.equal(o.ok, false, JSON.stringify(o));
  const c = o.results[2];
  assert.equal(c.ok, false);
  assert.equal(c.kind, "select");
  assert.match(c.error, /^the page changed/);
  assert.equal(c.pressed, "Senior");
  assert.equal(Object.hasOwn(c, "__perch_error"), false);
  assert.deepEqual(o.results.slice(0, 2).map((x) => [x.ok, x.unverified]), [[true, true], [true, true]]);
});

test("fill {fields}: a preference list never takes a dropped page state as a pick", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS);
  reloadsOnPick(dom);
  const { o } = await fill({ fields: [{ label_pattern: "first", text: "A" }, { label_pattern: "level", option: ["nope", "senior"] }] });
  assert.equal(o.results[1].ok, false, JSON.stringify(o));
  assert.equal(Object.hasOwn(o.results[1], "pref"), false);
  assert.match(o.results[1].error, /^the page changed/);
});

test("select: a pick that drops the page's state replies ok:false, with no raw page error", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS);
  reloadsOnPick(dom);
  const r = await handleCall("select", { label_pattern: "level", text: "senior" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.doesNotMatch(r.content[0].text, /__perch_error/);
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.ok, false);
  assert.equal(o.pressed, "Senior");
});

// A pick phase that throws stops the loop: no trusted click on an option it may
// never have found, and no readback of a pick that never happened.
test("select {trusted}: a pick that throws ends at once as a coded ok:false", async () => {
  const { world, dom } = onPage(CUSTOM, CUSTOM_JS);
  const ev = dom.eval.bind(dom), after = [];
  let threw = false;
  dom.eval = (js) => {
    if (threw) after.push(js);
    if (js.includes("s.polls++")) { threw = true; return ev(js.replace("s.polls++;", "throw new TypeError('boom');")); }
    return ev(js);
  };
  const r = await handleCall("select", { label_pattern: "level", text: "senior", trusted: true });
  assert.equal(threw, true);
  assert.equal(after.length, 0, after.map((s) => s.slice(-300)).join("\n---\n"));
  assert.doesNotMatch(r.content[0].text, /__perch_error/);
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.ok, false);
  assert.equal(o.kind, "select");
  assert.equal(o.error, "select: the page script failed on this page (TypeError); nothing verified");
});


test("select: a pick or read that throws is ok:false with the error name only", async () => {
  for (const marker of ["s.polls++;", `if (!s) return { ok: false, error: "the page changed after the pick was pressed; not verified" };`]) {
    const { dom } = onPage(CUSTOM, CUSTOM_JS);
    const threw = throwAt(dom, marker);
    const r = await handleCall("select", { label_pattern: "level", text: "senior" });
    assert.ok(threw() > 0, marker);
    assert.equal(r.isError, undefined, r.content[0].text);
    const o = JSON.parse(r.content[0].text);
    assert.equal(o.ok, false);
    assert.equal(o.kind, "select");
    assert.match(o.error, /\(TypeError\)/);
    assert.doesNotMatch(o.error, /page changed/);
    noRaw(o);
  }
});

const FF_PASS = `const href = location.href.split("#")[0];`;

test("fill {fields}: a first page pass that throws is ok:false with the error name only", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS);
  throwAt(dom, FF_PASS);
  const { r, o } = await fill({ fields: TWO });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.ok, false);
  assert.match(o.error, /^fill: .*\(TypeError\)/);
  noRaw(o);
});

test("fill {fields}: a later page pass that throws halts with the error name only", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS);
  throwAt(dom, FF_PASS, (n) => n === 2);
  const { r, o } = await fill({ fields: [...TWO, { label_pattern: "last", text: "B" }] });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  halted(o, 3);
  assert.match(o.error, /\(TypeError\)/);
  noRaw(o);
});

// Every pass is built from the batch alone, so a repeated batch sends the same
// scripts, later and re-read passes included, and the browser reuses them.
test("fill {fields}: every pass of a repeated batch is the same page script", async () => {
  const fields = [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "level", option: "senior" }, { label_pattern: "city", text: "Rio" }, { label_pattern: "level", option: "junior" }];
  const calls = [];
  for (let k = 0; k < 2; k++) {
    const { world } = onPage(CUSTOM_CLEARS, CUSTOM_CLEARS_JS);
    const sent = passes(world);
    await fill({ fields });
    calls.push(sent);
  }
  assert.equal(calls[0].length, 3);
  assert.deepEqual(calls[1], calls[0]);
  for (const s of calls[0]) assert.doesNotMatch(s, /\\?"run\\?"/);
});

// The combobox pick swaps the document: the record is gone and so is the form
// the rest of the batch was meant for.
test("fill {fields}: a pick that loads another page stops the batch before the next field", async () => {
  const { world, dom } = onPage(CUSTOM_CLEARS, CUSTOM_CLEARS_JS);
  const sent = passes(world);
  dom.document.getElementById("menu").addEventListener("click", () => {
    delete dom.__perch_ff;
    dom.document.body.innerHTML = CUSTOM_CLEARS.replace("Choose", "Senior");
  });
  const { o } = await fill({ fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "level", option: "senior" }, { label_pattern: "city", text: "Rio" }] });
  assert.equal(sent.length, 2);
  assert.equal(dom.document.getElementById("ci").value, "");
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results.length, 3);
  assert.deepEqual(o.results[2], { ok: false, error: "the page changed after fields[1]; not filled" });
  assert.equal(o.results[0].unverified, true);
  assert.equal(o.unverified, 1);
  assert.equal(o.warning, "the page changed after fields[1]; earlier fields may have been cleared, check them");
});

// A step form of an SPA: the City pick also runs a step script, which may push
// a route, swap the form or both.
const STEP_FORM = `<main><form><label>Name <input id=nm></label><label id=lab>City</label><div class="select__control"><div role=combobox aria-labelledby=lab aria-expanded=false tabindex=0><span class=v>Choose</span></div></div><div id=menu></div><label>Email <input id=em></label></form></main>`;
const STEP_JS = (step) => CUSTOM_JS.replace("Junior</div><div role=option>Senior", "Lima</div><div role=option>Rio")
  .replace("cb.querySelector('.v').textContent = o.textContent;", "cb.querySelector('.v').textContent = o.textContent; " + step);
const NEXT_STEP = "document.querySelector('main').innerHTML = '<form><label>Friend email <input id=fe></label></form>';";
const STEP_FIELDS = [{ label_pattern: "name", text: "Ada" }, { label_pattern: "city", option: "rio" }, { label_pattern: "email", text: "a@x.io" }];
const stoppedAtCity = (o) => {
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results.length, 3);
  assert.deepEqual(o.results[2], { ok: false, error: "the page changed after fields[1]; not filled" });
  assert.equal(o.results[0].unverified, true);
  assert.equal(o.warning, "the page changed after fields[1]; earlier fields may have been cleared, check them");
};

test("fill {fields}: a pick that routes an SPA to its next step stops the batch there", async () => {
  const { world, dom } = onPage(STEP_FORM, STEP_JS("history.pushState({}, '', '/step2'); " + NEXT_STEP));
  passes(world);
  const { o } = await fill({ fields: STEP_FIELDS });
  stoppedAtCity(o);
  assert.equal(dom.document.getElementById("fe").value, "");
});

test("fill {fields}: a pick that only pushes a route stops the batch, the form kept", async () => {
  const { world, dom } = onPage(STEP_FORM, STEP_JS("history.pushState({}, '', '/step2');"));
  passes(world);
  const { o } = await fill({ fields: STEP_FIELDS });
  stoppedAtCity(o);
  assert.equal(dom.document.getElementById("em").value, "");
});

test("fill {fields}: a pick that swaps in another form without a route stops the batch", async () => {
  const { world, dom } = onPage(STEP_FORM, STEP_JS(NEXT_STEP));
  passes(world);
  const { o } = await fill({ fields: STEP_FIELDS });
  stoppedAtCity(o);
  assert.equal(dom.document.getElementById("fe").value, "");
});

test("fill {fields}: a pick that changes only the hash keeps filling", async () => {
  const { world, dom } = onPage(STEP_FORM, STEP_JS("location.hash = '#step';"));
  passes(world);
  const { o } = await fill({ fields: STEP_FIELDS });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.warning, undefined);
  assert.equal(dom.document.getElementById("em").value, "a@x.io");
});

test("fill {fields}: a pick that re-renders the same form keeps filling it", async () => {
  const RERENDER = "const f = document.querySelector('form'), c = f.cloneNode(true); c.querySelector('#nm').value = f.querySelector('#nm').value; f.replaceWith(c);";
  const { world, dom } = onPage(STEP_FORM, STEP_JS(RERENDER));
  passes(world);
  const { o } = await fill({ fields: STEP_FIELDS });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.warning, undefined);
  assert.equal(dom.document.getElementById("em").value, "a@x.io");
  assert.equal(dom.document.getElementById("nm").value, "Ada");
});

// A single-page wizard: both steps are in the document from the start, and the
// City pick hides step 1 and shows step 2, whose "Friend email" also matches
// "email". Hidden fields keep their values, so only visibility tells.
const HIDE_FORM = `<main><form><section id=s1><label>Name <input id=nm></label><label id=lab>City</label><div class="select__control"><div role=combobox aria-labelledby=lab aria-expanded=false tabindex=0><span class=v>Choose</span></div></div><div id=menu></div><label>Email <input id=em></label></section><section id=s2 hidden><label>Friend email <input id=fe></label></section></form></main>`;
const HIDE_S1 = "document.getElementById('s1').style.display = 'none'; document.getElementById('s2').hidden = false;";

test("fill {fields}: a pick that hides the step (display:none) stops the batch", async () => {
  const { world, dom } = onPage(HIDE_FORM, STEP_JS(HIDE_S1));
  const sent = passes(world);
  const { o } = await fill({ fields: STEP_FIELDS });
  stoppedAtCity(o);
  assert.equal(sent.length, 2);
  assert.equal(dom.document.getElementById("fe").value, "");
  assert.equal(dom.document.getElementById("em").value, "");
});

test("fill {fields}: a pick that hides the step ([hidden]) stops the batch", async () => {
  const { world, dom } = onPage(HIDE_FORM, STEP_JS("document.getElementById('s1').hidden = true; document.getElementById('s2').hidden = false;"));
  passes(world);
  const { o } = await fill({ fields: STEP_FIELDS });
  stoppedAtCity(o);
  assert.equal(dom.document.getElementById("fe").value, "");
  assert.equal(dom.document.getElementById("em").value, "");
});

test("fill {fields}: a first-field pick that hides the step stops the batch, nothing unverified", async () => {
  const { world, dom } = onPage(HIDE_FORM, STEP_JS(HIDE_S1));
  passes(world);
  const { o } = await fill({ fields: [{ label_pattern: "city", option: "rio" }, { label_pattern: "email", text: "a@x.io" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results[0].ok, true);
  assert.deepEqual(o.results[1], { ok: false, error: "the page changed after fields[0]; not filled" });
  assert.equal(o.unverified, undefined);
  assert.ok(o.results.every((x) => !x.unverified));
  assert.equal(dom.document.getElementById("fe").value, "");
});

test("fill {fields}: a pick that only reveals more fields keeps filling", async () => {
  const { world, dom } = onPage(HIDE_FORM, STEP_JS("document.getElementById('s2').hidden = false;"));
  passes(world);
  const { o } = await fill({ fields: STEP_FIELDS });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.warning, undefined);
  assert.equal(dom.document.getElementById("em").value, "a@x.io");
});

test("fill {fields}: a pick whose control collapses into a chip keeps filling", async () => {
  const CHIP = HIDE_FORM.replace('<div class="select__control">', '<div id=cw><input aria-label=Search><div class="select__control">').replace("</div></div><div id=menu>", "</div></div></div><span id=chip></span><div id=menu>");
  const { world, dom } = onPage(CHIP, STEP_JS("document.getElementById('cw').style.display = 'none'; document.getElementById('chip').textContent = o.textContent;"));
  passes(world);
  const { o } = await fill({ fields: [{ label_pattern: "city", option: "rio" }, { label_pattern: "^email", text: "a@x.io" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.warning, undefined);
  assert.equal(dom.document.getElementById("em").value, "a@x.io");
});

test("fill {fields}: a batch that ends on a pick advancing the step is ok", async () => {
  const { world, dom } = onPage(HIDE_FORM, STEP_JS(HIDE_S1));
  passes(world);
  const { o } = await fill({ fields: STEP_FIELDS.slice(0, 2) });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.warning, undefined);
  assert.equal(o.unverified, undefined);
  assert.equal(dom.document.getElementById("nm").value, "Ada");
});

const NATIVE_STEP = `<form><section id=s1><label>Name <input id=nm></label><label>Kind <select id=kind onchange="document.getElementById('s1').hidden = true; document.getElementById('s2').hidden = false;"><option value="">Pick</option><option>Person</option><option>Company</option></select></label></section><section id=s2 hidden><label>Email <input id=em></label></section></form>`;

test("fill {fields}: a native select that hides the step stops the pass after it", async () => {
  const { dom } = onPage(NATIVE_STEP);
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }, { label_pattern: "kind", option: "Company" }, { label_pattern: "email", text: "a@x.io" }] });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.results[1].ok, true);
  assert.equal(o.results[0].unverified, true);
  assert.equal(o.results[2].error, "the page changed after fields[1]; not filled");
  assert.equal(o.warning, "the page changed after fields[1]; earlier fields may have been cleared, check them");
  assert.equal(dom.document.getElementById("em").value, "");
});

test("fill {fields}: a radio that only reveals a step keeps filling", async () => {
  const { dom } = onPage(`<form><section id=s1><label>Name <input id=nm></label><fieldset><legend>Kind</legend><label><input type=radio name=k value=p onchange="document.getElementById('s2').hidden = false;"> Person</label><label><input type=radio name=k value=c onchange="document.getElementById('s2').hidden = false;"> Company</label></fieldset></section><section id=s2 hidden><label>Email <input id=em></label></section></form>`);
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }, { label_pattern: "kind", option: "Company" }, { label_pattern: "email", text: "a@x.io" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(dom.document.getElementById("em").value, "a@x.io");
});

test("fill {fields}: a checkbox that hides one lone optional field keeps filling", async () => {
  const { dom } = onPage(`<form><label>Name <input id=nm></label><label><input type=checkbox id=same onchange="document.getElementById('opt').hidden = this.checked;"> Same billing address</label><div id=opt><label>Billing <input id=bi></label></div><label>Email <input id=em></label></form>`);
  const { o } = await fill({ fields: [{ label_pattern: "billing", text: "Main St" }, { label_pattern: "same", checked: true }, { label_pattern: "email", text: "a@x.io" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(dom.document.getElementById("em").value, "a@x.io");
});

test("fill {fields}: every pass of a repeated hide-step batch is the same page script", async () => {
  const calls = [];
  for (let k = 0; k < 2; k++) {
    const { world } = onPage(HIDE_FORM, STEP_JS(HIDE_S1));
    const sent = passes(world);
    await fill({ fields: STEP_FIELDS });
    calls.push(sent);
  }
  assert.equal(calls[0].length, 2);
  assert.deepEqual(calls[1], calls[0]);
});

const failSecondPass = (world, fail) => {
  let n = 0;
  const d = { run: (s) => (s.includes("PLACEHOLDERISH") && ++n === 2 ? fail(s) : world.daemon.run(s)) };
  DAEMONS.fast = d; DAEMONS.slow = d;
};

test("fill {fields}: a final re-read that fails leaves the landed fields unverified, with a warning", async () => {
  const { world } = onPage(CUSTOM, CUSTOM_JS);
  failSecondPass(world, async () => { throw new Error("timeout: fake hang"); });
  const { o } = await fill({ fields: [{ label_pattern: "first", text: "A" }, { label_pattern: "level", option: "senior" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.warning, "the final re-read did not run (timeout); earlier fields are unverified");
  assert.equal(o.unverified, 1);
  assert.equal(o.results[0].unverified, true);
  assert.equal(o.results[1].unverified, undefined);
});

test("fill {fields}: a final re-read the page throws in leaves the fields unverified, with a warning", async () => {
  const { world, dom } = onPage(CUSTOM_CLEARS, CUSTOM_CLEARS_JS);
  passes(world);
  dom.document.getElementById("menu").addEventListener("click", () => {
    Object.defineProperty(dom.__perch_ff, "items", { get() { throw new Error("boom"); } });
  });
  const { o } = await fill({ fields: [{ label_pattern: "state", text: "Cordoba" }, { label_pattern: "level", option: "senior" }] });
  assert.equal(o.warning, "the final re-read did not run (page error); earlier fields are unverified", JSON.stringify(o));
  assert.equal(o.unverified, 1);
  assert.equal(o.results[0].ok, true);
});

// ---- what the form still wants, from the final pass ----

const REQ3 = `<form><label>Name <input name=nm required></label><label>Email <input name=em required></label><label>Phone <input name=ph required></label></form>`;

test("fill {fields}: the result names the required field the batch left empty", async () => {
  onPage(REQ3);
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }, { label_pattern: "email", text: "a@x.io" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.form, { requiredEmpty: 1, left: [{ name: "ph", label: "Phone" }] });
});

test("fill {fields}: a filled form reads requiredEmpty 0 with nothing left", async () => {
  onPage(REQ3);
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }, { label_pattern: "email", text: "a@x.io" }, { label_pattern: "phone", text: "1" }] });
  assert.deepEqual(o.form, { requiredEmpty: 0 });
});

test("fill {fields}: a typeahead left typed but unpicked counts as unpicked and required-empty", async () => {
  const { dom } = onPage(`<form><label>Name <input name=nm required></label><div class=loc><label for=li>Location</label>
    <input id=li name=loc required><input type=hidden name=selectedLocation required><div class=dropdown-results></div></div></form>`);
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value").set.call(dom.document.getElementById("li"), "Buenos");
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.form, { requiredEmpty: 1, unpicked: 1, left: [{ name: "loc", label: "Location" }] });
});

test("fill {fields}: a required select left on its placeholder is named in left", async () => {
  onPage(`<form><label>Name <input name=nm required></label>
    <label>Gender <select name=g required><option value="0">Select...</option><option value="f">Female</option></select></label></form>`);
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.form, { requiredEmpty: 1, left: [{ name: "g", label: "Gender" }] });
});

test("fill {fields}: a batch the page changed under carries no form census", async () => {
  const { world } = onPage(HIDE_FORM.replace("<input id=fe>", "<input id=fe required>"), STEP_JS(HIDE_S1));
  passes(world);
  const { o } = await fill({ fields: STEP_FIELDS });
  stoppedAtCity(o);
  assert.equal("form" in o, false);
});

test("fill {fields}: a field in another form on the page is not counted", async () => {
  onPage(REQ3 + `<form><label>Search site <input name=q2 required></label><label>Coupon <input name=cp required></label></form>`);
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }, { label_pattern: "email", text: "a@x.io" }] });
  assert.deepEqual(o.form, { requiredEmpty: 1, left: [{ name: "ph", label: "Phone" }] });
});

test("fill {fields}: left names at most 10 fields; requiredEmpty counts them all", async () => {
  let h = "<form><label>Name <input name=nm required></label>";
  for (let i = 1; i <= 15; i++) h += `<label>Q${i} <input name=q${i} required></label>`;
  onPage(h + "</form>");
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }] });
  assert.equal(o.form.requiredEmpty, 15);
  assert.equal(o.form.left.length, 10);
  assert.deepEqual(o.form.left[0], { name: "q1", label: "Q1" });
  assert.deepEqual(o.form.left[9], { name: "q10", label: "Q10" });
});

test("fill {fields}: a batch ending on a combobox takes the census from the re-read", async () => {
  const REQ_CUSTOM = "<form>" + CUSTOM.replace("<input aria-label=Last>", "<input aria-label=Last name=last required>") + "</form>";
  const { world } = onPage(REQ_CUSTOM, CUSTOM_JS);
  const sent = passes(world);
  const { o } = await fill({ fields: [{ label_pattern: "first", text: "A" }, { label_pattern: "level", option: "senior" }] });
  assert.equal(sent.length, 2);
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.form, { requiredEmpty: 1, left: [{ name: "last", label: "Last" }] });
});

test("fill {fields}: a final re-read that fails carries no form census", async () => {
  const { world } = onPage("<form>" + CUSTOM.replace("<input aria-label=Last>", "<input aria-label=Last required>") + "</form>", CUSTOM_JS);
  failSecondPass(world, async () => { throw new Error("timeout: fake hang"); });
  const { o } = await fill({ fields: [{ label_pattern: "first", text: "A" }, { label_pattern: "level", option: "senior" }] });
  assert.match(o.warning, /final re-read did not run/);
  assert.equal("form" in o, false);
});

test("fill {fields}: fields outside any form carry no form census", async () => {
  onPage(`<label>Name <input name=nm required></label><label>Phone <input name=ph required></label>`);
  const { o } = await fill({ fields: [{ label_pattern: "name", text: "Ada" }] });
  assert.equal(o.ok, true);
  assert.equal("form" in o, false);
});

// ---- required ticks, form= fields and disabled ones in the census ----

const NM = [{ label_pattern: "^nm$", text: "Ada" }];
const TOS = (checked = "") => `<form><input name=nm aria-label=nm required><label><input type=checkbox name=tos required ${checked}> I agree</label></form>`;

test("fill {fields}: an unticked required checkbox is still wanted; a ticked one is not", async () => {
  onPage(TOS());
  let { o } = await fill({ fields: NM });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.form, { requiredEmpty: 1, left: [{ name: "tos", label: "I agree" }] });
  onPage(TOS("checked"));
  ({ o } = await fill({ fields: NM }));
  assert.deepEqual(o.form, { requiredEmpty: 0 });
});

const WORK = (checked = "") => `<form><input name=nm aria-label=nm required><fieldset><legend>Authorized to work?</legend>
  <label><input type=radio name=auth value=y required ${checked}> Yes</label><label><input type=radio name=auth value=n> No</label><label><input type=radio name=auth value=s> Soon</label></fieldset></form>`;

test("fill {fields}: a required radio group with none picked counts once, named by its question", async () => {
  onPage(WORK());
  let { o } = await fill({ fields: NM });
  assert.deepEqual(o.form, { requiredEmpty: 1, left: [{ name: "auth", label: "Authorized to work?" }] });
  onPage(WORK("checked"));
  ({ o } = await fill({ fields: NM }));
  assert.deepEqual(o.form, { requiredEmpty: 0 });
});

const SPONSOR = (on = "false") => `<form><input name=nm aria-label=nm required><div role=radiogroup aria-required=true aria-label=Sponsorship>
  <div role=radio aria-checked=${on} tabindex=0>Yes</div><div role=radio aria-checked=false tabindex=-1>No</div></div></form>`;

test("fill {fields}: a required ARIA radiogroup counts until one radio is checked", async () => {
  onPage(SPONSOR());
  let { o } = await fill({ fields: NM });
  assert.deepEqual(o.form, { requiredEmpty: 1, left: [{ label: "Sponsorship" }] });
  onPage(SPONSOR("true"));
  ({ o } = await fill({ fields: NM }));
  assert.deepEqual(o.form, { requiredEmpty: 0 });
});

test("fill {fields}: disabled and display:none required ticks are not wanted", async () => {
  onPage(`<form><input name=nm aria-label=nm required><input name=o required disabled><fieldset disabled><input name=fd required></fieldset>
    <div style="display:none"><label><input type=checkbox name=gone required> Gone</label></div></form>`);
  const { o } = await fill({ fields: NM });
  assert.deepEqual(o.form, { requiredEmpty: 0 });
});

test("fill {fields}: a required field tied to the form by form= is counted", async () => {
  onPage(`<form id=f1><input name=a aria-label=a required value=x></form><input name=ph form=f1 required>`);
  const { o } = await fill({ fields: [{ label_pattern: "^a$", text: "y" }] });
  assert.deepEqual(o.form, { requiredEmpty: 1, left: [{ name: "ph" }] });
});

test("fill {fields}: a nameless, unlabelled required field is still named in left", async () => {
  onPage(`<form><input name=nm aria-label=nm required><div><input required></div></form>`);
  const { o } = await fill({ fields: NM });
  assert.deepEqual(o.form, { requiredEmpty: 1, left: [{ type: "text" }] });
});

// ---- fields_path and ordered option preferences ----

const PROFILE_FX = (() => { const h = readFileSync(new URL("./fixtures/profile.html", import.meta.url), "utf8"); return h.slice(h.indexOf("<style>")); })();
const tmp = tempDir("perch-fields-");
const jsonFile = (name, body) => { const p = join(tmp, name); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };
const PROFILE_MAP = [
  { label_pattern: "first name", text: "Ada" },
  { label_pattern: "email", text: "other@example.test" },
  { label_pattern: "website", text: "https://ada.example" },
  { label_pattern: "city", text: "Rosario" },
  { label_pattern: "country", option: ["Nope", "Argentina"] },
  { label_pattern: "authorized", option: ["Maybe", "No", "Yes"] },
];

test("fill {fields_path}: file errors are named before the page is touched", async () => {
  onPage(PROFILE_FX);
  const err = async (args) => (await handleCall("fill", args)).content[0].text;
  const missing = join(tmp, "nope.json");
  const t = await err({ fields_path: missing });
  assert.match(t, /fill: fields_path: .*ENOENT/);
  assert.ok(t.includes(missing), t);
  assert.match(await err({ fields_path: jsonFile("bad.json", "[{") }), /fill: fields_path: bad JSON: /);
  assert.match(await err({ fields_path: jsonFile("obj.json", {}) }), /fill: fields_path: .*array/);
  assert.match(await err({ fields_path: jsonFile("big.json", " ".repeat(256 * 1024 + 1)) }), /fill: fields_path: file too large/);
  const ok = jsonFile("ok.json", PROFILE_MAP);
  assert.match(await err({ fields: PROFILE_MAP, fields_path: ok }), /fill: pass `fields` OR `fields_path`, not both/);
  assert.match(await err({ fields_path: ok, label_pattern: "city", text: "x" }), /`fields` OR a single field/);
  assert.match(await err({ fields_path: ok, trusted: true }), /trusted/);
  assert.match(await err({ fields_path: jsonFile("empty.json", []) }), /fields: empty/);
  assert.match(await err({ label_pattern: "city", text: "x", only_empty: true }), /only_empty takes `fields` or `fields_path`/);
});

test("fill {fields_path}: a file of fields fills exactly as the same fields inline", async () => {
  const p = jsonFile("profile.json", PROFILE_MAP);
  const a = onPage(PROFILE_FX);
  const inline = await fill({ fields: PROFILE_MAP, only_empty: true });
  const b = onPage(PROFILE_FX);
  const fromFile = await fill({ fields_path: p, only_empty: true });
  assert.deepEqual(fromFile.o, inline.o);
  for (const { dom } of [a, b]) assert.equal(dom.document.getElementById("country").value, "032");
});

test("fill {fields_path, only_empty}: the profile fixture skips the set field and the trap, and takes the first listed option present", async () => {
  const { dom } = onPage(PROFILE_FX);
  const { r, o } = await fill({ fields_path: jsonFile("profile2.json", PROFILE_MAP), only_empty: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.ok, true, JSON.stringify(o));
  const [fn, em, web, city, country, auth] = o.results;
  assert.equal(fn.ok, true);
  assert.deepEqual([em.skipped, em.value], ["has value", "ada@parsed.test"]);
  assert.equal(web.skipped, "trap");
  assert.equal(city.skipped, undefined);
  assert.deepEqual([country.ok, country.selected, country.pref], [true, "Argentina", 1]);
  assert.deepEqual([auth.ok, auth.kind, auth.selected, auth.pref], [true, "radio", "No", 1]);
  const d = dom.document;
  assert.deepEqual(["fn", "em", "website", "city", "country"].map((id) => d.getElementById(id).value), ["Ada", "ada@parsed.test", "", "Rosario", "032"]);
  assert.equal(d.querySelector("[name=auth][value=n]").checked, true);
});

test("fill_fields option list: each preference keeps the match tiers, never mid-word", () => {
  const pick = (option) => {
    const w = page(PROFILE_FX);
    return { r: run(w, "fill_fields", { fields: [{ label_pattern: "country", option }] }).results[0], v: val(w, "#country").value };
  };
  const first = pick(["Argentina", "Brazil"]);
  assert.deepEqual([first.r.ok, first.r.selected, "pref" in first.r, first.v], [true, "Argentina", false, "032"]);
  const prefix = pick(["Arg"]);
  assert.deepEqual([prefix.r.ok, prefix.r.selected, prefix.v], [true, "Argentina", "032"]);
  const mid = pick(["gentina"]);
  assert.equal(mid.r.ok, false);
  assert.equal(mid.r.error, "no matching option");
  assert.deepEqual(mid.r.tried, ["gentina"]);
  assert.equal(mid.v, "");
  const none = pick(["Nope", "gentina"]);
  assert.equal(none.r.error, "no matching option");
  assert.deepEqual(none.r.tried, ["Nope", "gentina"]);
  assert.ok(none.r.candidates.includes("Argentina"));
  const tie = pick(["Ar", "Brazil"]);
  assert.equal(tie.r.ok, false);
  assert.equal(tie.r.ambiguous, true);
  assert.match(tie.r.error, /several options matched "Ar"/);
  assert.deepEqual(tie.r.candidates, ["Armenia", "Argentina"]);
  assert.equal(tie.v, "", "a tie stops; a later preference never settles it");
});

test("fill_fields option list: a disabled option moves on to the next preference", () => {
  const html = `<label>Size <select id=s><option value="">Pick</option><option value=m disabled>Medium</option><option value=l>Large</option></select></label>`;
  const r = run(page(html), "fill_fields", { fields: [{ label_pattern: "size", option: ["Medium", "Large"] }] }).results[0];
  assert.deepEqual([r.ok, r.selected, r.pref], [true, "Large", 1]);
  const miss = run(page(html), "fill_fields", { fields: [{ label_pattern: "size", option: ["Medium", "Huge"] }] }).results[0];
  assert.equal(miss.ok, false);
  assert.match(miss.error, /"Medium" is disabled/);
  assert.deepEqual(miss.tried, ["Medium", "Huge"]);
  assert.ok(Array.isArray(miss.candidates));
});

test("fill_fields option list: a radio group takes the first preference it has; a tie stops", () => {
  const w = page(PROFILE_FX);
  const r = run(w, "fill_fields", { fields: [{ label_pattern: "authorized", option: ["Maybe", "Yes", "No"] }] }).results[0];
  assert.deepEqual([r.ok, r.selected, r.pref], [true, "Yes", 1]);
  assert.equal(val(w, "[value=y]").checked, true);
  const w2 = page(`<fieldset><legend>Shift</legend><label><input type=radio name=s value=a> Early morning</label><label><input type=radio name=s value=b> Early evening</label><label><input type=radio name=s value=c> Late</label></fieldset>`);
  const tie = run(w2, "fill_fields", { fields: [{ label_pattern: "shift", option: ["Early", "Late"] }] }).results[0];
  assert.equal(tie.ambiguous, true, JSON.stringify(tie));
  assert.equal(w2.document.querySelector("input:checked"), null);
  const miss = run(w2, "fill_fields", { fields: [{ label_pattern: "shift", option: ["Night", "Noon"] }] }).results[0];
  assert.deepEqual([miss.ok, miss.error, miss.tried], [false, "no matching option", ["Night", "Noon"]]);
});

test("fill {fields}: option lists are validated", async () => {
  onPage(FORM);
  const err = async (option) => (await handleCall("fill", { fields: [{ label_pattern: "country", option }] })).content[0].text;
  assert.match(await err([]), /fields\[0\].*`option`.*empty/);
  assert.match(await err(["a", 2]), /fields\[0\].*`option`.*strings/);
  assert.match(await err(Array.from({ length: 11 }, (_, i) => "o" + i)), /fields\[0\].*`option`.*10/);
});

const countSelects = (world) => {
  const c = { n: 0 }, orig = world.ctx.__perch.select;
  world.ctx.__perch.select = (...a) => { c.n++; return orig(...a); };
  return c;
};
const COUNT_OPENS = `window.opened = 0; document.querySelector('.select__control').addEventListener('mousedown', () => window.opened++);`;

test("fill {fields}: a custom combobox takes the first listed option it has, opened once", async () => {
  const { dom, world } = onPage(CUSTOM, CUSTOM_JS.replace("<div role=option>Junior</div><div role=option>Senior</div>", "<div role=option>Onsite</div><div role=option>Hybrid</div>") + COUNT_OPENS);
  const selects = countSelects(world);
  const { o } = await fill({ fields: [{ label_pattern: "level", option: ["Remote", "Hybrid"] }] });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(selects.n, 1);
  assert.deepEqual([o.results[0].selected, o.results[0].pref], ["Hybrid", 1]);
  assert.equal(dom.document.querySelector(".v").textContent, "Hybrid");
  assert.equal(dom.window.opened, 1);
});

test("fill {fields}: a custom combobox with nothing to type into misses once, listing what it tried", async () => {
  const { dom, world } = onPage(CUSTOM, CUSTOM_JS + COUNT_OPENS);
  const selects = countSelects(world);
  const { o } = await fill({ fields: [{ label_pattern: "level", option: ["Remote", "Onsite"] }] });
  assert.equal(selects.n, 1, "one select run: nothing was typed, so no later preference can turn up");
  const r = o.results[0];
  assert.equal(r.ok, false, JSON.stringify(o));
  assert.equal(r.error, "no option of this control matched");
  assert.deepEqual(r.tried, ["Remote", "Onsite"]);
  assert.deepEqual(r.candidates, ["Junior", "Senior"]);
  assert.equal("filtered" in r, false);
  assert.equal(dom.window.opened, 1);
});

// A search box whose full catalog shows only once a filter is typed.
const OFFICE = `<div><label id=sl>Office</label><input id=so role=combobox aria-labelledby=sl aria-controls=sm aria-expanded=false></div><ul id=sm role=listbox></ul>`;
const OFFICE_JS = `
  const inp = document.getElementById('so'), ul = document.getElementById('sm');
  const show = (xs) => { ul.innerHTML = xs.map((x) => '<li role=option>' + x + '</li>').join(''); inp.setAttribute('aria-expanded', 'true'); };
  const all = ['Berlin', 'Madrid', 'Oslo', 'Porto'];
  const top = () => show(['Berlin', 'Madrid']);
  window.typedQ = [];
  inp.addEventListener('focus', () => { if (!ul.children.length) top(); });
  inp.addEventListener('mousedown', () => { if (!ul.children.length) top(); });
  inp.addEventListener('input', () => { if (inp.value) window.typedQ.push(inp.value); if (inp.value) show(all.filter((x) => x.toLowerCase().startsWith(inp.value.toLowerCase()))); else top(); });
  ul.addEventListener('click', (e) => { inp.value = e.target.textContent; ul.innerHTML = ''; inp.setAttribute('aria-expanded', 'false'); });`;

test("fill {fields}: a type-to-filter combobox tries the next preference only after a plain typed miss", async () => {
  const { dom, world } = onPage(OFFICE, OFFICE_JS);
  const selects = countSelects(world);
  const { o } = await fill({ fields: [{ label_pattern: "office", option: ["Paris", "Oslo", "Porto"] }] });
  assert.equal(selects.n, 2, "Porto is never tried once Oslo lands");
  const r = o.results[0];
  assert.equal(r.ok, true, JSON.stringify(o));
  assert.deepEqual([r.selected, r.pref], ["Oslo", 1]);
  assert.equal(dom.document.getElementById("so").value, "Oslo");
  assert.deepEqual([...dom.window.typedQ], ["Paris", "Oslo"]);
});

test("the standalone select tool keeps a string text", () => {
  const t = TOOLS.find((x) => x.name === "select");
  assert.deepEqual(t.inputSchema.properties.text, { type: "string" });
  const f = TOOLS.find((x) => x.name === "fill").inputSchema.properties;
  assert.equal(f.fields_path.type, "string");
});

// A typeahead whose lookup lands a few executes later (window.__q, ticked per
// execute), so a batch with it spans several page calls.
const TA_FORM = `<form>
  <label>Name <input name=name></label>
  <div><label for=city>City</label><input id=city name=city autocomplete=off><input type=hidden id=city-id name=cityId><div class=dropdown-container id=city-dd></div></div>
  <label>Email <input type=email name=email></label>
  <label>Phone <input type=tel name=phone></label>
</form>`;
const TA_FORM_JS = `
  window.__q = [];
  window.later = (fn, n) => { window.__q.push({ fn, n }); };
  window.__tick = () => { const due = window.__q.filter((j) => --j.n <= 0); window.__q = window.__q.filter((j) => j.n > 0); due.forEach((j) => j.fn()); };
  const cities = ['Lisbon, Portugal', 'Lyon, France'];
  const inp = document.getElementById('city'), hid = document.getElementById('city-id'), dd = document.getElementById('city-dd');
  inp.addEventListener('input', () => {
    hid.value = '';
    const q = inp.value.toLowerCase();
    later(() => {
      dd.innerHTML = cities.filter((c) => q && c.toLowerCase().startsWith(q)).map((c) => '<div class=dropdown-item data-id=' + cities.indexOf(c) + '>' + c + '</div>').join('');
      dd.querySelectorAll('.dropdown-item').forEach((o) => o.addEventListener('mousedown', () => { inp.value = o.textContent; hid.value = 'c' + o.dataset.id; dd.innerHTML = ''; }));
    }, 3);
  });
  inp.addEventListener('blur', () => { dd.innerHTML = ''; if (!hid.value) inp.value = ''; });`;

test("fill {fields}: a concurrent fill on the same tab neither breaks the batch nor reads its record", async () => {
  const { dom } = onPage(TA_FORM, TA_FORM_JS);
  const ev = dom.eval.bind(dom);
  dom.eval = (js) => { dom.__tick(); return ev(js); };
  const [a, b] = await Promise.all([
    fill({ fields: [{ label_pattern: "name", text: "Ada" }, { label_pattern: "city", text: "Lisbon" }, { label_pattern: "email", text: "ada@example.test" }] }),
    fill({ fields: [{ label_pattern: "phone", text: "5551234" }] }),
  ]);
  assert.equal(a.o.ok, true, JSON.stringify(a.o));
  assert.equal(a.o.warning, undefined, JSON.stringify(a.o));
  assert.deepEqual(a.o.results.map((x) => [x.ok, x.unverified]), [[true, undefined], [true, undefined], [true, undefined]]);
  assert.equal(a.o.results[1].selected, "Lisbon, Portugal");
  assert.equal(b.o.ok, true, JSON.stringify(b.o));
  assert.equal(val(dom, "[name=email]").value, "ada@example.test");
  assert.equal(val(dom, "[name=phone]").value, "5551234");
  assert.equal(val(dom, "#city-id").value, "c0");
});

// ---- label_pattern over the field's autocomplete token ----

// No label here says given-name, email or tel: only the autocomplete tokens do.
const ES_FORM = `<form>
  <label>Nombre <input name=n1 autocomplete=given-name required></label>
  <label>Apellido <input name=n2 autocomplete="section-a family-name" required></label>
  <label>Correo <input name=n3 autocomplete="work email" required></label>
  <label>Celular <input name=n4 autocomplete="shipping mobile tel" required></label>
</form>`;
const TOKEN_PROFILE = [
  { label_pattern: "given-name|first.?name", text: "Ada" },
  { label_pattern: "family-name|last.?name", text: "Lovelace" },
  { label_pattern: "email", text: "ada@example.test" },
  { label_pattern: "tel|phone", text: "+1 555 010 0199" },
];

test("fill {fields, only_empty}: token patterns fill a form labelled in another language", async () => {
  const { dom } = onPage(ES_FORM);
  const { o } = await fill({ fields: TOKEN_PROFILE, only_empty: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.results.map((x) => [x.ok, x.kind, x.skipped, x.unverified]), TOKEN_PROFILE.map(() => [true, "plain", undefined, undefined]));
  assert.deepEqual(["n1", "n2", "n3", "n4"].map((n) => val(dom, `[name=${n}]`).value), ["Ada", "Lovelace", "ada@example.test", "+1 555 010 0199"]);
  assert.deepEqual(o.form, { requiredEmpty: 0 });
});

test("fill_fields only_empty: two fields sharing a token are ambiguous and neither is written", () => {
  const w = page(`<label>Casa <input name=a autocomplete=tel></label><label>Trabajo <input name=b autocomplete="work tel"></label>`);
  const r = run(w, "fill_fields", { only: true, fields: [{ label_pattern: "tel|phone", text: "5550100" }] }).results[0];
  assert.deepEqual(r, { ok: true, kind: "text", skipped: "ambiguous", candidates: [`textbox "Casa"`, `textbox "Trabajo"`] });
  assert.equal(val(w, "[name=a]").value, "");
  assert.equal(val(w, "[name=b]").value, "");
});

test("fill_fields only_empty: a honeypot carrying the token stays empty; a trap-only token match is skipped as a trap", () => {
  const w = page(`<div class=row><label>Correo <input id=trap tabindex=-1 autocomplete=email data-rect="-9999,0,100,20"></label></div>
    <div class=row><label>Correo electronico <input id=real autocomplete=email></label></div>`);
  const o = run(w, "fill_fields", { only: true, fields: [{ label_pattern: "email", text: "ada@example.test" }] });
  assert.equal(o.results[0].ok, true, JSON.stringify(o));
  assert.equal(o.results[0].skipped, undefined);
  assert.equal(val(w, "#real").value, "ada@example.test");
  assert.equal(val(w, "#trap").value, "");
  val(w, "#real").closest(".row").remove();
  const t = run(w, "fill_fields", { only: true, fields: [{ label_pattern: "email", text: "ada@example.test" }] }).results[0];
  assert.deepEqual(t, { ok: true, kind: "text", skipped: "trap", el: `textbox "Correo" hidden` });
  const single = run(w, "fill", { label_pattern: "email", text: "ada@example.test" });
  assert.equal(single.ok, false);
  assert.match(single.error, /bot trap/);
  assert.equal(val(w, "#trap").value, "");
});

// The textarea is claimed only by its section's text (10 plus bonuses); the url
// token is a full match (100), so the input wins with no tie and no rival.
test("fill: a token match outranks a field claimed only by its section's text", () => {
  const html = `<form><div class=q><p>Tell us about your LinkedIn activity</p><textarea id=ta></textarea></div>
    <div class=q><label>Sitio web <input id=u autocomplete=url></label></div></form>`;
  for (const only of [false, true]) {
    const w = page(html);
    const o = run(w, "fill_fields", { only, fields: [{ label_pattern: "url|linkedin", text: "https://example.test/ada" }] }).results[0];
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(o.el, `textbox "Sitio web"`);
    assert.equal(o.ambiguous, undefined);
    assert.equal(val(w, "#u").value, "https://example.test/ada");
    assert.equal(val(w, "#ta").value, "");
  }
});

test("fill_fields: autofill off, modifiers without a field name, and unknown tokens never match", () => {
  const w = page(`<label>Uno <input name=a autocomplete=off></label><label>Dos <input name=b autocomplete="section-a shipping"></label>
    <label>Tres <input name=c autocomplete="email-confirm"></label><label>Cuatro <input name=d autocomplete=on></label>`);
  for (const p of ["off", "on", "section-a", "shipping", "section-a shipping", "email-confirm", "email"]) {
    const r = run(w, "fill_fields", { only: true, fields: [{ label_pattern: p, text: "x" }] }).results[0];
    assert.equal(r.skipped, "absent", `${p}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(["a", "b", "c", "d"].map((n) => val(w, `[name=${n}]`).value), ["", "", "", ""]);
});

test("fill_fields: the token must match the whole pattern, not part of it", () => {
  const w = page(`<label>Nombre de pila <input name=g autocomplete=given-name></label><label>Nombre completo <input name=f autocomplete=name></label>`);
  const r = run(w, "fill_fields", { only: true, fields: [{ label_pattern: "name", text: "Ada Lovelace" }] }).results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.el, `textbox "Nombre completo"`);
  assert.equal(val(w, "[name=g]").value, "");
  assert.equal(val(w, "[name=f]").value, "Ada Lovelace");
});

// Deliberately conservative: a token hit counts as much as the field's own
// label, so a second field carrying the token ties with the labelled one.
test("fill_fields: a labelled field and another carrying only the token tie at the label tier", () => {
  const html = `<label>Email <input name=main></label><label>Boletin <input name=news autocomplete=email></label>`;
  const w = page(html);
  const r = run(w, "fill_fields", { only: true, fields: [{ label_pattern: "email", text: "ada@example.test" }] }).results[0];
  assert.deepEqual(r, { ok: true, kind: "text", skipped: "ambiguous", candidates: [`textbox "Email"`, `textbox "Boletin"`] });
  assert.equal(val(w, "[name=main]").value, "");
  assert.equal(val(w, "[name=news]").value, "");
  const w2 = page(html);
  const f = run(w2, "fill_fields", { fields: [{ label_pattern: "email", text: "ada@example.test" }] }).results[0];
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.equal(f.el, `textbox "Email"`);
  assert.deepEqual(f.ambiguous, [`textbox "Email"`, `textbox "Boletin"`]);
  assert.equal(val(w2, "[name=main]").value, "ada@example.test");
  assert.equal(val(w2, "[name=news]").value, "");
});

test("fill_fields: a payment token never matches", () => {
  const w = page(`<label>Tarjeta <input name=cc autocomplete="billing cc-number"></label><label>Vence <input name=exp autocomplete=cc-exp></label>`);
  for (const p of ["cc-number", "cc-.*", "cc-exp", ".*number", "(cc-)?number"]) {
    const r = run(w, "fill_fields", { only: true, fields: [{ label_pattern: p, text: "4111111111111111" }] }).results[0];
    assert.equal(r.skipped, "absent", `${p}: ${JSON.stringify(r)}`);
  }
  assert.equal(val(w, "[name=cc]").value, "");
  assert.equal(val(w, "[name=exp]").value, "");
});

test("fill {fields}: batches differing only in their patterns send the same library source", async () => {
  const { world } = onPage(`<label>Uno <input autocomplete=email></label><label>Dos <input autocomplete=tel></label>`);
  const sent = passes(world);
  await fill({ fields: [{ label_pattern: "zqemail", text: "a" }] });
  await fill({ fields: [{ label_pattern: "zqphone", text: "a" }] });
  assert.equal(sent.length, 2);
  assert.equal(sent[1], sent[0].replaceAll("zqemail", "zqphone"));
});
