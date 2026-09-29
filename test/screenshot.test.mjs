// Screenshots: the runtime captures and encodes the window itself, so a call
// spawns nothing; screencapture and sips remain the fallback. And the window
// match behind every capture and trusted post: a target that isn't on screen is
// window_offscreen, never another window of the same browser.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { SHOT_NO_IMAGE, BOUND, RAW, ownTmp, clean, hung } from "./helpers/shot.mjs";
import { JXA_PRELUDE, DAEMONS, handleCall, deps } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const CANARY = "Google Chrome Canary";
const tabs = (n, p = "t") => Array.from({ length: n }, (_, i) => ({ url: `https://${p}${i}.test/`, title: `${p}${i}`, id: `${p}${i}` }));
const saved = { fast: DAEMONS.fast, slow: DAEMONS.slow, exec: deps.exec, dialogs: deps.dialogs };
afterEach(() => Object.assign(DAEMONS, { fast: saved.fast, slow: saved.slow }) && Object.assign(deps, { exec: saved.exec, dialogs: saved.dialogs }));

let world;
function install(spec) {
  world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
const canary = () => install({
  browsers: [{ name: CANARY, kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(1) }] }],
  cg: [{ owner: CANARY, pid: 4242, wid: 77, x: 10, y: 0, w: 800, h: 620 }],
});
const arc = (windows, cg) => install({ browsers: [{ name: "Arc", kind: "arc", windows }], cg });
const geom = (target) => JSON.parse(world.run(`JSON.stringify(__perch.shotGeom(${JSON.stringify({ target })}))`));
const geomErr = (target) => { try { geom(target); } catch (e) { return String(e.message); } return "no error"; };

// Records spawns; screencapture writes a PNG `width` wide, sips resizes it.
function spawns(width = 3000) {
  const calls = [];
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(width, 16); png.writeUInt32BE(1000, 20);
  deps.exec = async (cmd, a) => {
    calls.push([cmd, ...a]);
    if (cmd === "screencapture") await writeFile(a[a.length - 1], png);
    if (cmd === "sips") { const out = Buffer.from(png); out.writeUInt32BE(Number(a[1]), 16); await writeFile(a[a.length - 1], out); }
    return { stdout: "" };
  };
  return calls;
}
const shoot = async (args) => {
  const r = await handleCall("screenshot", args);
  assert.equal(r.isError, undefined, r.content[0].text);
  return { r, meta: JSON.parse(r.content[1].text), bytes: Buffer.from(r.content[0].data, "base64") };
};

// ---- the runtime capture ----

test("screenshot captures in the runtime: nothing spawned from Node, the window alone without its shadow, downscaled to 1568", async () => {
  canary();
  const calls = spawns();
  const { r, meta, bytes } = await shoot({});
  assert.deepEqual(calls, [], "no screencapture or sips from Node");
  const [s] = world.state.shots;
  // screencapture of CGWindowID 77 without its shadow (-o), never CGWindowListCreateImage.
  // A shot to be downscaled is taken as an uncompressed TIFF, which screencapture
  // writes faster than a PNG it would compress only for perch to decode again.
  assert.deepEqual(s.args, ["/usr/sbin/screencapture", "-l", "77", "-x", "-o", "-r", "-t", "tiff", "/tmp/fake/perch-555-1.tiff"]);
  assert.equal(world.counts.CGWindowListCreateImage, undefined);
  assert.deepEqual(world.state.files, {}, "its file is removed");
  // A 2x capture of the 800x620 CG frame, drawn into a 1568-wide bitmap.
  assert.deepEqual([s.scaled.w, s.scaled.h, s.scaled.rect], [1568, 1215, { x: 0, y: 0, w: 1568, h: 1215 }]);
  assert.deepEqual(s.encoded, { type: 4, props: null, w: 1568, h: 1215 });
  assert.equal(r.content[0].mimeType, "image/png");
  assert.equal(bytes.readUInt32BE(0), 0x89504e47);
  assert.deepEqual(meta, { window: { x: 10, y: 0, w: 800, h: 620 }, image: { w: 1568, h: 1215 } });
});

