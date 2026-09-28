// Polls that land while the page's own navigation replaces the document. Chrome
// never replies to such an execute, and JXA commands take no timeout, so a plain
// poll blocked for the 2-minute Apple Event default. The fake world models the
// dropped reply with state.dropWhilePending (see test/navigate.test.mjs).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const NEXT = "https://next.test/";
let world, handle;
async function install() {
  world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [
      { id: 1, active: 0, tabs: [{ url: "https://a0.test/", id: "a0" }] },
      { id: 2, active: 0, tabs: [{ url: "https://c0.test/", id: "c0" }] },
    ] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  handle = (await call("list_tabs", {})).o.tabs.find((t) => t.url === "https://c0.test/").tabId;
  // The old document answers one more execute, then the next one is dropped.
  world.state.linger = 1;
  world.state.dropWhilePending = true;
  world.reset();
}
const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  return { r, t, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
const rt = (fn, args) => JSON.parse(world.run(`JSON.stringify(__perch.${fn}(${JSON.stringify(args)}))`));
const startNav = async () => {
  const { r } = await call("eval_js", { script: `location.assign(${JSON.stringify(NEXT)}); return 1`, target: { tabId: handle } });
  assert.equal(r.isError, undefined);
};
const newPage = () => world.page("Google Chrome", 1, 0);
const timed = async (f) => {
  const t0 = world.clock.t;
  const out = await f();
  return { out, took: world.clock.t - t0 };
};

beforeEach(() => { world = null; });

test("wait {expression} mid-navigation answers from the new document within its timeout", async () => {
  await install();
  await startNav();
  const { out: { r, o, t }, took } = await timed(() => call("wait", { expression: "location.href", timeout: 5000, target: { tabId: handle } }));
  assert.equal(r.isError, undefined, t);
  assert.equal(o.value, NEXT);
  assert.ok(took <= 5000 + 1000, `took ${took}ms`);
  assert.equal(world.counts["win.id()"] || 0, 0, "the bounded poll needs no window id read");
});

test("eval_js {awaitPromise} mid-navigation ends with a coded error, not the 2-minute Apple Event timeout", async () => {
  await install();
  await startNav();
  const { out: { r, t }, took } = await timed(() => call("eval_js", { script: "return 5", awaitPromise: true, timeout: 5000, target: { tabId: handle } }));
  if (r.isError) {
    assert.match(t, /^error: timeout: .*navigating; retry/);
    assert.doesNotMatch(t, /AppleEvent timed out/);
  } else assert.equal(t, "5");
  assert.ok(took <= 5000 + 1000, `took ${took}ms`);
});

test("click readback whose click navigates reports the new document", async () => {
  await install();
  const { out, took } = await timed(() => rt("click", {
    target: { tabId: handle },
    click: `window.__perch_rb = 1; location.assign(${JSON.stringify(NEXT)}); JSON.stringify({ok: true})`,
    read: "JSON.stringify(window.__perch_rb ? null : {changed: true, navigated: true, url: location.href})",
    readFinal: "JSON.stringify({changed: false})",
    settle: 2000,
  }));
  assert.deepEqual(out, { ok: true, changed: true, navigated: true, url: NEXT });
  assert.ok(took <= 2000 + 1000, `took ${took}ms`);
  assert.equal(newPage().location.href, NEXT);
});

test("click readback: a final read that gets no reply is a coded timeout, and the click ran once", async () => {
  await install();
  world.state.afterExecute = () => { world.state.hung = true; };
  const t0 = world.clock.t;
  assert.throws(() => rt("click", {
    target: { tabId: handle },
    click: "window.clicks = (window.clicks || 0) + 1; JSON.stringify({ok: true})",
    read: "JSON.stringify(null)",
    readFinal: "JSON.stringify({changed: false})",
    settle: 300,
  }), (e) => /timeout: .*navigating; retry/.test(e.message) && !/AppleEvent timed out/.test(e.message));
  assert.ok(world.clock.t - t0 <= 300 + 1000 + 200, `took ${world.clock.t - t0}ms`);
  assert.equal(world.page("Google Chrome", 1, 0).clicks, 1);
});

test("select whose start navigates settles on the new document's answer within its wait", async () => {
  await install();
  const { out, took } = await timed(() => rt("select", {
    target: { tabId: handle },
    start: `window.__open = 1; location.assign(${JSON.stringify(NEXT)}); JSON.stringify({pending: true})`,
    pick: "JSON.stringify(window.__open ? null : {ok: false, error: 'the page navigated'})",
    wait: 2000,
    miss: "JSON.stringify({ok: false, error: 'miss'})",
    read: "JSON.stringify(null)",
    readFinal: "JSON.stringify(null)",
  }));
  assert.deepEqual(out, { ok: false, error: "the page navigated" });
  assert.ok(took <= 2000 + 1000, `took ${took}ms`);
});

test("select: a miss read that gets no reply is a coded timeout", async () => {
  await install();
  world.state.hung = true;
  const t0 = world.clock.t;
  assert.throws(() => rt("select", {
    target: { tabId: handle },
    pick: "JSON.stringify(null)", wait: 300,
    miss: "JSON.stringify({ok: false, error: 'miss'})",
  }), (e) => /^timeout: .*navigating; retry/.test(e.message));
  assert.ok(world.clock.t - t0 <= 300 + 1000 + 200, `took ${world.clock.t - t0}ms`);
});

test("a poll on a tab that closed mid-poll is still stale_tab", async () => {
  await install();
  world.state.dropWhilePending = false;
  world.state.linger = 0;
  world.state.afterExecute = () => { world.tabsOf("Google Chrome", 1).pop(); };
  const { r, t } = await call("wait", { expression: "false", timeout: 2000, target: { tabId: handle } });
  assert.equal(r.isError, true);
  assert.match(t, /stale_tab/);
});
