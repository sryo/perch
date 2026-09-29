// Snapshot coverage for styled form widgets: controls a stylesheet hides
// behind their visible label or wrapper, values a widget shows outside its
// input, toggle state kept in ARIA, and names that live in nearby text.
// The layout stub treats data-zero as a 0x0 box (a width:0;height:0 input).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("snapshot: a select's hidden required stand-in is not counted as a second field", () => {
  // react-select renders this input only while a required select is empty,
  // for native validation; the field it stands for is the combobox.
  const stub = `<input required tabindex=-1 aria-hidden=true class=requiredInput style="opacity:0;position:absolute">`;
  const w = page(`<form>
    <div id=c-l>Region</div>${RS("select", { id: "c" }).replace("</div>\n  </div>", `</div>${stub}</div>`)}
    <input name=first required>
  </form>`);
  assert.deepEqual(snap(w).head.form, { fields: 2, requiredEmpty: 2 });
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

// ---- validation errors ----

const lineOf = (lines, name) => lines.find((l) => l.includes(`"${name}"`));

test("snapshot: aria-invalid with an aria-describedby error shows invalid and the message", () => {
  const w = page(`<form>
    <div><label for=loc>Location</label><input id=loc name=loc aria-invalid=true aria-describedby=loc-err><div id=loc-err>Please enter your location</div></div>
    <div><label for=nm>Name</label><input id=nm name=nm value=Ada></div>
  </form>`);
  const { head, lines } = snap(w);
  assert.equal(lineOf(lines, "Location"), `1 textbox "Location" name="loc" invalid error="Please enter your location"`);
  assert.doesNotMatch(lineOf(lines, "Name"), /invalid|error=/);
  assert.equal(head.form.invalid, 1);
});

test("snapshot: a role=alert in the field's own box beats a neutral describedby hint", () => {
  const w = page(`<form>
    <div class=f><label for=em>Email</label><input id=em aria-invalid=true aria-describedby=em-hint><small id=em-hint>We will not share it</small><span role=alert>Email is required</span></div>
    <div class=f><label for=ph>Phone</label><input id=ph></div>
  </form>`);
  assert.match(lineOf(snap(w).lines, "Email"), / invalid error="Email is required"$/);
});

test("snapshot: an error in another field's box never attaches to this one", () => {
  const w = page(`<form>
    <div class=f><label for=a>First</label><input id=a><span role=alert>First is wrong</span></div>
    <div class=f><label for=b>Second</label><input id=b aria-invalid=true></div>
  </form>`);
  const { head, lines } = snap(w);
  assert.equal(lineOf(lines, "First"), `1 textbox "First"`);
  assert.match(lineOf(lines, "Second"), / textbox "Second" invalid$/);
  assert.equal(head.form.invalid, 1);
});

test("snapshot: a native constraint failure counts only once the field holds a value", () => {
  // happy-dom implements validity and validationMessage for type=email, with a generic message.
  const w = page(`<form>
    <label for=e>Email</label><input id=e type=email required value=abc>
    <label for=p>Phone</label><input id=p type=tel required>
    <label><input type=checkbox required> Terms</label>
  </form>`);
  const { head, lines } = snap(w);
  const msg = w.document.getElementById("e").validationMessage;
  assert.ok(msg, "happy-dom gives a validationMessage");
  assert.equal(lineOf(lines, "Email"), `1 textbox "Email" type="email" value="abc" required invalid error=${JSON.stringify(msg)}`);
  assert.doesNotMatch(lineOf(lines, "Phone"), /invalid/);
  assert.doesNotMatch(lineOf(lines, "Terms"), /invalid/);
  assert.equal(head.form.invalid, 1);
  assert.equal(head.form.requiredEmpty, 1);
});

test("snapshot: aria-errormessage wins over aria-describedby", () => {
  const w = page(`<form>
    <div><label for=z>Zip</label><input id=z aria-invalid=true aria-describedby=z-d aria-errormessage=z-e><p id=z-d class=error>Zip looks off</p></div>
    <p id=z-e>Enter a 5 digit zip</p>
  </form>`);
  assert.match(lineOf(snap(w).lines, "Zip"), / invalid error="Enter a 5 digit zip"$/);
});

