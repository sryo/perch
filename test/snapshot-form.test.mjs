// Required fields the form header counts but no ordinary row shows: a custom
// input clipped or faded behind its visible label, a textarea collapsed behind
// an "Enter manually" button. Each gets a `hidden` row, with the button that
// reveals it as reveal=<ref>; decoys never do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { page, run } from "./helpers/page.mjs";

const snap = (w, A = {}) => {
  const [head, ...lines] = run(w, "snapshot", { max: 500, ...A }).split("\n");
  return { head: JSON.parse(head.slice(2)), lines };
};

test("snapshot: a clip-hidden or faded required input under a visible label is listed hidden, and fills by ref", () => {
  const w = page(`<form>
    <label for=a>Preferred name</label><input id=a name=pref required data-rect="0,0,1,1" style="position:absolute;width:1px;height:1px;clip:rect(0px,0px,0px,0px)">
    <label for=b>Pronouns</label><input id=b name=pron required style="opacity:0">
    <label for=c>City</label><input id=c name=city required>
  </form>`);
  const { head, lines } = snap(w);
  assert.deepEqual(lines, [
    `1 textbox "Preferred name" name="pref" required hidden`,
    `2 textbox "City" name="city" required`,
    `3 textbox "Pronouns" name="pron" required hidden`,
  ]);
  assert.deepEqual(head.form, { fields: 3, requiredEmpty: 3 });
  assert.equal(head.count, 3);
  for (const [ref, id] of [["1", "a"], ["3", "b"]]) {
    const o = run(w, "fill", { ref, text: "Ada" });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(o.hidden, true, JSON.stringify(o));
    assert.equal(w.document.getElementById(id).value, "Ada");
  }
  assert.deepEqual(snap(w).head.form, { fields: 3, requiredEmpty: 1 });
});

const COVER = ({ controls = true, label = true } = {}) => `<form>
  <div class=field>${label ? "<label for=cl>Cover Letter</label>" : "<div class=title>Cover Letter</div>"}
    <div class=acts><button type=button>Attach</button><button type=button ${controls ? "aria-controls=paste" : ""}>Enter manually</button></div>
    <div id=paste style="display:none"><textarea id=cl name=cover_letter required></textarea></div>
  </div>
  <label for=nm>Name</label><input id=nm name=nm required>
  <button type=submit>Submit application</button>
</form>`;

test("snapshot: a required textarea collapsed behind 'Enter manually' is listed hidden with reveal", () => {
  for (const opts of [{}, { controls: false }, { label: false }]) {
    const w = page(COVER(opts));
    const { head, lines } = snap(w);
    assert.deepEqual(lines, [
      `1 button "Attach"`,
      `2 button "Enter manually"`,
      `3 textbox "Name" name="nm" required`,
      `4 button "Submit application"`,
      `5 textbox "Cover Letter" name="cover_letter" type="textarea" required hidden reveal="2"`,
    ], JSON.stringify(opts));
    assert.equal(head.count, 5);
    assert.equal(head.form.requiredEmpty, 2);
    const o = run(w, "fill", { ref: "5", text: "Dear team" });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(o.hidden, true);
    assert.equal(w.document.getElementById("cl").value, "Dear team");
  }
});

test("snapshot: a reveal button left out by the query still gets a ref and a row", () => {
  const w = page(COVER());
  const { head, lines } = snap(w, { query: "cover" });
  assert.deepEqual(lines, [
    `1 textbox "Cover Letter" name="cover_letter" type="textarea" required hidden reveal="2"`,
    `2 button "Enter manually"`,
  ]);
  assert.equal(head.count, 2);
  assert.equal(run(w, "click", { ref: "2" }).ok, true);
});

test("snapshot: with roles filtering to buttons, no hidden textbox rows appear", () => {
  const w = page(COVER());
  const { head, lines } = snap(w, { role: "button" });
  assert.deepEqual(lines, [`1 button "Attach"`, `2 button "Enter manually"`, `3 button "Submit application"`]);
  assert.equal(head.form.requiredEmpty, 2);
});

test("snapshot: honeypot fixture fields never get rows or change requiredEmpty", () => {
  const html = readFileSync(new URL("./fixtures/honeypot.html", import.meta.url), "utf8");
  for (const [h, req] of [[html, 0], [html.replace(/<input /g, "<input required "), 3]]) {
    const { head, lines } = snap(page(h.slice(h.indexOf("<style>"))));
    assert.deepEqual(lines, [`1 textbox "Email" name="email_confirm"${req ? " required" : ""}`, `2 textbox "Email" type="email"${req ? " required" : ""}`]);
    assert.deepEqual(head.form, { fields: 3, requiredEmpty: req });
  }
  const w = page(`<form><div class=row><label for=t>Leave this field empty</label><input id=t name=hp required style="opacity:0"></div>
    <input name=trap required tabindex=-1 autocomplete=off style="opacity:0"><input name=aria required aria-hidden=true style="opacity:0">
    <label for=o>Nickname</label><input id=o required data-rect="-9999,0,100,20" style="display:block"><label for=n>Nickname</label><input id=n required></form>`);
  const { head, lines } = snap(w);
  assert.deepEqual(lines, [`1 textbox "Nickname" required`, `2 textbox "Nickname" required`]);
  assert.equal(head.form.requiredEmpty, 5);
});

test("snapshot: a react-select required stand-in gets no row", () => {
  const w = page(`<form><div id=c-l>Region</div><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
    <input class="select__input" role=combobox id=c aria-labelledby=c-l aria-required=true></div>
    <input required tabindex=-1 aria-hidden=true class=requiredInput style="opacity:0;position:absolute"></div></form>`);
  const { head, lines } = snap(w);
  assert.deepEqual(lines, [`1 combobox "Region" required`]);
  assert.deepEqual(head.form, { fields: 1, requiredEmpty: 1 });
});

test("snapshot: a typeahead's hidden companion gets no row; its input still reads unpicked", () => {
  const w = page(`<form><div class=loc><label for=li>Location</label>
    <input id=li required><input type=hidden id=selected-location name=selectedLocation required>
    <div class=dropdown-results></div></div></form>`);
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(w.document.getElementById("li"), "Buenos");
  const { head, lines } = snap(w);
  assert.deepEqual(lines, [`1 textbox "Location" value="Buenos" required unpicked`]);
  assert.deepEqual(head.form, { fields: 1, requiredEmpty: 1, unpicked: 1 });
});

test("snapshot: hidden rows stop at 10 and respect max", () => {
  const many = Array.from({ length: 14 }, (_, i) => `<label for=h${i}>Q${i}</label><input id=h${i} required style="display:none">`).join("");
  const w = page(`<form>${many}<label for=v>Visible</label><input id=v required></form>`);
  let { head, lines } = snap(w);
  assert.equal(lines.length, 11);
  assert.equal(lines[10], `11 textbox "Q9" required hidden`);
  assert.equal(head.form.requiredEmpty, 15);
  ({ head, lines } = snap(w, { max: 3 }));
  assert.equal(lines.length, 3);
  assert.equal(head.truncated, true);
});
