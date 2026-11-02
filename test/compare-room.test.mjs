// compare.mjs against a room (--app room:<name>): the suite runs through perch's own
// server over the fake room's DevTools endpoint, with no Apple Event (the isolate
// preload fails any), and closes its scratch tab through close_tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { handleCall, roomsReset } from "../server.js";
import { makeRooms } from "./fakes/cdp-room.mjs";
import { runSuite, closeWith, FIXTURE_URL, OP_IDS } from "../scripts/compare.mjs";

// happy-dom has no layout, so the fake room hit-tests clicks against data-rect boxes,
// and its innerText drops the newline Chrome keeps in the pre-wrap status.
const fixture = readFileSync(new URL("../bench/compare/fixture.html", import.meta.url), "utf8")
  .replace('id="agree"', 'id="agree" data-rect="10,500,20,20"')
  .replace('id="submit"', 'id="submit" data-rect="10,540,100,30"');

test("compare runs every op in a room and closes its scratch tab", async () => {
  const R = makeRooms({ rooms: { work: { sites: { [FIXTURE_URL]: fixture } } } });
  roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  const proto = new Window().HTMLElement.prototype;
  const innerText = Object.getOwnPropertyDescriptor(proto, "innerText");
  Object.defineProperty(proto, "innerText", { configurable: true, get() { return this.textContent; } });
  try {
    const closed = [];
    const close = closeWith(handleCall);
    const suite = await runSuite(handleCall, { app: "room:work", reps: 1, close: async (t) => closed.push(await close(t)) });
    assert.equal(suite.app, "room:work");
    for (const id of OP_IDS) {
      const [rep] = suite.ops[id].reps;
      assert.ok(rep.ok, `${id}: ${rep.note}`);
      assert.ok(rep.calls > 0, id);
    }
    assert.deepEqual(closed, [true]);
    assert.deepEqual([...R.room("work").targets.keys()], ["T0001"]);
  } finally {
    if (innerText) Object.defineProperty(proto, "innerText", innerText); else delete proto.innerText;
    roomsReset();
  }
});
