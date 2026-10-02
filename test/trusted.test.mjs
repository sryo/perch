import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, chunkUtf16, imageDims } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run, deliverPress } from "./helpers/page.mjs";

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
  assert.deepEqual(o, { ok: true, el: `button "Go"`, x: 100 + 200 + 50, y: 50 + 80 + 10, cx: 50, cy: 10, iw: 1000, ih: 820 });
});

test("trusted_probe asks to retry while the tab is hidden (its screen metrics are stale)", () => {
  const w = page(`<button id=b>Go</button>`);
  Object.defineProperty(w.document, "visibilityState", { value: "hidden", configurable: true });
  assert.deepEqual(run(w, "trusted_probe", { selector: "#b" }), { ok: false, retry: "hidden" });
});

test("trusted_cal drains the recorded mouse moves with client and screen coordinates", () => {
  const w = page(`<button id=b>Go</button>`);
  run(w, "trusted_probe", { selector: "#b" });
  assert.equal(run(w, "trusted_cal", {}), null);
  w.document.dispatchEvent(new w.MouseEvent("mousemove", { bubbles: true, clientX: 7, clientY: 9, screenX: 70, screenY: 90 }));
  assert.deepEqual(run(w, "trusted_cal", {}), { moves: [[7, 9, 70, 90]] });
  assert.equal(run(w, "trusted_cal", {}), null);
});

test("trusted_probe with label_pattern aims at the control click would pick", () => {
  const w = page(`<button style="display:none">Apply</button><button>Apply now</button><button id=b>Apply</button>`);
  withWindowMetrics(w, { screenX: 0, screenY: 0, outerWidth: 1000, innerWidth: 1000, outerHeight: 800, innerHeight: 800 });
  const o = run(w, "trusted_probe", { label_pattern: "apply" });
  assert.equal(o.el, `button "Apply"`);
  w.document.getElementById("b").dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
  assert.equal(run(w, "trusted_check", {}).hit, true, "armed on the resolved element");
  assert.match(run(w, "trusted_probe", { label_pattern: "app" }).error, /^ambiguous/);
});

test("trusted_probe for fill skips checkboxes/hidden and refuses rich editors", () => {
  const w = page(`<label>Email <input type=checkbox></label><label>Email <input id=e></label><div contenteditable aria-label="Email body"></div>`);
  const o = run(w, "trusted_probe", { label_pattern: "email", forFill: true });
  assert.equal(o.el, `textbox "Email"`);
  assert.equal(run(w, "trusted_probe", { ref: "1", forFill: true }).__perch_ref_miss, true);
  w.eval(`window.__perch_refsId = 'm'; window.__perch_refs = { '1': document.querySelector('[contenteditable]') }`);
  assert.match(run(w, "trusted_probe", { ref: "1", forFill: true }).error, /plain inputs\/textareas only/);
});

test("trusted_check reports whether the mousedown hit the element, then disarms", () => {
  const w = page(`<button id=b>Go</button><p id=o>other</p>`);
  const press = (id) => w.document.getElementById(id).dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
  run(w, "trusted_probe", { selector: "#b" });
  assert.deepEqual(run(w, "trusted_check", {}), { hit: null });
  run(w, "trusted_probe", { selector: "#b" });
  press("o");
  assert.deepEqual(run(w, "trusted_check", {}), { hit: false });
  run(w, "trusted_probe", { selector: "#b" });
  press("b");
  assert.deepEqual(run(w, "trusted_check", {}), { hit: true });
  w.document.dispatchEvent(new w.MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
  assert.equal(run(w, "trusted_cal", {}), null, "listeners removed after check");
});

test("background trusted fill rejects a value change without a trusted input event", () => {
  const w = page(`<input id=i value=old>`);
  w.document.execCommand = (_command, _ui, text) => {
    const el = w.document.activeElement;
    el.value = text;
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
    return true;
  };
  const result = run(w, "trusted_fill_background", { selector: "#i", text: "new" });
  assert.equal(result.ok, false);
  assert.equal(result.trusted, false);
  assert.equal(result.value, "new");
});

// ---- runtime (fake JXA world) ----

// A click by point first asks the page for its embedded frames, so tabs carry a
// DOM, with an 800x600 viewport: the web area PAGE_AX gives windows at x 10, y 0.
const tabs = (n) => Array.from({ length: n }, (_, i) => {
  const dom = page("", { url: `https://t${i}.test/` });
  withWindowMetrics(dom, { innerWidth: 800, innerHeight: 600 });
  return { url: `https://t${i}.test/`, id: `t${i}`, dom };
});
const PAGE_AX = { web: [{ x: 10, y: 20, w: 800, h: 600 }] };
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
  cg: [{ owner: "Google Chrome", pid: 4242, wid: 77, x: 10, y: 0, w: 800, h: 620, ax: PAGE_AX }],
});

