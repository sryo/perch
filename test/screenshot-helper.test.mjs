// The capture helper: a second osascript that captures in process with
// CGWindowListCreateImage and encodes there, so a screenshot spawns no
// screencapture. The daemon waits a bounded time for it and falls back to
// screencapture when it stalls, is gone, or another perch server holds it.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { SHOT_NO_IMAGE, NO_GRANT, scrolled, where } from "./helpers/shot.mjs";
import { JXA_PRELUDE, DAEMONS, handleCall, deps } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const CANARY = "Google Chrome Canary";
const saved = { fast: DAEMONS.fast, slow: DAEMONS.slow, exec: deps.exec };
afterEach(() => Object.assign(DAEMONS, { fast: saved.fast, slow: saved.slow }) && Object.assign(deps, { exec: saved.exec }));

let world;
function install(helper = {}, extra = {}) {
  world = makeWorld({
    browsers: [{ name: CANARY, kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: [{ url: "https://a.test/", id: "t0", ...extra.tab }] }] }],
    cg: [{ owner: CANARY, pid: 4242, wid: 77, x: 10, y: 0, w: 800, h: 620, ...extra.cg }],
  });
  if (helper) world.state.helper = helper;
  Object.assign(world.state, extra.state);
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
const shoot = async (args = {}) => {
  const r = await handleCall("screenshot", args);
  assert.equal(r.isError, undefined, r.content[0].text);
  return { r, meta: JSON.parse(r.content[1].text), bytes: Buffer.from(r.content[0].data, "base64") };
};
const cgShots = () => world.state.shots.filter((s) => s.cg != null);
const scShots = () => world.state.shots.filter((s) => s.args);
const onlyLock = () => assert.deepEqual(world.state.files, {}, "every request and reply file is removed");

test("a screenshot is taken by the capture helper: one osascript running this runtime's shotHelper, no screencapture", async () => {
  install();
  const calls = spawns();
  const { r, meta, bytes } = await shoot({});
  assert.deepEqual(calls, []);
  assert.equal(scShots().length, 0, "no screencapture run");
  const [h] = world.state.helpers;
  assert.deepEqual(Array.from(h.args.slice(0, 3)), ["-l", "JavaScript", "-e"]);
  assert.match(h.args[3], /^\(function jxaRuntime\(BROWSERS, HANG\) \{/);
  assert.match(h.args[3], /\);__perch\.shotHelper\("\/tmp\/fake\/perch-555-h1", 555\)$/);
  const [s] = cgShots();
  assert.equal(s.cg, 77);
  assert.deepEqual([s.scaled.w, s.scaled.h], [1568, 1215]);
  assert.deepEqual(s.encoded, { type: 4, props: null, w: 1568, h: 1215 });
  assert.equal(r.content[0].mimeType, "image/png");
  assert.equal(bytes.readUInt32BE(0), 0x89504e47);
  assert.deepEqual(meta, { window: { x: 10, y: 0, w: 800, h: 620 }, image: { w: 1568, h: 1215 } });
  onlyLock();
});

test("the helper stays up across screenshots: one launch, a jpeg at 0.8 and a full-size png through the same helper", async () => {
  install();
  spawns();
  await shoot({});
  const j = await shoot({ format: "jpeg", maxWidth: 0 });
  const p = await shoot({ maxWidth: 0 });
  assert.equal(world.state.helpers.length, 1);
  assert.equal(j.r.content[0].mimeType, "image/jpeg");
  assert.deepEqual(cgShots()[1].encoded, { type: 3, props: { NSImageCompressionFactor: 0.8 }, w: 1600, h: 1240 });
  assert.deepEqual(p.meta.image, { w: 1600, h: 1240 });
  assert.equal(scShots().length, 0);
  onlyLock();
});

test("the helper's shot costs its own time, not screencapture's: a 20ms helper answers in well under 50ms", async () => {
  install({ ms: 20 });
  spawns();
  await shoot({});
  const t0 = world.clock.t;
  await shoot({});
  assert.ok(world.clock.t - t0 <= 24, `took ${world.clock.t - t0}ms`);
});

test("a helper that doesn't answer in 1s is killed and screencapture takes the shot in the same call; the helper stays off for 60s", async () => {
  install({ stall: true });
  const calls = spawns();
  const t0 = world.clock.t;
  const { meta } = await shoot({});
  const took = world.clock.t - t0;
  assert.ok(took >= 1000 && took < 1500, `took ${took}ms`);
  assert.equal(world.state.helpers[0].killed, true);
  assert.equal(scShots().length, 1, "screencapture ran after the helper");
  assert.deepEqual(calls, []);
  assert.deepEqual(meta.image, { w: 1568, h: 1215 });
  onlyLock();
  // Within 60s: straight to screencapture, no new helper, no wait.
  const t1 = world.clock.t;
  await shoot({});
  assert.equal(world.state.helpers.length, 1);
  assert.ok(world.clock.t - t1 < 100);
  // After 60s a new helper is tried again.
  world.state.helper.stall = false;
  world.clock.t += 60000;
  await shoot({});
  assert.equal(world.state.helpers.length, 2);
  assert.equal(world.state.helpers[1].killed, false);
  assert.equal(cgShots().length, 1);
});

test("a stalled helper and a hung screencapture still end at 3s: the helper's wait counts toward the capture's bound", async () => {
  install({ stall: true }, { state: { captureMs: Infinity } });
  spawns();
  const t0 = world.clock.t;
  const r = await handleCall("screenshot", {});
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "error: " + SHOT_NO_IMAGE);
  const took = world.clock.t - t0;
  assert.ok(took >= 3000 && took <= 3500, `took ${took}ms`);
  onlyLock();
});

