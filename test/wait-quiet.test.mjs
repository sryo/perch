// wait {quiet}: resolves once the page has had no DOM mutation and no fetch/XHR
// finishing for `quiet` ms. Runs through the real JXA runtime (fake world,
// virtual clock) against a happy-dom page, so the quiet window is timed JXA-side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

function onPage(html = `<p id=s>Idle</p><div id=spin></div>`) {
  const dom = page(html);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return { dom, world };
}
const call = async (args) => {
  const r = await handleCall("wait", args);
  const t = r.content[0].text;
  return { r, t, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
// Runs fn(n) on the page before each of its script evaluations.
function beforeEvals(dom, fn) {
  const orig = dom.eval.bind(dom);
  let n = 0;
  dom.eval = (js) => { fn(++n); return orig(js); };
}
const timed = async (world, f) => {
  const t0 = world.clock.t;
  const out = await f();
  return { ...out, took: world.clock.t - t0 };
};

test("a quiet page resolves once the quiet window has passed", async () => {
  const { world } = onPage();
  const { r, t, o, took } = await timed(world, () => call({ quiet: 500 }));
  assert.equal(r.isError, undefined, t);
  assert.deepEqual(Object.keys(o), ["ok", "waited", "quietFor"]);
  assert.equal(o.ok, true);
  assert.ok(o.quietFor >= 500 && o.quietFor < 600, `quietFor ${o.quietFor}`);
  assert.ok(o.waited >= 500 && o.waited < 700, `waited ${o.waited}`);
  assert.ok(took < 900, `took ${took}ms`);
});

test("fetch or XHR requests still finishing keep it waiting until they stop", async () => {
  const { dom, world } = onPage();
  const entries = [];
  dom.performance.getEntriesByType = (k) => (k === "resource" ? entries.slice() : []);
  let stopAt = null;
  beforeEvals(dom, (n) => {
    if (n <= 20) entries.push({ initiatorType: n % 2 ? "fetch" : "xmlhttprequest" });
    if (n === 20) stopAt = world.clock.t;
  });
  const t0 = world.clock.t;
  const { r, t, o } = await call({ quiet: 400 });
  assert.equal(r.isError, undefined, t);
  assert.ok(stopAt - t0 >= 900, `requests ran ${stopAt - t0}ms`);
  assert.ok(o.waited >= stopAt - t0 + 400, `waited ${o.waited}`);
});

test("other resources finishing don't count as activity", async () => {
  const { dom, world } = onPage();
  const entries = [];
  dom.performance.getEntriesByType = (k) => (k === "resource" ? entries.slice() : []);
  beforeEvals(dom, () => entries.push({ initiatorType: "img" }));
  const { r, t, took } = await timed(world, () => call({ quiet: 400 }));
  assert.equal(r.isError, undefined, t);
  assert.ok(took < 700, `took ${took}ms`);
});

test("continuous DOM mutations time out with the coded timeout error", async () => {
  const { dom, world } = onPage();
  beforeEvals(dom, (n) => { dom.document.getElementById("spin").textContent = String(n); });
  const { r, t, took } = await timed(world, () => call({ quiet: 300, timeout: 2000 }));
  assert.equal(r.isError, true);
  assert.match(t, /^error: timeout: wait timed out after 2000ms/);
  assert.ok(took >= 2000 && took < 2600, `took ${took}ms`);
});

test("a mutation mid-wait restarts the quiet window", async () => {
  const { dom } = onPage();
  let at = null;
  beforeEvals(dom, (n) => { if (n === 8) { dom.document.getElementById("s").textContent = "Saved"; at = n; } });
  const { r, t, o } = await call({ quiet: 500 });
  assert.equal(r.isError, undefined, t);
  assert.equal(at, 8);
  assert.ok(o.waited >= 7 * 50 + 500, `waited ${o.waited}`);
});

test("a new document mid-wait restarts the quiet window", async () => {
  // A fresh document has none of perch's state; dropping it stands in for a navigation.
  const { dom } = onPage();
  beforeEvals(dom, (n) => { if (n === 8) delete dom.__perch_quiet; });
  const { r, t, o } = await call({ quiet: 500 });
  assert.equal(r.isError, undefined, t);
  assert.ok(o.waited >= 7 * 50 + 500, `waited ${o.waited}`);
});

test("the MutationObserver stops at the first mutation after its timeout", async () => {
  const { dom } = onPage();
  await call({ quiet: 200, timeout: 1000 });
  const s = dom.__perch_quiet;
  assert.ok(s && s.obs, "armed");
  const flush = () => new Promise((res) => setTimeout(res, 10));
  dom.document.getElementById("spin").textContent = "a";
  await flush();
  assert.ok(s.mut > 0, "still counting within its life");
  s.at -= 1001;
  const before = s.mut;
  dom.document.getElementById("spin").textContent = "b";
  await flush();
  dom.document.getElementById("spin").textContent = "c";
  await flush();
  assert.equal(s.mut, before, "disconnected");
});

test("quiet refuses bad values and mixing with selector or expression", async () => {
  onPage();
  for (const [args, re] of [
    [{ quiet: 0 }, /quiet/],
    [{ quiet: -5 }, /quiet/],
    [{ quiet: "500" }, /quiet/],
    [{ quiet: 5000, timeout: 2000 }, /quiet.*timeout/],
    [{ quiet: 300, selector: "#s" }, /quiet/],
    [{ quiet: 300, expression: "1" }, /quiet/],
  ]) {
    const { r, t } = await call(args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(t, re);
  }
});
