import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, OsaDaemon, handleCall, deps } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { fakeSpawner } from "./fakes/fake-repl.mjs";

const CANARY = "Google Chrome Canary";
const saved = { fast: DAEMONS.fast, slow: DAEMONS.slow, dialogs: deps.dialogs, exec: deps.exec };
afterEach(() => {
  for (const lane of ["fast", "slow"]) { if (DAEMONS[lane] && DAEMONS[lane].kill) DAEMONS[lane].kill(); DAEMONS[lane] = saved[lane]; }
  deps.dialogs = saved.dialogs;
  deps.exec = saved.exec;
});

let world;
function install(dialogs = []) {
  world = makeWorld({
    browsers: [
      { name: CANARY, kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ id: 5, url: "https://a.test/" }] }] },
      { name: "Google Chrome", kind: "chrome", windows: [{ id: 2, active: 0, tabs: [{ id: 6, url: "https://b.test/" }] }] },
    ],
    cg: [{ owner: "Terminal", pid: 1 }, { owner: CANARY, pid: 40, wid: 400 }, { owner: "Google Chrome", pid: 50, wid: 500 }],
  });
  world.run(JXA_PRELUDE);
  world.state.dialogs = dialogs;
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  return { r, t, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
const confirmBox = (extra = {}) => ({ pid: 40, texts: ["a.test says", "Delete the draft?"], buttons: ["Cancel", "OK"], ...extra });

// ---- runtime: reading dialogs ----

test("dialogs() names kind and message from the AX dialog window, origin line dropped", () => {
  install([
    confirmBox(),
    { pid: 50, texts: ["b.test says", "Saved"], buttons: ["OK"] },
    { pid: 50, texts: ["b.test says", "Your name?"], buttons: ["Cancel", "OK"], field: "" },
  ]);
  const all = JSON.parse(world.run("JSON.stringify(__perch.dialogs({}))"));
  assert.deepEqual(all, [
    { app: CANARY, kind: "confirm", message: "Delete the draft?" },
    { app: "Google Chrome", kind: "alert", message: "Saved" },
    { app: "Google Chrome", kind: "prompt", message: "Your name?" },
  ]);
  const one = JSON.parse(world.run(`JSON.stringify(__perch.dialogs({app:${JSON.stringify(CANARY)}}))`));
  assert.deepEqual(one.map((d) => d.app), [CANARY]);
});

test("dialogs() joins multi-line messages and caps them at 200 chars", () => {
  install([{ pid: 40, texts: ["a.test says", "line one", "x".repeat(300)], buttons: ["OK"] }]);
  const [d] = JSON.parse(world.run("JSON.stringify(__perch.dialogs({}))"));
  assert.equal(d.message.length, 200);
  assert.ok(d.message.startsWith("line one x"));
});

test("dialogs() returns [] without an Accessibility grant, and never prompts", () => {
  install([confirmBox()]);
  world.state.ax = false;
  assert.equal(world.run("JSON.stringify(__perch.dialogs({}))"), "[]");
  assert.equal(world.counts.AX, undefined);
});

// ---- press {dialog} ----

test("press {dialog} Enter presses the last button and verifies the dialog closed", async () => {
  const w = install([confirmBox()]);
  const { o } = await call("press", { key: "Enter", dialog: true });
  assert.deepEqual(o, { ok: true, dialog: "confirm", message: "Delete the draft?", answer: "accept" });
  assert.deepEqual(w.state.axActions, [{ role: "AXButton", title: "OK", action: "AXPress" }]);
  assert.equal(w.state.dialogs.length, 0);
});

test("press {dialog} Escape presses the first button, never by title", async () => {
  const w = install([confirmBox({ buttons: ["Abbrechen", "Bestätigen"] })]);
  const { o } = await call("press", { key: "Escape", dialog: true });
  assert.equal(o.ok, true);
  assert.equal(o.answer, "dismiss");
  assert.deepEqual(w.state.axActions.map((a) => a.title), ["Abbrechen"]);
});

test("press {dialog} Escape on an alert presses its only button", async () => {
  const w = install([{ pid: 40, texts: ["a.test says", "Done"], buttons: ["OK"] }]);
  const { o } = await call("press", { key: "Escape", dialog: true });
  assert.equal(o.dialog, "alert");
  assert.deepEqual(w.state.axActions.map((a) => a.title), ["OK"]);
});

test("press {dialog: text} sets the prompt's field, then presses OK", async () => {
  const d = { pid: 40, texts: ["a.test says", "Your name?"], buttons: ["Cancel", "OK"], field: "" };
  install([d]);
  const { o } = await call("press", { key: "Enter", dialog: "Ada Lovelace" });
  assert.deepEqual(o, { ok: true, dialog: "prompt", message: "Your name?", answer: "accept", text: "Ada Lovelace" });
  assert.equal(d.value, "Ada Lovelace");
  assert.equal(d.answer, "OK");
});

test("press {dialog: text} on a non-prompt presses nothing", async () => {
  const w = install([confirmBox()]);
  const { o } = await call("press", { key: "Enter", dialog: "hi" });
  assert.equal(o.ok, false);
  assert.match(o.error, /not a prompt/);
  assert.deepEqual(w.state.axActions, []);
});

test("press {dialog}: no dialog, several dialogs, and one that stays open", async () => {
  install([]);
  assert.deepEqual((await call("press", { key: "Enter", dialog: true })).o, { ok: false, error: "no open dialog" });
  const w = install([confirmBox(), { pid: 50, texts: ["b.test says", "Hi"], buttons: ["OK"] }]);
  assert.deepEqual((await call("press", { key: "Enter", dialog: true })).o, { ok: false, error: "several dialogs open in 2 windows; pass target" });
  assert.deepEqual(w.state.axActions, []);
  // A target's browser narrows the search to its own dialogs.
  const { o } = await call("press", { key: "Enter", dialog: true, target: { tabId: "canary:5" } });
  assert.equal(o.ok, true);
  assert.equal(w.state.dialogs.length, 1);
  install([confirmBox({ sticky: true })]);
  assert.deepEqual((await call("press", { key: "Enter", dialog: true })).o, { ok: false, error: "the dialog is still open" });
});

test("press {dialog} never activates or raises the browser", async () => {
  const w = install([confirmBox()]);
  await call("press", { key: "Enter", dialog: true });
  assert.equal(Object.keys(w.counts).filter((k) => k.startsWith("activate(")).length, 0);
  assert.ok(w.state.axActions.every((a) => a.action === "AXPress"));
  assert.equal(w.log.filter((l) => l[0] === "activate").length, 0);
  assert.equal(w.counts["tab.execute"], undefined, "no page JS");
});

test("press {dialog} needs Accessibility", async () => {
  install([confirmBox()]);
  world.state.ax = false;
  const { r, t } = await call("press", { key: "Enter", dialog: true });
  assert.equal(r.isError, true);
  assert.match(t, /Accessibility permission required/);
});

test("press {dialog} validates its arguments before touching anything", async () => {
  const w = install([confirmBox()]);
  const bad = [
    [{ key: "Tab", dialog: true }, /Enter.*Escape/],
    [{ key: "Enter", dialog: "" }, /non-empty/],
    [{ key: "Enter", dialog: false }, /non-empty/],
    [{ key: "Enter", dialog: true, ref: "3" }, /no ref, selector or trusted/],
    [{ key: "Enter", dialog: true, selector: "#x" }, /no ref, selector or trusted/],
    [{ key: "Enter", dialog: true, trusted: true }, /no ref, selector or trusted/],
    [{ key: "Escape", dialog: "text" }, /Escape/],
  ];
  for (const [args, re] of bad) {
    const { r, t } = await call("press", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(t, re, JSON.stringify(args));
  }
  assert.equal(w.counts.AX, undefined);
});

// ---- the watchdog ----

const hung = () => {
  const f = fakeSpawner({ mode: "silent" });
  return { d: new OsaDaemon({ spawn: f.spawnFn }), f };
};
const OPEN = [{ app: CANARY, kind: "confirm", message: "Delete the draft?" }];

test("a call stuck behind a dialog fails with dialog_open in about 1.5s, not at the timeout", { timeout: 10000 }, async () => {
  const { d, f } = hung();
  DAEMONS.fast = d;
  const asked = [];
  deps.dialogs = async (app) => { asked.push(app); return OPEN; };
  const t0 = Date.now();
  const { r, t } = await call("eval_js", { script: "return 1", target: { tabId: "canary:5" } });
  const ms = Date.now() - t0;
  assert.equal(r.isError, true);
  assert.ok(t.startsWith('error: dialog_open: a confirm ("Delete the draft?") is open and pauses the page; answer it with press {key:"Enter"|"Escape", dialog:true}'), t);
  assert.ok(ms >= 1400 && ms < 3000, `${ms}ms`);
  assert.deepEqual(asked, [CANARY]);
  assert.equal(f.spawned[0].killed, true, "the hung REPL is killed");
});

test("the watchdog keeps probing every 2s and stays quiet while no dialog is open", { timeout: 10000 }, async () => {
  const { d } = hung();
  DAEMONS.slow = d;
  let n = 0;
  deps.dialogs = async (app) => { n++; assert.equal(app, null); return n >= 2 ? OPEN : []; };
  const t0 = Date.now();
  const { t } = await call("wait", { expression: "false", timeout: 20000 });
  const ms = Date.now() - t0;
  assert.match(t, /^error: dialog_open: a confirm/);
  assert.equal(n, 2);
  assert.ok(ms >= 3400 && ms < 5000, `${ms}ms`);
});

test("a fast call never probes for dialogs", async () => {
  install([confirmBox()]);
  let n = 0;
  deps.dialogs = async () => { n++; return OPEN; };
  const { o } = await call("eval_js", { script: "return 2" });
  assert.equal(o, 2);
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(n, 0);
});

test("without the daemon, a timeout is checked once and rewritten to dialog_open", async () => {
  DAEMONS.fast = undefined;
  deps.exec = async () => { throw Object.assign(new Error("killed"), { killed: true }); };
  let n = 0;
  deps.dialogs = async () => { n++; return OPEN; };
  const { t } = await call("eval_js", { script: "return 1", target: { tabId: "canary:5" } });
  assert.match(t, /^error: dialog_open: a confirm \("Delete the draft\?"\)/);
  assert.equal(n, 1);
  deps.dialogs = async () => [];
  assert.match((await call("eval_js", { script: "return 1" })).t, /^error: timeout:/);
});
