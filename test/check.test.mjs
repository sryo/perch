// fill {checked} by label_pattern: ties refuse, traps and hidden boxes are never
// clicked, and a disabled box is reported rather than claimed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, run } from "./helpers/page.mjs";

const check = (w, f, only) => run(w, "fill_fields", { fields: [f], only })?.results[0];
const on = (w, sel) => w.document.querySelector(sel).checked;

const TWO = `<label><input type=checkbox id=m> I agree to marketing emails</label>
<label><input type=checkbox id=t> I agree to the terms</label>`;

test("check: two boxes named equally well refuse as ambiguous and stay unchecked", () => {
  const w = page(TWO);
  const r = check(w, { label_pattern: "I agree", checked: true });
  assert.equal(r.ok, false);
  assert.equal(r.ambiguous, true);
  assert.match(r.error, /several checkboxes\/radios matched \/I agree\/i equally/);
  assert.deepEqual(r.candidates, [`checkbox "I agree to marketing emails"`, `checkbox "I agree to the terms"`]);
  assert.equal(on(w, "#m"), false);
  assert.equal(on(w, "#t"), false);
});

test("check: only_empty skips an ambiguous match", () => {
  const w = page(TWO);
  const r = check(w, { label_pattern: "I agree", checked: true }, true);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, "ambiguous");
  assert.equal(r.candidates.length, 2);
  assert.equal(on(w, "#m"), false);
  assert.equal(on(w, "#t"), false);
});

test("check: a pattern naming one box picks it", () => {
  const w = page(TWO);
  const r = check(w, { label_pattern: "terms", checked: true });
  assert.deepEqual(r, { ok: true, kind: "check", el: `checkbox "I agree to the terms"`, checked: true });
  assert.equal(on(w, "#t"), true);
  assert.equal(on(w, "#m"), false);
});

test("check: a whole-word name beats a partial one", () => {
  const w = page(`<label><input type=checkbox id=a> Termsheet copy</label><label><input type=checkbox id=b> Terms</label>`);
  const r = check(w, { label_pattern: "terms", checked: true });
  assert.equal(r.ok, true);
  assert.equal(on(w, "#b"), true);
  assert.equal(on(w, "#a"), false);
});

