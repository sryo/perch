// Several perch servers (one per Claude session) can drive the same tab, and
// withTabLock serializes calls only within one process. click {readback} and
// wait {quiet} keep their page state on window globals, so each call carries an
// owner token the page script makes and returns, and another server's call on
// the same tab is never read as this call's outcome.
// "B" runs through the same JXA runtime or page scripts, nested inside one of
// A's page evaluations: the page state is all two servers share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, buildEvalWrapper, pageScript, CLICK_BLANK_GO } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

function onPage(html, setup) {
  const dom = page(html);
  if (setup) dom.eval(setup);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return { dom, world };
}
const text = (r) => r.content[0].text;
const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
const call = async (name, args) => { const r = await handleCall(name, args); return { r, t: text(r), o: parse(text(r)) }; };

// Runs fn(n, js) before each of the page's own script evaluations (not nested ones).
function beforeEvals(dom, fn) {
  const orig = dom.eval.bind(dom);
  let n = 0, inside = false;
  dom.eval = (js) => {
    if (!inside) {
      inside = true;
      try { fn(++n, js); } finally { inside = false; }
    }
    return orig(js);
  };
}

const FORM = `<button id=b>Submit</button><p id=s>Idle</p><div id=spin></div>`;
const COUNT = `window.n = 0; document.getElementById('b').addEventListener('click', () => { document.getElementById('s').textContent = 'Saved ' + (++window.n); });`;
const READ = "const text = rbText();";
const REPLACED = "timeout: click sent, but another perch call on this tab took over its readback state; the outcome is not verified";
const w = (name, A) => buildEvalWrapper(pageScript(name, A));
const rbSteps = (readback) => ({ read: w("readback_read", { readback }), readFinal: w("readback_read", { readback, final: true }), settle: 2000 });
// B's whole click {readback}, as its server's runtime runs it.
const clickB = (world, readback = "#s") => JSON.parse(world.run(`JSON.stringify(__perch.click(${JSON.stringify({
  click: w("click_readback", { ref: null, selector: "#b", label_pattern: null, probe: true, readback }), go: CLICK_BLANK_GO, ...rbSteps(readback),
})}))`));

function assertRefused(o) {
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.error, REPLACED);
  assert.equal(o.el, `button "Submit"`, "the click was delivered, and says so");
  for (const k of ["navigated", "changed", "readback", "url", "form", "invalid", "page"]) assert.ok(!(k in o), `${k} in ${JSON.stringify(o)}`);
}

