// fill {trusted:true, raise:true} passes only when the field holds the exact
// text (whitespace-normalised, or a phone mask's digits), and a typeahead typed
// this way goes on to the same pick as a plain fill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

const setValue = (w, el, v) => Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(el, v);
const down = (w, el) => el.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));

// Probes, lets the "keyboard" leave `landed` in the field, then checks.
function typed(html, text, landed, { hit = true } = {}) {
  const w = page(html);
  const el = w.document.querySelector("#f");
  assert.equal(run(w, "trusted_fill_probe", { selector: "#f", forFill: true }).ok, true);
  if (hit) down(w, el);
  el.value = landed;
  return run(w, "trusted_check", { forFill: true, text });
}

test("trusted_check: one dropped keystroke is ok:false, naming what the field holds and not the text sent", () => {
  const text = "Ada Lovelace, London";
  const o = typed(`<input id=f>`, text, "Ada Lovelace, Londn");
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.len, 19);
  assert.equal(o.error, `trusted typing left a different value (19 chars: "Ada Lovelace, Londn")`);
  assert.ok(!o.error.includes(text));
  assert.equal(o.pending, undefined);
});

test("trusted_check: a maxlength truncation is ok:false", () => {
  const o = typed(`<input id=f maxlength=10>`, "Ada Lovelace, London", "Ada Lovela");
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /^trusted typing left a different value \(10 chars: "Ada Lovela"\)$/);
});

test("trusted_check: exact, whitespace-normalised and phone-masked values are ok", () => {
  assert.equal(typed(`<input id=f>`, "Ada Lovelace", "Ada Lovelace").ok, true);
  const ta = typed(`<textarea id=f></textarea>`, "line one\r\nline  two", "line one\nline two");
  assert.equal(ta.ok, true, JSON.stringify(ta));
  assert.equal(typed(`<input id=f>`, "3415551234", "(341) 555-1234").ok, true);
  assert.equal(typed(`<input id=f>`, "3415551234", "(341) 555-123").ok, false, "a dropped digit is not a mask");
  assert.equal(typed(`<input id=f>`, "Ada", "Adb").ok, false, "a wrong character is not a match");
});

// react-select-style: a text input in a box with a hidden companion and a popup.
const TYPEAHEAD = `<div class=loc><label for=f>Location</label><input id=f name=location type=text value=Lyon autocomplete=off>
  <input type=hidden id=comp name=selectedLocation value=loc-9><div class=dropdown-container></div></div>`;

test("trusted_fill_probe records the typeahead's prior value before clearing it, and the check leaves it pending", () => {
  const w = page(TYPEAHEAD);
  const el = w.document.querySelector("#f");
  assert.equal(run(w, "trusted_fill_probe", { selector: "#f", forFill: true }).ok, true);
  assert.equal(el.value, "", "cleared for typing");
  assert.equal(w.__perch_ta.el, el);
  assert.equal(w.__perch_ta.prior, "Lyon");
  assert.equal(w.__perch_ta.priorComp, "loc-9");
  assert.equal(w.__perch_ta.comp, w.document.querySelector("#comp"));
  assert.equal(w.__perch_ta.text, undefined, "the probe carries no text; the check has it");
  down(w, el);
  setValue(w, el, "Rosario");
  assert.deepEqual(run(w, "trusted_check", { forFill: true, text: "Rosario" }), { hit: true, pending: true, trusted: true });
  assert.equal(w.__perch_ta.text, "Rosario");
});

