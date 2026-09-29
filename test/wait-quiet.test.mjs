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

test("the quiet window starts when the observer is armed, not at the call", async () => {
  // The first evaluation lands 100ms after the call and a mutation happens
  // just before it arms the observer: none of that time was watched.
  const { dom, world } = onPage();
  let evals = 0;
  beforeEvals(dom, (n) => {
    evals = n;
    if (n === 1) { world.clock.t += 100; dom.document.getElementById("s").textContent = "Saving"; }
  });
  const { r, t, o } = await call({ quiet: 50 });
  assert.equal(r.isError, undefined, t);
  assert.ok(evals >= 2, `resolved after ${evals} poll(s)`);
  assert.ok(o.waited >= 150, `waited ${o.waited}`);
});

test("a new document mid-wait restarts the quiet window", async () => {
  // A fresh document has none of perch's state; dropping it stands in for a navigation.
  const { dom } = onPage();
  let before = null;
  beforeEvals(dom, (n) => { if (n === 8) { before = dom.__perch_quiet; delete dom.__perch_quiet; } });
  const { r, t, o } = await call({ quiet: 500 });
  assert.equal(r.isError, undefined, t);
  assert.ok(o.waited >= 7 * 50 + 500, `waited ${o.waited}`);
  assert.ok(before && dom.__perch_quiet && dom.__perch_quiet !== before, "re-armed on the new document");
});

// Throws on the line that reads perch's state, in the arm (first sample) or a later poll.
function throwIn(dom, which) {
  const orig = dom.eval.bind(dom);
  let n = 0;
  dom.eval = (js) => {
    n++;
    const hit = which === "arm" ? n === 1 : n > 1;
    return orig(hit ? js.replace(/\n([^\n]*window\.__perch_quiet)/, "\nthrow new TypeError('secret-internal detail');\n$1") : js);
  };
}

for (const which of ["arm", "poll"]) {
  test(`a quiet ${which} that throws is a coded error naming only the error name`, async () => {
    const { dom } = onPage();
    throwIn(dom, which);
    const { r, t } = await call({ quiet: 300, timeout: 2000 });
    assert.equal(r.isError, true, t);
    assert.match(t, /^error: wait: the page script failed on this page \(TypeError\); nothing verified$/);
    for (const k of ["secret-internal", "__perch_error", "stack"]) assert.ok(!t.includes(k), t);
  });
}

test("the scripts a wait {quiet} sends are the same every call: an arm and a poll, no per-call id", async () => {
  const { dom } = onPage();
  const seen = [], orig = dom.eval.bind(dom);
  dom.eval = (js) => { seen.push(js); return orig(js); };
  const runs = [];
  for (let i = 0; i < 2; i++) {
    seen.length = 0;
    const { r, t } = await call({ quiet: 200, timeout: 3000 });
    assert.equal(r.isError, undefined, t);
    assert.ok(seen.length >= 3, `${seen.length} evals`);
    runs.push([...new Set(seen)]);
  }
  assert.equal(runs[0].length, 2, "one arm, one poll");
  assert.deepEqual(runs[1], runs[0]);
  const [arm, poll] = runs[0];
  assert.match(arm, /rbStop\(window\.__perch_quiet\)/);
  assert.match(poll, /const s = window\.__perch_quiet;/);
  for (const js of runs[0]) {
    const a = js.match(/\nconst A = (.*);\n/);
    assert.deepEqual(JSON.parse(a[1]), { life: 3000 });
  }
});

test("a stale state from an earlier wait is restarted by the first sample", async () => {
  // Left behind with no observer and activity matching now: read as-is, it would
  // never report busy and a mutation would pass unseen.
  const { dom } = onPage();
  const stale = { mut: 0, act: "0:0", at: 0, obs: null };
  dom.__perch_quiet = stale;
  beforeEvals(dom, (n) => { if (n === 4) dom.document.getElementById("s").textContent = "Saved"; });
  const { r, t, o } = await call({ quiet: 500 });
  assert.equal(r.isError, undefined, t);
  assert.notEqual(dom.__perch_quiet, stale);
  assert.ok(dom.__perch_quiet.obs, "armed");
  assert.ok(o.waited >= 3 * 50 + 500, `waited ${o.waited}`);
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
