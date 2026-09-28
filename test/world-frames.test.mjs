// The fake world's opt-in per-browser Apple Event log and frame clock. Live,
// an Apple Event to a browser returns at that browser's next display frame, and
// each browser keeps its own frame phase, so events to different browsers
// overlap. These tests pin the fake's model of that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./fakes/jxa-world.mjs";

const browsers = [
  { name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "a" }] }] },
  { name: "Safari", kind: "safari", windows: [{ id: 2, active: 0, tabs: [{ url: "https://b.test/", id: "b" }] }] },
];
const chromeId = `Application("Google Chrome").windows[0].tabs[0].id()`;
const safariUrl = `Application("Safari").windows[0].tabs[0].url()`;

test("aeLog records each Apple Event with its browser, and specifiers are not events", () => {
  const world = makeWorld({ browsers });
  world.run(chromeId);
  world.run(safariUrl);
  world.run(`Application("Google Chrome").running()`);
  assert.deepEqual(world.aeLog, [["Google Chrome", "tab.id"], ["Safari", "tab.url"]]);
  assert.deepEqual(world.aeBy("Safari"), ["tab.url"]);
  assert.deepEqual(world.aeBy("Google Chrome"), ["tab.id"]);
  world.reset();
  assert.deepEqual(world.aeLog, []);
});

test("without frameMs, Apple Events take no time", () => {
  const world = makeWorld({ browsers });
  const t0 = world.clock.t;
  for (let i = 0; i < 5; i++) world.run(chromeId);
  assert.equal(world.clock.t, t0);
});

test("with frameMs, an Apple Event returns at its browser's next frame, each browser on its own phase", () => {
  const frameMs = 16;
  const world = makeWorld({ browsers, frameMs });
  const phase = (app) => { world.run(app === "Safari" ? safariUrl : chromeId); return world.clock.t % frameMs; };
  const chromePhase = phase("Google Chrome");
  const safariPhase = phase("Safari");
  assert.notEqual(chromePhase, safariPhase);

  let t = world.clock.t;
  world.run(chromeId);
  world.run(chromeId);
  const a = world.clock.t;
  assert.equal(a % frameMs, chromePhase);
  assert.ok(a - t > frameMs && a - t <= 2 * frameMs, `two Chrome events span two frames, took ${a - t}`);

  // Alternating browsers overlaps their frames: four events cost less than four frames.
  t = world.clock.t;
  for (let i = 0; i < 2; i++) { world.run(safariUrl); world.run(chromeId); }
  assert.ok(world.clock.t - t < 4 * frameMs, `took ${world.clock.t - t}`);
  assert.ok(world.clock.t - t >= 2 * frameMs);
});