// Live finding (macOS 27, Chrome Canary): CGEventPostToPid and SkyLight's
// SLEventPostToPid never reach the page; only the HID event tap does.
test("trusted click goes through the HID tap and puts the cursor back", async () => {
  const world = chromeFront();
  const r = await handleCall("click", { trusted: true, raise: true, x: 300, y: 200 });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(world.posted.map((e) => [e.via, e.type, e.pt]), [["hid", 1, { x: 300, y: 200 }], ["hid", 2, { x: 300, y: 200 }]]);
  assert.deepEqual(world.state.cursor, { x: 1, y: 2 });
});

test("trusted input refuses a point outside the target window", async () => {
  const world = chromeFront();
  const r = await handleCall("click", { trusted: true, x: 5000, y: 200 });
  // Accessibility's hit test finds no page there, before the window bounds check.
  assert.match(r.content[0].text, /not on the page itself/);
  assert.equal(world.posted.length, 0);
  assert.equal(world.log.filter((entry) => entry[0] === "SLPSPostEventRecordTo").length, 0, "never borrow the user's key focus");
  assert.deepEqual(world.state.cursor, { x: 1, y: 2 });
  assert.deepEqual(world.state.warps, []);
});

// Change detector, on purpose: the event count, fields 51/91/92, the Command flag
// and the event types are what live probing found WindowServer needs to route a
// background press into Chromium. A behavior-preserving change to that sequence
// still has to be re-verified live (scripts/trusted-live.mjs --background).
test("trusted input reaches a background browser without changing app focus or cursor", async () => {
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(1) }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 5, wid: 77, x: 10, y: 0, w: 800, h: 620, ax: PAGE_AX }],
  });
  const r = await handleCall("click", { trusted: true, x: 300, y: 200 });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(world.posted.filter((e) => e.kind === "mouse" && e.pt.x >= 0 && (e.type === 1 || e.type === 2)).map((e) => [e.via, e.type, e.pt]), [
    ["skylight", 1, { x: 300, y: 200 }], ["skylight", 2, { x: 300, y: 200 }],
  ]);
  assert.deepEqual(world.posted.find((e) => e.kind === "mouse" && e.type === 1 && e.pt.x >= 0).windowPoint, { x: 290, y: 200 }, "stamp the target point relative to its window");
  assert.equal(world.posted.filter((e) => e.via === "skylight").length, 5, "primer, offscreen pair, then target pair");
  assert.ok(world.posted.every((e) => e.pid === 5 && e.fields[51] === 77 && e.fields[91] === 77 && e.fields[92] === 77));
  const targetDown = world.posted.find((e) => e.kind === "mouse" && e.type === 1 && e.pt.x >= 0);
  const targetUp = world.posted.find((e) => e.kind === "mouse" && e.type === 2 && e.pt.x >= 0);
  assert.equal(targetDown.flags, 0x100000, "Command flag lets WindowServer route the background press");
  assert.equal(targetUp.flags, undefined, "release without Command so the page receives an ordinary click");
  assert.equal(world.log.filter((entry) => entry[0] === "SLPSPostEventRecordTo").length, 0, "never borrow the user's key focus");
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
  assert.equal(world.counts["win.index="], undefined);
  assert.deepEqual(world.state.cursor, { x: 1, y: 2 });
  assert.deepEqual(world.state.warps, []);
});

// A click that makes the page call window.focus(), opens a native popup or a
// file chooser can bring the browser forward; perch can't undo that without
// taking focus, so it says so.
const raiseOnClick = (world) => (e) => {
  if (e.kind === "mouse" && e.type === 2 && e.pt.x >= 0) {
    const i = world.cg.findIndex((c) => c.owner === "Google Chrome");
    world.cg.unshift(world.cg.splice(i, 1)[0]);
  }
};
const behindTerminal = () => install({
  browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(1) }] }],
  cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 5, wid: 77, x: 10, y: 0, w: 800, h: 620, ax: PAGE_AX }],
});

test("a background trusted click that brings the browser to the front says so", async () => {
  const world = behindTerminal();
  world.state.onPost = raiseOnClick(world);
  const r = await handleCall("click", { trusted: true, x: 300, y: 200 });
  assert.equal(r.isError, undefined, r.content[0].text);
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.delivery, "skylight");
  assert.match(o.warning, /the click brought the browser to the front/);
  assert.equal(world.counts["activate(Google Chrome)"], undefined, "perch itself activated nothing");
});

test("a background trusted click that leaves the foreground alone carries no warning", async () => {
  behindTerminal();
  const r = await handleCall("click", { trusted: true, x: 300, y: 200 });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(JSON.parse(r.content[0].text).warning, undefined);
});

