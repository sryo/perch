import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OsaDaemon, jxa, ERR } from "../server.js";
import { fakeSpawner } from "./fakes/fake-repl.mjs";

// Whether `p` settles before one turn of the event loop: no timer, spawn or I/O in between.
const settlesAtOnce = async (p) => {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setImmediate(r));
  return settled;
};

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
  const out = await d.run("'y'.repeat(200000)", 60000);
  assert.equal(out.length, 200000);
  // Every byte is searched about once: a rescan from the start of the buffer on
  // each of the 2000 chunks would search ~200M.
  assert.ok(d.scanned < 2 * 200000, `scanned ${d.scanned} chars`);
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
  assert.ok(performance.now() - t0 >= 45, "first call waits the handshake out");
  const second = d.run("1", 1000);
  assert.equal(await settlesAtOnce(second), true, "the second call waits for nothing");
  await assert.rejects(second, (e) => e.notSent === true);
  assert.equal(f.spawned.length, 1, "no respawn per call");
  d.kill();
});

test("jxa falls back to one-shot at once when the daemon is disabled", async () => {
  const { d, f } = daemonWith({ mode: "deaf" }, { handshakeTimeout: 50 });
  let shots = 0;
  const oneShot = async () => { shots++; return "ok"; };
  assert.equal(await jxa("1", { daemons: { fast: d }, oneShot }), "ok");
  const second = jxa("1", { daemons: { fast: d }, oneShot });
  assert.equal(await settlesAtOnce(second), true, "the fallback waits for nothing");
  assert.equal(await second, "ok");
  assert.equal(shots, 2);
  assert.equal(f.spawned.length, 1);
  d.kill();
});

// ---- warm start ----

test("warm spawns and handshakes once; the first call then reuses the REPL", async () => {
  const { d, f } = daemonWith({}, { prelude: "globalThis.__pre = 7;" });
  d.warm();
  d.warm();
  assert.equal(f.spawned.length, 1, "a second warm is a no-op");
  assert.match(f.spawned[0].lines[0], /__pre|%5F%5Fpre/, "the warm line is the prelude handshake");
  assert.equal(await d.run("__pre", 1000), "7");
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].lines.length, 2, "handshake plus the call, no second handshake");
  d.warm();
  assert.equal(f.spawned.length, 1, "warm on a live REPL spawns nothing");
  d.kill();
});

test("a call that lands mid-handshake waits for it instead of hanging", async () => {
  const { d, f } = daemonWith({ chunk: 2 });
  d.warm();
  assert.equal(await d.run("'x'", 1000), "x");
  assert.equal(f.spawned.length, 1);
  d.kill();
});

test("warm swallows a spawn failure and the next call spawns again", async () => {
  const f = fakeSpawner();
  let fail = true;
  const d = new OsaDaemon({ spawn: (...a) => { if (fail) throw new Error("EAGAIN"); return f.spawnFn(...a); } });
  d.warm();
  await new Promise((r) => setImmediate(r));
  assert.equal(d.proc, null);
  assert.equal(d.disabled, null);
  fail = false;
  assert.equal(await d.run("1", 1000), "1");
  assert.equal(f.spawned.length, 1);
  d.kill();
});

test("warm on a deaf REPL disables it; a call queued behind the handshake falls back", async () => {
  const { d, f } = daemonWith({ mode: "deaf" }, { handshakeTimeout: 50 });
  d.warm();
  await assert.rejects(d.run("1", 1000), (e) => e.notSent === true);
  assert.ok(d.disabled);
  d.warm();
  assert.equal(f.spawned.length, 1, "a disabled daemon never warms again");
  d.kill();
});

// The entry block, run for real with a fake `osascript` on PATH that records each spawn.
async function startServer(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "perch-warm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "spawns");
  await writeFile(join(dir, "osascript"), `#!/bin/sh\necho spawn >> "${log}"\nexec cat > /dev/null\n`);
  await chmod(join(dir, "osascript"), 0o755);
  const server = fileURLToPath(new URL("../server.js", import.meta.url));
  const p = spawn(process.execPath, [server], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise((r) => p.on("exit", r));
  t.after(async () => { p.stdin.end(); await exited; });
  const replied = new Promise((r) => p.stdout.once("data", r));
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
  await replied;
  const spawns = () => readFile(log, "utf8").then((s) => s.split("\n").filter(Boolean).length, () => 0);
  return { spawns };
}

test("the server warms both lanes once it is connected", async (t) => {
  const { spawns } = await startServer(t);
  // A ceiling that only catches a hang: the spawns land in milliseconds.
  for (let i = 0; i < 750 && (await spawns()) < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await spawns(), 2);
});

test("PERCH_DAEMON=0 warms nothing", async (t) => {
  const { spawns } = await startServer(t, { PERCH_DAEMON: "0" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await spawns(), 0);
});

// Runs by default on macOS: it's the only guard against a REPL that stops answering.
// PERCH_LIVE=0 opts out (hermetic runs).
test("real osascript daemon answers line by line", { skip: process.platform !== "darwin" || process.env.PERCH_LIVE === "0" }, async () => {
  // Each run's own timeout is the ceiling: generous, so only a REPL that stopped answering fails.
  const d = new OsaDaemon({ prelude: "globalThis.__t = 41", handshakeTimeout: 15000 });
  assert.equal(await d.run("__t + 1", 15000), "42");
  assert.equal(await d.run("'<<:>>'", 15000), "<<:>>");
  d.kill();
});