test("snapshot: aria-invalid on a react-select combobox input marks its line", () => {
  const w = page(`<form><div class=field><div id=c-l>Country</div>${RS("rs", { id: "c" }).replace("role=combobox", "role=combobox aria-invalid=true")}<div class=field-error>Select a country</div></div></form>`);
  const { head, lines } = snap(w);
  assert.equal(lineOf(lines, "Country"), `1 combobox "Country" required invalid error="Select a country"`);
  assert.equal(head.form.invalid, 1);
});

test("snapshot: a form with no invalid field has no invalid key", () => {
  const w = page(`<form><label for=a>A</label><input id=a required></form>`);
  assert.deepEqual(snap(w).head.form, { fields: 1, requiredEmpty: 1 });
});

// ---- typeaheads ----

// A location typeahead keeps typed text; only its hidden companion holds a pick.
const LOC = ({ required = true, comp = "" } = {}) => `<form><div class=loc><label for=li>Location</label>
  <input id=li ${required ? "required" : ""}><input type=hidden id=sl name=selected-location value="${comp}"><div class=dropdown-results></div></div>
  <label for=nm>Name</label><input id=nm></form>`;
const type = (w, id, v) => Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(w.document.getElementById(id), v);

test("snapshot: typed text in a typeahead whose hidden companion is empty is unpicked", () => {
  const w = page(LOC());
  type(w, "li", "Buenos");
  let { head, lines } = snap(w);
  assert.equal(lineOf(lines, "Location"), `1 textbox "Location" value="Buenos" required unpicked`);
  assert.deepEqual(head.form, { fields: 2, requiredEmpty: 1, unpicked: 1 });
  w.document.getElementById("sl").value = "ChIJ0a";
  ({ head, lines } = snap(w));
  assert.equal(lineOf(lines, "Location"), `1 textbox "Location" value="Buenos" required`);
  assert.deepEqual(head.form, { fields: 2, requiredEmpty: 0 });
});

test("snapshot: an optional typeahead is flagged unpicked without counting as required", () => {
  const w = page(LOC({ required: false }));
  type(w, "li", "Buenos");
  const { head, lines } = snap(w);
  assert.match(lineOf(lines, "Location"), / unpicked$/);
  assert.deepEqual(head.form, { fields: 2, requiredEmpty: 0, unpicked: 1 });
});

test("snapshot: empty text, a prefilled companion, a shared box or a honeypot is never unpicked", () => {
  let w = page(LOC());
  let { head, lines } = snap(w);
  assert.doesNotMatch(lineOf(lines, "Location"), /unpicked/);
  assert.deepEqual(head.form, { fields: 2, requiredEmpty: 1 });
  w = page(LOC({ comp: "ChIJ0a" }));
  type(w, "li", "Buenos");
  assert.doesNotMatch(snap(w).lines.join("\n"), /unpicked/);
  w = page(`<form><div class=row><input type=hidden name=csrf><label for=a>City</label><input id=a><label for=b>Zip</label><input id=b></div>
    <div class=hp><input id=h name=website style="opacity:0" data-zero><input type=hidden name=hp></div>
    <input id=h2 name=url style="opacity:0"></form>`);
  for (const id of ["a", "h", "h2"]) type(w, id, "x");
  ({ head, lines } = snap(w));
  assert.doesNotMatch(lines.join("\n"), /unpicked/);
  assert.equal(head.form.unpicked, undefined);
});

test("snapshot: the pickers fixture's location field reads unpicked until a suggestion is picked", () => {
  const html = readFileSync(new URL("./fixtures/pickers.html", import.meta.url), "utf8");
  const w = page(/<body>([\s\S]*?)<script>/.exec(html)[1]);
  w.eval(/<script>([\s\S]*?)<\/script>/.exec(html)[1]);
  const li = w.document.getElementById("li");
  li.value = "Ros";
  li.dispatchEvent(new w.Event("input", { bubbles: true }));
  let { head, lines } = snap(w);
  assert.match(lineOf(lines, "Work location"), /value="Ros" required unpicked$/);
  assert.deepEqual(head.form, { fields: 1, requiredEmpty: 1, unpicked: 1 });
  w.document.querySelector(".loc-pick .dropdown-item").dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
  ({ head, lines } = snap(w));
  assert.match(lineOf(lines, "Work location"), /value="Rosario, Santa Fe, Argentina" required$/);
  assert.deepEqual(head.form, { fields: 1, requiredEmpty: 0 });
});