test("a raised trusted click carries no front warning: raising was asked for", async () => {
  const world = behindTerminal();
  world.state.onPost = raiseOnClick(world);
  const r = await handleCall("click", { trusted: true, raise: true, x: 300, y: 200 });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(JSON.parse(r.content[0].text).warning, undefined);
});

test("background trusted clicks refuse to switch a browser window's active tab", async () => {
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(2) }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 5, wid: 77, x: 10, y: 0, w: 800, h: 620, ax: PAGE_AX }],
  });
  const target = { app: "Google Chrome", windowId: 1, tabIndex: 1 };
  const click = await handleCall("click", { trusted: true, x: 300, y: 200, target });
  assert.equal(click.isError, true);
  assert.match(click.content[0].text, /tab_not_visible: /);
  assert.equal(world.counts["win.activeTabIndex="], undefined);
  assert.equal(world.posted.length, 0);
});

test("trusted fill edits an inactive Chrome tab without an on-screen window", async () => {
  const dom = page(`<input id=i aria-label="Name" value="old">`);
  Object.defineProperty(dom.document, "visibilityState", { value: "hidden", configurable: true });
  dom.document.execCommand = (_command, _ui, text) => {
    const el = dom.document.activeElement;
    el.value = text;
    const event = new dom.Event("input", { bubbles: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    el.dispatchEvent(event);
    return true;
  };
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "about:blank", id: "front" }, { url: "about:blank", id: "background", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }],
  });
  const r = await handleCall("fill", { trusted: true, selector: "#i", text: "Ada 😀", target: { app: "Google Chrome", windowId: 1, tabIndex: 1 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, trusted: true, value: "Ada 😀", el: 'textbox "Name"' });
  assert.equal(dom.document.getElementById("i").value, "Ada 😀");
  assert.equal(world.counts["win.activeTabIndex="], undefined);
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
  assert.equal(world.posted.length, 0);
});

test("trusted fills can target three inactive tabs without selecting any", async () => {
  const doms = Array.from({ length: 3 }, () => page(`<input id=i aria-label="Name" value="old">`));
  for (const dom of doms) {
    Object.defineProperty(dom.document, "visibilityState", { value: "hidden", configurable: true });
    dom.document.execCommand = (_command, _ui, value) => {
      const el = dom.document.activeElement;
      el.value = value;
      const event = new dom.Event("input", { bubbles: true });
      Object.defineProperty(event, "isTrusted", { value: true });
      el.dispatchEvent(event);
      return true;
    };
  }
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [
      { url: "about:blank", id: "front" },
      ...doms.map((dom, i) => ({ url: "about:blank", id: `background${i}`, dom })),
    ] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }],
  });
  const values = ["first 😀", "second é", "third ok"];
  const results = await Promise.all(values.map((value, i) => handleCall("fill", {
    trusted: true, selector: "#i", text: value, target: { app: "Google Chrome", windowId: 1, tabIndex: i + 1 },
  })));
  results.forEach((result, i) => {
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).ok, true);
    assert.equal(doms[i].document.getElementById("i").value, values[i]);
  });
  assert.equal(world.counts["win.activeTabIndex="], undefined);
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
  assert.equal(world.posted.length, 0);
});

test("raise:true keeps the existing foreground HID path", async () => {
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(1) }] }],
    cg: [{ owner: "Terminal", pid: 1 }, { owner: "Google Chrome", pid: 5, wid: 77, x: 10, y: 0, w: 800, h: 620, ax: PAGE_AX }],
  });
  const r = await handleCall("click", { trusted: true, x: 300, y: 200, raise: true });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(world.counts["activate(Google Chrome)"], 1);
  assert.deepEqual(world.posted.map((e) => e.via), ["hid", "hid"]);
  assert.deepEqual(world.state.cursor, { x: 1, y: 2 });
});

test("trusted input without Accessibility permission fails before posting", async () => {
  const world = chromeFront();
  world.state.ax = false;
  const r = await handleCall("click", { trusted: true, x: 300, y: 200 });
  assert.match(r.content[0].text, /Accessibility permission required/);
  assert.equal(world.posted.length, 0);
});

test("screenshot geometry: Arc frame comes from its CG window; inactive tabs need raise", async () => {
  const world = install({
    browsers: [{ name: "Arc", kind: "arc", windows: [{ id: "A", active: 0, tabs: tabs(3) }] }],
    cg: [{ owner: "Arc", pid: 9, wid: 31, x: 5, y: 6, w: 900, h: 700 }],
  });
  assert.throws(() => world.run(`__perch.shotGeom({ target: { tabIndex: 2 } })`), /tab_not_visible: /);
  assert.equal(world.counts["tab.select"], undefined);
  const g = world.run(`JSON.stringify(__perch.shotGeom({ target: { tabIndex: 0 } }))`);
  assert.deepEqual(JSON.parse(g), { geom: { x: 5, y: 6, w: 900, h: 700 }, pid: 9, windowNumber: 31, cgBounds: { x: 5, y: 6, w: 900, h: 700 } });
  assert.equal(world.counts["tab.select"], undefined);
  assert.equal(world.counts["activate(Arc)"], undefined);
});

