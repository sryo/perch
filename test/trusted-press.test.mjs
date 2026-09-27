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
  assert.deepEqual(run(w, "trusted_key_arm", { key: "Tab" }), { ok: true, el: 'textbox "Name"' });
  assert.equal(run(w, "trusted_key_arm", { ref: "9", key: "Tab" }).__perch_ref_miss, true);
  assert.match(run(w, "trusted_key_arm", { selector: "#nope", key: "Tab" }).error, /no element/);
  assert.match(run(w, "trusted_key_arm", { selector: "#d", key: "Tab" }).error, /did not accept focus/);
});

test("trusted_key_arm focuses an element inside a shadow root", () => {
  const w = page(`<div id=host></div>`);
  w.document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = `<input id=s aria-label="Inner">`;
  assert.deepEqual(run(w, "trusted_key_arm", { selector: "#s", key: "Enter" }), { ok: true, el: 'textbox "Inner"' });
});

// ---- runtime (fake JXA world) ----

// The page's view of a key event, keyed by virtual keycode (what the browser derives).
const KEY_OF = { 36: "Enter", 53: "Escape", 48: "Tab", 125: "ArrowDown", 49: " " };

function background({ active = 1, cg } = {}) {
  const dom = page(`<input id=i aria-label="City"><button id=b>Go</button>`);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active, x: 10, y: 20, w: 800, h: 600, tabs: [{ url: "about:blank", id: "front" }, { url: "about:blank", id: "scratch", dom }] }] }],
    cg: cg || [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 5, wid: 77, x: 10, y: 0, w: 800, h: 620 }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
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
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: false, el: 'generic "Go"', key: "Escape", hit: null, focus: 'generic "Go"', delivery: "skylight" });
  assert.equal(keys(world).length, 2);
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
  assert.equal(press.description, "Key or chord (Enter, Escape, Tab, ArrowDown, cmd+k) to ref/selector or the focused element; emulates Enter/Space/Tab defaults. `trusted`: real key events in the shown tab; check `hit`.");
  assert.deepEqual(press.inputSchema.properties.trusted, { type: "boolean" });
});
