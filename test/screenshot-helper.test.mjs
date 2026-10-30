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

test("with the capture lock held by another perch server that registered no helper, none is launched, screencapture takes it, and the lock is checked again only after 10s", async () => {
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

// ---- another perch server's helper ----

const REG = "/tmp/fake/perch-capture.helper";
const filesLeft = () => Object.keys(world.state.files).sort();

test("with the lock held by another server's registered helper, the shot goes through that helper: no launch, no screencapture, one lock probe", async () => {
  install(null);
  const f = world.hostHelper();
  const calls = spawns();
  const { meta } = await shoot({});
  const j = await shoot({ format: "jpeg" });
  assert.deepEqual(calls, []);
  assert.equal(scShots().length, 0, "no screencapture run");
  assert.equal(world.state.helpers, undefined, "no helper launched");
  assert.equal(f.served, 2);
  assert.equal(cgShots().length, 2);
  assert.deepEqual(meta.image, { w: 1568, h: 1215 });
  assert.equal(j.r.content[0].mimeType, "image/jpeg");
  assert.deepEqual(world.state.flocks, [6], "the lock is probed once, then the helper's pid");
  assert.equal(world.state.sigkills, undefined);
  assert.deepEqual(filesLeft(), [REG], "only the other server's registry is left");
});

test("a slot holding another client's request is never overwritten: the shot waits for the helper to take it, then lands", async () => {
  install(null);
  const f = world.hostHelper({ ms: 20 });
  const other = { wid: 77, format: "png", maxWidth: 0, map: null, out: "/tmp/fake/perch-900-h1.42-1.json", until: world.clock.t + 5000 };
  world.state.files[f.prefix + ".req"] = { text: JSON.stringify(other) };
  spawns();
  const t0 = world.clock.t;
  await shoot({});
  const took = world.clock.t - t0;
  assert.ok(took >= 40 && took < 100, `took ${took}ms`);
  assert.equal(f.served, 2, "the other request first, then this one");
  assert.equal(scShots().length, 0);
  assert.ok(world.state.files[other.out], "the other client's reply is left for it");
  delete world.state.files[other.out];
  assert.deepEqual(filesLeft(), [REG]);
});

test("the owner's own shot waits for a request another server put in its helper's slot, and never replaces it", async () => {
  install({ ms: 20 });
  spawns();
  await shoot({});
  const other = { wid: 77, format: "png", maxWidth: 0, map: null, out: "/tmp/fake/perch-555-h1.42-1.json", until: world.clock.t + 5000 };
  world.state.files["/tmp/fake/perch-555-h1.req"] = { text: JSON.stringify(other) };
  const t0 = world.clock.t;
  await shoot({});
  assert.ok(world.clock.t - t0 >= 40, `took ${world.clock.t - t0}ms`);
  assert.equal(cgShots().length, 3);
  assert.ok(world.state.files[other.out]);
  delete world.state.files[other.out];
  onlyLock();
});

test("another server's helper that stalls is never killed: screencapture takes the shot in the same call, that helper is left off for 60s, and the expired request it skips leaves no file", async () => {
  install(null);
  const f = world.hostHelper({ stall: true });
  const calls = spawns();
  const t0 = world.clock.t;
  const { meta } = await shoot({});
  const took = world.clock.t - t0;
  assert.ok(took >= 1000 && took < 1500, `took ${took}ms`);
  assert.deepEqual([f.alive, f.killed, world.state.sigkills], [true, false, undefined], "never signalled");
  assert.equal(scShots().length, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(meta.image, { w: 1568, h: 1215 });
  const left = JSON.parse(world.state.files[f.prefix + ".req"].text);
  assert.ok(left.until < world.clock.t, "the request left in the slot has expired");
  assert.deepEqual(filesLeft(), [f.prefix + ".req", REG]);
  // Within 60s: straight to screencapture, no wait.
  const t1 = world.clock.t;
  await shoot({});
  assert.ok(world.clock.t - t1 < 100);
  assert.equal(scShots().length, 2);
  // It recovers; after 60s it skips the expired request uncaptured and serves the new one.
  f.cfg().stall = false;
  world.clock.t += 60000;
  await shoot({});
  assert.equal(f.served, 2);
  assert.equal(cgShots().length, 1, "only the live request was captured");
  assert.equal(scShots().length, 2);
  assert.deepEqual(filesLeft(), [REG]);
});

test("another server's stalled helper and a hung screencapture still end at 3s", async () => {
  install(null, { state: { captureMs: Infinity } });
  const f = world.hostHelper({ stall: true });
  spawns();
  const t0 = world.clock.t;
  const r = await handleCall("screenshot", {});
  assert.equal(r.content[0].text, "error: " + SHOT_NO_IMAGE);
  const took = world.clock.t - t0;
  assert.ok(took >= 3000 && took <= 3500, `took ${took}ms`);
  assert.equal(f.killed, false);
});

test("a registry naming a pid that is gone falls back as before: screencapture, no launch, no request left, the lock checked again after 10s", async () => {
  install(null);
  world.hostHelper({ dead: true });
  spawns();
  await shoot({});
  await shoot({});
  assert.equal(world.state.helpers, undefined);
  assert.equal(scShots().length, 2);
  assert.deepEqual(world.state.flocks, [6]);
  assert.deepEqual(filesLeft(), [REG]);
  world.clock.t += 10000;
  await shoot({});
  assert.deepEqual(world.state.flocks, [6, 6]);
});

test("another server's helper that exits mid-wait hands the shot to screencapture at once and the request is taken back from its slot", async () => {
  install(null);
  const f = world.hostHelper({ stall: true, goneAt: world.clock.t + 50 });
  spawns();
  const t0 = world.clock.t;
  await shoot({});
  assert.ok(world.clock.t - t0 < 150, `took ${world.clock.t - t0}ms`);
  assert.equal(scShots().length, 1);
  assert.equal(f.killed, false);
  assert.deepEqual(filesLeft(), [REG]);
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
  world.state.files[REQ] = { text: JSON.stringify({ wid: 77, format: "jpeg", maxWidth: 400, map: null, out: "/tmp/fake/r1.json", until: world.clock.t + 1000 }) };
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
  world.state.files[REQ] = { text: JSON.stringify({ wid: 77, format: "png", maxWidth: 0, map: null, out: "/tmp/fake/r1.json", until: world.clock.t + 1000 }) };
  world.run(`__perch.shotHelper("/tmp/fake/perch-555-h1", 555)`);
  assert.equal(world.state.files["/tmp/fake/r1.json"], undefined);
  assert.equal(world.clock.t, t0);
});

test("shotHelper registers {prefix, pid} in perch-capture.helper while it holds the lock, and removes the entry on exit only while it still names it", () => {
  install();
  world.state.lockFile = "/tmp/fake/perch-capture.lock";
  let seen = null;
  world.state.onDelay = () => { if (seen == null) seen = world.state.files[REG]; };
  world.run(`__perch.shotHelper("/tmp/fake/perch-555-h1", 555)`);
  assert.deepEqual(JSON.parse(seen.text), { prefix: "/tmp/fake/perch-555-h1", pid: 555 });
  assert.deepEqual(filesLeft(), []);
  const theirs = JSON.stringify({ prefix: "/tmp/fake/perch-900-h1", pid: 7001 });
  world.state.onDelay = () => { world.state.files[REG] = { text: theirs }; };
  world.run(`__perch.shotHelper("/tmp/fake/perch-555-h1", 555)`);
  assert.equal(world.state.files[REG].text, theirs);
});

test("shotHelper skips a request already past its until: nothing captured, no reply, the slot cleared", () => {
  install();
  world.state.lockFile = "/tmp/fake/perch-capture.lock";
  world.state.files[REQ] = { text: JSON.stringify({ wid: 77, format: "png", maxWidth: 0, map: null, out: "/tmp/fake/r1.json", until: world.clock.t - 1 }) };
  world.run(`__perch.shotHelper(${JSON.stringify(REQ.slice(0, -4))}, 555)`);
  assert.equal(cgShots().length, 0);
  assert.deepEqual(filesLeft(), []);
});

test("a reply finished after its request's until is dropped, never left for a client that gave up", () => {
  install();
  world.state.onDelay = null;
  const until = world.clock.t + 10;
  // The capture itself takes 15ms on the clock.
  world.run(`(function () { const f = $.CGWindowListCreateImage; $.CGWindowListCreateImage = function () { delay(0.015); return f.apply(null, arguments); }; })()`);
  world.run(`__perch.helperServe(${JSON.stringify({ wid: 77, format: "png", maxWidth: 0, map: null, out: "/tmp/fake/r1.json", until })})`);
  assert.equal(cgShots().length, 1);
  assert.deepEqual(filesLeft(), []);
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

// ---- idle cost, stale requests, the off switch ----

test("shotHelper idles at 10ms polls throughout, never the 2ms poll", () => {
  install();
  world.state.lockFile = "/tmp/fake/perch-capture.lock";
  world.state.files[REQ] = { text: JSON.stringify({ wid: 77, format: "png", maxWidth: 0, map: null, out: "/tmp/fake/r1.json", until: world.clock.t + 1000 }) };
  world.state.delays = [];
  world.run(`__perch.shotHelper(${JSON.stringify(REQ.slice(0, -4))}, 555)`);
  assert.deepEqual([...new Set(world.state.delays)], [0.01], "never the 2ms poll");
  const polls = world.state.delays.length;
  assert.ok(polls >= 2900 && polls <= 3000, `${polls} polls in 30s`);
});

test("a stale request left under the new helper's prefix (a reused pid) is removed before the helper launches", async () => {
  install({ exits: true });
  spawns();
  world.state.files[REQ] = { text: JSON.stringify({ wid: 77, format: "png", maxWidth: 0, map: null, out: "/tmp/fake/old.json" }) };
  await shoot({});
  assert.deepEqual(world.state.helpers[0].filesAtLaunch, []);
  onlyLock();
});

test("PERCH_CAPTURE_HELPER=0 turns the helper off: no lock probe, no launch, screencapture takes every shot, crops included", async (t) => {
  const was = process.env.PERCH_CAPTURE_HELPER;
  process.env.PERCH_CAPTURE_HELPER = "0";
  t.after(() => { if (was == null) delete process.env.PERCH_CAPTURE_HELPER; else process.env.PERCH_CAPTURE_HELPER = was; });
  install();
  spawns();
  await shoot({});
  await shoot({ format: "jpeg" });
  assert.deepEqual([world.state.helpers, world.state.flocks, cgShots().length, scShots().length], [undefined, undefined, 0, 2]);
  const p = scrolled({ from: "100,200,300,50" });
  installCrop(p);
  spawns();
  const { meta } = await shoot({ target: { tabId: "chrome:c0" }, selector: "#t" });
  assert.deepEqual([world.state.helpers, cgShots().length, scShots().length], [undefined, 0, 1]);
  assert.deepEqual(meta.clip, { x: 584, y: 544, w: 632, h: 132 });
  onlyLock();
});
