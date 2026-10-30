// Date-part widgets: role=spinbutton inputs in a labelled group (month, year)
// that show "06" as 6 and commit only on focusout. fill counts the same number
// as landed, ends with a bubbling focusout (a trusted fill with a blur), and a part
// shrunk to a pixel inside a shown, named group is no bot trap. Real honeypots
// (plain text fields, aria-hidden or off-page parts, parts outside a group)
// still are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, run } from "./helpers/page.mjs";

const GROUP = (input) => `<form><div role=group aria-labelledby=from><span id=from>From</span>${input}</div></form>`;
const MONTH = `<input id=m role=spinbutton aria-label=Month aria-valuemin=1 aria-valuemax=12>`;

// The widget keeps the number, not the typed text, and commits what it holds
// to window.committed only when focus leaves it.
function widget(w, sel = "#m") {
  const el = w.document.querySelector(sel);
  el.addEventListener("input", () => { if (/^\d+$/.test(el.value)) el.value = String(Number(el.value)); });
  w.document.addEventListener("focusout", (e) => { if (e.target === el) w.committed = el.value; });
  return el;
}
function trustedEdits(w) {
  w.document.execCommand = (_command, _ui, text) => {
    const el = w.document.activeElement;
    el.value = text;
    const ev = new w.Event("input", { bubbles: true });
    Object.defineProperty(ev, "isTrusted", { value: true });
    el.dispatchEvent(ev);
    return true;
  };
}

test("trusted_fill_background: a spinbutton that shows 06 as 6 landed, and is blurred so it commits", () => {
  const w = page(GROUP(MONTH));
  const el = widget(w);
  trustedEdits(w);
  const o = run(w, "trusted_fill_background", { selector: "#m", text: "06" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value, "6");
  assert.equal(o.error, undefined);
  assert.equal(w.committed, "6", "focusout reached the widget");
  assert.notEqual(w.document.activeElement, el);
});

test("trusted_fill_background: a plain text field that drops a leading zero still misses", () => {
  const w = page(`<label>Code <input id=m></label>`);
  widget(w);
  trustedEdits(w);
  const o = run(w, "trusted_fill_background", { selector: "#m", text: "06" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.value, "6");
  assert.equal(w.committed, undefined, "a miss leaves focus where it was");
});

test("trusted_check: typed 06 into a number or spinbutton that holds 6 is ok, and the field is left", () => {
  for (const input of [MONTH, `<input id=m type=number aria-label=Month>`]) {
    const w = page(GROUP(input));
    const el = widget(w);
    assert.equal(run(w, "trusted_fill_probe", { selector: "#m", forFill: true }).ok, true);
    el.focus();
    el.value = "6";
    const o = run(w, "trusted_check", { forFill: true, text: "06" });
    assert.equal(o.ok, true, input + JSON.stringify(o));
    assert.equal(w.committed, "6", input);
  }
  const w = page(GROUP(MONTH));
  const el = widget(w);
  run(w, "trusted_fill_probe", { selector: "#m", forFill: true });
  el.value = "7";
  assert.equal(run(w, "trusted_check", { forFill: true, text: "06" }).ok, false, "another number is a miss");
});

test("fill: a widget that commits on a bubbling focusout gets one", () => {
  for (const focused of [false, true]) {
    const w = page(GROUP(MONTH));
    const el = widget(w);
    if (focused) el.focus();
    const o = run(w, "fill", { selector: "#m", text: "06" });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(w.committed, "6", `focused: ${focused}`);
  }
});

test("fill: a spinbutton shrunk to a pixel in a shown, named group or fieldset is no bot trap", () => {
  const part = `<input id=m role=spinbutton aria-label=Year data-rect="10,10,1,20">`;
  for (const html of [GROUP(part), `<form><fieldset><legend>From</legend>${part}</fieldset></form>`, `<form><div role=group aria-label=From>${part}</div></form>`]) {
    const w = page(html);
    const o = run(w, "fill", { selector: "#m", text: "2024" });
    assert.equal(o.ok, true, html + JSON.stringify(o));
    assert.equal(o.warning, undefined, html);
    assert.match(o.el, /^spinbutton "Year"/);
  }
});

test("fill: honeypots near a date group still warn", () => {
  for (const html of [
    GROUP(`<input id=m aria-label=Website data-rect="10,10,1,20">`),
    `<form><input id=m role=spinbutton aria-label=Year data-rect="10,10,1,20"></form>`,
    `<form><div role=group><input id=m role=spinbutton aria-label=Year data-rect="10,10,1,20"></div></form>`,
    GROUP(`<input id=m role=spinbutton aria-label=Year data-rect="-9999,10,100,20">`),
    GROUP(`<div aria-hidden=true><input id=m role=spinbutton aria-label=Year></div>`),
    `<form><div role=group aria-label=From hidden><input id=m role=spinbutton aria-label=Year data-rect="10,10,1,20"></div></form>`,
  ]) {
    const w = page(html);
    const o = run(w, "fill", { selector: "#m", text: "2024" });
    assert.match(o.warning || "", /bot trap/, html + JSON.stringify(o));
  }
});
