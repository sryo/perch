import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, chunkUtf16, imageDims } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

// ---- pure helpers ----

test("chunkUtf16 never splits a surrogate pair and caps chunks at 20 units", () => {
  const text = "a".repeat(19) + "😀" + "b".repeat(30) + "\u{1F680}";
  const chunks = chunkUtf16(text);
  assert.equal(chunks.join(""), text);
  for (const c of chunks) {
    assert.ok(c.length <= 20, c);
    assert.ok(!/[\uD800-\uDBFF]$/.test(c), `chunk ends mid-pair: ${JSON.stringify(c)}`);
  }
  assert.deepEqual(chunkUtf16(""), []);
});

test("imageDims reads PNG, baseline JPEG and progressive JPEG headers", () => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1568, 16); png.writeUInt32BE(900, 20);
  assert.deepEqual(imageDims(png), { w: 1568, h: 900 });
  const jpeg = (sof) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, sof, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(imageDims(jpeg(0xc0)), { w: 800, h: 600 });
  assert.deepEqual(imageDims(jpeg(0xc2)), { w: 800, h: 600 });
  assert.equal(imageDims(Buffer.from("nope")), null);
});

// ---- page probe (happy-dom) ----

function withWindowMetrics(w, m) {
  for (const [k, v] of Object.entries(m)) Object.defineProperty(w, k, { value: v, configurable: true });
}

test("trusted_probe estimates the screen point including browser chrome", () => {
  const w = page(`<button id=b>Go</button>`);
  withWindowMetrics(w, { screenX: 100, screenY: 50, outerWidth: 1200, innerWidth: 1000, outerHeight: 900, innerHeight: 820 });
  const o = run(w, "trusted_probe", { selector: "#b" });
  // rect is stubbed at 0,0 100x20: center (50,10); chrome = 200 left (sidebar), 80 top (toolbar).
  assert.deepEqual(o, { ok: true, el: `button "Go"`, x: 100 + 200 + 50, y: 50 + 80 + 10 });
});

test("trusted_probe for fill skips checkboxes/hidden and refuses rich editors", () => {
  const w = page(`<label>Email <input type=checkbox></label><label>Email <input id=e></label><div contenteditable aria-label="Email body"></div>`);
  const o = run(w, "trusted_probe", { label_pattern: "email", forFill: true });
  assert.equal(o.el, `textbox "Email"`);
  assert.equal(run(w, "trusted_probe", { ref: "1", forFill: true }).__perch_ref_miss, true);
  w.eval(`window.__perch_refs = { '1': document.querySelector('[contenteditable]') }`);
  assert.match(run(w, "trusted_probe", { ref: "1", forFill: true }).error, /plain inputs\/textareas only/);
});

test("trusted_check reports whether the mousedown hit the element", () => {
  const w = page(`<button id=b>Go</button><p id=o>other</p>`);
  run(w, "trusted_probe", { selector: "#b" });
  assert.deepEqual(run(w, "trusted_check", {}), { hit: null });
  w.document.getElementById("o").dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
  assert.deepEqual(run(w, "trusted_check", {}), { hit: false });
  run(w, "trusted_probe", { selector: "#b" });
  w.document.getElementById("b").dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
  assert.deepEqual(run(w, "trusted_check", {}), { hit: true });
});

// ---- runtime (fake JXA world) ----

const tabs = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://t${i}.test/`, id: `t${i}` }));
function install(spec) {
  const world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
const chromeFront = () => install({
  browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(2) }] }],
  cg: [{ owner: "Google Chrome", pid: 4242, wid: 77, x: 10, y: 0, w: 800, h: 620 }],
});

test("trusted click at x/y posts down+up to the browser pid with window routing", async () => {
  const world = chromeFront();
  const r = await handleCall("click", { trusted: true, x: 300, y: 200 });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(world.posted.map((e) => [e.type, e.pid, e.fields[9], e.fields[51], e.fields[58]]), [[1, 4242, 4242, 77, 1], [2, 4242, 4242, 77, 1]]);
  assert.deepEqual(world.posted[0].pt, { x: 300, y: 200 });
});

test("trusted input refuses when the browser isn't frontmost, raises when asked", async () => {
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: tabs(1) }] }],
    cg: [{ owner: "Terminal" }, { owner: "Google Chrome", pid: 5 }],
  });
  const r = await handleCall("click", { trusted: true, x: 1, y: 1 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not frontmost/);
  assert.equal(world.posted.length, 0);
  await handleCall("click", { trusted: true, x: 1, y: 1, raise: true });
  assert.equal(world.counts["activate(Google Chrome)"], 1);
});

test("trusted input without Accessibility permission fails before posting", async () => {
  const world = chromeFront();
  world.state.ax = false;
  const r = await handleCall("fill", { trusted: true, selector: "input", text: "x" });
  assert.match(r.content[0].text, /Accessibility permission required/);
  assert.equal(world.posted.length, 0);
});

test("screenshot geometry: Arc frame comes from its CG window; tabIndex switches without raising", async () => {
  const world = install({
    browsers: [{ name: "Arc", kind: "arc", windows: [{ id: "A", active: 0, tabs: tabs(3) }] }],
    cg: [{ owner: "Arc", pid: 9, wid: 31, x: 5, y: 6, w: 900, h: 700 }],
  });
  const g = world.run(`JSON.stringify(__perch.shotGeom({ target: { tabIndex: 2 } }))`);
  assert.deepEqual(JSON.parse(g), { geom: { x: 5, y: 6, w: 900, h: 700 }, pid: 9, windowNumber: 31, cgBounds: { x: 5, y: 6, w: 900, h: 700 } });
  assert.equal(world.counts["tab.select"], 1);
  assert.equal(world.counts["activate(Arc)"], undefined);
});
