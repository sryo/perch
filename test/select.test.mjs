// select runs through the real JXA runtime (fake world) against a happy-dom page,
// so the start / pick / readback phases are polled JXA-side as in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

function onPage(html, setup) {
  const dom = page(html);
  if (setup) dom.eval(setup);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return { dom, world };
}
const select = async (args) => {
  const r = await handleCall("select", args);
  return { r, o: JSON.parse(r.content[0].text.replace(/^error: /, '"') + (r.isError ? '"' : "")) };
};

const NATIVE = `<label>Country <select><option value="">Pick</option><option value=ar>Argentina</option><option value=br>Brazil</option></select></label>`;

test("native select: exact text, value, substring; candidates on miss", async () => {
  onPage(NATIVE);
  assert.deepEqual((await select({ label_pattern: "country", text: "Argentina" })).o, { ok: true, selected: "Argentina", el: `combobox "Country"` });
  assert.equal((await select({ label_pattern: "country", text: "br" })).o.selected, "Brazil");
  assert.equal((await select({ label_pattern: "country", text: "razi" })).o.selected, "Brazil");
  const miss = (await select({ label_pattern: "country", text: "Chile" })).o;
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.candidates, ["Pick", "Argentina", "Brazil"]);
});

// A react-select-like widget: opens only for a left-button press with a view,
// renders options on open, and shows the choice in the control.
const CUSTOM = `<label id=lab>Level</label><div class="select__control"><div role=combobox aria-labelledby=lab aria-expanded=false tabindex=0><span class=v>Choose</span></div></div><div id=menu></div>`;
const CUSTOM_JS = `
  const cb = document.querySelector('[role=combobox]');
  window.opens = 0;
  document.querySelector('.select__control').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.view) return;
    window.opens++;
    cb.setAttribute('aria-expanded', 'true');
    document.getElementById('menu').innerHTML = '<div role=option>Junior</div><div role=option>Senior</div>';
    document.querySelectorAll('[role=option]').forEach(o => o.addEventListener('click', () => { cb.querySelector('.v').textContent = o.textContent; }));
  });`;

test("custom combobox: opens with a real left press, picks, verifies", async () => {
  const { dom } = onPage(CUSTOM, CUSTOM_JS);
  const { o } = await select({ label_pattern: "level", text: "senior" });
  assert.deepEqual(o, { ok: true, selected: "Senior", el: `combobox "Level"`, value: "Senior" });
  assert.equal(dom.opens, 1);
});

test("custom combobox: no matching option lists what was there", async () => {
  onPage(CUSTOM, CUSTOM_JS);
  const { o } = await select({ label_pattern: "level", text: "principal" });
  assert.equal(o.ok, false);
  assert.deepEqual(o.candidates, ["Junior", "Senior"]);
});

test("custom combobox that never shows the choice is flagged unverified", async () => {
  onPage(CUSTOM, CUSTOM_JS.replace("cb.querySelector('.v').textContent = o.textContent;", ""));
  const { o } = await select({ label_pattern: "level", text: "junior" });
  assert.equal(o.ok, true);
  assert.equal(o.unverified, true);
});

test("select validates its arguments before touching the page", async () => {
  onPage(NATIVE);
  assert.match((await handleCall("select", { text: "x" })).content[0].text, /requires `ref`, `selector`, or `label_pattern`/);
  assert.match((await handleCall("select", { label_pattern: "(", text: "x" })).content[0].text, /invalid label_pattern/);
});