test("screenshot refuses a minimized window instead of capturing another app's pixels", () => {
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(1) }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }],
  });
  assert.throws(() => world.run(`__perch.shotGeom({ target: { app: "Google Chrome", windowId: 1 } })`), /window_offscreen: /);
});

// ---- guards: trusted input that can't be sure of its window posts nothing ----

test("raise that doesn't bring the browser to the front refuses before posting", async () => {
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(2) }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 77, x: 10, y: 0, w: 800, h: 620, ax: PAGE_AX }],
  });
  world.state.activateFails = true;
  const r = await handleCall("click", { trusted: true, raise: true, x: 300, y: 200 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^error: target did not become frontmost after raise/);
  assert.equal(world.posted.length, 0);
});

test("trusted input to a window with no on-screen CG entry is window_offscreen and posts nothing", async () => {
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(2) }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }],
  });
  for (const raise of [true, false]) {
    const r = await handleCall("click", { trusted: true, raise, x: 300, y: 200 });
    assert.equal(r.isError, true, `raise:${raise}`);
    assert.match(r.content[0].text, /^error: window_offscreen: /, `raise:${raise}`);
  }
  assert.equal(world.posted.length, 0);
});

test("a tab that never becomes visible is reported, not clicked", async () => {
  const { dom, world } = domTab(`<button id=b>Go</button>`, METRICS);
  Object.defineProperty(dom.document, "visibilityState", { value: "hidden", configurable: true });
  const r = await handleCall("click", { trusted: true, raise: true, selector: "#b", target: { tabIndex: 1 } });
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.ok, false);
  assert.match(o.error, /never became visible/);
  assert.equal(world.posted.length, 0);
});

// ---- aiming: visibility + calibration, through the runtime against a happy-dom page ----

// `area` is the page's web area in Accessibility (null: none).
function domTab(html, metrics, area = { x: 56, y: 157, w: 798, h: 500 }) {
  const dom = page(html);
  withWindowMetrics(dom, metrics);
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ...(area ? { ax: { web: [area] } } : {}) }],
  });
  return { dom, world };
}
const METRICS = { screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 };
const downs = (world) => world.posted.filter((e) => e.type === 1).map((e) => e.pt);

test("trusted click shows the target tab and waits until it's visible before measuring", async () => {
  const { dom, world } = domTab(`<button id=b>Go</button>`, METRICS);
  let hiddenChecks = 3;
  Object.defineProperty(dom.document, "visibilityState", { get: () => (hiddenChecks-- > 0 ? "hidden" : "visible"), configurable: true });
  const r = await handleCall("click", { trusted: true, raise: true, selector: "#b", target: { tabIndex: 1 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(world.counts["win.activeTabIndex="], 1);
  assert.equal(downs(world).length, 1);
});

test("calibration: a mouse move reveals the real offset and the click lands on the element", async () => {
  const { dom, world } = domTab(`<button id=b>Go</button>`, METRICS, { x: 0, y: 157, w: 798, h: 500 });
  // The real content area starts 56pt left of where outer-inner assumes (a right-side
  // panel, say): wherever a move is posted, the page sees it 56px further right.
  world.state.onPost = (e) => {
    if (e.type !== 5) return;
    dom.document.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, clientX: e.pt.x - METRICS.screenX + 0, clientY: e.pt.y - 57 - 100, screenX: e.pt.x, screenY: e.pt.y }));
  };
  const r = await handleCall("click", { trusted: true, raise: true, selector: "#b", target: { tabIndex: 1 } });
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.calibrated, true);
  // Element center (50,10) in client px maps to screen (0 + 50, 57 + 100 + 10).
  assert.deepEqual(downs(world), [{ x: 50, y: 167 }]);
  assert.deepEqual(o.calibration, [[-56, 0], [0, 0]]);
});

test("calibration ignores a mouse move recorded before its own post", async () => {
  const { dom, world } = domTab(`<button id=b>Go</button>`, METRICS);
  // The posted move reaches the page one read late, so the first read after the
  // post sees only what was already buffered.
  let pending = null, evalsSincePost = 0;
  world.state.onPost = (e) => { if (e.type === 5) { pending = e.pt; evalsSincePost = 0; } };
  const evalPage = dom.eval.bind(dom);
  let evals = 0;
  dom.eval = (js) => {
    if (pending && ++evalsSincePost === 2) {
      dom.document.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, clientX: pending.x - 56, clientY: pending.y - 157, screenX: pending.x, screenY: pending.y }));
      pending = null;
    }
    const out = evalPage(js);
    // Right after the first page script (the probe) arms its listeners, a stray move
    // lands within 1px of the point calibration will post at, with a client point
    // 20px off. Only clearing the buffer before the post keeps it out.
    if (++evals === 1) dom.document.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, clientX: 30, clientY: 30, screenX: 107, screenY: 168 }));
    return out;
  };
  const r = await handleCall("click", { trusted: true, raise: true, selector: "#b", target: { tabIndex: 1 } });
  const o = JSON.parse(r.content[0].text);
  assert.deepEqual(o.calibration, [[0, 0]]);
  assert.deepEqual(downs(world), [{ x: 106, y: 167 }]);
});

