// console_capture {mode:"network"}: completed requests read from Resource Timing,
// drained through a cursor like console reads. getEntriesByType is stubbed with
// fixture entries, since happy-dom records no resource timings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

const entry = (i, o = {}) => ({
  name: `https://api.test/r${i}`, initiatorType: "fetch", duration: 84.4,
  transferSize: 1234, decodedBodySize: 1234, responseStatus: 200, ...o,
});

function net(entries) {
  const w = page("");
  const log = { sizes: [] };
  w.performance.getEntriesByType = (t) => (t === "resource" ? entries.slice() : []);
  w.performance.setResourceTimingBufferSize = (n) => log.sizes.push(n);
  return { w, log };
}

test("network: the first call returns everything buffered, later calls only new entries", () => {
  const entries = [entry(1), entry(2, { initiatorType: "script", duration: 3.6, transferSize: 0, decodedBodySize: 900 })];
  const { w, log } = net(entries);
  assert.deepEqual(run(w, "network_read"), {
    ok: true,
    requests: ["200 fetch 84ms 1.2kB https://api.test/r1", "200 script 4ms cache https://api.test/r2"],
  });
  assert.deepEqual(log.sizes, [1000]);
  assert.deepEqual(run(w, "network_read"), { ok: true, requests: [] });
  entries.push(entry(3, { transferSize: 512, responseStatus: 404 }));
  assert.deepEqual(run(w, "network_read").requests, ["404 fetch 84ms 512B https://api.test/r3"]);
  assert.deepEqual(log.sizes, [1000], "the buffer is raised once");
});

test("network: at most 100 lines per call, `more` counts the rest", () => {
  const { w } = net(Array.from({ length: 130 }, (_, i) => entry(i)));
  const a = run(w, "network_read");
  assert.equal(a.requests.length, 100);
  assert.equal(a.more, 30);
  assert.match(a.requests[99], /r99$/);
  const b = run(w, "network_read");
  assert.equal(b.requests.length, 30);
  assert.equal(b.more, undefined);
  assert.match(b.requests[0], /r100$/);
});

test("network: no responseStatus (Safari) gives '-', sizes format, long URLs clip", () => {
  const long = "https://x.test/" + "a".repeat(300);
  const { w } = net([
    entry(1, { responseStatus: undefined, initiatorType: "img", transferSize: 2500000 }),
    entry(2, { responseStatus: 0, transferSize: 0, decodedBodySize: 0 }),
    entry(3, { name: long }),
  ]);
  const [a, b, c] = run(w, "network_read").requests;
  assert.equal(a, "- img 84ms 2.5MB https://api.test/r1");
  assert.equal(b, "- fetch 84ms 0B https://api.test/r2");
  assert.equal(c, "200 fetch 84ms 1.2kB " + long.slice(0, 200) + "...");
});

test("network: `full` when the buffer filled, so the browser dropped some", () => {
  // Before perch raises it the buffer holds the spec default of 250.
  const { w } = net(Array.from({ length: 250 }, (_, i) => entry(i)));
  assert.equal(run(w, "network_read").full, true);
  const small = net([entry(1)]);
  assert.equal(run(small.w, "network_read").full, undefined);
  const raised = [entry(0)];
  const r = net(raised);
  run(r.w, "network_read");
  for (let i = 1; i < 1000; i++) raised.push(entry(i));
  assert.equal(run(r.w, "network_read").full, true);
});

test("network: a cleared buffer restarts the cursor instead of hiding new entries", () => {
  const entries = [entry(1), entry(2)];
  const { w } = net(entries);
  run(w, "network_read");
  entries.length = 0;
  entries.push(entry(9));
  assert.deepEqual(run(w, "network_read").requests, ["200 fetch 84ms 1.2kB https://api.test/r9"]);
});

test("network: works without Resource Timing support", () => {
  const w = page("");
  w.performance.getEntriesByType = undefined;
  assert.deepEqual(run(w, "network_read"), { ok: false, error: "network: this browser has no Resource Timing" });
});

test("console_capture {mode:'network'} runs through the tool layer without start", async () => {
  const dom = page("");
  dom.performance.getEntriesByType = () => [entry(1)];
  const world = makeWorld({
    browsers: [{ name: "Google Chrome Canary", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: [{ url: "https://a.test/p", id: "d", dom }] }] }],
    cg: [{ owner: "Google Chrome Canary", pid: 4242, wid: 77, x: 10, y: 0, w: 800, h: 620 }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  const r = await handleCall("console_capture", { mode: "network" });
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, requests: ["200 fetch 84ms 1.2kB https://api.test/r1"] });
});

test("console_capture: an unknown mode names network among the choices", async () => {
  const r = await handleCall("console_capture", { mode: "net" });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "error: console_capture: unknown mode 'net' (expected start | read | stop | network)");
});