test("screenshot downscales only when wider than maxWidth; maxWidth:0 keeps full size", async () => {
  canary();
  spawns();
  for (const maxWidth of [0, 1600, 4000]) {
    world.state.shots.length = 0;
    const { meta } = await shoot({ maxWidth });
    assert.equal(world.state.shots[0].scaled, undefined, `maxWidth ${maxWidth}`);
    assert.deepEqual(meta.image, { w: 1600, h: 1240 });
  }
  world.state.shots.length = 0;
  assert.deepEqual((await shoot({ maxWidth: 400 })).meta.image, { w: 400, h: 310 });
});

test("a png screenshot that needs no downscale returns screencapture's own PNG, never decoded or encoded again", async () => {
  canary();
  const calls = spawns();
  for (const maxWidth of [0, 1600]) {
    world.state.shots.length = 0;
    const { r, meta, bytes } = await shoot({ maxWidth });
    const [s] = world.state.shots;
    assert.deepEqual(s.args.slice(1, -1), ["-l", "77", "-x", "-o", "-r", "-t", "png"], `maxWidth ${maxWidth}`);
    assert.match(s.args[s.args.length - 1], /\.png$/);
    assert.deepEqual([s.scaled, s.encoded], [undefined, undefined]);
    assert.equal(r.content[0].mimeType, "image/png");
    assert.deepEqual([bytes.readUInt32BE(0), bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [0x89504e47, 1600, 1240], "the file's own bytes");
    assert.deepEqual(meta, { window: { x: 10, y: 0, w: 800, h: 620 }, image: { w: 1600, h: 1240 } });
  }
  assert.deepEqual([calls, world.state.files], [[], {}]);
});

test("a PNG taken to be returned as is that turns out wider than maxWidth is still downscaled", async () => {
  canary();
  spawns();
  // The screens report 1x, but the capture comes back at 2x.
  world.state.screenScale = 1;
  const { meta } = await shoot({ maxWidth: 1000 });
  const [s] = world.state.shots;
  assert.deepEqual(s.args.slice(-3, -1), ["-t", "png"]);
  assert.deepEqual(s.encoded, { type: 4, props: null, w: 1000, h: 775 });
  assert.deepEqual(meta.image, { w: 1000, h: 775 });
});

test("a capture is polled every 2ms, not 10", async () => {
  canary();
  spawns();
  world.state.captureMs = 101;
  const t0 = world.clock.t;
  await shoot({});
  assert.ok(world.clock.t - t0 <= 103, `took ${world.clock.t - t0}ms`);
});

test("screenshot falls back to screencapture and sips when the runtime can't downscale", async () => {
  canary();
  const calls = spawns();
  world.state.scaleFail = true;
  const { meta } = await shoot({ maxWidth: 400 });
  assert.deepEqual(calls.map((c) => c[0]), ["screencapture", "sips"]);
  assert.equal(meta.image.w, 400, "never wider than maxWidth");
});

test("screenshot jpeg is encoded at 0.8 and sent as image/jpeg", async () => {
  canary();
  const calls = spawns();
  const { r, meta, bytes } = await shoot({ format: "jpeg", maxWidth: 0 });
  assert.deepEqual(calls, []);
  assert.deepEqual(world.state.shots[0].args.slice(-3, -1), ["-t", "tiff"], "never screencapture's own JPEG, whose quality isn't 0.8");
  assert.deepEqual(world.state.shots[0].encoded, { type: 3, props: { NSImageCompressionFactor: 0.8 }, w: 1600, h: 1240 });
  assert.equal(r.content[0].mimeType, "image/jpeg");
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8]);
  assert.deepEqual(meta.image, { w: 1600, h: 1240 });
});

test("without the Screen Recording grant the runtime never captures, and screencapture takes over", async () => {
  canary();
  world.state.capture = false;
  const calls = spawns();
  const { meta } = await shoot({});
  assert.equal(world.counts.screencapture, undefined);
  assert.deepEqual(calls.map((c) => c[0]), ["screencapture", "sips"]);
  assert.deepEqual(calls[0].slice(1, 3), ["-l", "77"]);
  assert.deepEqual(meta, { window: { x: 10, y: 0, w: 800, h: 620 }, image: { w: 1568, h: 1000 } });
});