// Terminal in front: the no-raise route, with the page's tab shown (active) or not.
function backgroundTab(html, active) {
  const dom = page(html);
  withWindowMetrics(dom, METRICS);
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 798, h: 500 }] } }],
  });
  return { dom, world };
}
const LABELLED = `<button id=a>Apply now</button><button id=b>Apply</button>`;

test("trusted click by label posts at the resolved control in a shown background tab", async () => {
  const { dom, world } = backgroundTab(LABELLED, 1);
  world.state.onPost = (e) => {
    if (e.type === 1 && e.pt.x >= 0) dom.document.getElementById("b").dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true }));
  };
  const r = await handleCall("click", { trusted: true, label_pattern: "apply", target: { tabIndex: 1 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.el, `button "Apply"`);
  assert.equal(o.hit, true);
  assert.deepEqual(world.posted.filter((e) => e.type === 1 && e.pt.x >= 0).map((e) => [e.via, e.pt]), [["skylight", { x: 106, y: 167 }]]);
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
});

test("a background trusted click by label that brings the browser to the front says so", async () => {
  const { dom, world } = backgroundTab(LABELLED, 1);
  const front = raiseOnClick(world);
  world.state.onPost = (e) => {
    if (e.type === 1 && e.pt.x >= 0) dom.document.getElementById("b").dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true }));
    front(e);
  };
  const r = await handleCall("click", { trusted: true, label_pattern: "apply", target: { tabIndex: 1 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.hit, true);
  assert.match(o.warning, /the click brought the browser to the front/);
});

test("trusted click on a disabled button refuses before any mouse event", async () => {
  const { world } = backgroundTab(`<button id=save disabled>Save</button>`, 1);
  const r = await handleCall("click", { trusted: true, selector: "#save", target: { tabIndex: 1 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.ok, false);
  assert.match(o.error, /button "Save" is disabled; nothing was clicked/);
  assert.equal(world.posted.length, 0);
  assert.deepEqual(world.state.warps, []);
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
});

test("trusted click by label in a hidden tab is tab_not_visible and activates nothing", async () => {
  const { world } = backgroundTab(LABELLED, 0);
  const r = await handleCall("click", { trusted: true, label_pattern: "apply", target: { tabIndex: 1 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /tab_not_visible: /);
  assert.equal(world.counts["win.activeTabIndex="], undefined);
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
  assert.equal(world.posted.length, 0);
});

test("no mouse move reaches the page and Accessibility finds no page area: nothing is clicked", async () => {
  const { world } = domTab(`<button id=b>Go</button>`, METRICS, null);
  const r = await handleCall("click", { trusted: true, raise: true, selector: "#b", target: { tabIndex: 1 } });
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.ok, false);
  assert.match(o.error, /not on the page itself/);
  assert.deepEqual(downs(world), []);
  assert.deepEqual(world.state.cursor, { x: 1, y: 2 });
});

test("trusted fill types the whole text, emoji included, in surrogate-safe chunks", async () => {
  const { dom, world } = domTab(`<input id=i aria-label="Name">`, METRICS);
  world.state.onPost = (e) => {
    if (e.kind === "key" && e.down) {
      const el = dom.document.getElementById("i");
      el.value += e.text;
    }
  };
  const text = "Ada Lovelace 😀 ".repeat(3) + "ok";
  const r = await handleCall("fill", { trusted: true, raise: true, selector: "#i", text, target: { tabIndex: 1 } });
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.ok, true, r.content[0].text);
  assert.equal(dom.document.getElementById("i").value, text);
  // Each key event carries its chunk as UTF-16LE; without it Chrome types virtual
  // key 0 ("a"), which is what the old 0x14000100 encoding constant produced.
  const keys = world.posted.filter((e) => e.kind === "key");
  assert.ok(keys.length && keys.every((e) => e.via === "tap1" && e.text && e.len === e.text.length));
});

// A key held on the real keyboard (Command, Option) would otherwise ride on the
// typed text and turn it into shortcuts.
test("raised trusted fill types with no modifier flags", async () => {
  const { dom, world } = domTab(`<input id=i aria-label="Name">`, METRICS);
  world.state.onPost = (e) => { if (e.kind === "key" && e.down) dom.document.getElementById("i").value += e.text; };
  const r = await handleCall("fill", { trusted: true, raise: true, selector: "#i", text: "wq", target: { tabIndex: 1 } });
  assert.equal(JSON.parse(r.content[0].text).ok, true, r.content[0].text);
  const keys = world.posted.filter((e) => e.kind === "key");
  assert.ok(keys.length);
  assert.ok(keys.every((e) => e.flags === 0), JSON.stringify(keys.map((e) => e.flags)));
});

test("trusted fill edits a background browser without changing AppKit focus", async () => {
  const dom = page(`<input id=i aria-label="Name">`);
  withWindowMetrics(dom, METRICS);
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600 }],
  });
  dom.document.execCommand = (_command, _ui, text) => {
    const el = dom.document.activeElement;
    el.value = text;
    const event = new dom.Event("input", { bubbles: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    el.dispatchEvent(event);
    return true;
  };
  const r = await handleCall("fill", { trusted: true, selector: "#i", text: "Ada 😀" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(JSON.parse(r.content[0].text).ok, true);
  assert.equal(dom.document.getElementById("i").value, "Ada 😀");
  assert.equal(world.posted.filter((e) => e.kind === "key").length, 0, "do not borrow the user's keyboard focus");
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
  assert.deepEqual(world.state.cursor, { x: 1, y: 2 });
  assert.deepEqual(world.state.warps, []);
  assert.equal(world.log.filter((entry) => entry[0] === "SLPSPostEventRecordTo").length, 0);
});

test("calibration ignores moves that aren't the one it posted (late events, the real mouse)", async () => {
  const { dom, world } = domTab(`<button id=b>Go</button>`, METRICS);
  world.state.onPost = (e) => {
    if (e.type !== 5) return;
    // The posted move, then a late or user-made one at a different screen point.
    dom.document.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, clientX: e.pt.x - 56, clientY: e.pt.y - 157, screenX: e.pt.x, screenY: e.pt.y }));
    dom.document.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 50, screenX: 3, screenY: 900 }));
  };
  const r = await handleCall("click", { trusted: true, raise: true, selector: "#b", target: { tabIndex: 1 } });
  const o = JSON.parse(r.content[0].text);
  assert.deepEqual(o.calibration, [[0, 0]]);
  assert.deepEqual(downs(world), [{ x: 106, y: 167 }]);
});