test("check: an off-page honeypot box is never clicked", () => {
  const w = page(`<div data-rect="-5000,0,100,20"><label data-rect="-5000,0,100,20"><input type=checkbox name=subscribe_hp data-rect="-5000,0,20,20"> Subscribe</label></div>`);
  const r = check(w, { label_pattern: "subscribe", checked: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /bot trap/);
  assert.equal(on(w, "[name=subscribe_hp]"), false);
  const s = check(w, { label_pattern: "subscribe", checked: true }, true);
  assert.equal(s.ok, true);
  assert.equal(s.skipped, "trap");
  assert.equal(on(w, "[name=subscribe_hp]"), false);
});

test("check: an off-page box is a trap when its label is a pixel or faded out", () => {
  for (const html of [
    `<input type=checkbox id=c data-rect="-5000,0,20,20"><label for=c data-rect="0,0,1,1">Subscribe</label>`,
    `<div style="opacity:0"><input type=checkbox id=c data-rect="-5000,0,20,20"><label for=c>Subscribe</label></div>`,
  ]) {
    const w = page(html);
    const r = check(w, { label_pattern: "subscribe", checked: true });
    assert.equal(r.ok, false, html);
    assert.equal(on(w, "#c"), false, html);
  }
});

test("check: an off-page input under a visible label is an sr-only custom box, not a trap", () => {
  const w = page(`<label><input type=checkbox id=c data-rect="-10000,0,1,1"> Subscribe</label>`);
  const r = check(w, { label_pattern: "subscribe", checked: true });
  assert.equal(r.ok, true);
  assert.equal(on(w, "#c"), true);
});

test("check: a box whose name says to leave it alone is a trap", () => {
  const w = page(`<label><input type=checkbox name=x_do_not_fill id=c> Do not fill: subscribe</label>`);
  const r = check(w, { label_pattern: "subscribe", checked: true });
  assert.equal(r.ok, false);
  assert.equal(on(w, "#c"), false);
});

test("check: a visible and a hidden box with the same name pick the visible one", () => {
  const w = page(`<label style="display:none"><input type=checkbox id=h> Subscribe to newsletter</label>
<label><input type=checkbox id=v> Subscribe to newsletter</label>`);
  const r = check(w, { label_pattern: "subscribe to newsletter", checked: true });
  assert.equal(r.ok, true);
  assert.equal(on(w, "#v"), true);
  assert.equal(on(w, "#h"), false);
});

test("check: a hidden-only match is refused, never clicked", () => {
  const w = page(`<label style="display:none"><input type=checkbox id=h> Subscribe to newsletter</label>`);
  const r = check(w, { label_pattern: "newsletter", checked: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /hidden/);
  assert.match(r.error, /ref or selector/);
  assert.equal(r.el, `checkbox "Subscribe to newsletter" hidden`);
  assert.equal(on(w, "#h"), false);
  const s = check(w, { label_pattern: "newsletter", checked: true }, true);
  assert.deepEqual(s, { ok: true, kind: "check", skipped: "absent" });
  assert.equal(on(w, "#h"), false);
});

test("check: a disabled box refuses by selector, by label and inside a disabled fieldset", () => {
  const w = page(`<label><input type=checkbox id=d disabled> Remember me</label>
<label><input type=checkbox id=dc disabled checked> Keep copy</label>
<fieldset disabled><label><input type=checkbox id=f> Opt in</label></fieldset>`);
  for (const f of [{ selector: "#d" }, { label_pattern: "remember" }, { label_pattern: "opt in" }, { selector: "#f" }]) {
    const r = check(w, { ...f, checked: true });
    assert.equal(r.ok, false, JSON.stringify(f));
    assert.equal(r.kind, "check");
    assert.match(r.error, /is disabled; the form will not submit it/);
  }
  assert.equal(on(w, "#d"), false);
  assert.equal(on(w, "#f"), false);
  const already = check(w, { selector: "#dc", checked: true });
  assert.equal(already.ok, false);
  assert.match(already.error, /disabled/);
  assert.equal(on(w, "#dc"), true);
});

// The common styled box: the input is display:none and a visible <label for>
// draws the box people click.
const STYLED = `<style>.sr{display:none}</style>
<input type=checkbox class=sr id=c><label for=c>I accept the terms</label>`;

test("check: a display:none box under a visible label is checked", () => {
  const w = page(STYLED);
  const r = check(w, { label_pattern: "accept the terms", checked: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.checked, true);
  assert.equal(on(w, "#c"), true);
});

test("check: only_empty checks a display:none box under a visible label", () => {
  const w = page(STYLED);
  const r = check(w, { label_pattern: "accept the terms", checked: true }, true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.skipped, undefined);
  assert.equal(on(w, "#c"), true);
});

test("check: a display:none radio under a visible label is checked", () => {
  const w = page(`<input type=radio name=p id=a style="display:none"><label for=a>Monthly plan</label>
<input type=radio name=p id=b style="display:none"><label for=b>Yearly plan</label>`);
  const r = check(w, { label_pattern: "yearly", checked: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(on(w, "#b"), true);
});

test("check: a hidden honeypot box under a visible label is still refused", () => {
  for (const [html, only] of [
    [`<input type=checkbox id=c style="display:none" tabindex=-1><label for=c>Subscribe</label>`, "absent"],
    [`<div aria-hidden=true><input type=checkbox id=c style="display:none"></div><label for=c>Subscribe</label>`, "absent"],
    [`<input type=checkbox id=c style="display:none"><label for=c>Leave this blank: subscribe</label>`, "trap"],
    [`<input type=checkbox id=c style="display:none"><label for=c style="display:none">Subscribe</label>`, "absent"],
    [`<input type=checkbox id=c style="display:none"><label for=c data-rect="-5000,0,100,20">Subscribe</label>`, "absent"],
    [`<input type=checkbox id=c style="display:none"><label for=c data-rect="0,0,1,1">Subscribe</label>`, "absent"],
    [`<input type=checkbox id=c style="display:none"><label for=c style="position:absolute;clip:rect(0px, 0px, 0px, 0px)">Subscribe</label>`, "absent"],
    [`<div style="opacity:0"><div><input type=checkbox id=c style="display:none"><label for=c>Subscribe</label></div></div>`, "absent"],
    [`<input type=checkbox id=c style="display:none" tabindex=-2><label for=c>Subscribe</label>`, "absent"],
    [`<input type=checkbox id=c style="display:none" name=leave_blank_hp><label for=c>Subscribe</label>`, "trap"],
    [`<input type=checkbox id=c style="display:none" name=do-not-fill><label for=c>Subscribe</label>`, "trap"],
  ]) {
    const w = page(html);
    const r = check(w, { label_pattern: "subscribe", checked: true });
    assert.equal(r.ok, false, html);
    assert.equal(on(w, "#c"), false, html);
    const s = check(w, { label_pattern: "subscribe", checked: true }, true);
    assert.equal(s.ok, true, html);
    assert.equal(s.skipped, only, html);
    assert.equal(on(w, "#c"), false, html);
  }
});

test("check: only_empty skips a disabled box", () => {
  const w = page(`<label><input type=checkbox id=d disabled> Remember me</label>`);
  for (const f of [{ selector: "#d" }, { label_pattern: "remember" }]) {
    const r = check(w, { ...f, checked: true }, true);
    assert.deepEqual(r, { ok: true, kind: "check", el: `checkbox "Remember me"`, skipped: "disabled" }, JSON.stringify(f));
  }
  assert.equal(on(w, "#d"), false);
});