test("with the capture lock held by another perch server no helper is launched, screencapture takes it, and the lock is checked again only after 10s", async () => {
  install(null);
  spawns();
  await shoot({});
  await shoot({});
  assert.equal(world.state.helpers, undefined);
  assert.equal(scShots().length, 2);
  assert.deepEqual(world.state.flocks, [6], "one LOCK_EX|LOCK_NB try, not one per shot");
  world.clock.t += 10000;
  await shoot({});
  assert.deepEqual(world.state.flocks, [6, 6]);
  onlyLock();
});

test("a free lock is only probed by the daemon (LOCK_EX|LOCK_NB, then LOCK_UN); the helper takes it", async () => {
  install();
  spawns();
  await shoot({});
  assert.deepEqual(world.state.flocks, [6, 8]);
  assert.equal(world.state.lockFile, "/tmp/fake/perch-capture.lock");
});

test("a helper that ends without answering is replaced by screencapture in the same call and left off for 5s", async () => {
  install({ exits: true });
  spawns();
  const t0 = world.clock.t;
  const { meta } = await shoot({});
  assert.ok(world.clock.t - t0 < 100, `took ${world.clock.t - t0}ms`);
  assert.equal(scShots().length, 1);
  assert.deepEqual(meta.image, { w: 1568, h: 1215 });
  await shoot({});
  assert.equal(world.state.helpers.length, 1);
  world.clock.t += 5000;
  await shoot({});
  assert.equal(world.state.helpers.length, 2);
  onlyLock();
});

test("a helper that captured no image (window gone) hands the shot to screencapture", async () => {
  install({}, { state: { shotEmpty: [true, false] } });
  spawns();
  const { meta } = await shoot({});
  assert.equal(cgShots().length, 1);
  assert.equal(scShots().length, 1);
  assert.deepEqual(meta.image, { w: 1568, h: 1215 });
  onlyLock();
});

test("without the Screen Recording grant no helper is launched", async () => {
  install({}, { state: { capture: false } });
  const calls = spawns();
  const r = await handleCall("screenshot", {});
  assert.equal(r.content[0].text, JSON.stringify({ ok: false, error: NO_GRANT }));
  assert.deepEqual([world.state.helpers, calls, world.state.flocks], [undefined, [], undefined]);
});

// ---- the helper's own loop ----

