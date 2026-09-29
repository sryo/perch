// Required fields the form header counts but no ordinary row shows: a custom
// input faded behind its visible label, a textarea collapsed behind an "Enter
// manually" button. Each gets a `hidden` row, with the button that reveals it
// as reveal=<ref>; decoys never do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { page, run } from "./helpers/page.mjs";

const snap = (w, A = {}) => {
  const [head, ...lines] = run(w, "snapshot", { max: 500, ...A }).split("\n");
  return { head: JSON.parse(head.slice(2)), lines };
};

test("snapshot: a clip-hidden required input under a visible label is a plain row; a faded one is listed hidden; both fill by ref", () => {
  const w = page(`<form>
    <label for=a>Preferred name</label><input id=a name=pref required data-rect="0,0,1,1" style="position:absolute;width:1px;height:1px;clip:rect(0px,0px,0px,0px)">
    <label for=b>Pronouns</label><input id=b name=pron required style="opacity:0">
    <label for=c>City</label><input id=c name=city required>
  </form>`);
  const { head, lines } = snap(w);
  assert.deepEqual(lines, [
    `1 textbox "Preferred name" name="pref" required`,
    `2 textbox "City" name="city" required`,
    `3 textbox "Pronouns" name="pron" required hidden`,
  ]);
  assert.deepEqual(head.form, { fields: 3, requiredEmpty: 3 });
  assert.equal(head.count, 3);
  // Fill takes the labelled sr-only input for a real field; the faded one stays hidden.
  for (const [ref, id, hidden] of [["1", "a", undefined], ["3", "b", true]]) {
    const o = run(w, "fill", { ref, text: "Ada" });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(o.hidden, hidden, JSON.stringify(o));
    assert.equal(w.document.getElementById(id).value, "Ada");
  }
  assert.deepEqual(snap(w).head.form, { fields: 3, requiredEmpty: 1 });
});

// The snapshot's `hidden` and fill's must agree: a required sr-only input named
// by visible text is a field both treat as shown; a trap is never offered as a
// hidden field to fill, and fill by label refuses it.
test("snapshot: hidden flags agree with fill on sr-only inputs and traps", () => {
  const sr = `style="position:absolute;width:1px;height:1px;overflow:hidden" data-rect="0,0,1,1"`;
  const faded = `style="position:absolute;width:1px;height:1px;opacity:0" data-rect="0,0,1,1"`;
  for (const css of [sr, faded]) {
    for (const html of [
      `<form><label for=r>Referral code</label><input id=r required ${css}></form>`,
      `<form><label for=r>Referral code</label><input id=r aria-required=true ${css}></form>`,
      `<form><span id=l>Referral code</span><input id=r aria-labelledby=l required ${css}></form>`,
    ]) {
      const w = page(html);
      const { lines } = snap(w);
      const shown = css === sr;
      assert.deepEqual(lines, [`1 textbox "Referral code" required${shown ? "" : " hidden"}`], html + css);
      const o = run(w, "fill", { ref: "1", text: "AB12" });
      assert.equal(o.ok, true, html + JSON.stringify(o));
      assert.equal(o.hidden, shown ? undefined : true, html + css + JSON.stringify(o));
      assert.equal(w.document.getElementById("r").value, "AB12", html);
    }
    for (const html of [
      `<form><label for=r>Referral code</label><input id=r required tabindex=-1 ${css}></form>`,
      `<form><label for=r>Referral code</label><input id=r required aria-hidden=true ${css}></form>`,
      `<form><label for=r>Referral code, leave this blank</label><input id=r required ${css}></form>`,
      `<form><label for=r>Referral code</label><input id=r ${css}></form>`,
    ]) {
      const { head, lines } = snap(page(html));
      assert.ok(lines.every((l) => !/ hidden\b/.test(l)), html + css + JSON.stringify(lines));
      if (css === faded) assert.deepEqual(lines, [], html);
      assert.equal(head.count, lines.length, html);
      const o = run(page(html), "fill", { label_pattern: "referral code", text: "AB12" });
      assert.match(o.error || "", /bot trap/, html + css + JSON.stringify(o));
    }
  }
});

