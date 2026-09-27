import { test } from "node:test";
import assert from "node:assert/strict";
import { OsaDaemon, jxa, ERR } from "../server.js";
import { fakeSpawner } from "./fakes/fake-repl.mjs";

const daemonWith = (opts, extra = {}) => {
  const f = fakeSpawner(opts);
  return { d: new OsaDaemon({ spawn: f.spawnFn, ...extra }), f };
};

test("round-trips strings, objects, and undefined", async () => {
  const { d } = daemonWith();
  assert.equal(await d.run("'hi'", 1000), "hi");
  assert.equal(await d.run("({a:1})", 1000), '{"a":1}');
  assert.equal(await d.run("undefined", 1000), "");
  d.kill();
});

test("script errors reject with the message and keep the daemon alive", async () => {
  const { d, f } = daemonWith();
  await assert.rejects(d.run("throw new Error('boom')", 1000), /boom/);
  assert.equal(await d.run("2", 1000), "2");
  assert.equal(f.spawned.length, 1);
  d.kill();
});

test("a result marker split across tiny chunks still resolves", async () => {
  const { d } = daemonWith({ chunk: 3 });
  assert.equal(await d.run("'x'.repeat(50)", 1000), "x".repeat(50));
  d.kill();
});

test("large chunked output is parsed incrementally, not rescanned", async () => {
  const { d } = daemonWith({ chunk: 100 });
  const t0 = performance.now();
  const out = await d.run("'y'.repeat(200000)", 5000);
  assert.equal(out.length, 200000);
  assert.ok(performance.now() - t0 < 1500, `took ${performance.now() - t0}ms`);
  d.kill();
});

test("the first line after spawn is the prelude handshake", async () => {
  const { d, f } = daemonWith({}, { prelude: "globalThis.__pre = 7;" });
  assert.equal(await d.run("__pre", 1000), "7");
  assert.match(f.spawned[0].lines[0], /__pre|%5F%5Fpre/);
  d.kill();
});

test("timeout kills the daemon and does not re-run the script", async () => {
  const { d, f } = daemonWith({ mode: "silent" });
  await assert.rejects(d.run("1", 50), (e) => e.message === ERR.timeout(50) && !e.notSent);
  assert.equal(f.spawned[0].killed, true);
  assert.ok(ERR.timeout(30000).length <= 200);
});

test("exit mid-call rejects without the notSent flag; next call respawns", async () => {
  const { d, f } = daemonWith({ mode: "exitMidCall" });
  await assert.rejects(d.run("1", 1000), (e) => !e.notSent);
  await assert.rejects(d.run("1", 1000));
  assert.equal(f.spawned.length, 2);
});

test("a write that throws marks the job notSent (safe to retry one-shot)", async () => {
  const { d } = daemonWith({ mode: "throwOnWrite" });
  await assert.rejects(d.run("1", 1000), (e) => e.notSent === true);
});

test("jxa falls back to one-shot only for notSent failures", async () => {
  const calls = [];
  const oneShot = async (s) => { calls.push(s); return "fallback"; };
  const silent = daemonWith({ mode: "silent" }).d;
  await assert.rejects(jxa("1", { timeout: 50, daemons: { fast: silent }, oneShot }));
  assert.equal(calls.length, 0);
  const broken = daemonWith({ mode: "throwOnWrite" }).d;
  assert.equal(await jxa("1", { daemons: { fast: broken }, oneShot }), "fallback");
  assert.equal(calls.length, 1);
});

test("a hung slow-lane call does not block the fast lane", async () => {
  const slow = daemonWith({ mode: "silent" }).d;
  const fast = daemonWith().d;
  const hung = jxa("1", { lane: "slow", timeout: 2000, daemons: { slow, fast } }).catch(() => {});
  assert.equal(await jxa("'quick'", { daemons: { slow, fast } }), "quick");
  slow.kill(); fast.kill();
  await hung;
});

test("abort() rejects the current job with the given error, kills the REPL, and the next call respawns", async () => {
  const { d, f } = daemonWith({ mode: "silent" });
  const token = {};
  const job = d.run("1", 5000, token);
  await new Promise((r) => setTimeout(r, 20));
  const err = new Error("dialog_open: test");
  assert.equal(d.abort(err, token), true);
  await assert.rejects(job, (e) => e === err);
  assert.equal(f.spawned[0].killed, true);
  await assert.rejects(d.run("1", 50), (e) => e.message === ERR.timeout(50));
  assert.equal(f.spawned.length, 2);
});

test("a stale abort after its job finished is a no-op", async () => {
  const { d, f } = daemonWith();
  const token = {};
  assert.equal(await d.run("1", 1000, token), "1");
  assert.equal(d.abort(new Error("late"), token), false);
  assert.equal(f.spawned[0].killed, false);
  // Another call's job is not the aborted token's either.
  const other = d.run("'x'", 1000);
  assert.equal(d.abort(new Error("late"), token), false);
  assert.equal(await other, "x");
  assert.equal(f.spawned.length, 1);
  d.kill();
});

test("the daemon runs its own stdin loop, not `osascript -i`", async () => {
  const { d, f } = daemonWith();
  assert.equal(await d.run("1", 1000), "1");
  assert.equal(f.spawned[0].cmd, "osascript");
  assert.ok(!f.spawned[0].args.includes("-i"), f.spawned[0].args.join(" "));
  d.kill();
});

test("a REPL that never answers the handshake disables the daemon after one wait", async () => {
  const { d, f } = daemonWith({ mode: "deaf" }, { handshakeTimeout: 50 });
  const t0 = performance.now();
  await assert.rejects(d.run("1", 1000), (e) => e.notSent === true);
  const t1 = performance.now();
  await assert.rejects(d.run("1", 1000), (e) => e.notSent === true);
  assert.ok(performance.now() - t1 < 20, `second call waited ${performance.now() - t1}ms`);
  assert.ok(t1 - t0 >= 45, "first call waits the handshake out");
  assert.equal(f.spawned.length, 1, "no respawn per call");
  d.kill();
});

test("jxa falls back to one-shot at once when the daemon is disabled", async () => {
  const { d } = daemonWith({ mode: "deaf" }, { handshakeTimeout: 50 });
  let shots = 0;
  const oneShot = async () => { shots++; return "ok"; };
  assert.equal(await jxa("1", { daemons: { fast: d }, oneShot }), "ok");
  const t = performance.now();
  assert.equal(await jxa("1", { daemons: { fast: d }, oneShot }), "ok");
  assert.ok(performance.now() - t < 20);
  assert.equal(shots, 2);
  d.kill();
});

// Runs by default on macOS: it's the only guard against a REPL that stops answering.
// PERCH_LIVE=0 opts out (hermetic runs).
test("real osascript daemon answers line by line", { skip: process.platform !== "darwin" || process.env.PERCH_LIVE === "0" }, async () => {
  const d = new OsaDaemon({ prelude: "globalThis.__t = 41" });
  const t0 = performance.now();
  assert.equal(await d.run("__t + 1", 5000), "42");
  assert.equal(await d.run("'<<:>>'", 5000), "<<:>>");
  assert.ok(performance.now() - t0 < 4000, `took ${performance.now() - t0}ms`);
  d.kill();
});
