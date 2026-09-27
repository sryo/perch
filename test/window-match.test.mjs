// Matching the target window to its CG entry and its Accessibility window. Two
// windows of one browser with the same frame can't be told apart by geometry, so
// frames and trusted input fail closed rather than read or click the other one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const AREA = { x: 56, y: 157, w: 598, h: 500 };
const FRAME = { x: 0, y: 57, w: 854, h: 600 };

// Window 1 shows the target tab; window 2, in front in the CG list, shows
// another page whose frame has a "Steal" button. `other` shapes window 2's CG entry.
function twoWindows({ other = {}, mine = {} } = {}) {
  const dom = page(`<button id=b>Go</button>`, { url: "https://shop.test/" });
  const dom2 = page(`<button>Other</button>`, { url: "https://other.test/" });
  for (const w of [dom, dom2]) {
    Object.defineProperty(w, "innerWidth", { value: 598, configurable: true });
    Object.defineProperty(w, "innerHeight", { value: 500, configurable: true });
  }
  const pay = { url: "https://pay.example/", box: { x: 100, y: 300, w: 400, h: 150 }, kids: [{ role: "AXButton", title: "Pay", box: { x: 110, y: 390, w: 100, h: 40 } }] };
  const evil = { url: "https://evil.example/", box: { x: 100, y: 300, w: 400, h: 150 }, kids: [{ role: "AXButton", title: "Steal", box: { x: 110, y: 390, w: 100, h: 40 } }] };
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [
      { id: 1, active: 0, ...FRAME, tabs: [{ url: "https://shop.test/", id: "t", dom }] },
      { id: 2, active: 0, ...FRAME, tabs: [{ url: "https://other.test/", id: "u", dom: dom2 }] },
    ] }],
    cg: [
      { owner: "Google Chrome", pid: 4242, wid: 51, ...FRAME, ax: { web: [{ ...AREA, frames: [evil] }] }, ...other },
      { owner: "Google Chrome", pid: 4242, wid: 50, ...FRAME, ax: { web: [{ ...AREA, frames: [pay] }] }, ...mine },
    ],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}

const text = (r) => r.content[0].text;
const head = (s) => JSON.parse(s.split("\n")[0].slice(2));
const snap = async () => {
  const r = await handleCall("accessibility_snapshot", { frames: true, target: { tabId: "t" } });
  assert.equal(r.isError, undefined, text(r));
  return text(r);
};

test("two same-frame windows: frames is window_ambiguous and never lists the other window's controls", async () => {
  const world = twoWindows();
  const s = await snap();
  assert.doesNotMatch(s, /Steal/);
  assert.match(head(s).frames.error, /^window_ambiguous: /);
  assert.equal(s.split("\n")[1], `1 button "Go"`);
  assert.deepEqual(world.posted, []);
});

test("two same-frame windows: trusted click is window_ambiguous and posts nothing", async () => {
  const world = twoWindows();
  for (const raise of [false, true]) {
    const r = await handleCall("click", { trusted: true, raise, selector: "#b", target: { tabId: "t" } });
    assert.match(text(r), /window_ambiguous: /, `raise:${raise}`);
    assert.deepEqual(world.posted.filter((e) => e.kind === "mouse"), [], `raise:${raise}`);
  }
});

test("a window of another size nearby does not count as a tie", async () => {
  twoWindows({ other: { w: 700 } });
  const s = await snap();
  assert.doesNotMatch(s, /Steal/);
  assert.match(s, /^f1 button "Pay" frame="pay\.example"$/m);
});

// The CG entries differ, so the CGWindowID is known, but two AX windows sit
// within the geometry tolerance of the target's frame.
test("two AX windows at the target's frame: no page area, so no frame rows", async () => {
  twoWindows({ other: { x: 900, axFrame: FRAME } });
  const s = await snap();
  assert.doesNotMatch(s, /Steal/);
  assert.match(head(s).frames.error, /^no page area/);
});

test("the AX window's own CGWindowID settles a geometric tie", async () => {
  twoWindows({ other: { x: 900, axFrame: FRAME, axWid: 51 }, mine: { axWid: 50 } });
  const s = await snap();
  assert.doesNotMatch(s, /Steal/);
  assert.match(s, /^f1 button "Pay" frame="pay\.example"$/m);
});

test("an AX window whose CGWindowID is readable and different is never used", async () => {
  twoWindows({ other: { x: 900, ax: { web: [] } }, mine: { axWid: 77 } });
  const s = await snap();
  assert.match(head(s).frames.error, /^no page area/);
});

test("a frame click whose window became ambiguous posts nothing", async () => {
  const world = twoWindows({ other: { x: 900, ax: { web: [] } } });
  const s = await snap();
  assert.match(s, /^f1 button "Pay"/m);
  // Window 2's AX window moves onto the target's frame, showing an identical frame.
  world.cg[0].axFrame = FRAME;
  world.cg[0].ax = world.cg[1].ax;
  world.reset();
  const r = await handleCall("click", { trusted: true, ref: "f1", target: { tabId: "t" } });
  assert.doesNotMatch(text(r), /"ok":true/);
  assert.deepEqual(world.posted.filter((e) => e.kind === "mouse"), []);
});
