// Multi-step tools keep state on window globals between page calls, so calls on
// one tab run one at a time; calls on different tabs still overlap.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, withTabLock, tabLocks } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const FORM = `<label>Name <input name=name></label><label>City <input name=city></label>`;

function twoTabs() {
  const doms = [page(FORM), page(FORM)];
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [
      { url: "https://a.test/", id: "x", dom: doms[0] },
      { url: "https://b.test/", id: "y", dom: doms[1] },
    ] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  const log = [];
  // Each script is in flight for a macrotask, as a real Apple Event is; "end" marks its reply.
  const daemon = { run: async (script) => {
    log.push(script);
    await new Promise((r) => setTimeout(r, 1));
    try { return await world.daemon.run(script); } finally { log.push("end:" + script); }
  } };
  DAEMONS.fast = daemon;
  DAEMONS.slow = daemon;
  return { doms, world, log };
}

const firstSent = (log, marker) => log.findIndex((s) => !s.startsWith("end:") && s.includes(marker));

async function race(targetA, targetB) {
  const { doms, log } = twoTabs();
  const a = handleCall("fill", { label_pattern: "name", text: "Alpha1", target: targetA }).then((r) => { log.push("A-done"); return r; });
  const b = handleCall("fill", { label_pattern: "city", text: "Bravo2", target: targetB });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(JSON.parse(ra.content[0].text).ok, true, ra.content[0].text);
  assert.equal(JSON.parse(rb.content[0].text).ok, true, rb.content[0].text);
  const aLast = log.findLastIndex((s) => s.startsWith("end:") && s.includes("Alpha1"));
  return { doms, bFirst: firstSent(log, "Bravo2"), aLast, aDone: log.indexOf("A-done") };
}

test("tab lock: fills on different tabs overlap", async () => {
  const { doms, bFirst, aDone } = await race({ tabId: "chrome:x" }, { tabId: "chrome:y" });
  assert.ok(bFirst >= 0 && bFirst < aDone, `B's first script (${bFirst}) is sent before A completes (${aDone})`);
  assert.equal(doms[0].document.querySelector("[name=name]").value, "Alpha1");
  assert.equal(doms[1].document.querySelector("[name=city]").value, "Bravo2");
});

test("tab lock: fills on one tab run one after the other", async () => {
  const { doms, bFirst, aLast } = await race({ tabId: "chrome:x" }, { tabId: "chrome:x" });
  assert.ok(aLast >= 0 && bFirst > aLast, `B's first script (${bFirst}) waits for A's last reply (${aLast})`);
  assert.equal(doms[0].document.querySelector("[name=city]").value, "Bravo2");
});

test("tab lock: untargeted fills share one key", async () => {
  const { bFirst, aLast } = await race(undefined, undefined);
  assert.ok(aLast >= 0 && bFirst > aLast);
});

test("tab lock: read-only tools don't wait on a held tab", async () => {
  twoTabs();
  let release;
  const held = withTabLock("tab:chrome:x", () => new Promise((r) => { release = r; }));
  const r = await handleCall("eval_js", { script: "return 7", target: { tabId: "chrome:x" } });
  assert.equal(r.content[0].text, "7");
  release();
  await held;
});

test("tab lock: a call that fails releases its tab", { timeout: 5000 }, async () => {
  twoTabs();
  DAEMONS.fast = DAEMONS.slow = { run: async () => { throw new Error("boom (-1712)"); } };
  const bad = await handleCall("fill", { label_pattern: "name", text: "x", target: { tabId: "chrome:x" } });
  assert.equal(bad.isError, true);
  const { doms } = twoTabs();
  const ok = await handleCall("fill", { label_pattern: "name", text: "Ada", target: { tabId: "chrome:x" } });
  assert.equal(JSON.parse(ok.content[0].text).ok, true, ok.content[0].text);
  assert.equal(doms[0].document.querySelector("[name=name]").value, "Ada");
  assert.equal(tabLocks.size, 0);
});

