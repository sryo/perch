// press {trusted:true}: real key events posted through SkyLight to the browser
// pid, for widgets that ignore synthetic keys. Page recorders run in happy-dom;
// the runtime runs against the fake JXA world, where posted events are recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, TOOLS } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

const trustedKey = (w, type, key, trusted = true) => {
  const e = new w.KeyboardEvent(type, { key, bubbles: true });
  Object.defineProperty(e, "isTrusted", { value: trusted });
  (w.document.activeElement || w.document.body).dispatchEvent(e);
};

// ---- page recorders (happy-dom) ----

test("trusted_key_arm focuses the element; trusted_key_check waits for keyup, then reports", () => {
  const w = page(`<input id=a aria-label="First"><input id=b aria-label="Second">`);
  assert.deepEqual(run(w, "trusted_key_arm", { selector: "#b", key: "Enter" }), { ok: true, el: 'textbox "Second"' });
  assert.equal(w.document.activeElement.id, "b");
  assert.equal(run(w, "trusted_key_check", {}), null, "nothing yet: keep polling");
  trustedKey(w, "keydown", "Enter");
  assert.equal(run(w, "trusted_key_check", {}), null, "keydown without keyup: keep polling");
  trustedKey(w, "keyup", "Enter");
  assert.deepEqual(run(w, "trusted_key_check", {}), { hit: true, focus: 'textbox "Second"' });
  trustedKey(w, "keydown", "Enter");
  assert.equal(w.__perch_key, undefined, "listeners and state removed after the check");
});

test("trusted_key_check: untrusted or other keys miss; no keydown at all is null", () => {
  const w = page(`<button id=b>Go</button>`);
  run(w, "trusted_key_arm", { selector: "#b", key: "Enter" });
  trustedKey(w, "keydown", "Enter", false);
  trustedKey(w, "keyup", "Enter", false);
  assert.deepEqual(run(w, "trusted_key_check", {}), { hit: false, focus: 'button "Go"' });
  run(w, "trusted_key_arm", { key: "Escape" });
  trustedKey(w, "keydown", "Enter");
  trustedKey(w, "keyup", "Enter");
  assert.equal(run(w, "trusted_key_check", {}).hit, false);
  run(w, "trusted_key_arm", { key: "Escape" });
  assert.deepEqual(run(w, "trusted_key_check", { final: true }), { hit: null, focus: 'button "Go"' });
});

test("trusted_key_arm without ref/selector keeps the focused element; misses are reported", () => {
  const w = page(`<input id=a aria-label="Name"><input id=d aria-label="Off" disabled>`);
  w.document.getElementById("a").focus();
  assert.deepEqual(run(w, "trusted_key_arm", { key: "Escape" }), { ok: true, el: 'textbox "Name"' });
  assert.equal(run(w, "trusted_key_arm", { ref: "9", key: "Tab" }).__perch_ref_miss, true);
  assert.match(run(w, "trusted_key_arm", { selector: "#nope", key: "Tab" }).error, /no element/);
  assert.match(run(w, "trusted_key_arm", { selector: "#d", key: "Tab" }).error, /did not accept focus/);
});

test("trusted_key_arm refuses a Tab that would leave the page for the browser's toolbar", () => {
  const w = page(`<button id=b>Go</button><input id=i aria-label="Name"><input id=h type=hidden>`);
  assert.match(run(w, "trusted_key_arm", { selector: "#i", key: "Tab" }).error, /last focusable.*toolbar/);
  assert.match(run(w, "trusted_key_arm", { selector: "#b", key: "Tab", shift: true }).error, /first focusable.*toolbar/);
  assert.equal(run(w, "trusted_key_arm", { selector: "#b", key: "Tab" }).ok, true);
  assert.equal(run(w, "trusted_key_arm", { selector: "#i", key: "Tab", shift: true }).ok, true);
  assert.equal(run(w, "trusted_key_arm", { selector: "#i", key: "Enter" }).ok, true);
});

test("trusted_key_arm refuses a frame or embed as the key's target", () => {
  const w = page(`<input id=a aria-label="Name"><iframe id=f title="Check"></iframe><object id=o data="x.svg"></object><embed id=e src="x.svg">`);
  for (const selector of ["iframe", "#o", "#e"]) {
    const r = run(w, "trusted_key_arm", { selector, key: "Enter" });
    assert.equal(r.ok, false, selector);
    assert.match(r.error, /embedded frame.*click \{trusted:true\}/, selector);
  }
  w.document.getElementById("f").focus();
  assert.equal(w.document.activeElement.id, "f");
  assert.match(run(w, "trusted_key_arm", { key: "Enter" }).error, /embedded frame/);
  assert.equal(w.__perch_key, undefined, "nothing armed");
});

