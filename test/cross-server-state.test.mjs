// Several perch servers (one per Claude session) can drive the same tab, and
// withTabLock serializes calls only within one process. click {readback} and
// wait {quiet} keep their page state on window globals, so each call carries an
// owner token the page script makes and returns, and another server's call on
// the same tab is never read as this call's outcome.
// "B" runs through the same JXA runtime or page scripts, nested inside one of
// A's page evaluations: the page state is all two servers share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JXA_PRELUDE, DAEMONS, handleCall, buildEvalWrapper, pageScript, CLICK_BLANK_GO, SHOT_BUSY } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";
import { scrolled, where } from "./helpers/shot.mjs";

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
const READ = "const s = window.__perch_rb;";
const REPLACED = "timeout: click sent, but another perch call on this tab took over its readback state; the outcome is not verified";
const w = (name, A) => buildEvalWrapper(pageScript(name, A));
const rbSteps = (readback) => ({ read: w("readback_read", { readback }), readFinal: w("readback_read", { readback, final: true }), settle: 2000 });
// B's whole click {readback}, as its server's runtime runs it.
const clickB = (world, readback = "#s", selector = "#b") => JSON.parse(world.run(`JSON.stringify(__perch.click(${JSON.stringify({
  click: w("click_readback", { ref: null, selector, label_pattern: null, probe: true, readback }), go: CLICK_BLANK_GO, ...rbSteps(readback),
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

// ---- readback on another selector ----
// A clicks #go and reads back #noop; B clicks #noop and reads back #go. A read
// of B's record must never measure A's element against B's baseline.

const PAIR = `<button id=go>Submit</button><button id=noop>Other</button><p id=s>Idle</p>`;
const armB = (dom) => run(dom, "click_readback", { ref: null, selector: "#noop", label_pattern: null, probe: true, readback: "#go" });
const pollOwn = (dom, readback) => {
  let v = null;
  for (let i = 0; i < 40 && !(v && !v.pending); i++) v = run(dom, "readback_read", { readback });
  return v;
};
function assertRefusedOn(o, el) {
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.error, REPLACED);
  assert.equal(o.el, el);
  for (const k of ["navigated", "changed", "readback", "url", "form", "invalid", "page"]) assert.ok(!(k in o), `${k} in ${JSON.stringify(o)}`);
}

test("readback overlap: B's whole click runs at A's first read; neither reads the other's element", async () => {
  const { dom, world } = onPage(PAIR);
  let b = null;
  beforeEvals(dom, (n, js) => { if (!b && js.includes(READ)) b = clickB(world, "#go", "#noop"); });
  const { o } = await call("click", { selector: "#go", readback: "#noop" });
  assert.ok(b, "B ran inside A's poll");
  assert.deepEqual(b, { ok: true, el: `button "Other"`, readback: "Submit", changed: false });
  assertRefusedOn(o, `button "Submit"`);
});

test("readback overlap: B arms after A's 3rd read; A is refused and B reads its own element", async () => {
  const { dom } = onPage(PAIR);
  let reads = 0, arm = null;
  beforeEvals(dom, (n, js) => {
    if (!js.includes(READ)) return;
    if (++reads === 4) arm = armB(dom);
  });
  const { o } = await call("click", { selector: "#go", readback: "#noop" });
  assert.ok(arm && arm.ok, JSON.stringify(arm));
  assertRefusedOn(o, `button "Submit"`);
  assert.ok(!dom.__perch_rb.done, "A's read left B's record pending");
  const v = pollOwn(dom, "#go");
  assert.equal(v.tok, arm.rbTok, JSON.stringify(v));
  assert.equal(v.readback, "Submit", JSON.stringify(v));
  assert.equal(v.changed, false);
});

test("readback overlap: A finishes before B arms; both get their own results", async () => {
  const { world } = onPage(PAIR);
  const { o } = await call("click", { selector: "#go", readback: "#noop" });
  assert.deepEqual(o, { ok: true, el: `button "Submit"`, readback: "Other", changed: false });
  assert.deepEqual(clickB(world, "#go", "#noop"), { ok: true, el: `button "Other"`, readback: "Submit", changed: false });
});

test("readback overlap: a read with another selector answers pending with the owner's token and touches nothing", () => {
  const { dom } = onPage(PAIR);
  const arm = run(dom, "readback_arm", { readback: "#go" });
  assert.equal(arm.ok, true, JSON.stringify(arm));
  const r = dom.__perch_rb;
  let stops = 0;
  const disconnect = r.obs.disconnect.bind(r.obs);
  r.obs.disconnect = () => { stops++; disconnect(); };
  const snap = () => ({ quiet: r.quiet, act: r.act, clsSeen: r.clsSeen, calm: r.calm, done: r.done, mut: r.mut, away: r.away, text: r.text, sig: r.sig, cls: r.cls });
  const before = snap();
  for (let i = 0; i < 5; i++) assert.deepEqual(run(dom, "readback_read", { readback: "#noop" }), { pending: true, tok: arm.tok });
  assert.equal(dom.__perch_rb, r, "the record is the owner's");
  assert.deepEqual(snap(), before);
  assert.equal(stops, 0, "the observer is still connected");
  for (let i = 1; i < 10; i++) assert.deepEqual(run(dom, "readback_read", { readback: "#go" }), { pending: true, tok: arm.tok }, `owner read ${i}`);
  assert.deepEqual(run(dom, "readback_read", { readback: "#go" }), { readback: "Submit", changed: false, tok: arm.tok });
  assert.equal(stops, 1);
});

// ---- click on a new-tab link ----

const LINKS = `<a id=x href="/job/x" target=_blank>Apply X</a><a id=y href="/job/y" target=_blank>Apply Y</a>`;
// Each link counts its clicks on window.clicks and, as the browser would, opens a tab.
const opens = (world, dom) => {
  dom.eval("window.clicks = { x: 0, y: 0 }");
  for (const id of ["x", "y"]) dom.document.getElementById(id).addEventListener("click", (e) => {
    dom.clicks[id]++;
    world.openTab("Google Chrome", 0, e.currentTarget.href);
  });
};
const GO = "window.__perch_blank = null";
const MID = "another perch call on this tab is mid-click; nothing was clicked, retry";
const FOREIGN = "click: sent on another perch call's element; not verified";
const probeArgs = (sel) => ({ ref: null, selector: sel, label_pattern: null, probe: true });
// B's whole plain click, as its server's runtime runs it.
const clickPageB = (world, sel) => parse(world.run(`__perch.clickPage(${JSON.stringify({ click: w("click", probeArgs(sel)), go: CLICK_BLANK_GO })})`));
const tabCount = (world) => world.tabsOf("Google Chrome", 0).length;
const noOpened = (o) => { for (const k of ["opened", "blocked", "unconfirmed", "rbTok", "tok", "taken"]) assert.ok(!(k in o), `${k} in ${JSON.stringify(o)}`); };

test("new-tab click: another server's whole click between A's probe and A's second pass clicks nothing", async () => {
  const { dom, world } = onPage(LINKS);
  opens(world, dom);
  let b = null;
  beforeEvals(dom, (n, js) => { if (!b && js.includes(GO)) b = clickPageB(world, "#y"); });
  const { o } = await call("click", { selector: "#x" });
  assert.ok(b, "B ran between A's probe and A's second pass");
  assert.deepEqual(b, { ok: false, error: MID });
  assert.deepEqual(o, { ok: false, error: MID });
  assert.deepEqual({ ...dom.clicks }, { x: 0, y: 0 });
  assert.equal(tabCount(world), 1, "no tab opened");
  assert.equal(dom.__perch_blank, null, "A's second pass cleared the clash");
});

test("new-tab click with readback: B's probe inside A's second pass clicks nothing and hands A no token", async () => {
  const { dom, world } = onPage(LINKS);
  opens(world, dom);
  let b = null;
  beforeEvals(dom, (n, js) => { if (!b && js.includes(GO)) b = run(dom, "click_readback", { ...probeArgs("#y"), readback: "#y" }); });
  const { o } = await call("click", { selector: "#x", readback: "#x" });
  assert.deepEqual(b, { ok: false, error: MID });
  assert.deepEqual(o, { ok: false, error: MID });
  noOpened(o);
  // B's runtime would not send its second pass; one sent anyway clicks nothing.
  const late = JSON.parse(dom.eval(CLICK_BLANK_GO));
  assert.equal(late.ok, false);
  assert.match(late.error, /nothing was clicked/);
  assert.deepEqual({ ...dom.clicks }, { x: 0, y: 0 });
  assert.equal(tabCount(world), 1);
});

test("new-tab click: a probe over a fresh clash still refuses until its owner's second pass clears it", () => {
  const dom = page(LINKS);
  assert.equal(run(dom, "click", probeArgs("#x")).blank.href, "https://a.test/job/x");
  assert.deepEqual(run(dom, "click", probeArgs("#y")), { ok: false, error: MID });
  assert.deepEqual(run(dom, "click", probeArgs("#y")), { ok: false, error: MID });
  assert.deepEqual(JSON.parse(dom.eval(CLICK_BLANK_GO)), { ok: false, error: MID });
  const again = run(dom, "click", probeArgs("#y"));
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(typeof again.tok, "string");
});

test("new-tab click: a stale slot is replaced; A's late second pass is not verified, B still succeeds", async () => {
  const { dom, world } = onPage(LINKS);
  opens(world, dom);
  let b = null;
  beforeEvals(dom, (n, js) => {
    if (b || !js.includes(GO)) return;
    dom.__perch_blank.at -= 20000;
    b = clickPageB(world, "#y");
  });
  const { o } = await call("click", { selector: "#x" });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.opened.url, "https://a.test/job/y");
  assert.equal(o.ok, false, JSON.stringify(o));
  noOpened(o);
  assert.deepEqual({ ...dom.clicks }, { x: 0, y: 1 });
  assert.equal(tabCount(world), 2);
});

test("new-tab click: A's late second pass on B's element says so, and B's second pass does not deny the click", async () => {
  const { dom, world } = onPage(LINKS);
  opens(world, dom);
  let bProbe = null;
  beforeEvals(dom, (n, js) => {
    if (bProbe || !js.includes(GO)) return;
    dom.__perch_blank.at -= 20000;
    bProbe = run(dom, "click", probeArgs("#y"));
  });
  const { o } = await call("click", { selector: "#x" });
  assert.equal(bProbe.ok, true, JSON.stringify(bProbe));
  assert.deepEqual(o, { ok: false, error: FOREIGN });
  assert.deepEqual({ ...dom.clicks }, { x: 0, y: 1 });
  // B's second pass: the page answers with B's token, which B's runtime reads as its element already clicked.
  const bGo = JSON.parse(dom.eval(CLICK_BLANK_GO));
  assert.equal(bGo.ok, false);
  assert.equal(bGo.taken, bProbe.tok);
  assert.deepEqual({ ...dom.clicks }, { x: 0, y: 1 });
});

test("new-tab click: B's element run by another call's second pass is B's refusal, not 'nothing was clicked'", () => {
  const { dom, world } = onPage(LINKS);
  opens(world, dom);
  run(dom, "click", probeArgs("#x"));
  dom.__perch_blank.at -= 20000;
  let a = null;
  beforeEvals(dom, (n, js) => { if (!a && js.includes(GO)) a = JSON.parse(dom.eval(CLICK_BLANK_GO)); });
  const b = clickPageB(world, "#y");
  assert.equal(a.ok, true, "A's stale second pass ran B's element");
  assert.deepEqual(b, { ok: false, error: "click: another perch call on this tab sent this click; not verified" });
  assert.deepEqual({ ...dom.clicks }, { x: 0, y: 1 });
});

test("every script that makes owner tokens defines rbTok once", () => {
  for (const name of ["click", "click_readback", "wait_quiet", "readback_read"]) {
    const src = pageScript(name, { selector: "#x", probe: true, readback: "#x", life: 1 });
    assert.equal(src.split("function rbTok(").length - 1, 1, name);
  }
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

// ---- select ----
// Two listbox comboboxes that both offer "Other", driven by trusted-select.html's
// script: data-picker "none" takes synthetic presses, "open" opens only on a
// trusted one.

const TS = readFileSync(new URL("./fixtures/trusted-select.html", import.meta.url), "utf8");
const TS_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(TS)[1];
const combo = (id, label, mode, items) => `<div class="field"><span id="${id}-label">${label}</span>
  <div id="${id}" role="combobox" tabindex="0" aria-labelledby="${id}-label" aria-expanded="false" aria-controls="${id}-list" data-picker="${mode}" data-items="${items}"><span class="placeholder">Pick one</span></div>
  <ul id="${id}-list" role="listbox" hidden></ul></div>`;
const PLACES = (mode = "none") => combo("country", "Country", mode, "Argentina|Chile|Other") + combo("region", "Region", "none", "North|South|Other");
// Every press that reaches an option, by the option's list.
const COUNT_OPTS = `window.optClicks = {}; document.addEventListener("click", function (e) { const o = e.target.closest && e.target.closest("[role=option]"); if (o) { const k = o.parentElement.id + ":" + o.textContent; window.optClicks[k] = (window.optClicks[k] || 0) + 1; } }, true);`;
const TAKEN = "another perch call on this tab took over this select; not verified";
const PICK = "s.polls++;";
const selA = (selector, text, extra = {}) => ({ ref: null, selector, label_pattern: null, text, ...extra });
const shows = (dom, id) => dom.document.getElementById(id).textContent;
// B's select to the end, as its server's runtime runs the phases.
function finishSelect(dom, A) {
  let v = null;
  for (let i = 0; i < 20 && !(v && !v.pending); i++) v = run(dom, "select_pick", A);
  if (!v || v.picked == null) return v;
  for (let i = 0; i < 10; i++) { const r = run(dom, "select_read", A); if (r && !r.pending) return r; }
  return run(dom, "select_read", { ...A, final: true });
}

test("select: another server's select_start between A's start and A's pick is refused; A presses nothing in B's list", async () => {
  const { dom } = onPage(PLACES(), TS_SCRIPT + COUNT_OPTS);
  let startB = null;
  beforeEvals(dom, (n, js) => { if (!startB && js.includes(PICK)) startB = run(dom, "select_start", selA("#region", "Other")); });
  const { r, o } = await call("select", { selector: "#country", text: "Other" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.ok(startB && startB.pending, JSON.stringify(startB));
  assert.deepEqual(o, { ok: false, error: TAKEN });
  assert.deepEqual({ ...dom.optClicks }, {}, "A pressed no option");
  assert.deepEqual([...dom.pickerLog], []);
  assert.equal(shows(dom, "country"), "Pick one");
  // B's own select still finishes on its own control.
  const b = finishSelect(dom, selA("#region", "Other"));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.selected, "Other");
  assert.match(b.el, /Region/);
  assert.deepEqual([...dom.pickerLog], ["region:Other"]);
  assert.equal(shows(dom, "country"), "Pick one");
});

test("select: another server with identical args is caught by its token", async () => {
  const { dom } = onPage(PLACES(), TS_SCRIPT + COUNT_OPTS);
  let startB = null;
  beforeEvals(dom, (n, js) => { if (!startB && js.includes(PICK)) startB = run(dom, "select_start", selA("#country", "Other")); });
  const { o } = await call("select", { selector: "#country", text: "Other" });
  assert.ok(startB && startB.pending, JSON.stringify(startB));
  assert.deepEqual(o, { ok: false, error: TAKEN });
  assert.ok((dom.optClicks["country-list:Other"] || 0) <= 1);
});

test("select: a select alone still reads its own control, with no token in its result", async () => {
  const { dom } = onPage(PLACES(), TS_SCRIPT + COUNT_OPTS);
  const { o } = await call("select", { selector: "#country", text: "Other" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Other");
  assert.equal("tok" in o, false);
  assert.deepEqual([...dom.pickerLog], ["country:Other"]);
});

test("select {trusted}: a probe that finds another call's select state posts no event", async () => {
  const dom = page(PLACES("open"), { url: "https://form.test/" });
  for (const [k, v] of Object.entries({ screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 })) Object.defineProperty(dom, k, { value: v, configurable: true });
  dom.eval(TS_SCRIPT + COUNT_OPTS);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 1, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "https://form.test/", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 798, h: 500, frames: [] }] } }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  let startB = null;
  beforeEvals(dom, (n, js) => { if (!startB && js.includes(`A.select === "option"`)) startB = run(dom, "select_start", selA("#region", "Other")); });
  const { r, o } = await call("select", { target: { tabIndex: 1 }, selector: "#country", text: "Other", trusted: true });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.ok(startB && startB.pending, JSON.stringify(startB));
  assert.deepEqual(o, { ok: false, error: TAKEN });
  assert.deepEqual(world.posted, [], "no event posted at B's control");
  assert.deepEqual({ ...dom.optClicks }, {});
  assert.equal(dom.document.getElementById("region").getAttribute("aria-expanded"), "true", "B's open list is left alone");
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

// ---- screenshot {ref|selector} ----
// A crop keeps the scroll positions it moved on window.__perch_shot until its
// restore. Only one crop per tab may hold that record, so another server's
// restore never puts back positions A had already moved, and never mid-capture.

const isShotPoll = (js) => /\{ painted: /.test(js);
const isShotRestore = (js) => js.includes("if (!s) return { ok: false };");
function onShot(p) {
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 100, y: 50, w: 1000, h: 700, tabs: [{ url: "https://a.test/", id: "c0", dom: p.dom }] }] }],
    cg: [{ owner: "Google Chrome", pid: 4242, wid: 77, x: 100, y: 50, w: 1000, h: 700, ax: { web: [{ x: 300, y: 130, w: 800, h: 620 }] } }],
  });
  world.state.shotScale = 1;
  world.state.scripts = [];
  world.state.onExecute = (spec, js) => {
    world.state.scripts.push(js);
    const frames = p.dom.rafs.splice(0);
    frames.forEach((cb) => cb(0));
    if (!frames.length) p.dom.timers.splice(0).forEach((cb) => cb());
  };
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
const shotArgs = { target: { tabId: "chrome:c0" }, selector: "#t" };
const shotA = async () => {
  const r = await handleCall("screenshot", shotArgs);
  const image = r.content[0].type === "image";
  return { r, o: image ? JSON.parse(r.content[1].text) : parse(text(r)), image };
};
// B's whole crop, as its server's runtime runs it.
const shotB = (world) => parse(world.run(`JSON.stringify(__perch.shot(${JSON.stringify({
  ...shotArgs, format: "png", maxWidth: 1568, raise: false,
  clip: w("shot_clip", { ref: null, selector: "#t" }), painted: w("shot_painted", {}), restore: w("shot_restore", {}),
})}))`));

test("screenshot: another server's crop inside A's is refused before it scrolls; A captures and every scroll comes back", async () => {
  const p = scrolled();
  const world = onShot(p);
  let b = null, before = null;
  beforeEvals(p.dom, (n, js) => {
    if (b || !isShotPoll(js)) return;
    before = where(p);
    b = shotB(world);
    assert.deepEqual(where(p), before, "B scrolled nothing");
  });
  const { o, image } = await shotA();
  assert.deepEqual(before, [0, 900, 0], "B ran while A held its scroll");
  assert.deepEqual(b, { ok: false, error: SHOT_BUSY });
  assert.equal(image, true, JSON.stringify(o));
  assert.equal(o.warning, undefined);
  assert.equal(world.state.shots.length, 1, "only A captured");
  assert.deepEqual(where(p), [0, 40, 37], "the user's scroll is back");
  assert.equal(p.dom.__perch_shot, null);
  assert.equal(world.log.filter((e) => e[0] === "activate").length, 0);
});

test("screenshot: a record left 10s ago is put back, then replaced; a newer one refuses", async () => {
  const p = scrolled();
  const world = onShot(p);
  // A crop whose server died after its clip: the page sits scrolled, the record kept.
  assert.equal(run(p.dom, "shot_clip", { selector: "#t" }).ok, true);
  assert.deepEqual(where(p), [0, 900, 0]);
  p.dom.__perch_shot.at -= 9000;
  const { o } = await shotA();
  assert.deepEqual(o, { ok: false, error: SHOT_BUSY });
  assert.deepEqual(where(p), [0, 900, 0], "a live record is left alone");
  assert.equal(world.state.shots.length, 0);
  p.dom.__perch_shot.at -= 1000;
  const a = await shotA();
  assert.equal(a.image, true, JSON.stringify(a.o));
  assert.equal(a.o.warning, undefined);
  assert.deepEqual(where(p), [0, 40, 37], "the scroll from before the dead crop is back");
  assert.equal(p.dom.__perch_shot, null);
});

test("screenshot: a capture whose restore finds another call's record is refused, not an image with a warning", async () => {
  const p = scrolled();
  const world = onShot(p);
  beforeEvals(p.dom, (n, js) => { if (isShotRestore(js) && p.dom.__perch_shot) p.dom.__perch_shot.token = "9.other"; });
  const { r, o } = await shotA();
  assert.equal(r.content.length, 1, "no image");
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /^screenshot: another perch call on this tab took over this screenshot's scroll record/);
  assert.match(o.error, /the scroll may be left moved/);
  assert.equal(world.state.shots.length, 1, "the capture ran, its image dropped");
});

test("screenshot scripts are byte-identical across calls, with no token in A", async () => {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const p = scrolled();
    const world = onShot(p);
    await shotA();
    runs.push(new Set(world.state.scripts.filter((js) => js.includes("__perch_shot"))));
  }
  assert.deepEqual([...runs[1]], [...runs[0]]);
  assert.equal(runs[0].size, 3, "clip, paint poll and restore");
  for (const js of runs[0]) assert.ok(!/\d+\.[a-z0-9]{8}/.test(js.match(/\nconst A = (.*);\n/)[1]), "no token in A");
});
