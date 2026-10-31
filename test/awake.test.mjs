import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleCall, awake, releaseAwake } from "../server.js";

// macOS locks the screen when the display sleeps, and a locked screen refuses
// trusted input. So each tool call keeps the display awake for awake.ms after it,
// through one `caffeinate -d -i -w <pid>` child: -w ends it with this process, even
// on a crash. Spawns are faked here; nothing real is held.
let spawned;
const fakeSpawn = (cmd, args) => {
  const p = new EventEmitter();
  p.cmd = cmd; p.args = args; p.killed = false;
  p.kill = () => { p.killed = true; p.emit("exit", null, "SIGTERM"); return true; };
  p.unref = () => {};
  spawned.push(p);
  return p;
};
beforeEach((t) => {
  releaseAwake();
  spawned = [];
  Object.assign(awake, { on: true, ms: 600000, spawn: fakeSpawn });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { releaseAwake(); awake.on = false; });
});
// Any tool name works: the hold wraps the call, so an unknown tool needs no browser.
const call = () => handleCall("no_such_tool", {});

test("a tool call holds one display-awake caffeinate tied to this process", async () => {
  await call();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, "caffeinate");
  assert.deepEqual(spawned[0].args, ["-d", "-i", "-w", String(process.pid)]);
  await call();
  await call();
  assert.equal(spawned.length, 1, "repeated calls refresh the one hold");
  assert.equal(spawned[0].killed, false);
});

test("the hold ends awake.ms after the last call, and the next call holds again", async (t) => {
  await call();
  t.mock.timers.tick(9 * 60000);
  await call();
  t.mock.timers.tick(9 * 60000);
  assert.equal(spawned[0].killed, false, "a call refreshes the 10 minutes");
  t.mock.timers.tick(60000);
  assert.equal(spawned[0].killed, true);
  await call();
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].killed, false);
});

test("a caffeinate that exits on its own is replaced by the next call", async () => {
  await call();
  spawned[0].emit("exit", 1, null);
  await call();
  assert.equal(spawned.length, 2);
});

test("a spawn that fails costs the call nothing", async () => {
  awake.spawn = () => { throw new Error("ENOENT"); };
  const r = await call();
  assert.match(r.content[0].text, /unknown tool/);
  awake.spawn = fakeSpawn;
  await call();
  assert.equal(spawned.length, 1, "tried again on the next call");
});

test("releaseAwake (shutdown) ends the hold", async () => {
  await call();
  releaseAwake();
  assert.equal(spawned[0].killed, true);
});

test("with the hold off (PERCH_AWAKE=0) nothing is spawned", async () => {
  awake.on = false;
  await call();
  assert.equal(spawned.length, 0);
});
