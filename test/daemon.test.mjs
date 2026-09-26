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