// Another long-lived osascript that has captured makes CGWindowListCreateImage
// wait replayd's 30s, so the capture is a screencapture run the runtime kills.
test("a runtime capture that gives no image in 3s is killed and refused as a coded timeout, well inside the lane's 30s", async () => {
  canary();
  world.state.captureMs = Infinity;
  const calls = spawns();
  const t0 = world.clock.t;
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "error: timeout: screenshot: the window capture gave no image within 3s; nothing was captured");
  assert.ok(world.clock.t - t0 < 3100, `took ${world.clock.t - t0}ms`);
  assert.equal(world.state.shots[0].killed, true);
  assert.deepEqual([calls, world.state.files], [[], {}], "no Node fallback, no file left");
});

test("a runtime capture retried after a miss shares the first run's 3s: a late miss then a slow run is one 3s timeout", async () => {
  canary();
  world.state.captureExit = [1, 0];
  world.state.captureMs = [2800, 2800];
  const calls = spawns();
  const t0 = world.clock.t;
  const r = await handleCall("screenshot", {});
  assert.equal(r.content[0].text, "error: timeout: screenshot: the window capture gave no image within 3s; nothing was captured");
  assert.ok(world.clock.t - t0 < 3100, `took ${world.clock.t - t0}ms`);
  const [a, b] = world.state.shots;
  assert.deepEqual([world.state.shots.length, a.killed, b.killed], [2, undefined, true]);
  assert.deepEqual([calls, world.state.files], [[], {}]);
});

test("a runtime capture that misses once is run again and kept, nothing spawned from Node", async () => {
  canary();
  world.state.captureExit = [1, 0];
  const calls = spawns();
  const { meta } = await shoot({ maxWidth: 0 });
  assert.deepEqual(meta.image, { w: 1600, h: 1240 });
  assert.equal(world.state.shots.length, 2);
  assert.deepEqual([calls, world.state.files], [[], {}]);
});

test("a PNG to be returned as is that misses once is retried as PNG and the second run's own bytes go back", async () => {
  canary();
  world.state.captureExit = [1, 0];
  const calls = spawns();
  const { meta, bytes } = await shoot({ maxWidth: 0 });
  const [a, b] = world.state.shots;
  assert.deepEqual([a.type, b.type], ["png", "png"]);
  assert.notEqual(a.args.at(-1), b.args.at(-1), "each run its own file");
  assert.deepEqual([b.scaled, b.encoded], [undefined, undefined]);
  assert.deepEqual([bytes.readUInt32BE(0), bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [0x89504e47, 1600, 1240], "the second file's own bytes");
  assert.deepEqual(meta.image, { w: 1600, h: 1240 });
  assert.deepEqual([calls, world.state.files], [[], {}]);
});

test("a runtime capture that finishes within 3s is kept", async () => {
  canary();
  world.state.captureMs = 2500;
  spawns();
  const { meta } = await shoot({ maxWidth: 0 });
  assert.deepEqual(meta.image, { w: 1600, h: 1240 });
});

test("a runtime capture that exits nonzero or won't load twice falls back to screencapture, both files removed", async () => {
  for (const set of [() => { world.state.captureExit = 1; }, () => { world.state.unreadable = true; }]) {
    canary();
    set();
    const calls = spawns(1000);
    const { meta } = await shoot({});
    assert.deepEqual(calls.map((c) => c[0]), ["screencapture"]);
    assert.deepEqual(meta.image, { w: 1000, h: 1000 });
    assert.equal(world.state.shots.length, 2);
    assert.deepEqual(world.state.files, {}, "the failed runs' files are removed");
  }
});

test("two empty captures fall back to screencapture", async () => {
  canary();
  world.state.shotEmpty = true;
  const calls = spawns(1000);
  const { r, meta } = await shoot({ format: "jpeg" });
  assert.equal(world.counts.screencapture, 2);
  assert.deepEqual(calls.map((c) => c[0]), ["screencapture"]);
  assert.ok(calls[0].includes("jpg"), calls[0].join(" "));
  assert.equal(r.content[0].mimeType, "image/jpeg");
  assert.deepEqual(meta.image, { w: 1000, h: 1000 });
});

// ---- Node's screencapture fallback: bounded, coded, no leftovers ----

test("a screencapture fallback that hangs is killed at 3s and is a coded timeout, its file removed", { timeout: 2000 }, async (t) => {
  const dir = ownTmp(t);
  canary();
  world.state.capture = false;
  const seen = [];
  deps.exec = hung("screencapture", seen);
  const r = await handleCall("screenshot", {});
  assert.deepEqual(seen, [["screencapture", BOUND]]);
  assert.equal(r.content[0].text, "error: " + SHOT_NO_IMAGE);
  clean(r.content[0].text);
  assert.deepEqual(readdirSync(dir), []);
});

test("a screencapture fallback that exits nonzero, writes nothing or writes no image is window_offscreen, never execFile's or fs's words", async (t) => {
  const dir = ownTmp(t);
  const cases = {
    exit: async () => { throw Object.assign(new Error(RAW), { code: 1, killed: false, stderr: "could not create image from window" }); },
    nofile: async () => ({ stdout: "" }),
    garbage: async (cmd, a) => { await writeFile(a[a.length - 1], "not an image"); return { stdout: "" }; },
  };
  for (const [name, fake] of Object.entries(cases)) {
    canary();
    world.state.capture = false;
    deps.exec = fake;
    const r = await handleCall("screenshot", {});
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /^error: window_offscreen: screenshot: the window capture gave no image/, name);
    clean(r.content[0].text);
    assert.deepEqual(readdirSync(dir), [], name);
  }
});

