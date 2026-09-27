// A frame click posts at its row's fresh Accessibility center, so Accessibility's
// hit test at that point must land on that row's element in that row's frame. A
// sign-in, challenge or blank frame positioned over it would otherwise take the
// trusted click.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const AREA = { x: 56, y: 157, w: 598, h: 500 };
const COVERED = /is covered at its center by something else \(another frame or an overlay\); nothing was clicked/;

// A card frame holding a Pay button, plus `over`: frames painted after it.
function world(over = [], payKids = []) {
  const dom = page(`<button id=b>Go</button>`, { url: "https://shop.test/checkout" });
  Object.defineProperty(dom, "innerWidth", { value: 598, configurable: true });
  Object.defineProperty(dom, "innerHeight", { value: 500, configurable: true });
  const pay = { url: "https://js.pay.example/v3/card", box: { x: 100, y: 300, w: 400, h: 150 }, kids: [
    { role: "AXButton", title: "Pay", box: { x: 110, y: 390, w: 100, h: 40 } },
  ].concat(payKids) };
  const w = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "https://shop.test/checkout", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ ...AREA, frames: [pay].concat(over) }] } }],
  });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = w.daemon;
  DAEMONS.slow = w.daemon;
  w.reset();
  return w;
}

const text = (r) => r.content[0].text;
const snap = async () => text(await handleCall("accessibility_snapshot", { frames: true }));
const click = async (ref, extra = {}) => JSON.parse(text(await handleCall("click", { ref, trusted: true, ...extra })));
const presses = (w) => w.posted.filter((e) => (e.type === 1 || e.type === 2) && e.pt.x >= 0);
const payRef = (s) => /^(f\d+) button "Pay"/m.exec(s)[1];

for (const url of ["https://challenges.cloudflare.com/cdn-cgi/challenge", "https://accounts.google.com/gsi/iframe", "about:blank"]) {
  for (const raise of [false, true]) {
    test(`a frame button covered by a ${url} frame is refused${raise ? ", raised" : ""}, with nothing posted`, async () => {
      const w = world([{ url, box: { x: 100, y: 380, w: 300, h: 65 }, kids: [{ role: "AXCheckBox", title: "Verify you are human", box: { x: 120, y: 395, w: 20, h: 20 } }] }]);
      const o = await click(payRef(await snap()), { raise });
      assert.equal(o.ok, false, JSON.stringify(o));
      assert.match(o.error, COVERED);
      assert.deepEqual(presses(w), []);
    });
  }
}

test("a control of the same frame drawn over the button is refused too", async () => {
  const w = world([], [{ role: "AXLink", title: "Promo", box: { x: 100, y: 380, w: 300, h: 60 } }]);
  const o = await click(payRef(await snap()));
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, COVERED);
  assert.deepEqual(presses(w), []);
});

test("without CFEqual, a same-size control in a covering frame is still told apart by its frame", async () => {
  const w = world([{ url: "about:blank", box: { x: 100, y: 380, w: 300, h: 65 }, kids: [{ role: "AXButton", title: "Pay", box: { x: 110, y: 390, w: 100, h: 40 } }] }]);
  w.state.unbound = ["CFEqual"];
  const o = await click(payRef(await snap()));
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, COVERED);
  assert.deepEqual(presses(w), []);
});

test("a hit test that fails refuses the frame click", async () => {
  const w = world();
  const ref = payRef(await snap());
  w.state.hitFail = true;
  const o = await click(ref);
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, COVERED);
  assert.deepEqual(presses(w), []);
});

test("an uncovered frame button, or one beside a frame that doesn't reach it, still clicks", async () => {
  for (const over of [[], [{ url: "about:blank", box: { x: 300, y: 380, w: 100, h: 65 }, kids: [] }]]) {
    const w = world(over);
    const o = await click(payRef(await snap()));
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.deepEqual(presses(w).map((e) => e.pt), [{ x: 160, y: 410 }, { x: 160, y: 410 }]);
  }
});