// ---- aiming from the Accessibility tree ----

// A background Canary window at x=0: 56px of chrome on the left, a 200px side panel
// on the right. The page's estimate puts all 256px of chrome on the left.
function panelTab(web, metrics = { screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 598, outerHeight: 600, innerHeight: 500 }) {
  const dom = page(`<button id=b>Go</button>`);
  withWindowMetrics(dom, metrics);
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ...(web ? { ax: { web } } : {}) }],
  });
  return { dom, world };
}
const presses = (world) => world.posted.filter((e) => e.type === 1 && e.pt.x >= 0).map((e) => e.pt);

test("background aim reads the page area from Accessibility, past a right-side panel", async () => {
  // The panel is a web area too; the page's is the one its viewport fills.
  const { world } = panelTab([{ x: 654, y: 157, w: 200, h: 500 }, { x: 56, y: 157, w: 598, h: 500 }]);
  const r = await handleCall("click", { trusted: true, selector: "#b" });
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.aim, "ax");
  assert.equal(o.calibrated, true);
  assert.equal(o.warning, undefined);
  // Estimate 0 + 256 + 50 = 306; the page really starts at 56, so the press is at 106.
  assert.deepEqual(o.calibration, [[-200, 0]]);
  assert.deepEqual(presses(world), [{ x: 106, y: 167 }]);
  // Only the click's own primer move: no calibration moves, which never reach a background page.
  assert.equal(world.posted.filter((e) => e.type === 5 && e.pt.x >= 0).length, 1);
});

test("Accessibility aim scales by page zoom, which the estimate can't see", async () => {
  // 125% zoom: a 478-CSS-px viewport fills 598 screen points.
  const { world } = panelTab([{ x: 56, y: 157, w: 598, h: 500 }], { screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 478.4, outerHeight: 600, innerHeight: 400 });
  const o = JSON.parse((await handleCall("click", { trusted: true, selector: "#b" })).content[0].text);
  assert.equal(o.aim, "ax");
  assert.deepEqual(presses(world), [{ x: 56 + 50 * 1.25, y: 157 + 10 * 1.25 }]);
});

test("with no page area from Accessibility a background press is refused, not aimed by the estimate", async () => {
  const { world } = panelTab(null);
  const o = JSON.parse((await handleCall("click", { trusted: true, selector: "#b" })).content[0].text);
  assert.equal(o.ok, false);
  assert.match(o.error, /not on the page itself/);
  assert.deepEqual(presses(world), []);
});