test("the fallback's resample sips is bounded and stays best effort", async (t) => {
  const dir = ownTmp(t);
  canary();
  world.state.capture = false;
  spawns();
  const capture = deps.exec;
  const opts = [];
  deps.exec = async (cmd, a, o) => {
    opts.push([cmd, o]);
    if (cmd === "sips") throw Object.assign(new Error("Command failed: sips"), { killed: true });
    return capture(cmd, a, o);
  };
  const { meta } = await shoot({});
  assert.deepEqual(opts, [["screencapture", BOUND], ["sips", BOUND]]);
  assert.deepEqual(meta.image, { w: 3000, h: 1000 }, "the full-size capture still goes back");
  assert.deepEqual(readdirSync(dir), []);
});

test("screenshot runs no page JS, so the dialog watchdog never probes for it", async () => {
  canary();
  DAEMONS.fast = undefined;
  DAEMONS.slow = undefined;
  deps.exec = async () => { throw Object.assign(new Error("killed"), { killed: true }); };
  let probes = 0;
  deps.dialogs = async () => { probes++; return [{ kind: "confirm", message: "x" }]; };
  const r = await handleCall("screenshot", {});
  assert.match(r.content[0].text, /^error: timeout/);
  assert.equal(probes, 0);
});

// ---- Arc: the window is matched by title ----

test("Arc screenshot geometry costs one Apple Event beyond resolving the tab", () => {
  arc([{ id: "W1", active: 0, name: "Docs", tabs: tabs(1, "a") }, { id: "W2", active: 0, name: "Mail", tabs: tabs(1, "b") }],
    [{ owner: "Arc", wid: 10, name: "Mail" }, { owner: "Arc", wid: 11, name: "Docs" }]);
  const g = geom({});
  assert.equal(g.windowNumber, 11);
  // resolve: the front window's activeTab.id; geometry: windows.name().
  assert.deepEqual(world.aeBy("Arc"), ["tab.id", "windows.name()(Arc)"]);
});

test("an Arc tab its hint proved shown is not read again for a background screenshot", () => {
  arc([{ id: "W1", active: 0, name: "Docs", tabs: tabs(1, "a") }, { id: "W2", active: 0, name: "Mail", tabs: tabs(1, "b") }],
    [{ owner: "Arc", wid: 10, name: "Mail" }, { owner: "Arc", wid: 11, name: "Docs" }]);
  world.run(`JSON.stringify(__perch.listTabs({}))`);
  world.reset();
  const g = geom({ tabId: "arc:b0" });
  assert.equal(g.windowNumber, 10);
  // resolve: the hinted window's activeTab.id; geometry: windows.name().
  assert.deepEqual(world.aeBy("Arc"), ["tab.id", "windows.name()(Arc)"]);
});

