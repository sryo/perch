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

test("wait {quiet} mid-navigation waits out the dropped reply, then times the window on the new document", async () => {
  await install();
  await startNav();
  const { out: { r, o, t }, took } = await timed(() => call("wait", { quiet: 500, timeout: 5000, target: { tabId: handle } }));
  assert.equal(r.isError, undefined, t);
  assert.ok(o.quietFor >= 500, `quietFor ${o.quietFor}`);
  // The dropped reply (one POLL_EXEC_SECS) restarts the window, so it runs on the new document.
  assert.ok(took >= 1000 + 500 && took <= 5000 + 1000, `took ${took}ms`);
  assert.equal(newPage().location.href, NEXT);
  assert.ok(newPage().__perch_quiet, "the new document was armed");
  assert.equal(world.log.filter(([k]) => k === "assign").length, 1, "the page's own navigation ran once");
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
    readFinal: "JSON.stringify(window.__perch_rb ? {changed: false} : {changed: true, navigated: true, url: location.href})",
    settle: 2000,
  }));
  assert.deepEqual(out, { ok: true, changed: true, navigated: true, url: NEXT });
  assert.ok(took <= 2000 + 1000, `took ${took}ms`);
  assert.equal(newPage().location.href, NEXT);
});

test("click readback: a final read that gets no reply says the click ran, and the click ran once", async () => {
  await install();
  world.state.afterExecute = () => { world.state.hung = true; };
  const t0 = world.clock.t;
  assert.throws(() => rt("click", {
    target: { tabId: handle },
    click: "window.clicks = (window.clicks || 0) + 1; JSON.stringify({ok: true})",
    read: "JSON.stringify(null)",
    readFinal: "JSON.stringify({changed: false})",
    settle: 300,
  }), (e) => RAN("click").test(e.message) && !/AppleEvent timed out/.test(e.message));
  assert.ok(world.clock.t - t0 <= 300 + 2000 + 4000 + 200, `took ${world.clock.t - t0}ms`);
  assert.equal(world.page("Google Chrome", 1, 0).clicks, 1);
});

test("select whose start navigates: the pick the navigation drops ends coded within its wait, sent once", async () => {
  await install();
  const t0 = world.clock.t;
  world.reset();
  assert.throws(() => rt("select", {
    target: { tabId: handle },
    start: `window.__open = 1; location.assign(${JSON.stringify(NEXT)}); JSON.stringify({pending: true})`,
    pick: "JSON.stringify(window.__open ? null : {ok: false, error: 'the page navigated'})",
    wait: 2000,
    miss: "JSON.stringify({ok: false, error: 'miss'})",
    read: "JSON.stringify(null)",
    readFinal: "JSON.stringify(null)",
  }), (e) => NO_RERUN.test(e.message));
  assert.ok(world.clock.t - t0 <= 5000, `took ${world.clock.t - t0}ms`);
  assert.equal(world.counts["tab.execute"], 2, "start and one pick");
});

