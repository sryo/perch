// A trusted click posts only where Accessibility's hit test, at the exact screen
// point, lands inside the page's own web area. Page JS can't see into a closed
// shadow root, and elementFromPoint retargets a hit in any shadow tree to its
// host, so an embedded frame there is only visible to this check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run, deliverPress } from "./helpers/page.mjs";

const AREA = { x: 56, y: 157, w: 598, h: 500 };
const OFF = /the point is not on the page itself \(embedded frame or browser UI\); frame controls need accessibility_snapshot \{frames:true\} and an fN ref/;
// The host's shadow iframe: viewport 100..400 x 100..165, so its center is (250, 132.5).
const WIDGET = { url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile", box: { x: 156, y: 257, w: 300, h: 65 }, kids: [
  { role: "AXCheckBox", title: "Verify you are human", box: { x: 170, y: 270, w: 24, h: 24 } },
] };

// A background (or raised) Chrome window whose page area is AREA at zoom 1, and
// whose page estimate agrees with it. `mode` puts a turnstile-like host holding
// an iframe in an open or closed shadow root.
function world({ mode = null, frames = [], web = null, html = "" } = {}) {
  const dom = page(`<button id=b>Go</button><input id=i>${html}`, { url: "https://shop.test/" });
  for (const [k, v] of Object.entries({ screenX: 0, screenY: 57, outerWidth: 654, innerWidth: 598, outerHeight: 600, innerHeight: 500 })) {
    Object.defineProperty(dom, k, { value: v, configurable: true });
  }
  if (mode) {
    const host = dom.document.createElement("div");
    host.id = "cf";
    host.className = "cf-turnstile";
    dom.document.body.appendChild(host);
    host.attachShadow({ mode }).innerHTML = `<iframe title="Widget containing a Cloudflare security challenge"></iframe>`;
    host.getBoundingClientRect = () => ({ x: 100, y: 100, left: 100, top: 100, right: 400, bottom: 165, width: 300, height: 65 });
    // elementFromPoint retargets a hit inside a shadow tree to its host.
    dom.document.elementFromPoint = (x, y) => (y >= 100 && y < 165 && x >= 100 && x < 400 ? host : dom.document.getElementById("b"));
  }
  const w = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "https://shop.test/", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: web || [{ ...AREA, frames: (mode ? [WIDGET] : []).concat(frames) }] } }],
  });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = w.daemon;
  DAEMONS.slow = w.daemon;
  w.reset();
  w.dom = dom;
  return w;
}

const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content[0].text;
  try { return JSON.parse(t); } catch { return { ok: false, error: t, isError: r.isError }; }
};
const click = (args) => call("click", { trusted: true, ...args });
// Presses and releases only: calibration and primer moves are not clicks.
const clicks = (w) => w.posted.filter((e) => (e.type === 1 || e.type === 2) && e.pt.x >= 0).map((e) => [e.type, e.pt]);
const keys = (w) => w.posted.filter((e) => e.kind === "key");

for (const mode of ["open", "closed"]) {
  for (const raise of [false, true]) {
    test(`a shadow host (${mode} root) whose iframe covers its center is refused${raise ? ", raised" : ""}, with nothing posted`, async () => {
      const w = world({ mode });
      const o = await click({ selector: ".cf-turnstile", raise });
      assert.equal(o.ok, false, JSON.stringify(o));
      assert.match(o.error, OFF);
      assert.deepEqual(clicks(w), []);
      assert.deepEqual(w.state.cursor, { x: 1, y: 2 });
    });

    test(`a point on a shadow-rooted (${mode}) iframe is refused${raise ? ", raised" : ""}, with nothing posted`, async () => {
      const w = world({ mode });
      const o = await click({ x: 306, y: 289, raise });
      assert.equal(o.ok, false, JSON.stringify(o));
      assert.deepEqual(clicks(w), []);
    });
  }
}

test("an overlay whose closed shadow root holds a frame over the target is refused", async () => {
  const w = world({ frames: [{ url: "https://ads.example/slot", box: { x: 56, y: 157, w: 598, h: 100 }, kids: [] }] });
  const host = w.dom.document.createElement("div");
  w.dom.document.body.appendChild(host);
  host.attachShadow({ mode: "closed" }).innerHTML = `<iframe></iframe>`;
  w.dom.document.elementFromPoint = () => host;
  for (const raise of [false, true]) {
    const o = await click({ selector: "#b", raise });
    assert.equal(o.ok, false, JSON.stringify(o));
    assert.match(o.error, OFF);
  }
  assert.deepEqual(clicks(w), []);
});

