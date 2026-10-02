// Which rows a snapshot keeps when the page has more than `max`: an open
// dialog's controls and the focused element first, then form fields and their
// submit buttons, then the rest in document order. Kept rows still print in
// document order with ascending refs; the header adds `omitted`. A page under
// the cap prints exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, run, runBody } from "./helpers/page.mjs";
import { build } from "./fixtures/large-dom.mjs";

const snap = (w, A = {}) => {
  const [head, ...lines] = run(w, "snapshot", { max: 500, ...A }).split("\n");
  return { head: JSON.parse(head.slice(2)), lines };
};
const unref = (l) => l.slice(l.indexOf(" ") + 1);
const refs = (lines) => lines.map((l) => Number(l.split(" ")[0]));
const ascending = (a) => a.every((x, i) => i === 0 || x > a[i - 1]);
const links = (k) => Array.from({ length: k }, (_, i) => `<a href="/l${i}">Link ${i}</a>`).join("");

test("large page: a capped snapshot keeps the big form's fields, which sit past the first 500 rows", () => {
  const w = page("");
  build(w.document);
  const { head, lines } = snap(w);
  assert.equal(lines.length, 500);
  assert.equal(head.truncated, true);
  const boxes = lines.filter((l) => / textbox /.test(l)).map((l) => l.split(" ")[0]);
  const inForm = runBody(w, `return ${JSON.stringify(boxes)}.filter(function (r) { return !!window.__perch_refs[r].closest("#big"); }).length`);
  assert.ok(inForm >= 60, `${inForm} of ${boxes.length} textbox rows in the form`);
  assert.ok(lines.some((l) => /^\d+ button "Save details"/.test(l)), "its submit button");
  assert.ok(ascending(refs(lines)), "document order");
  assert.ok(head.omitted > 2000, JSON.stringify(head));
});

test("an open modal dialog's controls get rows ahead of the background, printed in document order", () => {
  const w = page(`${links(100)}<div role=dialog aria-modal=true aria-label="Verify it's you"><label>Code <input></label><button>Verify</button></div>`);
  const { head, lines } = snap(w, { max: 5 });
  assert.deepEqual(lines.map(unref), [`link "Link 0" href="/l0"`, `link "Link 1" href="/l1"`, `dialog "Verify it's you"`, `textbox "Code"`, `button "Verify"`]);
  assert.ok(ascending(refs(lines)));
  assert.equal(head.count, 5);
  assert.equal(head.truncated, true);
  assert.equal(head.omitted, 98);
  assert.deepEqual(head.dialogs, ["Verify it's you"]);
});

test("a <dialog open> ranks the same, and the focused element keeps its row so focus names a ref", () => {
  const w = page(`${links(30)}<p><button id=f>Far away</button></p>${links(30)}<dialog open><button>Close</button></dialog>`);
  w.document.getElementById("f").focus();
  const { head, lines } = snap(w, { max: 3 });
  assert.deepEqual(lines.map(unref), [`link "Link 0" href="/l0"`, `button "Far away"`, `button "Close"`]);
  assert.equal(head.focus, lines[1].split(" ")[0]);
  assert.equal(head.omitted, 59);
});

test("form fields and the form's submit button outrank links and checkboxes outside any form", () => {
  const rows = Array.from({ length: 20 }, (_, i) => `<label><input type=checkbox> Row ${i}</label>`).join("");
  const w = page(`${links(20)}${rows}<form><label>Email <input type=email name=email></label>
    <label><input type=checkbox name=terms> I agree</label><button type=button>Help</button><button>Send</button></form>`);
  const { lines } = snap(w, { max: 4 });
  assert.deepEqual(lines.map(unref), [`link "Link 0" href="/l0"`, `textbox "Email" name="email" type="email"`, `checkbox "I agree" name="terms"`, `button "Send"`]);
});

test("a query ranks its matches too, and omitted counts the matches left out", () => {
  const w = page(`${links(10)}<form><label>Link code <input name=code></label></form>`);
  const { head, lines } = snap(w, { max: 2, query: "link" });
  assert.deepEqual(lines.map(unref), [`link "Link 0" href="/l0"`, `textbox "Link code" name="code"`]);
  assert.equal(head.matched, 11);
  assert.equal(head.omitted, 9);
});

test("a role filter narrows first, then the cap ranks what is left", () => {
  const w = page(`${links(10)}<form><label>Name <input name=n></label><button>Go</button></form>`);
  const { head, lines } = snap(w, { max: 1, role: ["link", "button"] });
  assert.deepEqual(lines.map(unref), [`button "Go"`]);
  assert.equal(head.omitted, 10);
});

test("a same-origin frame's form fields rank like the page's, keeping frame=N", () => {
  const w = page(`${links(10)}<iframe id=app data-rect="0,100,600,800"></iframe>`);
  w.document.getElementById("app").contentDocument.body.innerHTML = `<form><label for=fn>First name</label><input id=fn name=first required></form>`;
  const { head, lines } = snap(w, { max: 2 });
  assert.deepEqual(lines.map(unref), [`link "Link 0" href="/l0"`, `textbox "First name" name="first" required frame=0`]);
  assert.equal(head.omitted, 9);
});

test("max 0 is still the header alone, with the rows it left out", () => {
  const w = page(`${links(3)}<form><input name=q></form>`);
  const { head, lines } = snap(w, { max: 0 });
  assert.deepEqual(lines, []);
  assert.equal(head.truncated, true);
  assert.equal(head.omitted, 4);
});

test("a page under the cap prints as before: document order, no truncated or omitted, dialog or not", () => {
  const w = page(`<h1>Shop</h1>${links(3)}<form><label>Email <input name=e required></label><button>Send</button></form>
    <div role=dialog aria-modal=true aria-label=Promo><button>Close</button></div>`);
  const out = run(w, "snapshot", { max: 500 });
  const [head, ...lines] = out.split("\n");
  const h = JSON.parse(head.slice(2));
  assert.deepEqual(lines.map(unref), [`heading "Shop" level=1`, `link "Link 0" href="/l0"`, `link "Link 1" href="/l1"`, `link "Link 2" href="/l2"`,
    `textbox "Email" name="e" required`, `button "Send"`, `dialog "Promo"`, `button "Close"`]);
  assert.ok(ascending(refs(lines)));
  assert.equal("truncated" in h, false);
  assert.equal("omitted" in h, false);
  // Exactly at the cap is not truncated either.
  const exact = snap(w, { max: 8 });
  assert.equal(exact.lines.length, 8);
  assert.equal("truncated" in exact.head, false);
});
