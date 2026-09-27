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
  assert.deepEqual(o, { ok: true, el: `button "Go"`, x: 100 + 200 + 50, y: 50 + 80 + 10, cx: 50, cy: 10 });
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

test("trusted_probe for fill skips checkboxes/hidden and refuses rich editors", () => {
  const w = page(`<label>Email <input type=checkbox></label><label>Email <input id=e></label><div contenteditable aria-label="Email body"></div>`);
  const o = run(w, "trusted_probe", { label_pattern: "email", forFill: true });
  assert.equal(o.el, `textbox "Email"`);
  assert.equal(run(w, "trusted_probe", { ref: "1", forFill: true }).__perch_ref_miss, true);
  w.eval(`window.__perch_refs = { '1': document.querySelector('[contenteditable]') }`);
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
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /outside the target window/);
  assert.equal(world.posted.length, 0);
  assert.equal(world.log.filter((entry) => entry[0] === "SLPSPostEventRecordTo").length, 0, "never borrow the user's key focus");
  assert.deepEqual(world.state.cursor, { x: 1, y: 2 });
  assert.deepEqual(world.state.warps, []);
});

test("trusted input reaches a background browser without changing app focus or cursor", async () => {
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(1) }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 5, wid: 77, x: 10, y: 0, w: 800, h: 620 }],
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

test("background trusted clicks refuse to switch a browser window's active tab", async () => {
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(2) }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 5, wid: 77, x: 10, y: 0, w: 800, h: 620 }],
  });
  const target = { app: "Google Chrome", windowId: 1, tabIndex: 1 };
  const click = await handleCall("click", { trusted: true, x: 300, y: 200, target });
  assert.equal(click.isError, true);
  assert.match(click.content[0].text, /already be the active tab/);
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
    cg: [{ owner: "Terminal", pid: 1 }, { owner: "Google Chrome", pid: 5, wid: 77, x: 10, y: 0, w: 800, h: 620 }],
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
  assert.throws(() => world.run(`__perch.shotGeom({ target: { tabIndex: 2 } })`), /already be the active tab/);
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
  assert.throws(() => world.run(`__perch.shotGeom({ target: { app: "Google Chrome", windowId: 1 } })`), /isn't on screen/);
});

// ---- aiming: visibility + calibration, through the runtime against a happy-dom page ----

function domTab(html, metrics) {
  const dom = page(html);
  withWindowMetrics(dom, metrics);
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600 }],
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
  const { dom, world } = domTab(`<button id=b>Go</button>`, METRICS);
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
  // A stale move (the user's cursor, say) sits in the page before calibration posts.
  world.state.onPost = (e) => {
    if (e.type !== 5) return;
    dom.document.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, clientX: e.pt.x - 56, clientY: e.pt.y - 157, screenX: e.pt.x, screenY: e.pt.y }));
  };
  // Right after the probe arms its listeners, a stray move (31px off) reaches the page.
  const evalPage = dom.eval.bind(dom);
  dom.eval = (js) => {
    const out = evalPage(js);
    if (js.includes('retry: "hidden"')) dom.document.dispatchEvent(new dom.MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: 41, screenX: 106, screenY: 198 }));
    return out;
  };
  const r = await handleCall("click", { trusted: true, raise: true, selector: "#b", target: { tabIndex: 1 } });
  const o = JSON.parse(r.content[0].text);
  assert.deepEqual(o.calibration, [[0, 0]]);
  assert.deepEqual(downs(world), [{ x: 106, y: 167 }]);
});

test("no mouse move reaches the page: click at the estimate, uncalibrated", async () => {
  const { world } = domTab(`<button id=b>Go</button>`, METRICS);
  const r = await handleCall("click", { trusted: true, raise: true, selector: "#b", target: { tabIndex: 1 } });
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.calibrated, false);
  assert.deepEqual(downs(world), [{ x: 0 + 56 + 50, y: 57 + 100 + 10 }]);
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

test("screenshot: a failed downscale still returns the full-size capture", async () => {
  const { deps } = await import("../server.js");
  const { writeFile } = await import("node:fs/promises");
  chromeFront();
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