test("a frame exactly the page area's size is still another web area, and refused", async () => {
  const w = world({ frames: [{ url: "https://interstitial.example/", box: { ...AREA }, kids: [] }] });
  const o = await click({ selector: "#b" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, OFF);
  assert.deepEqual(clicks(w), []);
});

test("a point on the browser's own chrome is refused, background and raised", async () => {
  const w = world();
  for (const raise of [false, true]) {
    const o = await click({ x: 300, y: 100, raise });
    assert.equal(o.ok, false, JSON.stringify(o));
    assert.match(o.error, OFF);
  }
  assert.deepEqual(clicks(w), []);
});

test("a point on a frame nested inside an ordinary frame is refused", async () => {
  const inner = { url: "https://accounts.example/widget", box: { x: 300, y: 400, w: 200, h: 100 }, kids: [] };
  const w = world({ frames: [{ url: "https://pay.example/", box: { x: 200, y: 350, w: 400, h: 250 }, kids: [], frames: [inner] }] });
  for (const pt of [{ x: 350, y: 450 }, { x: 250, y: 360 }]) {
    const o = await click(pt);
    assert.equal(o.ok, false, JSON.stringify(o));
    assert.match(o.error, OFF);
  }
  assert.deepEqual(clicks(w), []);
});

test("a point under a JS dialog's child window is refused", async () => {
  const w = world();
  w.state.dialogs = [{ pid: 4242, parent: 50, frame: { x: 56, y: 157, w: 300, h: 100 }, texts: ["shop.test says", "Sure?"], buttons: ["Cancel", "OK"] }];
  const o = await click({ selector: "#b" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, OFF);
  assert.deepEqual(clicks(w), []);
});

test("a hit test that fails, or can't be bound, refuses: nothing is posted", async () => {
  let w = world();
  w.state.hitFail = true;
  for (const args of [{ selector: "#b" }, { x: 106, y: 167 }, { selector: "#b", raise: true }]) {
    const o = await click(args);
    assert.equal(o.ok, false, JSON.stringify(args));
    assert.match(o.error, OFF);
  }
  assert.deepEqual(clicks(w), []);
  w = world();
  w.state.unbound = ["AXUIElementCopyElementAtPosition"];
  const o = await click({ selector: "#b" });
  assert.equal(o.ok, false);
  assert.match(o.error, OFF);
  assert.deepEqual(clicks(w), []);
});

test("without a page area from Accessibility nothing is clicked (no aim by estimate alone)", async () => {
  const w = world({ web: [] });
  for (const args of [{ selector: "#b" }, { selector: "#b", raise: true }, { x: 106, y: 167 }]) {
    const o = await click(args);
    assert.equal(o.ok, false, JSON.stringify(args));
    assert.match(o.error, OFF);
  }
  assert.deepEqual(clicks(w), []);
});

test("ordinary page clicks still post, by selector and by point, background and raised", async () => {
  const w = world({ mode: "closed" });
  deliverPress(w, w.dom);
  for (const raise of [false, true]) {
    w.posted.length = 0;
    let o = await click({ selector: "#b", raise });
    assert.equal(o.aim, "ax", JSON.stringify(o));
    assert.deepEqual(clicks(w), [[1, { x: 106, y: 167 }], [2, { x: 106, y: 167 }]]);
    w.posted.length = 0;
    o = await click({ x: 120, y: 170, raise });
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.deepEqual(clicks(w), [[1, { x: 120, y: 170 }], [2, { x: 120, y: 170 }]]);
  }
});

test("a page click with no CFEqual binding matches the page area by frame", async () => {
  const w = world();
  w.state.unbound = ["CFEqual"];
  const o = await click({ selector: "#b" });
  assert.equal(o.aim, "ax", JSON.stringify(o));
  assert.equal(clicks(w).length, 2);
});

test("raised trusted fill refuses a field under a shadow-rooted frame, typing nothing", async () => {
  const w = world({ frames: [{ url: "https://ads.example/slot", box: { x: 56, y: 157, w: 598, h: 100 }, kids: [] }] });
  const o = await call("fill", { trusted: true, raise: true, selector: "#i", text: "hello" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, OFF);
  assert.deepEqual(clicks(w), []);
  assert.deepEqual(keys(w), []);
});

test("raised trusted fill still clicks and types into an ordinary field", async () => {
  const w = world();
  await call("fill", { trusted: true, raise: true, selector: "#i", text: "hi" });
  assert.deepEqual(clicks(w), [[1, { x: 106, y: 167 }], [2, { x: 106, y: 167 }]]);
  assert.ok(keys(w).length > 0);
});

test("an element that is itself a frame is refused before the page scrolls", () => {
  const w = page(`<iframe id=f></iframe>`);
  let scrolled = 0;
  w.document.getElementById("f").scrollIntoView = () => { scrolled++; };
  const o = run(w, "trusted_probe", { selector: "#f" });
  assert.equal(o.ok, false);
  assert.match(o.error, /embedded frame/);
  assert.equal(scrolled, 0);
});

// Another window of the same browser, in front of the target and over the point.
const COVER = /another of the browser's windows covers the point/;
function covered(extra = {}) {
  const w = world();
  w.cg.splice(1, 0, { owner: "Google Chrome", pid: 4242, wid: 51, x: 0, y: 57, w: 400, h: 300, ax: { web: [{ x: 0, y: 120, w: 400, h: 237 }] }, ...extra });
  return w;
}

test("a point under another window of the browser says so, and posts nothing", async () => {
  for (const extra of [{}, { axWid: 51 }]) {
    const w = covered(extra);
    for (const args of [{ selector: "#b" }, { x: 106, y: 167 }]) {
      const o = await click(args);
      assert.equal(o.ok, false, JSON.stringify(o));
      assert.match(o.error, COVER);
    }
    assert.deepEqual(clicks(w), []);
  }
});

test("a point on the target window's own toolbar is still browser UI, not another window", async () => {
  covered();
  const o = await click({ x: 600, y: 100 });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, OFF);
});
