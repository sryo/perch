// select on popover pickers (test/fixtures/pickers.html): Radix Popover + cmdk
// multi and single selects, and a Downshift combobox that opens only on input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/pickers.html", import.meta.url), "utf8");
const BODY = /<body>([\s\S]*?)<script>/.exec(FIXTURE)[1];
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(FIXTURE)[1];

function onPage(setup, extra = "") {
  const dom = page(BODY + extra);
  dom.eval(SCRIPT);
  if (setup) dom.eval(setup);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  dom.world = world;
  return dom;
}
const select = async (args) => {
  const r = await handleCall("select", args);
  return JSON.parse(r.content[0].text.replace(/^error: /, '"') + (r.isError ? '"' : ""));
};
const popovers = (dom) => dom.document.querySelectorAll("[data-radix-popper-content-wrapper]").length;
const badges = (dom, id) => [...dom.document.querySelectorAll(`#${id} .badge`)].map((b) => b.textContent);
const LANGS = ["English", "Spanish", "Portuguese", "French (Canada)"];

test("cmdk multi-select: each select picks from the trigger's own popover, reads the badges back, and closes it", async () => {
  const dom = onPage();
  let o = await select({ selector: "#langs", text: "spanish" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Spanish");
  assert.match(o.value, /Spanish/);
  assert.equal(popovers(dom), 0, "the popover select opened is closed");
  o = await select({ label_pattern: "^languages$", text: "French" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "French (Canada)");
  assert.equal(o.value, "Spanish, French (Canada)", "each badge reads back apart");
  assert.deepEqual(badges(dom, "langs"), ["Spanish", "French (Canada)"]);
  assert.deepEqual([...dom.pickerLog], ["langs:Spanish", "langs:French (Canada)"]);
  assert.equal(popovers(dom), 0);
});

test("cmdk multi-select: an option already chosen is not pressed again, since a press toggles it off", async () => {
  const dom = onPage();
  await select({ selector: "#langs", text: "Spanish" });
  const o = await select({ selector: "#langs", text: "Spanish" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Spanish");
  assert.deepEqual(badges(dom, "langs"), ["Spanish"]);
  assert.deepEqual([...dom.pickerLog], ["langs:Spanish"]);
  assert.equal(popovers(dom), 0);
});

test("cmdk: empty text lists the popover's enabled items and closes it", async () => {
  const dom = onPage();
  const o = await select({ selector: "#langs", text: "" });
  assert.equal(o.ok, false);
  assert.deepEqual(o.candidates, LANGS);
  assert.deepEqual([...dom.pickerLog], []);
  assert.equal(popovers(dom), 0);
  assert.equal(dom.document.querySelector("#langs").getAttribute("aria-expanded"), "false");
});

test("cmdk: a miss returns candidates, leaves no search text, and closes the popover", async () => {
  const dom = onPage();
  const o = await select({ selector: "#langs", text: "German" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.candidates, LANGS);
  assert.deepEqual([...dom.pickerLog], []);
  assert.equal(popovers(dom), 0);
  assert.equal(dom.document.querySelector("#langs").textContent, "Select all that apply");
});

test("cmdk: a disabled item is never pressed, and the miss says it is disabled", async () => {
  const dom = onPage();
  const o = await select({ selector: "#langs", text: "Klingon" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /disabled/);
  assert.deepEqual(o.candidates, LANGS);
  assert.deepEqual([...dom.pickerLog], []);
  assert.equal(popovers(dom), 0);
});

test("another trigger's open popover never supplies the pick", async () => {
  const dom = onPage(`document.getElementById('tools').click();`);
  let o = await select({ selector: "#langs", text: "Spanish" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual([...dom.pickerLog], ["langs:Spanish"]);
  assert.equal(popovers(dom), 0);
  dom.document.getElementById("langs").click();
  o = await select({ label_pattern: "^tools$", text: "Spanish" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Spanish tooling");
  assert.deepEqual([...dom.pickerLog], ["langs:Spanish", "tools:Spanish tooling"]);
  assert.equal(popovers(dom), 0);
});

test("a trigger that links nothing lists only the popover its own click opened", async () => {
  const dom = onPage(`document.getElementById('langs').click();`);
  const o = await select({ selector: "#tools", text: "" });
  assert.deepEqual(o.candidates, ["Figma", "Sketch", "Spanish tooling"], JSON.stringify(o));
  assert.equal(popovers(dom), 0);
});

test("a trigger that links nothing searches its own popover for an item it shows only when searched", async () => {
  const dom = onPage();
  const o = await select({ selector: "#tools", text: "Zeplin" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(badges(dom, "tools"), ["Zeplin"]);
  assert.equal(popovers(dom), 0);
});

test("a popover the user already opened is used as is and stays open", async () => {
  const dom = onPage(`document.getElementById('langs').click();`);
  const o = await select({ selector: "#langs", text: "English" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(badges(dom, "langs"), ["English"]);
  assert.equal(popovers(dom), 1);
});

test("cmdk single combobox: picks, closes itself, and a repeat does not toggle the value off", async () => {
  const dom = onPage();
  let o = await select({ label_pattern: "country", text: "Spain" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value, "Spain");
  o = await select({ label_pattern: "country", text: "spain" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(dom.document.getElementById("country").textContent, "Spain");
  assert.deepEqual([...dom.pickerLog], ["country:Spain"]);
  assert.equal(popovers(dom), 0);
});

test("Downshift: its toggle button lists the items, typing opens it to pick, and listing or a miss keep the selection", async () => {
  const dom = onPage();
  const input = dom.document.getElementById("downshift-:r0:-input");
  let o = await select({ label_pattern: "department", text: "" });
  assert.deepEqual(o.candidates, ["Engineering", "Design", "Product design lead", "Sales"], JSON.stringify(o));
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.value, "");
  o = await select({ label_pattern: "department", text: "Design" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value, "Design");
  assert.equal(dom.downshift.selectedItem, "Design");
  // The menu filters by the input's text, so a filled combobox lists what matches it.
  o = await select({ label_pattern: "department", text: "" });
  assert.deepEqual(o.candidates, ["Design", "Product design lead"], JSON.stringify(o));
  assert.equal(dom.downshift.selectedItem, "Design", "listing never clears the selection");
  assert.equal(input.value, "Design");
  const t0 = dom.world.clock.t;
  o = await select({ label_pattern: "department", text: "zz" });
  assert.equal(o.ok, false);
  assert.deepEqual(o.candidates, ["Design", "Product design lead"], JSON.stringify(o));
  assert.equal(dom.world.clock.t - t0, 550, "typed at 150ms, then 8 empty polls");
  assert.equal(dom.downshift.selectedItem, "Design");
  assert.equal(input.value, "Design");
  assert.equal(input.getAttribute("aria-expanded"), "false");
  // Without its toggle button the menu never opens for a listing, and Escape on a
  // closed Downshift menu would clear the selection.
  dom.document.getElementById("downshift-:r0:-toggle-button").remove();
  o = await select({ label_pattern: "department", text: "" });
  assert.equal(o.ok, false);
  assert.equal(dom.downshift.selectedItem, "Design");
  assert.equal(input.value, "Design");
});

// A popup whose options land inside a form dialog: the dialog's fields are not its search box.
const FORM_DIALOG = `document.body.insertAdjacentHTML("beforeend", '<div role="dialog" aria-modal="true"><label for="name">Name</label><input id="name" value="Ada">' +
  '<label for="t">Color</label><button id="t" type="button" aria-haspopup="listbox" aria-expanded="false">Pick a color</button><div id="opts"></div></div>');
window.nameFocus = 0;
document.getElementById("name").addEventListener("focus", function () { window.nameFocus++; });
document.getElementById("t").addEventListener("click", function () {
  document.getElementById("opts").innerHTML = '<div role="option">Red</div><div role="option">Blue</div>';
  this.setAttribute("aria-expanded", "true");
});`;

test("options that appear inside a form dialog never make its prefilled field the search box", async () => {
  const dom = onPage(FORM_DIALOG);
  const o = await select({ selector: "#t", text: "Green" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.candidates, ["Red", "Blue"]);
  assert.equal(dom.document.getElementById("name").value, "Ada");
  assert.equal(dom.nameFocus, 0, "the field is never focused");
});

// The dialog also holds an empty combobox of its own, whose list is not the one select picks from.
const FORM_COMBO = `document.body.insertAdjacentHTML("beforeend", '<div role="dialog" aria-modal="true"><label for="city">City</label><input id="city" role="combobox" aria-controls="citymenu" aria-expanded="false"><ul id="citymenu" role="listbox"></ul>' +
  '<label for="t">Color</label><button id="t" type="button" aria-haspopup="listbox" aria-expanded="false">Pick a color</button><div id="opts"></div></div>');
window.cityLog = [];
const city = document.getElementById("city");
city.addEventListener("focus", function () { window.cityLog.push("focus"); });
city.addEventListener("input", function () { window.cityLog.push(city.value); });
document.getElementById("t").addEventListener("click", function () {
  document.getElementById("opts").innerHTML = '<div role="option">Red</div><div role="option">Blue</div>';
  this.setAttribute("aria-expanded", "true");
});`;

test("another combobox in the dialog, naming a list select is not picking from, is never the search box", async () => {
  const dom = onPage(FORM_COMBO);
  const o = await select({ selector: "#t", text: "Green" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.candidates, ["Red", "Blue"]);
  assert.deepEqual([...dom.cityLog], [], "never focused or typed into");
});

// A portaled popup dialog that holds its own unrelated form field beside the options.
const POPUP_FORM = `document.body.insertAdjacentHTML("beforeend", '<label for="t2">Color</label><button id="t2" type="button" aria-haspopup="dialog" aria-expanded="false">Pick a color</button>');
window.noteFocus = 0;
document.getElementById("t2").addEventListener("click", function () {
  document.body.insertAdjacentHTML("beforeend", '<div role="dialog" id="pop"><input id="note" value="keep me"><div role="option">Red</div><div role="option">Blue</div></div>');
  document.getElementById("note").addEventListener("focus", function () { window.noteFocus++; });
  this.setAttribute("aria-expanded", "true");
});`;

test("a popup's own unrelated field is never taken as its search box", async () => {
  const dom = onPage(POPUP_FORM);
  const o = await select({ selector: "#t2", text: "Green" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual(o.candidates, ["Red", "Blue"]);
  assert.equal(dom.document.getElementById("note").value, "keep me");
  assert.equal(dom.noteFocus, 0, "the field is never focused");
});

const CITY = `<div class="field"><label for="city">City</label>
  <button id="city" type="button" role="combobox" aria-haspopup="dialog" aria-expanded="false" aria-controls="radix-:r8:" data-state="closed" data-picker="single" data-items="Paris|Paris, Texas|Lyon"><span class="placeholder">Select city...</span></button></div>`;

test("a single value with a comma is one value: an option equal to one of its parts is still pressed", async () => {
  const dom = onPage("", CITY);
  let o = await select({ selector: "#city", text: "Paris, Texas" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value, "Paris, Texas");
  o = await select({ selector: "#city", text: "Paris" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.note, undefined, JSON.stringify(o));
  assert.equal(o.value, "Paris");
  assert.equal(o.unverified, undefined, JSON.stringify(o));
  assert.deepEqual([...dom.pickerLog], ["city:Paris, Texas", "city:Paris"]);
});

// A single select whose display never changes after the pick.
const STUCK = `document.body.insertAdjacentHTML("beforeend", '<label for="c2">Town</label><button id="c2" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="l2"><span>Paris, Texas</span></button>');
window.stuckLog = [];
document.getElementById("c2").addEventListener("click", function () {
  document.body.insertAdjacentHTML("beforeend", '<div id="l2" role="listbox"><div role="option">Paris</div><div role="option">Paris, Texas</div></div>');
  document.querySelectorAll("#l2 [role=option]").forEach(function (o) { o.addEventListener("click", function () { window.stuckLog.push(o.textContent); document.getElementById("l2").remove(); }); });
  this.setAttribute("aria-expanded", "true");
});`;

test("a single value that only contains the pick does not verify it", async () => {
  const dom = onPage(STUCK);
  const o = await select({ selector: "#c2", text: "Paris" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.deepEqual([...dom.stuckLog], ["Paris"]);
  assert.equal(o.pressed, "Paris");
  assert.match(o.value, /Paris, Texas/);
  assert.match(o.error, /^pressed "Paris" but the control shows ".*Paris, Texas.*"; not verified$/);
  assert.equal(o.unverified, undefined, JSON.stringify(o));
});

const LEGACY = `<div class="field"><label for="speak">Speaks</label>
  <button id="speak" type="button" aria-haspopup="dialog" aria-expanded="false" data-state="closed" data-picker="multi" data-limit="2" data-items="Spanish (legacy)*|Figma|Spanish"><span class="placeholder">Select all that apply</span></button></div>`;

test("a disabled word-prefix match does not hide an enabled match the search box finds", async () => {
  const dom = onPage("", LEGACY);
  const o = await select({ selector: "#speak", text: "Spanish" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Spanish");
  assert.deepEqual([...dom.pickerLog], ["speak:Spanish"]);
});

// Single selects whose trigger holds more than the value: a label, or the value in a pill.
const SINGLES = `window.singleLog = [];
function single(id, inner, set) {
  document.body.insertAdjacentHTML("beforeend", '<button id="' + id + '" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="' + id + '-l">' + inner + '</button>');
  const t = document.getElementById(id);
  t.addEventListener("click", function () {
    document.body.insertAdjacentHTML("beforeend", '<div id="' + id + '-l" role="listbox"><div role="option">Berlin</div><div role="option">Paris</div><div role="option">Paris, Texas</div></div>');
    document.querySelectorAll("#" + id + "-l [role=option]").forEach(function (o) { o.addEventListener("click", function () { window.singleLog.push(id + ":" + o.textContent); set(t, o.textContent); document.getElementById(id + "-l").remove(); t.setAttribute("aria-expanded", "false"); }); });
    t.setAttribute("aria-expanded", "true");
  });
}
single("lab", '<b>Country:</b> <span>Paris</span>', function (t, v) { t.querySelector("span").textContent = v; });
single("twin", '<span class="v">Paris, Texas</span> <span class="v">Change:</span>', function (t, v) { t.querySelector(".v").textContent = v; });
single("pill", '<span class="badge rounded-pill">Paris, Texas</span>', function (t, v) { t.querySelector(".badge").textContent = v; });`;

test("a single select with a label in its trigger verifies the pick and does not press it twice", async () => {
  const dom = onPage(SINGLES);
  let o = await select({ selector: "#lab", text: "Berlin" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.unverified, undefined, JSON.stringify(o));
  o = await select({ selector: "#lab", text: "Berlin" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.match(o.note || "", /already chosen/);
  assert.deepEqual([...dom.singleLog], ["lab:Berlin"]);
});

test("a label and value alike in tag and class, or one pill, do not make a single select multi", async () => {
  const dom = onPage(SINGLES);
  for (const id of ["twin", "pill"]) {
    const o = await select({ selector: "#" + id, text: "Paris" });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(o.note, undefined, id + ": " + JSON.stringify(o));
  }
  assert.deepEqual([...dom.singleLog], ["twin:Paris", "pill:Paris"]);
});
