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