const REQ = "/tmp/fake/perch-555-h1.req";
test("shotHelper serves a request: captures the window, encodes it, writes the reply whole (.w then renamed), and exits 30s after its last shot", () => {
  install();
  world.state.lockFile = "/tmp/fake/perch-capture.lock";
  world.state.files[REQ] = { text: JSON.stringify({ wid: 77, format: "jpeg", maxWidth: 400, map: null, out: "/tmp/fake/r1.json" }) };
  const t0 = world.clock.t;
  world.run(`__perch.shotHelper(${JSON.stringify(REQ.slice(0, -4))}, 555)`);
  const r = JSON.parse(world.state.files["/tmp/fake/r1.json"].text);
  assert.deepEqual(r.image, { w: 400, h: 310 });
  assert.ok(r.data);
  assert.deepEqual(Object.keys(world.state.files), ["/tmp/fake/r1.json"], "the request is removed, no .w left");
  assert.deepEqual(world.state.flocks, [6], "the helper holds the lock");
  const took = world.clock.t - t0;
  assert.ok(took >= 30000 && took < 30100, `idled out after ${took}ms`);
});

test("shotHelper exits at once when its daemon is gone, and serves nothing without the lock", () => {
  install();
  world.state.lockFile = "/tmp/fake/perch-capture.lock";
  world.state.ppid = 1;
  const t0 = world.clock.t;
  world.run(`__perch.shotHelper("/tmp/fake/perch-555-h1", 555)`);
  assert.equal(world.clock.t, t0);
  world.state.ppid = 555;
  world.state.helper = undefined;
  world.state.files[REQ] = { text: JSON.stringify({ wid: 77, format: "png", maxWidth: 0, map: null, out: "/tmp/fake/r1.json" }) };
  world.run(`__perch.shotHelper("/tmp/fake/perch-555-h1", 555)`);
  assert.equal(world.state.files["/tmp/fake/r1.json"], undefined);
  assert.equal(world.clock.t, t0);
});

// ---- element crops ----

const AREA = { x: 300, y: 130, w: 800, h: 620 };
function installCrop(p, helper = {}) {
  world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 100, y: 50, w: 1000, h: 700, tabs: [{ url: "https://a.test/", id: "c0", dom: p.dom }] }] }],
    cg: [{ owner: "Google Chrome", pid: 4242, wid: 77, x: 100, y: 50, w: 1000, h: 700, ax: { web: [AREA] } }],
  });
  if (helper) world.state.helper = helper;
  world.state.onExecute = (spec) => {
    if (spec.dom && spec.dom.rafs) {
      const frames = spec.dom.rafs.splice(0);
      frames.forEach((cb) => cb(0));
      if (!frames.length) spec.dom.timers.splice(0).forEach((cb) => cb());
    }
  };
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
}

test("an element crop goes through the helper with the shot map: the same crop, no early screencapture", async () => {
  for (const p of [scrolled(), scrolled({ from: "100,200,300,50" })]) {
    installCrop(p);
    const calls = spawns();
    const { meta } = await shoot({ target: { tabId: "chrome:c0" }, selector: "#t" });
    assert.deepEqual(calls, []);
    assert.equal(scShots().length, 0, "no screencapture, not even one started early");
    const [s] = cgShots();
    assert.deepEqual(s.crop, { x: 584, y: 544, w: 632, h: 132 });
    assert.deepEqual(meta, { window: { x: 100, y: 50, w: 1000, h: 700 }, image: { w: 632, h: 132 }, clip: { x: 584, y: 544, w: 632, h: 132 }, aim: "ax" });
    assert.deepEqual(where(p), [0, 40, 37]);
    onlyLock();
  }
});

test("an element crop whose helper stalls is cropped from screencapture after the wait, the scroll restored", async () => {
  const p = scrolled();
  installCrop(p, { stall: true });
  spawns();
  const { meta } = await shoot({ target: { tabId: "chrome:c0" }, selector: "#t" });
  assert.equal(scShots().length, 1);
  assert.deepEqual(scShots()[0].crop, { x: 584, y: 544, w: 632, h: 132 });
  assert.deepEqual(meta.clip, { x: 584, y: 544, w: 632, h: 132 });
  assert.deepEqual(where(p), [0, 40, 37]);
  onlyLock();
});