test("trusted_key_arm focuses an element inside a shadow root", () => {
  const w = page(`<div id=host></div>`);
  w.document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = `<input id=s aria-label="Inner">`;
  assert.deepEqual(run(w, "trusted_key_arm", { selector: "#s", key: "Enter" }), { ok: true, el: 'textbox "Inner"' });
});

// ---- runtime (fake JXA world) ----

// The page's view of a key event, keyed by virtual keycode (what the browser derives).
const KEY_OF = { 36: "Enter", 53: "Escape", 48: "Tab", 125: "ArrowDown", 49: " " };

// The target window's CG frame, and its page's web area (happy-dom's viewport is
// 1024x768, shown at 800x600). By default the browser's key focus is a field in
// that page.
const WIN = { x: 10, y: 0, w: 800, h: 620 };
const AREA = { x: 10, y: 20, w: 800, h: 600 };
const inPage = { window: WIN, chain: [{ role: "AXTextField", box: { x: 20, y: 40, w: 100, h: 20 } }, { role: "AXGroup" }, { role: "AXWebArea", box: AREA }, { role: "AXGroup" }, { role: "AXWindow", box: WIN }] };

function background({ active = 1, cg, extra = [], focus = inPage } = {}) {
  const dom = page(`<input id=i aria-label="City"><button id=b>Go</button>`);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active, x: 10, y: 20, w: 800, h: 600, tabs: [{ url: "about:blank", id: "front" }, { url: "about:blank", id: "scratch", dom }] }] }],
    cg: cg || [{ owner: "Terminal", pid: 1, wid: 10 }, ...extra, { owner: "Google Chrome", pid: 5, wid: 77, ...WIN, ax: { web: [AREA] } }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  world.state.focus = focus;
  world.state.onPost = (e) => { if (e.kind === "key") trustedKey(dom, e.down ? "keydown" : "keyup", KEY_OF[e.vk]); };
  return { world, dom };
}
const target = { app: "Google Chrome", windowId: 1, tabIndex: 1 };
const keys = (world) => world.posted.filter((e) => e.kind === "key").map((e) => ({ via: e.via, pid: e.pid, vk: e.vk, down: e.down, text: e.text, len: e.len, flags: e.flags }));

test("trusted press posts a real key pair to the browser pid, focused on the element", async () => {
  const { world, dom } = background();
  const r = await handleCall("press", { key: "Enter", selector: "#i", trusted: true, target });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, el: 'textbox "City"', key: "Enter", hit: true, focus: 'textbox "City"', delivery: "skylight" });
  assert.deepEqual(keys(world), [
    { via: "skylight", pid: 5, vk: 36, down: true, text: "\r", len: 1, flags: 0 },
    { via: "skylight", pid: 5, vk: 36, down: false, text: "\r", len: 1, flags: 0 },
  ]);
  assert.equal(dom.document.activeElement.id, "i");
  assert.equal(world.posted.length, 2, "no mouse events");
  assert.equal(world.log.filter((entry) => entry[0] === "SLPSPostEventRecordTo").length, 0, "never borrow the user's key focus");
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
  assert.equal(world.counts["win.activeTabIndex="], undefined);
  assert.deepEqual(world.state.warps, []);
});

test("trusted press: shift is the only modifier, and never with Command", async () => {
  const { world } = background();
  const r = await handleCall("press", { key: "shift+Tab", trusted: true, target });
  assert.equal(JSON.parse(r.content[0].text).hit, true, r.content[0].text);
  assert.deepEqual(keys(world).map((k) => [k.vk, k.text, k.flags]), [[48, "\t", 0x20000], [48, "\t", 0x20000]]);
  world.posted.length = 0;
  await handleCall("press", { key: "ArrowDown", trusted: true, target });
  assert.deepEqual(keys(world).map((k) => [k.vk, k.text, k.flags]), [[125, "", 0], [125, "", 0]]);
  world.posted.length = 0;
  await handleCall("press", { key: "Space", trusted: true, target });
  assert.deepEqual(keys(world).map((k) => [k.vk, k.text]), [[49, " "], [49, " "]]);
  for (const k of keys(world)) assert.equal(k.flags & 0x100000, 0);
});

