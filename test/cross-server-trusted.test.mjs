// A trusted click arms a recorder on the page (window.__perch_trusted), posts
// the press, then reads what the recorder saw. Mouse events carry no caller, so
// when a second perch server's probe replaces the recorder, the first call's
// check says its outcome is not verified, and the second still reads its own press.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, pageScript, TRUSTED_TAKEN } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

function setup() {
  const dom = page(`<button id=a>A</button><button id=b>B</button>`, { url: "https://form.test/" });
  for (const [k, v] of Object.entries({ screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 })) Object.defineProperty(dom, k, { value: v, configurable: true });
  dom.eval(`window.downs = []; window.addEventListener("mousedown", (e) => window.downs.push(e.target.id), true);`);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "https://form.test/", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 798, h: 500, frames: [] }] } }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return { dom, world };
}
// The press lands on `id` as a trusted mousedown; `first` runs just before it.
function onPress(world, dom, id, first) {
  world.state.onPost = (e) => {
    if (e.type !== 1 || e.pt.x < 0) return;
    if (first) first();
    const ev = new dom.MouseEvent("mousedown", { bubbles: true, composed: true });
    Object.defineProperty(ev, "isTrusted", { value: true });
    dom.document.getElementById(id).dispatchEvent(ev);
  };
}
const click = async (selector) => JSON.parse((await handleCall("click", { trusted: true, selector })).content[0].text);

test("trusted click: a check that finds another call's recorder is not verified, never a hit or a miss", async () => {
  const { dom, world } = setup();
  let b = null;
  onPress(world, dom, "a", () => { b = run(dom, "trusted_probe", { selector: "#b" }); });
  const o = await click("#a");
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.error, TRUSTED_TAKEN);
  assert.equal(o.hit, undefined);
  assert.equal(o.rec, undefined, "the recorder's token stays out of the result");
  assert.deepEqual([...dom.downs], ["a"]);
  // A's press reached B's recorder first; B's own press is still the one it reads.
  const ev = new dom.MouseEvent("mousedown", { bubbles: true, composed: true });
  dom.document.getElementById("b").dispatchEvent(ev);
  assert.deepEqual(run(dom, "trusted_check", {}), { hit: true, rec: b.rec });
});

test("trusted click: a press that only ever lands elsewhere is still a miss", () => {
  const { dom } = setup();
  const p = run(dom, "trusted_probe", { selector: "#b" });
  dom.document.getElementById("a").dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, composed: true }));
  assert.deepEqual(run(dom, "trusted_check", {}), { hit: false, rec: p.rec });
});

test("trusted click: a click alone reads its own hit, with no token in its result", async () => {
  const { dom, world } = setup();
  onPress(world, dom, "a");
  const o = await click("#a");
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.hit, true);
  assert.equal(o.rec, undefined);
});

test("trusted probe and check are byte-identical across calls, with no token in A", () => {
  assert.equal(pageScript("trusted_check", {}), pageScript("trusted_check", {}));
  assert.equal(pageScript("trusted_probe", { selector: "#a" }), pageScript("trusted_probe", { selector: "#a" }));
  assert.ok(!/"(tok|rec)":/.test(pageScript("trusted_check", {}).split("\n")[0]));
});