test("trusted_check never leaves a typeahead pending when the click missed it", () => {
  const w = page(TYPEAHEAD);
  const el = w.document.querySelector("#f");
  run(w, "trusted_fill_probe", { selector: "#f", forFill: true });
  setValue(w, el, "Rosario");
  const o = run(w, "trusted_check", { forFill: true, text: "Rosario" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.pending, undefined);
  assert.equal(o.hit, null);
});

test("trusted_fill_probe drops a stale typeahead record when the field is plain", () => {
  const w = page(TYPEAHEAD + `<input id=p aria-label=Name>`);
  run(w, "trusted_fill_probe", { selector: "#f", forFill: true });
  run(w, "trusted_fill_probe", { selector: "#p", forFill: true });
  down(w, w.document.querySelector("#p"));
  w.document.querySelector("#p").value = "Ada";
  const o = run(w, "trusted_check", { forFill: true, text: "Ada" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.pending, undefined);
});

// ---- the raised route through the runtime (fake world) ----

const METRICS = { screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 };
const CITIES = ["Rosario, Santa Fe, Argentina", "Rosario del Tala, Entre Rios", "Toronto, ON, Canada"];
// Page work queued with later() runs one step per execute, standing in for timers.
const LOOKUP_JS = `
  window.__q = [];
  window.later = (fn, n) => { window.__q.push({ fn, n }); };
  window.__tick = () => { const due = window.__q.filter((j) => --j.n <= 0); window.__q = window.__q.filter((j) => j.n > 0); due.forEach((j) => j.fn()); };
  const cities = ${JSON.stringify(CITIES)};
  const inp = document.getElementById('f'), hid = document.getElementById('comp');
  const dd = document.querySelector('.dropdown-container');
  inp.addEventListener('input', () => {
    hid.value = '';
    window.__q = [];
    const q = inp.value.toLowerCase();
    later(() => {
      dd.innerHTML = cities.filter((c) => q && c.toLowerCase().startsWith(q)).map((c) => '<div class=dropdown-item data-id=' + cities.indexOf(c) + '>' + c + '</div>').join('');
      dd.querySelectorAll('.dropdown-item').forEach((o) => o.addEventListener('mousedown', () => {
        inp.value = o.textContent;
        hid.value = 'loc-' + o.dataset.id;
        dd.innerHTML = '';
      }));
    }, 3);
  });
  inp.addEventListener('blur', () => { window.__q = []; dd.innerHTML = ''; if (!hid.value) inp.value = ''; });`;

function raisedTypeahead(html = TYPEAHEAD) {
  const dom = page(html);
  for (const [k, v] of Object.entries(METRICS)) Object.defineProperty(dom, k, { value: v, configurable: true });
  dom.eval(LOOKUP_JS);
  const ev = dom.eval.bind(dom);
  dom.eval = (js) => { dom.__tick(); return ev(js); };
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 798, h: 500 }] } }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  const el = dom.document.getElementById("f");
  world.state.onPost = (e) => {
    if (e.type === 1 && e.pt.x >= 0) { el.focus(); down(dom, el); }
    if (e.kind === "key" && e.down) { setValue(dom, el, el.value + e.text); el.dispatchEvent(new dom.InputEvent("input", { bubbles: true, data: e.text })); }
  };
  return { dom, world, el };
}
const fillRaised = async (text) => {
  const r = await handleCall("fill", { trusted: true, raise: true, selector: "#f", text, target: { tabIndex: 1 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};

test("raised trusted fill on a typeahead picks the suggestion and keeps trusted, hit and delivery", async () => {
  const { dom, el } = raisedTypeahead();
  const o = await fillRaised("Rosario");
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "typeahead");
  assert.equal(o.selected, "Rosario, Santa Fe, Argentina");
  assert.equal(o.trusted, true);
  assert.equal(o.hit, true);
  assert.equal(o.delivery, "hid");
  assert.equal(el.value, "Rosario, Santa Fe, Argentina");
  assert.equal(dom.document.getElementById("comp").value, "loc-0");
  // The snapshot no longer flags the field: its companion holds the pick.
  const [head, ...lines] = run(dom, "snapshot", { max: 50 }).split("\n");
  assert.ok(!lines.some((l) => / unpicked/.test(l)), lines.join("\n"));
  assert.equal(JSON.parse(head.slice(2)).form?.unpicked, undefined);
});

test("raised trusted fill on a typeahead with no suggestion withdraws to the prior value, never ok", async () => {
  const { dom, el } = raisedTypeahead();
  const o = await fillRaised("Zzyzx");
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.trusted, true);
  assert.match(o.error, /no suggestion/);
  assert.equal(el.value, "Lyon");
  assert.equal(dom.document.getElementById("comp").value, "loc-9");
});
