// Multi-step tools keep state on window globals between page calls, so calls on
// one tab run one at a time; calls on different tabs still overlap.
import { test } from "node:test";
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

test("tab lock: select, file_upload and a readback click wait on a held tab; a plain click doesn't", async () => {
  const target = { tabId: "chrome:x" };
  const cases = [
    ["select", { label_pattern: "name", text: "a", target }, true],
    ["file_upload", { selector: "input", path: new URL(import.meta.url).pathname, target }, true],
    ["click", { selector: "input", readback: "body", target }, true],
    ["click", { selector: "input", target }, false],
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
