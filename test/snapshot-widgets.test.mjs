// Snapshot coverage for styled form widgets: controls a stylesheet hides
// behind their visible label or wrapper, values a widget shows outside its
// input, toggle state kept in ARIA, and names that live in nearby text.
// The layout stub treats data-zero as a 0x0 box (a width:0;height:0 input).
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, run, runBody } from "./helpers/page.mjs";

const snap = (w, A = {}) => {
  const [head, ...lines] = run(w, "snapshot", { max: 500, ...A }).split("\n");
  return { head: JSON.parse(head.slice(2)), lines };
};
const HIDE = `style="opacity:0" data-zero`;

test("snapshot: a visually hidden radio or checkbox is listed under its visible label", () => {
  const w = page(`
    <div role=radiogroup aria-label="Experience">
      <div class=r><input type=radio id=r0 name=exp ${HIDE} aria-checked=false><label for=r0>Yes</label></div>
      <div class=r><input type=radio id=r1 name=exp ${HIDE} checked><label for=r1>No</label></div>
    </div>
    <input type=checkbox id=c name=consent ${HIDE}><label for=c>I agree</label>
    <label><span><input type=radio name=q1 ${HIDE}></span><span class=control></span><span>Option A</span></label>
    <input type=checkbox name=gone style="display:none"><label style="display:none"><input type=radio name=gone2 ${HIDE}>Gone</label>
    <div style="display:none"><input type=radio id=g3 name=gone3 ${HIDE}></div><label for=g3>Collapsed</label>`);
  const { lines } = snap(w);
  assert.deepEqual(lines, [
    `1 radiogroup "Experience"`,
    `2 radio "Yes" name="exp"`,
    `3 radio "No" name="exp" checked`,
    `4 checkbox "I agree" name="consent"`,
    `5 radio "Option A" name="q1"`,
  ]);
  const r = run(w, "fill_fields", { fields: [{ ref: "4", checked: true }, { ref: "2", checked: true }] }).results;
  assert.equal(r[0].ok && r[1].ok, true, JSON.stringify(r));
  assert.equal(w.document.getElementById("c").checked, true);
  assert.equal(w.document.getElementById("r0").checked, true);
});

const RS = (p, { picked = "", multi = [], required = true, id = p } = {}) => `
  <div class="${p}__control">
    <div class="${p}__value-container">
      ${picked ? `<div class="${p}__single-value">${picked}</div>` : multi.length ? "" : `<div class="${p}__placeholder">Select...</div>`}
      ${multi.map((m) => `<div class="${p}__multi-value"><div class="${p}__multi-value__label">${m}</div><div class="${p}__multi-value__remove">x</div></div>`).join("")}
      <input class="${p}__input" role=combobox id=${id} aria-labelledby=${id}-l ${required ? "aria-required=true" : ""} ${picked || multi.length ? `style="opacity:0"` : ""}>
    </div>
  </div>`;

test("snapshot: a non-searchable select's dummy input is listed through its visible control", () => {
  const w = page(`<div id=lbl>English level</div>
    <div class="dropdown__control"><div class="dropdown__value-container"><div class="dropdown__placeholder">Choose</div>
    <input role=combobox inputmode=none aria-readonly=true aria-labelledby=lbl style="opacity:0;width:1px;transform:scale(.01)"></div></div>`);
  assert.deepEqual(snap(w).lines, [`1 combobox "English level"`]);
});

test("snapshot: a picked select keeps its combobox with the shown value, and counts as filled", () => {
  const w = page(`<form>
    <div id=a-l>Country</div>${RS("select", { id: "a", picked: "Picked" })}
    <div id=b-l>Languages</div>${RS("select", { id: "b", multi: ["One", "Two"] })}
    <div id=c-l>Region</div>${RS("select", { id: "c" })}
    <label>Resume <input type=file name=cv required></label>
  </form>`);
  const { head, lines } = snap(w);
  assert.deepEqual(lines, [
    `1 combobox "Country" value="Picked" required`,
    `2 combobox "Languages" value="One, Two" required`,
    `3 combobox "Region" required`,
    `4 textbox "Resume" name="cv" type="file" required`,
  ]);
  assert.equal(head.form.requiredEmpty, 2);
});

test("snapshot: a typed combobox shows its value; a nearby unlinked label beats the placeholder", () => {
  const w = page(`<div class=field><label class=title>Location</label>
    <div class=wrap><input role=combobox placeholder="Start typing..."></div></div>`);
  w.document.querySelector("input").value = "City, Region, Country";
  assert.deepEqual(snap(w).lines, [`1 combobox "Location" value="City, Region, Country"`]);
});

test("snapshot: pressed, checked and selected come from ARIA state too", () => {
  const w = page(`<div class=yesno><button aria-pressed=true>Yes</button><button aria-pressed=false>No</button><input type=checkbox tabindex=-1 name=u style="display:none"></div>
    <div role=checkbox aria-checked=true tabindex=0>Remember</div>
    <div role=tablist><div role=tab aria-selected=true>One</div><div role=tab aria-selected=false>Two</div></div>`);
  assert.deepEqual(snap(w).lines, [
    `1 button "Yes" pressed`,
    `2 button "No"`,
    `3 checkbox "Remember" checked`,
    `4 tablist "One Two"`,
    `5 tab "One" selected`,
    `6 tab "Two"`,
  ]);
});

test("accName: an unlabeled field takes the question text laid out before it", () => {
  const w = page(`<ul><li class=question><div>
      <div class=label-like><div class=text>Question?<span>✱</span></div></div>
      <div class=field><textarea id=t name="cards[abc][field0]" required></textarea></div>
    </div></li>
    <li><div class=text>Unrelated</div></li>
    <li><input id=bare name=bare_name></li></ul>
    <label>First <input id=f1></label><input id=f2 name=second>`);
  assert.deepEqual(runBody(w, `return ['t', 'bare', 'f2'].map(id => accName(document.getElementById(id)))`),
    ["Question? ✱", "bare_name", "second"]);
});

test("accName: a wrapping label's hidden text and popups are not part of the name", () => {
  const w = page(`<label>Current location <span>✱</span>
    <input id=x role=combobox>
    <div role=listbox><div role=option>No location found...</div></div>
    <div class=dropdown-results>No location found...</div>
    <span style="display:none">Loading</span><span hidden>Loading</span></label>`);
  assert.equal(runBody(w, `return accName(document.getElementById('x'))`), "Current location ✱");
});
