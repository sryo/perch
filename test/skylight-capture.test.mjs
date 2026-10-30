// A minimized window has no on-screen CG entry and CGWindowListCreateImage draws
// nothing for it. Accessibility still lists it (AXMinimized, with its
// CGWindowID), and SkyLight's SLSHWCaptureWindowList still has its pixels. Every
// other window stays on the CG path, and a window perch can't capture says why.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { JXA_PRELUDE, DAEMONS, handleCall, deps } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const CANARY = "Google Chrome Canary", BUNDLE = "com.google.Chrome.canary";
const saved = { fast: DAEMONS.fast, slow: DAEMONS.slow, exec: deps.exec, env: process.env.PERCH_CAPTURE_SKYLIGHT };
afterEach(() => {
  Object.assign(DAEMONS, { fast: saved.fast, slow: saved.slow });
  Object.assign(deps, { exec: saved.exec });
  if (saved.env === undefined) delete process.env.PERCH_CAPTURE_SKYLIGHT; else process.env.PERCH_CAPTURE_SKYLIGHT = saved.env;
});

let world;
// The only browser window is minimized: no CG entry, an AX window with its id.
function install({ cg = [], state = {}, minimized = [{ pid: 4242, wid: 88, x: 10, y: 0, w: 800, h: 620, title: "Docs" }] } = {}) {
  world = makeWorld({
    browsers: [{ name: CANARY, kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: [{ url: "https://a.test/", id: "t0", title: "Docs" }] }] }],
    cg,
  });
  Object.assign(world.state, { helper: {}, minimized, pids: { [BUNDLE]: [4242] } }, state);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
function spawns() {
  const calls = [];
  deps.exec = async (cmd, a) => {
    calls.push([cmd, ...a]);
    const png = Buffer.alloc(33);
    png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1568, 16); png.writeUInt32BE(1215, 20);
    await writeFile(a[a.length - 1], png);
    return { stdout: "" };
  };
  return calls;
}
const skyShots = () => world.state.shots.filter((s) => s.sky != null);
const cgShots = () => world.state.shots.filter((s) => s.cg != null);

test("a minimized window is captured by SkyLight under the CGWindowID Accessibility gives, and says so", async () => {
  install();
  const calls = spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, undefined, r.content[0].text);
  const meta = JSON.parse(r.content[1].text);
  assert.deepEqual(calls, [], "no screencapture");
  assert.equal(skyShots().length, 1);
  assert.equal(skyShots()[0].sky, 88);
  assert.equal(skyShots()[0].options, (1 << 11) | (1 << 8), "no global clip shape, best resolution (yabai, AltTab)");
  assert.deepEqual(cgShots().map((s) => s.cg), [88], "CoreGraphics is asked first and draws nothing");
  assert.match(meta.warning, /minimized, hidden or locked/);
  assert.deepEqual(meta.image, { w: 1568, h: 1215 });
  assert.deepEqual(world.state.files, {});
});

test("the minimized window is the AX window titled like the tab's among those framed like it", async () => {
  install({ minimized: [
    { pid: 4242, wid: 87, x: 10, y: 0, w: 800, h: 620, title: "Other" },
    { pid: 4242, wid: 88, x: 10, y: 0, w: 800, h: 620, title: "Docs" },
    { pid: 4242, wid: 89, x: 500, y: 300, w: 400, h: 300, title: "Docs" },
  ] });
  spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(skyShots()[0].sky, 88);
});

test("two minimized windows that can't be told apart are refused, with nothing captured", async () => {
  install({ minimized: [
    { pid: 4242, wid: 87, x: 10, y: 0, w: 800, h: 620, title: "Docs" },
    { pid: 4242, wid: 88, x: 10, y: 0, w: 800, h: 620, title: "Docs" },
  ] });
  spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^error: window_offscreen:/);
  assert.equal(world.state.shots.length, 0);
});

test("PERCH_CAPTURE_SKYLIGHT=0 keeps a minimized window window_offscreen", async () => {
  install();
  process.env.PERCH_CAPTURE_SKYLIGHT = "0";
  spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^error: window_offscreen:/);
  assert.equal(world.state.shots.length, 0);
});

