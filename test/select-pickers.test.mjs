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

function onPage(setup) {
  const dom = page(BODY);
  dom.eval(SCRIPT);
  if (setup) dom.eval(setup);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
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
  o = await select({ label_pattern: "department", text: "zz" });
  assert.equal(o.ok, false);
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
