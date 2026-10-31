// Every server.js instance a test loads (the lock harness loads one per
// scenario) must stay off the user's real rooms: one that is up would answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./lock/harness.mjs";

test("a fresh server instance reads no real rooms registry", async () => {
  const srv = await import("../server.js?rooms-isolation=1");
  assert.match(srv.rooms.home, /nonexistent/);
});

test("the lock harness's servers refuse any rooms endpoint", async () => {
  const srv = await freshServer("rooms-isolation");
  await assert.rejects(() => srv.rooms.fetch("http://127.0.0.1:9300/x/json/version"), /reached the real system/);
  assert.throws(() => new srv.rooms.WebSocket("ws://127.0.0.1:9300/"), /reached the real system/);
});