test("without the Accessibility grant the minimized window is found in CG's all-windows list", async () => {
  install({ state: { ax: false } });
  spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(skyShots()[0].sky, 88);
});

test("an element crop of a minimized window is refused: nothing paints it, so a scroll under it would show nothing", async () => {
  install();
  spawns();
  const r = await handleCall("screenshot", { selector: "body" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^error: window_offscreen:/);
  assert.equal(skyShots().length, 0);
});

test("a window on screen never touches SkyLight", async () => {
  install({ minimized: [], cg: [{ owner: CANARY, pid: 4242, wid: 77, x: 10, y: 0, w: 800, h: 620 }] });
  spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(skyShots().length, 0);
  assert.deepEqual(cgShots().map((s) => s.cg), [77]);
});

test("SkyLight giving no image leaves the capture to screencapture, which refuses a window it can't draw", async () => {
  install({ state: { skyShotEmpty: true } });
  spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(skyShots().length, 1);
  assert.ok(r.isError || r.content[0].data, "an error or the screencapture fallback's image, never a crash");
});

test("the refusal says why: the browser is hidden, a window is on another Space, or neither is known", async () => {
  install({ minimized: [], state: { hidden: [4242] } });
  spawns();
  let r = await handleCall("screenshot", {});
  assert.match(r.content[0].text, /^error: window_offscreen: .*hidden/);
  install({ minimized: [], state: { spaces: { current: [1], all: [1, 2], windows: { 2: [{ wid: 300, pid: 4242 }] } } } });
  r = await handleCall("screenshot", {});
  assert.match(r.content[0].text, /^error: window_offscreen: .*another Space/);
  install({ minimized: [], state: { spaces: { current: [1], all: [1, 2], windows: { 2: [{ wid: 300, pid: 999 }] } } } });
  r = await handleCall("screenshot", {});
  assert.match(r.content[0].text, /^error: window_offscreen: the browser window isn't on screen \(minimized or on another Space\)$/);
});

// Live, with the screen locked: Accessibility listed the windows redacted (no
// AXMinimized, no CGWindowID) while AppleScript and CG's all-windows list stayed whole.
test("with Accessibility redacted (a locked screen) the minimized window is found in CG's all-windows list by title and frame", async () => {
  install({ state: { axRedacted: true } });
  spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(skyShots()[0].sky, 88);
  assert.match(JSON.parse(r.content[1].text).warning, /minimized/);
});

test("the CG fallback refuses two windows it can't tell apart, and a window titled otherwise", async () => {
  install({ state: { axRedacted: true }, minimized: [
    { pid: 4242, wid: 87, x: 10, y: 0, w: 800, h: 620, title: "Docs" },
    { pid: 4242, wid: 88, x: 10, y: 0, w: 800, h: 620, title: "Docs" },
  ] });
  spawns();
  let r = await handleCall("screenshot", {});
  assert.match(r.content[0].text, /^error: window_offscreen:/);
  install({ state: { axRedacted: true }, minimized: [{ pid: 4242, wid: 88, x: 10, y: 0, w: 800, h: 620, title: "Elsewhere" }] });
  r = await handleCall("screenshot", {});
  assert.match(r.content[0].text, /^error: window_offscreen:/);
  assert.equal(skyShots().length, 0);
});

test("Accessibility titles end in the app name (\"Docs: Google Chrome Canary\"); the tie-break still matches the tab's window title", async () => {
  install({ minimized: [
    { pid: 4242, wid: 87, x: 10, y: 0, w: 800, h: 620, title: "Other: Google Chrome Canary" },
    { pid: 4242, wid: 88, x: 10, y: 0, w: 800, h: 620, title: "Docs: Google Chrome Canary" },
  ] });
  spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(skyShots()[0].sky, 88);
});

test("a hidden browser's window is captured the same way, and the warning doesn't call it minimized only", async () => {
  install({ state: { hidden: [4242] } });
  spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(skyShots()[0].sky, 88);
  assert.match(JSON.parse(r.content[1].text).warning, /not on screen \(minimized, hidden or locked\)/);
});