test("select: a miss read that gets no reply is a coded timeout saying the select ran", async () => {
  await install();
  world.state.afterExecute = () => { world.state.hung = true; };
  const t0 = world.clock.t;
  assert.throws(() => rt("select", {
    target: { tabId: handle },
    pick: "JSON.stringify({settled: true})", wait: 300,
    miss: "JSON.stringify({ok: false, error: 'miss'})",
  }), (e) => RAN("select").test(e.message));
  assert.ok(world.clock.t - t0 <= 2000 + 4000 + 200, `took ${world.clock.t - t0}ms`);
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

// A tab with no navigation in flight, for page JS that is merely slow.
const calm = () => { world.state.linger = 0; world.state.dropWhilePending = false; };
const assigns = () => world.log.filter(([k]) => k === "assign").length;
const NO_RERUN = /^(error: )?timeout: .*navigating; retry after checking the page/;

test("eval_js {awaitPromise} whose code runs 1.5s before its first await answers, and runs once", async () => {
  await install();
  calm();
  const { r, t } = await call("eval_js", {
    script: "__busy(1500); window.runs = (window.runs || 0) + 1; await 0; return 7",
    awaitPromise: true, timeout: 5000, target: { tabId: handle },
  });
  assert.equal(r.isError, undefined, t);
  assert.equal(t, "7");
  assert.equal(world.page("Google Chrome", 1, 0).runs, 1);
});

test("eval_js {awaitPromise}: after a slow kick's dropped reply, a promise still pending is waited for", async () => {
  await install();
  calm();
  // Resolved by the first poll, so it settles only after that poll has read the slot.
  world.state.afterExecute = () => { world.page("Google Chrome", 1, 0).__go(9); };
  const { r, t } = await call("eval_js", {
    script: "__busy(1500); return await new Promise((res) => { window.__go = res; })",
    awaitPromise: true, timeout: 5000, target: { tabId: handle },
  });
  assert.equal(r.isError, undefined, t);
  assert.equal(t, "9");
});

test("eval_js {awaitPromise} whose kick reply a navigation drops ends coded within its timeout, having run once", async () => {
  await install();
  world.state.dropAfterAssign = true;
  const { out: { r, t }, took } = await timed(() => call("eval_js", {
    script: `location.assign(${JSON.stringify(NEXT)}); return 1`,
    awaitPromise: true, timeout: 5000, target: { tabId: handle },
  }));
  assert.equal(r.isError, true);
  assert.match(t, NO_RERUN);
  assert.ok(took <= 5000, `took ${took}ms`);
  assert.equal(assigns(), 1);
});

test("wait {expression} that takes 1.5s per evaluation still answers", async () => {
  await install();
  calm();
  const { r, o, t } = await call("wait", { expression: "(__busy(1500), 'slow')", timeout: 8000, target: { tabId: handle } });
  assert.equal(r.isError, undefined, t);
  assert.equal(o.value, "slow");
});

test("a poll dropped by a navigation costs one POLL_EXEC_SECS (2s), not a doubled wait", async () => {
  await install();
  await startNav();
  const { out: { o }, took } = await timed(() => call("wait", { expression: "location.href", timeout: 5000, target: { tabId: handle } }));
  assert.equal(o.value, NEXT);
  assert.ok(took <= 2200, `took ${took}ms`);
});

test("a select pick (and fill's typeahead pick) whose reply is dropped is not run again", async () => {
  await install();
  world.state.dropWhilePending = false;
  world.state.dropAfterAssign = true;
  const { out: thrown, took } = await timed(async () => {
    try {
      rt("select", {
        target: { tabId: handle }, tool: "fill", wait: 3000,
        pick: `location.assign(${JSON.stringify(NEXT)}); JSON.stringify({ok: true})`,
        miss: "JSON.stringify({ok: false, error: 'miss'})",
      });
    } catch (e) { return e; }
    return null;
  });
  assert.match(String(thrown && thrown.message), NO_RERUN);
  assert.ok(took <= 5000, `took ${took}ms`);
  assert.equal(assigns(), 1);
});

test("a select start whose reply is dropped is not run again", async () => {
  await install();
  world.state.dropWhilePending = false;
  world.state.dropAfterAssign = true;
  assert.throws(() => rt("select", {
    target: { tabId: handle },
    start: `location.assign(${JSON.stringify(NEXT)}); JSON.stringify({pending: true})`,
    pick: "JSON.stringify({ok: true})", miss: "JSON.stringify({ok: false, error: 'miss'})",
  }), (e) => NO_RERUN.test(e.message));
  assert.equal(assigns(), 1);
});

test("a click whose reply is dropped ends coded within the click's cap, clicked once", async () => {
  await install();
  world.state.dropWhilePending = false;
  world.state.dropAfterAssign = true;
  const t0 = world.clock.t;
  assert.throws(() => rt("click", {
    target: { tabId: handle },
    click: `location.assign(${JSON.stringify(NEXT)}); JSON.stringify({ok: true})`,
    read: "JSON.stringify(null)", readFinal: "JSON.stringify({changed: false})", settle: 300,
  }), (e) => NO_RERUN.test(e.message));
  assert.ok(world.clock.t - t0 <= 5200, `took ${world.clock.t - t0}ms`);
  assert.equal(assigns(), 1);
});

const clickArgs = (click) => ({
  target: { tabId: handle }, click,
  read: "JSON.stringify(null)", readFinal: "JSON.stringify({changed: false})", settle: 300,
});
const COUNT_CLICK = "window.clicks = (window.clicks || 0) + 1; JSON.stringify({ok: true})";

test("eval_js {awaitPromise}: a poll that gave up and runs late does not eat the result", async () => {
  await install();
  calm();
  world.state.lateRun = true;
  const { r, t } = await call("eval_js", {
    script: "__busy(2500); await 0; return 7",
    awaitPromise: true, timeout: 8000, target: { tabId: handle },
  });
  assert.equal(r.isError, undefined, t);
  assert.equal(t, "7");
});

test("eval_js {awaitPromise}: the next call sweeps the slots earlier calls read", async () => {
  await install();
  calm();
  for (const n of [1, 2]) assert.equal((await call("eval_js", { script: `return ${n}`, awaitPromise: true, target: { tabId: handle } })).t, String(n));
  const left = Object.keys(world.page("Google Chrome", 1, 0)).filter((k) => /^__perch_async_/.test(k) && k !== "__perch_async_done");
  assert.equal(left.length, 1, left.join());
});

test("a pick run near the deadline that answers null in time is a clean miss", async () => {
  await install();
  calm();
  const out = rt("select", {
    target: { tabId: handle }, wait: 500,
    pick: "__busy(300); JSON.stringify(null)",
    miss: "JSON.stringify({ok: false, error: 'miss'})",
  });
  assert.deepEqual(out, { ok: false, error: "miss" });
});

test("a click whose handler runs 1.5s synchronously answers", async () => {
  await install();
  calm();
  const out = rt("click", clickArgs("__busy(1500); " + COUNT_CLICK));
  assert.equal(out.ok, true);
  assert.equal(world.page("Google Chrome", 1, 0).clicks, 1);
});

test("a click whose window was raised is resent on the plain path, once, to the right tab", async () => {
  await install();
  calm();
  world.run(`Application("Google Chrome").windows[1].index = 1`);
  const out = rt("click", clickArgs(COUNT_CLICK));
  assert.equal(out.ok, true);
  assert.equal(world.page("Google Chrome", 0, 0).clicks, 1);
  assert.equal(world.page("Google Chrome", 1, 0).clicks, undefined);
});

test("a click that fails at once for no provable reason is not resent", async () => {
  await install();
  calm();
  world.state.failAfterRun = true;
  assert.throws(() => rt("click", clickArgs(COUNT_CLICK)), (e) => /^timeout: .*may have run.*retry after checking the page/.test(e.message));
  assert.equal(world.page("Google Chrome", 1, 0).clicks, 1);
});

test("a click with JavaScript from Apple Events off reports that, not a timeout", async () => {
  await install();
  calm();
  world.state.jsOff = true;
  assert.throws(() => rt("click", clickArgs(COUNT_CLICK)), (e) => /turned off/.test(e.message));
  assert.equal(world.page("Google Chrome", 1, 0).clicks, undefined);
});

test("a window raised mid-poll: the `window N` run falls back to the plain path and polls the right tab", async () => {
  await install();
  calm();
  world.state.afterExecute = () => { world.run(`Application("Google Chrome").windows[1].index = 1`); };
  const { r, o, t } = await call("wait", {
    expression: "(window.polls = (window.polls || 0) + 1) >= 2 && location.href", timeout: 3000, target: { tabId: handle },
  });
  assert.equal(r.isError, undefined, t);
  assert.equal(o.value, "https://c0.test/");
  assert.equal(world.winSpec("Google Chrome", 0).id, 2, "window 2 is now in front");
  assert.equal(world.page("Google Chrome", 1, 0).polls, undefined, "the other window's tab was never polled");
  assert.ok((world.counts.NSAppleScript || 0) >= 2, "the poll took the `window N` path");
});

// A slow machine: page JS that is alive but answers late must not fail a step.
test("a select start and pick that each hold the page 1.5s still answer", async () => {
  await install();
  calm();
  const out = rt("select", {
    target: { tabId: handle },
    start: "__busy(1500); window.starts = (window.starts || 0) + 1; JSON.stringify({pending: true})",
    pick: "__busy(1500); window.picks = (window.picks || 0) + 1; JSON.stringify({ok: true})",
    miss: "JSON.stringify({ok: false, error: 'miss'})",
    read: "JSON.stringify({ok: true, value: 'B'})", readFinal: "JSON.stringify(null)",
  });
  assert.deepEqual(out, { ok: true, value: "B" });
  assert.equal(world.page("Google Chrome", 1, 0).starts, 1);
  assert.equal(world.page("Google Chrome", 1, 0).picks, 1);
});

test("a read that takes 1.5s answers on its first run", async () => {
  await install();
  calm();
  const { o, t } = await call("wait", { expression: "(__busy(1500), 'slow')", timeout: 5000, target: { tabId: handle } });
  assert.equal(o.value, "slow", t);
  assert.equal(world.counts.NSAppleScript, 1);
});

test("a one-shot read that takes 2.5s still answers", async () => {
  await install();
  calm();
  const out = rt("click", {
    target: { tabId: handle }, click: COUNT_CLICK,
    read: "JSON.stringify(null)", readFinal: "__busy(2500); JSON.stringify({changed: false})", settle: 100,
  });
  assert.deepEqual(out, { ok: true, changed: false });
  assert.equal(world.page("Google Chrome", 1, 0).clicks, 1);
});

const RAN = (tool) => new RegExp(`^timeout: the ${tool} ran but .*don't ${tool} again`);

test("a click whose readback gets no reply says the click ran", async () => {
  await install();
  calm();
  world.state.afterExecute = () => { world.state.hung = true; };
  assert.throws(() => rt("click", clickArgs(COUNT_CLICK)), (e) => RAN("click").test(e.message));
  assert.equal(world.page("Google Chrome", 1, 0).clicks, 1);
});

test("a fill whose typeahead miss read gets no reply says the fill ran", async () => {
  await install();
  calm();
  world.state.afterExecute = () => { world.state.hung = true; };
  assert.throws(() => rt("select", {
    target: { tabId: handle }, tool: "fill", wait: 300,
    pick: "JSON.stringify({settled: true})",
    miss: "JSON.stringify({ok: false, error: 'miss'})",
  }), (e) => RAN("fill").test(e.message));
});

test("eval_js {awaitPromise} that times out says its code ran", async () => {
  await install();
  calm();
  const { r, t } = await call("eval_js", { script: "await new Promise(() => {})", awaitPromise: true, target: { tabId: handle } });
  assert.equal(r.isError, true);
  assert.match(t, /timed out after \d+ms; the code ran/);
});

test("the bounded execute compiles once per tab and window, not once per poll", async () => {
  await install();
  calm();
  const args = { ...clickArgs(COUNT_CLICK), settle: 1000 };
  assert.equal(rt("click", args).ok, true);
  const runs = world.counts.NSAppleScript;
  assert.ok(runs >= 10, `only ${runs} bounded runs`);
  assert.equal(world.state.compiles, 1);
  assert.equal(rt("click", args).ok, true);
  assert.equal(world.state.compiles, 1, "a later call reuses the compiled script");
});