test("withTabLock: a throw releases the key and the map drains", async () => {
  const order = [];
  const a = withTabLock("k", async () => { order.push("a"); throw new Error("x"); });
  const b = withTabLock("k", async () => { order.push("b"); return 2; });
  const c = withTabLock("other", async () => { order.push("c"); return 3; });
  await assert.rejects(a, /x/);
  assert.equal(await b, 2);
  assert.equal(await c, 3);
  assert.deepEqual([...order].sort(), ["a", "b", "c"]);
  assert.ok(order.indexOf("a") < order.indexOf("b"));
  assert.equal(tabLocks.size, 0);
});

test("tab lock: select, file_upload, readback or trusted clicks, trusted presses and quiet waits wait on a held tab; plain ones don't", async () => {
  const target = { tabId: "chrome:x" };
  const cases = [
    ["select", { label_pattern: "name", text: "a", target }, true],
    ["file_upload", { selector: "input", path: new URL(import.meta.url).pathname, target }, true],
    ["click", { selector: "input", readback: "body", target }, true],
    ["click", { selector: "input", trusted: true, target }, true],
    ["press", { key: "Enter", selector: "input", trusted: true, target }, true],
    ["wait", { quiet: 50, timeout: 500, target }, true],
    ["click", { selector: "input", target }, false],
    ["press", { key: "Enter", selector: "input", target }, false],
    ["wait", { selector: "input", target }, false],
  ];
  for (const [name, args, waits] of cases) {
    const { log } = twoTabs();
    let release;
    const held = withTabLock("tab:chrome:x", () => new Promise((r) => { release = r; }));
    const call = handleCall(name, args);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(log.length === 0, waits, `${name} ${JSON.stringify(args)}: ${log.length} scripts sent while held`);
    release();
    await held;
    await call;
  }
});

// click {trusted}, press {trusted} and wait {quiet} arm window globals
// (__perch_trusted, __perch_key, __perch_quiet) that a later step of the same
// call reads, and select {trusted} reads __perch_trusted between its probe and
// check, so they too run one at a time per tab.
const FIXTURE = readFileSync(new URL("./fixtures/trusted-select.html", import.meta.url), "utf8");