test("foreground aim still prefers the mouse move, and falls back to Accessibility", async () => {
  const { dom, world } = panelTab([{ x: 56, y: 157, w: 598, h: 500 }]);
  const withMove = (on) => { world.state.onPost = on ? (e) => {
    if (e.type !== 5) return;
    dom.document.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, clientX: e.pt.x - 56, clientY: e.pt.y - 157, screenX: e.pt.x, screenY: e.pt.y }));
  } : undefined; };
  withMove(true);
  let o = JSON.parse((await handleCall("click", { trusted: true, raise: true, selector: "#b" })).content[0].text);
  assert.equal(o.aim, "mouse");
  withMove(false);
  o = JSON.parse((await handleCall("click", { trusted: true, raise: true, selector: "#b" })).content[0].text);
  assert.equal(o.aim, "ax");
  assert.deepEqual(o.point, { x: 106, y: 167 });
});

test("screenshot: a failed downscale still returns the full-size capture", async () => {
  const { deps } = await import("../server.js");
  const { writeFile } = await import("node:fs/promises");
  // Two runtime runs that exit nonzero leave the capture to screencapture.
  chromeFront().state.captureExit = 1;
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(3000, 16); png.writeUInt32BE(2000, 20);
  const real = deps.exec;
  deps.exec = async (cmd, args) => {
    if (cmd === "screencapture") { await writeFile(args[args.length - 1], png); return { stdout: "" }; }
    throw new Error("sips: boom");
  };
  try {
    const r = await handleCall("screenshot", {});
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.deepEqual(JSON.parse(r.content[1].text).image, { w: 3000, h: 2000 });
  } finally { deps.exec = real; }
});

// ---- a click by point proves delivery the way an element click does ----

const reachesPage = (dom, world) => deliverPress(world, dom, dom.document.getElementById("b"));
const isCheck = (js) => js.includes("if (st.off) st.off();\nconst out = { hit: st.down };");
function recordScripts(dom) {
  const seen = [];
  const evalPage = dom.eval.bind(dom);
  dom.eval = (js) => { seen.push(js); return evalPage(js); };
  return seen;
}

test("trusted click by point reports the page's mousedown as hit, with the element it landed on", async () => {
  const { dom, world } = backgroundTab(`<button id=b>Go</button>`, 1);
  reachesPage(dom, world);
  const r = await handleCall("click", { trusted: true, x: 106, y: 167, target: { tabIndex: 1 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.ok, true, r.content[0].text);
  assert.equal(o.hit, true);
  assert.equal(o.el, `button "Go"`);
  assert.deepEqual(o.point, { x: 106, y: 167 });
  assert.equal(o.delivery, "skylight");
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
  assert.equal(world.log.filter((entry) => entry[0] === "activate").length, 0);
});

test("a background click by point the page never receives is ok:false, posted once, nothing activated", async () => {
  const { world } = backgroundTab(`<button id=b>Go</button>`, 1);
  const r = await handleCall("click", { trusted: true, x: 106, y: 167, target: { tabIndex: 1 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.ok, false, r.content[0].text);
  assert.equal(o.hit, false);
  assert.match(o.error, /no click reached the page at 106,167/);
  assert.deepEqual(presses(world), [{ x: 106, y: 167 }]);
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
  assert.equal(world.counts["win.activeTabIndex="], undefined);
  assert.deepEqual(world.state.cursor, { x: 1, y: 2 });
  assert.deepEqual(world.state.warps, []);
});

test("a click by point resets an earlier click's recorder, so its stale hit can't vouch for a dropped click", async () => {
  const { dom, world } = backgroundTab(`<button id=b>Go</button>`, 1);
  reachesPage(dom, world);
  const first = JSON.parse((await handleCall("click", { trusted: true, selector: "#b", target: { tabIndex: 1 } })).content[0].text);
  assert.equal(first.hit, true, JSON.stringify(first));
  assert.equal(dom.window.__perch_trusted.down, true);
  world.state.onPost = undefined;
  const o = JSON.parse((await handleCall("click", { trusted: true, x: 106, y: 167, target: { tabIndex: 1 } })).content[0].text);
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.hit, false);
});

test("a click by point ignores a synthetic mousedown the page fires itself", async () => {
  const { dom, world } = backgroundTab(`<button id=b>Go</button>`, 1);
  world.state.onPost = (e) => {
    if (e.type === 1 && e.pt.x >= 0) dom.document.getElementById("b").dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true }));
  };
  const o = JSON.parse((await handleCall("click", { trusted: true, x: 106, y: 167, target: { tabIndex: 1 } })).content[0].text);
  assert.equal(o.ok, false, JSON.stringify(o));
});