test("trusted press never posts a Tab that would move focus out of the page", async () => {
  const { world } = background();
  for (const [key, selector] of [["shift+Tab", "#i"], ["Tab", "#b"]]) {
    const r = await handleCall("press", { key, selector, trusted: true, target });
    assert.match(JSON.parse(r.content[0].text).error, /focusable element; a real Tab would move focus into the browser's toolbar/, key);
  }
  assert.equal(keys(world).length, 0);
});

test("trusted press refuses chords and characters before touching the browser", async () => {
  const { world } = background();
  for (const key of ["cmd+k", "ctrl+Enter", "alt+ArrowDown", "a", "shift+a"]) {
    const r = await handleCall("press", { key, trusted: true, target });
    assert.equal(r.isError, true, key);
    assert.match(r.content[0].text, /press: trusted takes a named key \(Enter, Escape, Tab, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, F1-F12\), optionally with shift/, key);
  }
  assert.equal(world.posted.length, 0);
});

test("trusted press needs the tab its window shows, on screen", async () => {
  const { world } = background({ active: 0 });
  const r = await handleCall("press", { key: "Enter", trusted: true, target });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^error: tab_not_visible: a background trusted press needs the tab its window shows/);
  assert.doesNotMatch(r.content[0].text, /raise/);
  assert.equal(world.counts["win.activeTabIndex="], undefined);
  assert.equal(world.posted.length, 0);

  const off = background({ cg: [{ owner: "Terminal", pid: 1, wid: 10 }] });
  const o = await handleCall("press", { key: "Enter", trusted: true, target });
  assert.match(o.content[0].text, /window_offscreen/);
  assert.equal(off.world.posted.length, 0);
});

test("trusted press reports hit:null when no keydown reaches the page, and ok:false", async () => {
  const { world } = background();
  world.state.onPost = null;
  const r = await handleCall("press", { key: "Escape", trusted: true, target });
  const o = JSON.parse(r.content[0].text);
  assert.match(o.error, /no key reached the page/);
  delete o.error;
  assert.deepEqual(o, { ok: false, el: 'generic "Go"', key: "Escape", hit: null, focus: 'generic "Go"', delivery: "skylight" });
  assert.equal(keys(world).length, 2);
});

// A key posted to the pid goes to the browser's key window and its focused
// element, so the press refuses unless both are the target's page.
async function refused(opts, hint, code = "tab_not_visible") {
  const { world, dom } = background(opts);
  const r = await handleCall("press", { key: "Enter", selector: "#i", trusted: true, target });
  assert.equal(r.isError, true, r.content[0].text);
  assert.match(r.content[0].text, new RegExp("^error: " + code + ": "));
  assert.match(r.content[0].text, hint);
  assert.equal(world.posted.length, 0, "nothing posted");
  assert.equal(dom.__perch_key, undefined, "the page was not armed");
  assert.notEqual(dom.document.activeElement.id, "i", "page focus untouched");
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
}
const OTHER = { x: 300, y: 200, w: 700, h: 500 };
const BUBBLE = { x: 400, y: 60, w: 320, h: 180 };
const onRaise = /another browser window has the keyboard.*click \{trusted:true, raise:true\}/;
const onClick = /keyboard focus is outside the page.*trusted click on the page first/;

test("trusted press refuses when another browser window is the key window", async () => {
  await refused({
    extra: [{ owner: "Google Chrome", pid: 5, wid: 78, ...OTHER, ax: { web: [] } }],
    focus: { window: OTHER, chain: [{ role: "AXTextField" }, { role: "AXWebArea", box: { ...OTHER, y: 280, h: 420 } }, { role: "AXWindow", box: OTHER }] },
  }, onRaise);
});

test("trusted press refuses when focus is in the toolbar (the address bar)", async () => {
  await refused({ focus: { window: WIN, chain: [{ role: "AXTextField", box: { x: 100, y: 5, w: 500, h: 20 } }, { role: "AXToolbar" }, { role: "AXWindow", box: WIN }] } }, onClick);
});

test("trusted press refuses when focus is in a bubble, a child window or a side panel", async () => {
  // A bubble's own window has the focus.
  await refused({
    extra: [{ owner: "Google Chrome", pid: 5, wid: 79, ...BUBBLE }],
    focus: { window: BUBBLE, chain: [{ role: "AXButton" }, { role: "AXGroup" }, { role: "AXWindow", box: BUBBLE }] },
  }, onRaise);
  // The target window reports focus, but the element hangs off a popup, not the page.
  await refused({ focus: { window: WIN, chain: [{ role: "AXButton" }, { role: "AXGroup" }, { role: "AXPopover" }, { role: "AXWindow", box: WIN }] } }, onClick);
  // A web area that is not the page's (a side panel's).
  await refused({ focus: { window: WIN, chain: [{ role: "AXTextField" }, { role: "AXWebArea", box: { x: 610, y: 20, w: 200, h: 600 } }, { role: "AXWindow", box: WIN }] } }, onClick);
});