test("Arc: a minimized window is window_offscreen, never another window's CG entry", () => {
  const wins = [{ id: "W1", active: 0, name: "Docs", tabs: tabs(1, "a") }, { id: "W2", active: 0, name: "Mail", tabs: tabs(1, "b") }];
  // W1 (Docs) is minimized: only Mail is on screen.
  arc(wins, [{ owner: "Arc", wid: 10, name: "Mail" }]);
  assert.match(geomErr({ windowId: "W1" }), /^window_offscreen: /);
  assert.equal(geom({ windowId: "W2" }).windowNumber, 10);
  // Two windows titled Mail, one minimized: which CG entry is whose is unknowable.
  arc([{ id: "W1", active: 0, name: "Mail", tabs: tabs(1, "a") }, { id: "W2", active: 0, name: "Mail", tabs: tabs(1, "b") }], [{ owner: "Arc", wid: 10, name: "Mail" }]);
  assert.match(geomErr({ windowId: "W1" }), /^window_offscreen: /);
  assert.match(geomErr({ windowId: "W2" }), /^window_offscreen: /);
});

test("Arc without CG window titles pairs windows by position only while every window is on screen", () => {
  const wins = [{ id: "W1", active: 0, name: "Docs", tabs: tabs(1, "a") }, { id: "W2", active: 0, name: "Mail", tabs: tabs(1, "b") }];
  arc(wins, [{ owner: "Arc", wid: 10 }, { owner: "Arc", wid: 11 }]);
  assert.deepEqual([geom({ windowId: "W1" }).windowNumber, geom({ windowId: "W2" }).windowNumber], [10, 11]);
  arc(wins, [{ owner: "Arc", wid: 11 }]);
  assert.match(geomErr({ windowId: "W1" }), /^window_offscreen: /);
  assert.match(geomErr({ windowId: "W2" }), /^window_offscreen: /);
});

// ---- Chromium and Safari: the window is matched by frame ----

test("a minimized window is window_offscreen even while another window of its browser is on screen", async () => {
  install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [
      { id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(1, "a") },
      { id: 2, active: 0, x: 900, y: 20, w: 800, h: 600, tabs: tabs(1, "b") },
    ] }],
    cg: [{ owner: "Google Chrome", pid: 50, wid: 88, x: 900, y: 0, w: 800, h: 620 }],
  });
  assert.match(geomErr({ app: "Google Chrome", windowId: 1 }), /^window_offscreen: /);
  assert.equal(geom({ app: "Google Chrome", windowId: 2 }).windowNumber, 88);
  const calls = spawns();
  const r = await handleCall("screenshot", { target: { tabId: "chrome:a0" } });
  assert.match(r.content[0].text, /^error: window_offscreen: /);
  assert.deepEqual([calls, world.state.shots], [[], []]);
  const c = await handleCall("click", { trusted: true, x: 100, y: 100, target: { tabId: "chrome:a0" } });
  assert.match(c.content[0].text, /^error: window_offscreen: /);
  assert.deepEqual(world.posted, []);
});

test("the frame match allows a titlebar and toolbar in y and h, not a shifted or resized window", () => {
  const one = (cgFrame) => install({
    browsers: [{ name: "Safari", kind: "safari", windows: [{ id: 3, active: 0, x: 100, y: 200, w: 900, h: 700, tabs: tabs(1, "s") }] }],
    cg: [{ owner: "Safari", pid: 60, wid: 66, ...cgFrame }],
  });
  for (const f of [{ x: 100, y: 200, w: 900, h: 700 }, { x: 96, y: 80, w: 904, h: 820 }, { x: 104, y: 320, w: 896, h: 580 }]) {
    one(f);
    assert.equal(geom({}).windowNumber, 66, JSON.stringify(f));
  }
  for (const f of [{ x: 95, y: 200, w: 900, h: 700 }, { x: 100, y: 200, w: 905, h: 700 }, { x: 100, y: 79, w: 900, h: 700 }, { x: 100, y: 200, w: 900, h: 821 }]) {
    one(f);
    assert.match(geomErr({}), /^window_offscreen: /, JSON.stringify(f));
  }
});