test("another server's completed readback on the tab is refused, not read as a navigation", async () => {
  const { dom, world } = onPage(FORM, COUNT);
  let b = null;
  beforeEvals(dom, (n, js) => { if (!b && js.includes(READ)) b = clickB(world); });
  const { r, o } = await call("click", { selector: "#b", readback: "#s" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.ok(b, "B ran between A's click and A's first poll");
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.readback, "Saved 2");
  assert.equal(b.changed, true);
  assertRefused(o);
  assert.equal(dom.n, 2, "both clicks ran");
});

test("A's poll after B armed is refused; B's own outcome stays correct", async () => {
  const { dom } = onPage(FORM, COUNT);
  let armB = null;
  beforeEvals(dom, (n, js) => { if (!armB && js.includes(READ)) armB = run(dom, "click_readback", { ref: null, selector: "#b", label_pattern: null, probe: true, readback: "#s" }); });
  const { o } = await call("click", { selector: "#b", readback: "#s" });
  assertRefused(o);
  assert.equal(armB.ok, true, JSON.stringify(armB));
  const tok = armB.rbTok;
  assert.ok(typeof tok === "string" && tok.length > 2, JSON.stringify(armB));
  // B keeps polling its own record: A's refused poll left it in place.
  let v = null;
  for (let i = 0; i < 40 && !(v && !v.pending); i++) v = run(dom, "readback_read", { readback: "#s" });
  assert.equal(v.tok, tok, JSON.stringify(v));
  assert.equal(v.readback, "Saved 2");
  assert.equal(v.changed, true);
  assert.equal(v.navigated, undefined);
});

test("B's poll of A's live record carries A's token, and A's call then reads normally", async () => {
  const { dom } = onPage(FORM, COUNT);
  let seen = null, armTok = null;
  beforeEvals(dom, (n, js) => {
    if (!seen && js.includes(READ)) { armTok = dom.__perch_rb && dom.__perch_rb.tok; seen = run(dom, "readback_read", { readback: "#s" }); }
  });
  const { r, o } = await call("click", { selector: "#b", readback: "#s" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(seen.tok, armTok, JSON.stringify(seen));
  assert.ok(!("navigated" in seen));
  assert.deepEqual(o, { ok: true, el: `button "Submit"`, readback: "Saved 1", changed: true });
});

test("a finished readback keeps its record; a new document still reads navigated", async () => {
  const { dom } = onPage(FORM, COUNT);
  const first = await call("click", { selector: "#b", readback: "#s" });
  assert.deepEqual(first.o, { ok: true, el: `button "Submit"`, readback: "Saved 1", changed: true });
  assert.ok(dom.__perch_rb && dom.__perch_rb.done === true, "the final read marks its record done instead of deleting it");
  // The next arm replaces the finished record and reads normally.
  const second = await call("click", { selector: "#b", readback: "#s" });
  assert.deepEqual(second.o, { ok: true, el: `button "Submit"`, readback: "Saved 2", changed: true });
  // A new document has no record: navigated.
  let dropped = false;
  beforeEvals(dom, (n, js) => { if (!dropped && js.includes(READ)) { dropped = true; delete dom.__perch_rb; dom.document.getElementById("s").textContent = "Welcome"; } });
  const third = await call("click", { selector: "#b", readback: "#s" });
  assert.equal(third.o.navigated, true, JSON.stringify(third.o));
  assert.equal(third.o.changed, true);
  assert.equal(third.o.readback, "Welcome");
});

// ---- wait {quiet} ----

const QUIET_POLL = "const s = window.__perch_quiet;";
const spin = (dom, v) => { dom.document.getElementById("spin").textContent = String(v); };

test("wait {quiet}: another server's poll consumes nothing, so A still sees the mutation", async () => {
  const { dom, world } = onPage(FORM);
  let at = null;
  beforeEvals(dom, (n) => {
    if (n === 3) { spin(dom, "x"); at = world.clock.t; run(dom, "wait_quiet", { life: 3000 }); }
  });
  const t0 = world.clock.t;
  const { r, t, o } = await call("wait", { quiet: 500, timeout: 3000 });
  assert.equal(r.isError, undefined, t);
  assert.ok(o.waited >= at - t0 + 500, `waited ${o.waited}, mutation at ${at - t0}`);
});

test("wait {quiet}: another server arming mid-wait restarts A's window, never shortens it", async () => {
  const { dom, world } = onPage(FORM);
  let at = null;
  beforeEvals(dom, (n) => {
    if (n === 3) {
      spin(dom, "x");
      at = world.clock.t;
      run(dom, "wait_quiet_arm", { life: 3000 });
      run(dom, "wait_quiet", { life: 3000 });
    }
  });
  const t0 = world.clock.t;
  const { r, t, o } = await call("wait", { quiet: 500, timeout: 3000 });
  assert.equal(r.isError, undefined, t);
  assert.ok(o.waited >= at - t0 + 500, `waited ${o.waited}, mutation at ${at - t0}`);
});

test("wait {quiet}: two concurrent waits on a page that mutates every 100ms both time out", async () => {
  const { dom, world } = onPage(FORM);
  let last = world.clock.t, i = 0;
  // B: armed once, then polled right before each of A's runs, deciding as its runtime does.
  const B = { tok: null, act: null, last: 0, best: 0 };
  beforeEvals(dom, (n) => {
    if (world.clock.t - last >= 100) { spin(dom, ++i); last = world.clock.t; }
    const v = run(dom, B.tok ? "wait_quiet" : "wait_quiet_arm", { life: 2000 });
    const now = world.clock.t;
    if (v.fresh || v.tok !== B.tok || v.act !== B.act) { B.last = now; B.tok = v.tok; B.act = v.act; }
    B.best = Math.max(B.best, now - B.last);
  });
  const { r, t } = await call("wait", { quiet: 300, timeout: 2000 });
  assert.equal(r.isError, true, t);
  assert.match(t, /^error: timeout: wait timed out after 2000ms/);
  assert.ok(i >= 15, `${i} mutations`);
  assert.ok(B.best < 300, `B saw ${B.best}ms quiet`);
});

test("wait {quiet}: an observer past its life re-arms instead of reading quiet", async () => {
  const { dom } = onPage(FORM);
  run(dom, "wait_quiet_arm", { life: 0 });
  const first = run(dom, "wait_quiet", { life: 0 });
  assert.ok(first.tok && !first.fresh, JSON.stringify(first));
  const was = dom.__perch_quiet;
  was.at -= 10;
  spin(dom, "x");
  await new Promise((res) => setTimeout(res, 0));
  const next = run(dom, "wait_quiet", { life: 0 });
  assert.equal(next.fresh, true, JSON.stringify(next));
  assert.notEqual(next.tok, first.tok);
  assert.notEqual(dom.__perch_quiet, was);
});

// ---- compile cache ----

test("readback and quiet scripts are byte-identical across calls", async () => {
  const { dom, world } = onPage(FORM, COUNT);
  let sent = [];
  world.state.onExecute = (spec, js) => sent.push(js);
  const runs = [];
  for (let i = 0; i < 2; i++) {
    sent = [];
    // The second time the page never settles, so the click also sends its final read.
    if (i === 1) beforeEvals(dom, () => spin(dom, Math.random()));
    await call("click", { selector: "#b", readback: "#b" });
    await call("wait", { quiet: 200, timeout: 600 });
    runs.push(new Set(sent.filter((js) => /__perch_(rb|quiet)\b/.test(js))));
  }
  for (const js of runs[1]) assert.ok(runs[0].has(js) || js.includes('"final":true'), "a script not sent by the first call");
  assert.equal(runs[1].size, 5, "click, poll, final read, quiet arm and poll");
  for (const js of runs[1]) assert.ok(!/\d+\.[a-z0-9]{8}/.test(js.match(/\nconst A = (.*);\n/)[1]), "no token in A");
  // readback_arm, the trusted click's, is fixed source too.
  const arm = (A) => pageScript("readback_arm", A);
  assert.equal(arm({ readback: "#s", probed: true }), arm({ readback: "#s", probed: true }));
});

// ---- console_capture ----
// A is this server through the tool layer; B is another server's page scripts.

const NOTE = "another perch call read entries since your last read; some may be missing";
const cc = async (mode) => (await call("console_capture", mode ? { mode } : {})).o;

test("console_capture: a read after another server drained says partial, never a bare empty ok", async () => {
  const { dom } = onPage(FORM);
  assert.equal((await cc("start")).ok, true);
  assert.equal(run(dom, "console_start").ok, true);
  dom.console.error("boom");
  assert.deepEqual(run(dom, "console_read").entries, ["error: boom"]);
  const a = await cc();
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual(a.entries, []);
  assert.equal(a.partial, true, JSON.stringify(a));
  assert.equal(a.note, NOTE);
  for (const k of ["gen", "prevGen", "id"]) assert.ok(!(k in a), `${k} in ${JSON.stringify(a)}`);
  // Nothing drained since: the next read is whole again.
  dom.console.warn("next");
  assert.deepEqual(await cc(), { ok: true, entries: ["warn: next"] });
});

test("console_capture: another server's stop leaves A capturing; the last stop restores console", async () => {
  const { dom } = onPage(FORM);
  const orig = { error: dom.console.error, assert: dom.console.assert };
  await cc("start");
  run(dom, "console_start");
  const b = run(dom, "console_stop");
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.stillCapturing, true, JSON.stringify(b));
  assert.notEqual(dom.console.error, orig.error, "still hooked for A");
  dom.console.error("later");
  const a = await cc();
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual(a.entries, ["error: later"]);
  const s = await cc("stop");
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.ok(!("stillCapturing" in s), JSON.stringify(s));
  assert.equal(dom.console.error, orig.error);
  assert.equal(dom.console.assert, orig.assert);
  dom.console.error("after");
  assert.equal((await cc()).ok, false);
});

test("console_capture: one server's reads and stop never carry partial", async () => {
  const { dom } = onPage(FORM);
  await cc("start");
  dom.console.log("a");
  assert.deepEqual(await cc(), { ok: true, entries: ["log: a"] });
  assert.deepEqual(await cc(), { ok: true, entries: [] });
  dom.console.log("b");
  assert.deepEqual(await cc(), { ok: true, entries: ["log: b"] });
  dom.console.log("c");
  assert.deepEqual(await cc("stop"), { ok: true, entries: ["log: c"] });
  // A new capture on the same document starts whole.
  await cc("start");
  assert.deepEqual(await cc(), { ok: true, entries: [] });
  await cc("stop");
});

test("console_capture: a drain between A's start and its first read is caught too", async () => {
  const { dom } = onPage(FORM);
  run(dom, "console_start");
  await cc("start");
  dom.console.log("x");
  run(dom, "console_read");
  const a = await cc("stop");
  assert.equal(a.partial, true, JSON.stringify(a));
  assert.equal(a.stillCapturing, true, "B still holds its start");
});

test("console_capture scripts are byte-identical across calls", async () => {
  const { dom, world } = onPage(FORM);
  const sent = [];
  world.state.onExecute = (spec, js) => sent.push(js);
  await cc("start"); await cc(); await cc(); await cc("stop");
  await cc("start"); await cc(); await cc("stop");
  assert.equal(new Set(sent.filter((js) => js.includes("__perch_console"))).size, 3);
});