// The trusted-select fixture in a shown tab of a background Chrome window, with
// each script in flight for a macrotask and select's for 30ms, the window a
// real select spends between its probe and its check. A posted press reaches the element the
// latest probe armed on __perch_trusted, a posted Enter the focused element;
// `downs` records each mousedown's target.
function trustedTab() {
  const dom = page(/<body>([\s\S]*?)<script>/.exec(FIXTURE)[1], { url: "https://form.test/" });
  for (const [k, v] of Object.entries({ screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 })) {
    Object.defineProperty(dom, k, { value: v, configurable: true });
  }
  dom.eval(/<script>([\s\S]*?)<\/script>/.exec(FIXTURE)[1]);
  dom.document.body.insertAdjacentHTML("beforeend", "<button id=go>Go</button><input id=note>");
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 1, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "https://form.test/", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 798, h: 500, frames: [] }] } }],
  });
  world.run(JXA_PRELUDE);
  world.reset();
  const downs = [];
  const fire = (el, types, C) => types.forEach((type) => {
    const e = new C(type, { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(e, "isTrusted", { value: true });
    el.dispatchEvent(e);
  });
  let aimed = null;
  const WIN = { x: 0, y: 57, w: 854, h: 600 };
  world.state.focus = { window: WIN, chain: [{ role: "AXTextField", box: { x: 60, y: 170, w: 100, h: 20 } }, { role: "AXWebArea", box: { x: 56, y: 157, w: 798, h: 500 } }, { role: "AXWindow", box: WIN }] };
  world.state.onPost = (e) => {
    if (e.kind === "key" && e.vk === 36) {
      const k = new dom.KeyboardEvent(e.down ? "keydown" : "keyup", { key: "Enter", bubbles: true });
      Object.defineProperty(k, "isTrusted", { value: true });
      (dom.document.activeElement || dom.document.body).dispatchEvent(k);
    }
    if (e.kind !== "mouse" || e.pt.x < 0 || (e.type !== 1 && e.type !== 2)) return;
    if (e.type === 1) aimed = dom.__perch_trusted && dom.__perch_trusted.el;
    if (!aimed) return;
    const P = dom.PointerEvent || dom.MouseEvent;
    if (e.type === 1) { downs.push(aimed.id); fire(aimed, ["pointerdown"], P); fire(aimed, ["mousedown"], dom.MouseEvent); }
    else { fire(aimed, ["pointerup"], P); fire(aimed, ["mouseup", "click"], dom.MouseEvent); }
  };
  const log = [];
  const daemon = { run: async (script) => {
    log.push(script);
    await new Promise((r) => setTimeout(r, script.includes("__perch.select(") ? 30 : 1));
    try { return await world.daemon.run(script); } finally { log.push("end:" + script); }
  } };
  DAEMONS.fast = daemon;
  DAEMONS.slow = daemon;
  return { dom, world, log, downs };
}

const parsed = (r) => { const t = r.content[0].text; try { return JSON.parse(t); } catch { return { error: t }; } };

// Fires select {trusted} on #fruit, then `name` at `tabId` once select's first
// script is in flight; `selectDone` is select's last reply. `marker` is text only the second call's scripts carry.
async function afterTrustedSelect(name, args, marker, tabId = "chrome:t") {
  const tab = trustedTab();
  const sel = handleCall("select", { selector: "#fruit", text: "banana", trusted: true, target: { tabId: "chrome:t" } });
  while (!tab.log.length) await new Promise((r) => setImmediate(r));
  const other = handleCall(name, { ...args, target: { tabId } });
  const [rs, ro] = await Promise.all([sel, other]);
  return { tab, rs: parsed(rs), ro: parsed(ro), selectDone: tab.log.findLastIndex((s) => s.startsWith("end:") && s.includes("__perch.select(")), otherFirst: firstSent(tab.log, marker) };
}

test("tab lock: a trusted click waits for a trusted select on its tab, and select's hit is its own press", async () => {
  const { tab, rs, ro, selectDone, otherFirst } = await afterTrustedSelect("click", { trusted: true, selector: "#go" }, "__perch.trustedClick(");
  assert.ok(otherFirst > selectDone, `click's first script (${otherFirst}) waits for select to resolve (${selectDone})`);
  assert.equal(rs.ok, true, JSON.stringify(rs));
  assert.deepEqual(rs.trusted, ["control"]);
  assert.equal(rs.value, "Banana");
  assert.deepEqual([...tab.dom.pickerLog], ["fruit:Banana"]);
  assert.equal(ro.ok, true, JSON.stringify(ro));
  assert.deepEqual(tab.downs, ["fruit", "go"]);
});

test("tab lock: a trusted press waits for a trusted select on its tab", async () => {
  const { tab, rs, ro, selectDone, otherFirst } = await afterTrustedSelect("press", { key: "Enter", trusted: true, selector: "#note" }, "__perch.trustedPress(");
  assert.ok(otherFirst > selectDone, `press's first script (${otherFirst}) waits for select to resolve (${selectDone})`);
  assert.equal(rs.ok, true, JSON.stringify(rs));
  assert.deepEqual(rs.trusted, ["control"]);
  assert.deepEqual([...tab.dom.pickerLog], ["fruit:Banana"]);
  assert.equal(ro.ok, true, JSON.stringify(ro));
  assert.equal(ro.hit, true);
  assert.deepEqual(tab.downs, ["fruit"]);
});

test("tab lock: a trusted click on another tab doesn't wait", async () => {
  const { selectDone, otherFirst } = await afterTrustedSelect("click", { trusted: true, selector: "#go" }, "__perch.trustedClick(", "chrome:other");
  assert.ok(otherFirst >= 0 && otherFirst < selectDone, `click's first script (${otherFirst}) is sent before select resolves (${selectDone})`);
});

test("tab lock: two wait {quiet} calls on one tab run one after the other", async () => {
  const { log } = twoTabs();
  const target = { tabId: "chrome:x" };
  const a = handleCall("wait", { quiet: 100, timeout: 2000, target }).then((r) => { log.push("A-done"); return r; });
  const b = handleCall("wait", { quiet: 150, timeout: 2000, target });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(parsed(ra).ok, true, ra.content[0].text);
  assert.equal(parsed(rb).ok, true, rb.content[0].text);
  const bFirst = firstSent(log, '"quiet":150');
  const aLast = log.findLastIndex((s) => s.startsWith("end:") && s.includes('"quiet":100'));
  assert.ok(aLast >= 0 && bFirst > aLast, `B's first script (${bFirst}) waits for A's last reply (${aLast})`);
});