test("trusted press refuses when the focused window can't be told apart", async () => {
  // A twin of the target's frame is refused before focus is read.
  await refused({ extra: [{ owner: "Google Chrome", pid: 5, wid: 78, ...WIN }] }, /same frame/, "window_ambiguous");
  // One 3pt off is not a tie for the target, but the focused window's frame
  // still matches two CG entries: no unique match.
  await refused({ extra: [{ owner: "Google Chrome", pid: 5, wid: 78, ...WIN, x: WIN.x + 3 }] }, onRaise);
  // No focused window at all.
  await refused({ focus: null }, onRaise);
});

const onFrame = /focus is inside an embedded frame; frames take only click \{trusted:true\}/;

test("trusted press accepts focus anywhere inside the page's own web area", async () => {
  for (const focus of [inPage, { window: WIN, chain: [{ role: "AXWebArea", box: AREA }, { role: "AXWindow", box: WIN }] }]) {
    const { world } = background({ focus });
    const r = await handleCall("press", { key: "Enter", selector: "#i", trusted: true, target });
    assert.equal(JSON.parse(r.content[0].text).hit, true, r.content[0].text);
    assert.equal(keys(world).length, 2);
  }
});

test("trusted press refuses when focus is inside an embedded frame", async () => {
  // The first web area up from the focus is the frame's, even though the page's sits above it.
  const frame = { x: 50, y: 300, w: 300, h: 150 };
  await refused({ focus: { window: WIN, chain: [{ role: "AXTextField" }, { role: "AXWebArea", box: frame }, { role: "AXGroup" }, { role: "AXWebArea", box: AREA }, { role: "AXWindow", box: WIN }] } }, onFrame);
  await refused({ focus: { window: WIN, chain: [{ role: "AXCheckBox" }, { role: "AXGroup" }, { role: "AXWebArea", box: frame }, { role: "AXWebArea", box: AREA }, { role: "AXWindow", box: WIN }] } }, onFrame);
});

test("trusted press stops on a missed element without posting", async () => {
  const { world } = background();
  const r = await handleCall("press", { key: "Enter", ref: "3", trusted: true, target });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ref 3 is stale/);
  const s = await handleCall("press", { key: "Enter", selector: "#nope", trusted: true, target });
  assert.equal(JSON.parse(s.content[0].text).ok, false);
  assert.equal(world.posted.length, 0);
});

test("trusted press without Accessibility fails before posting", async () => {
  const { world } = background();
  world.state.ax = false;
  const r = await handleCall("press", { key: "Enter", trusted: true, target });
  assert.match(r.content[0].text, /Accessibility permission required/);
  assert.equal(world.posted.length, 0);
});

test("the press schema offers trusted and says to check hit", () => {
  const press = TOOLS.find((t) => t.name === "press");
  assert.ok(press.description.includes("`trusted`: real key events in the shown tab; check `hit`."), press.description);
  assert.deepEqual(press.inputSchema.properties.trusted, { type: "boolean" });
});

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

test("trusted press posts no key when its arm step throws", async () => {
  const { world, dom } = background();
  const threw = throwAt(dom, "const framed = function (e)");
  const r = await handleCall("press", { key: "Enter", selector: "#i", trusted: true, target });
  assert.ok(threw() > 0);
  assert.equal(r.isError, undefined, r.content[0].text);
  const o = JSON.parse(r.content[0].text);
  assert.deepEqual(o, { ok: false, error: "press: the page script failed on this page (TypeError); nothing was pressed" });
  noRaw(o);
  assert.equal(keys(world).length, 0);
  assert.deepEqual(world.state.warps, []);
});

test("trusted press whose check throws after the key is ok:false and unverified", async () => {
  const { world, dom } = background();
  throwAt(dom, "const d = st && st.down;");
  const r = await handleCall("press", { key: "Enter", selector: "#i", trusted: true, target });
  assert.equal(r.isError, undefined, r.content[0].text);
  const o = JSON.parse(r.content[0].text);
  assert.deepEqual(o, { ok: false, el: 'textbox "City"', key: "Enter", delivery: "skylight", error: "press: the key was sent; the page script failed checking it (TypeError); outcome unverified" });
  noRaw(o);
  assert.equal(keys(world).length, 2);
});