test("snapshot: a required combobox input faded inside its painted box is a plain row, as fill sees it", () => {
  const w = page(`<form><div class=box><span>Select...</span><input id=c role=combobox aria-label=Region required style="opacity:0"></div></form>`);
  const { head, lines } = snap(w);
  assert.deepEqual(lines, [`1 combobox "Region" required`]);
  assert.deepEqual(head.form, { fields: 1, requiredEmpty: 1 });
  const o = run(w, "fill", { ref: "1", text: "West" });
  assert.equal(o.hidden, undefined, JSON.stringify(o));
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

test("snapshot: the form header carries the wizard's step, and only when one shows", () => {
  const html = readFileSync(new URL("./fixtures/wizard.html", import.meta.url), "utf8");
  const w = page(html.slice(html.indexOf("<body>") + 6, html.indexOf("<script>")));
  assert.equal(snap(w).head.form.step, "1/3");
  w.document.querySelector(".steps").remove();
  assert.equal(snap(w).head.form.step, "1/3", "the Step n of m text stands in");
  w.document.getElementById("count").remove();
  assert.equal("step" in snap(w).head.form, false);
});

// Required ticks count as wanted until one is ticked; the header and fill's
// census agree on the same form state. `fields` still counts text-like fields.
test("snapshot: required checkboxes, radio groups and ARIA radiogroups count in requiredEmpty, not fields", () => {
  const w = page(`<form><input name=nm aria-label=nm required><label><input type=checkbox name=tos required> I agree</label>
    <fieldset><legend>Authorized to work?</legend><label><input type=radio name=auth value=y required> Yes</label><label><input type=radio name=auth value=n> No</label><label><input type=radio name=auth value=s> Soon</label></fieldset>
    <div role=radiogroup aria-required=true aria-label=Sponsorship><div role=radio aria-checked=false tabindex=0>Yes</div><div role=radio aria-checked=false tabindex=-1>No</div></div>
    <div role=checkbox aria-required=true aria-checked=false aria-label=Consent tabindex=0></div></form>`);
  assert.deepEqual(snap(w).head.form, { fields: 1, requiredEmpty: 5 });
  const o = run(w, "fill_fields", { fields: [{ label_pattern: "^nm$", text: "Ada" }] });
  assert.deepEqual(o.form, { requiredEmpty: 4, left: [{ name: "tos", label: "I agree" }, { name: "auth", label: "Authorized to work?" }, { label: "Sponsorship" }, { label: "Consent" }] });
  assert.deepEqual(snap(w).head.form, { fields: 1, requiredEmpty: 4 });
  w.document.querySelector("[name=tos]").checked = true;
  w.document.querySelector("[name=auth][value=n]").checked = true;
  w.document.querySelector("[role=radio]").setAttribute("aria-checked", "true");
  w.document.querySelector("[role=checkbox]").setAttribute("aria-checked", "true");
  assert.deepEqual(snap(w).head.form, { fields: 1, requiredEmpty: 0 });
});

test("snapshot: disabled required fields and hidden required ticks leave requiredEmpty; form= fields join it", () => {
  const w = page(`<form id=f1><input name=a aria-label=a required value=x><input name=o required disabled><fieldset disabled><input name=fd required></fieldset>
    <div style="display:none"><label><input type=checkbox name=gone required> Gone</label><input type=radio name=g2 required></div></form><input name=ph aria-label=Phone form=f1 required>`);
  assert.deepEqual(snap(w).head.form, { fields: 3, requiredEmpty: 1 });
});

test("snapshot: a required tick hidden by visibility still gets a hidden row, named by its question", () => {
  const w = page(`<form><input name=nm aria-label=nm required value=A><fieldset><legend>Relocate?</legend><input type=radio name=rel required style="visibility:hidden"><input type=radio name=rel style="visibility:hidden"></fieldset></form>`);
  const { head, lines } = snap(w);
  assert.deepEqual(head.form, { fields: 1, requiredEmpty: 1 });
  assert.match(lines[lines.length - 1], /^\d+ radio "Relocate\?" name="rel".* hidden$/);
});

test("snapshot: a hidden required radio's row carries its group's question, and a nameless field its type", () => {
  const w = page(`<form><input name=nm aria-label=nm required value=A><div role=radiogroup aria-label="Need a visa?">
    <label for=v1 style="display:none">Yes</label><input type=radio id=v1 name=visa required style="visibility:hidden"></div>
    <div style="display:none"><input required></div></form>`);
  const { head, lines } = snap(w);
  assert.deepEqual(head.form, { fields: 2, requiredEmpty: 2 });
  assert.match(lines[lines.length - 2], /^\d+ radio "Need a visa\?" name="visa".* hidden$/);
  assert.match(lines[lines.length - 1], /^\d+ textbox "text" required hidden$/);
});