test("a click by point that navigates the page is not called a miss", async () => {
  const { dom, world } = backgroundTab(`<button id=b>Go</button>`, 1);
  // A new document: the recorder the click armed is gone.
  world.state.onPost = (e) => { if (e.type === 2 && e.pt.x >= 0) delete dom.window.__perch_trusted; };
  const o = JSON.parse((await handleCall("click", { trusted: true, x: 106, y: 167, target: { tabIndex: 1 } })).content[0].text);
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.hit, undefined);
  assert.match(o.note, /unknown/);
  assert.equal(o.error, undefined);
});

test("a refused click by point posts nothing and reads no check", async () => {
  const { dom, world } = backgroundTab(`<button id=b>Go</button>`, 1);
  const seen = recordScripts(dom);
  const r = await handleCall("click", { trusted: true, x: 5000, y: 167, target: { tabIndex: 1 } });
  assert.match(r.content[0].text, /not on the page itself/);
  assert.equal(world.posted.length, 0);
  assert.ok(seen.length > 0);
  assert.equal(seen.filter(isCheck).length, 0);
});

test("clicks by point send the same page script source every time", async () => {
  const { dom, world } = backgroundTab(`<button id=b>Go</button>`, 1);
  reachesPage(dom, world);
  const seen = recordScripts(dom);
  await handleCall("click", { trusted: true, x: 106, y: 167, target: { tabIndex: 1 } });
  const first = seen.splice(0);
  await handleCall("click", { trusted: true, x: 120, y: 170, target: { tabIndex: 1 } });
  assert.equal(first.filter(isCheck).length, 1);
  assert.deepEqual(seen, first);
});

// ---- a page script that throws fails the click closed ----

// Makes every page script containing `marker` throw just before it.
function throwAt(dom, marker) {
  const ev = dom.eval.bind(dom);
  let threw = 0;
  dom.eval = (js) => js.includes(marker) ? (threw++, ev(js.replace(marker, "throw new TypeError('secret-internal detail');" + marker))) : ev(js);
  return () => threw;
}
const noRaw = (x) => {
  const s = JSON.stringify(x);
  for (const k of ["secret-internal", "__perch", "stack"]) assert.ok(!s.includes(k), s);
};
const RB_ARM = "return rbArm(A.probed";
const RB_READ = "const text = rbText(s ? s.sel : A.readback);";
const CHECK = "const out = { hit: st.down };";
const clickReply = async (args) => {
  const r = await handleCall("click", { ...args, trusted: true, target: { tabIndex: 1 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};

test("a readback arm that throws posts no click and moves no cursor, by point or by element", async () => {
  for (const aim of [{ x: 106, y: 167 }, { selector: "#b" }]) {
    const { dom, world } = backgroundTab(`<button id=b>Go</button><p id=s>Idle</p>`, 1);
    reachesPage(dom, world);
    const threw = throwAt(dom, RB_ARM);
    const o = await clickReply({ ...aim, readback: "#s" });
    assert.ok(threw() > 0);
    assert.equal(o.ok, false, JSON.stringify(o));
    assert.equal(o.error, "click: the page script failed on this page (TypeError); nothing was clicked");
    noRaw(o);
    assert.deepEqual(presses(world), []);
    assert.deepEqual(world.state.cursor, { x: 1, y: 2 });
    assert.deepEqual(world.state.warps, []);
  }
});

test("a click check that throws after the post is ok:false and unverified, never a navigation note", async () => {
  for (const aim of [{ x: 106, y: 167 }, { selector: "#b" }]) {
    const { dom, world } = backgroundTab(`<button id=b>Go</button>`, 1);
    reachesPage(dom, world);
    throwAt(dom, CHECK);
    const o = await clickReply(aim);
    assert.equal(o.ok, false, JSON.stringify(o));
    assert.equal(o.error, "click: the click was sent; the page script failed checking it (TypeError); outcome unverified");
    assert.equal(o.note, undefined);
    assert.deepEqual(o.point, { x: 106, y: 167 });
    assert.equal(o.delivery, "skylight");
    if (aim.selector) assert.equal(o.el, `button "Go"`);
    noRaw(o);
    assert.equal(presses(world).length, 1);
  }
});

test("a trusted click's readback that throws is ok:false and keeps the point", async () => {
  for (const aim of [{ x: 106, y: 167 }, { selector: "#b" }]) {
    const { dom, world } = backgroundTab(`<button id=b>Go</button><p id=s>Idle</p>`, 1);
    reachesPage(dom, world);
    throwAt(dom, RB_READ);
    const o = await clickReply({ ...aim, readback: "#s" });
    assert.equal(o.ok, false, JSON.stringify(o));
    assert.equal(o.error, "click: the click was sent; the page script failed reading it back (TypeError); outcome unverified");
    assert.deepEqual(o.point, { x: 106, y: 167 });
    assert.equal(o.delivery, "skylight");
    noRaw(o);
    assert.equal(presses(world).length, 1);
  }
});
