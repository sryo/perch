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

// Canary has two windows: window 1 (CGWindowID 400) shows a.test (tab 5) with
// c.test (tab 7) behind it, window 3 (410) shows www.d.test (tab 8). Chrome's
// window 2 (500) shows b.test. A dialog's `parent` is the window it is a child of.
let world;
function install(dialogs = [], { urls = {} } = {}) {
  world = makeWorld({
    browsers: [
      { name: CANARY, kind: "chrome", windows: [
        { id: 1, active: 0, tabs: [{ id: 5, url: urls[5] || "https://a.test/" }, { id: 7, url: "https://c.test/" }] },
        { id: 3, active: 0, x: 900, tabs: [{ id: 8, url: "https://www.d.test/x" }] },
      ] },
      { name: "Google Chrome", kind: "chrome", windows: [{ id: 2, active: 0, x: 1800, tabs: [{ id: 6, url: "https://b.test/" }] }] },
    ],
    cg: [
      { owner: "Terminal", pid: 1 },
      { owner: CANARY, pid: 40, wid: 400, x: 0, y: 0, w: 800, h: 700, ax: { web: [{ x: 0, y: 80, w: 800, h: 620 }] } },
      { owner: CANARY, pid: 40, wid: 410, x: 900, y: 0, w: 800, h: 600 },
      { owner: "Google Chrome", pid: 50, wid: 500, x: 1800, y: 0, w: 800, h: 600 },
    ],
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
const confirmBox = (extra = {}) => ({ pid: 40, parent: 400, texts: ["a.test says", "Delete the draft?"], buttons: ["Cancel", "OK"], ...extra });
const promptBox = (extra = {}) => ({ pid: 40, parent: 400, texts: ["a.test says", "Your name?"], buttons: ["Cancel", "OK"], field: "", ...extra });
const B = { x: 1075, y: 120, w: 450, h: 160 };
const dialogsOf = (target) => JSON.parse(world.run(`JSON.stringify(__perch.dialogs(${JSON.stringify({ target })}))`));
const A = { tabId: "canary:5" };

// ---- runtime: which dialogs belong to the target ----

test("dialogs() names kind and message of the target's own dialog, origin line dropped", () => {
  install([confirmBox()]);
  assert.deepEqual(dialogsOf(A), [{ kind: "confirm", message: "Delete the draft?" }]);
  install([{ pid: 40, parent: 400, texts: ["a.test says", "Saved"], buttons: ["OK"] }]);
  assert.deepEqual(dialogsOf(A), [{ kind: "alert", message: "Saved" }]);
  install([promptBox()]);
  assert.deepEqual(dialogsOf(A), [{ kind: "prompt", message: "Your name?" }]);
});

test("dialogs() with no target reads the default target, the topmost window's shown tab", () => {
  install([confirmBox()]);
  assert.deepEqual(dialogsOf(undefined), [{ kind: "confirm", message: "Delete the draft?" }]);
  install([confirmBox({ parent: 410, frame: B, texts: ["www.d.test says", "Hi"] })]);
  assert.deepEqual(dialogsOf(undefined), []);
});

test("a dialog in another window of the same browser is not the target's", () => {
  install([confirmBox({ parent: 410, frame: B, texts: ["www.d.test says", "Leave?"] })]);
  assert.deepEqual(dialogsOf(A), []);
  assert.deepEqual(dialogsOf({ tabId: "canary:8" }), [{ kind: "confirm", message: "Leave?" }]);
});

test("a dialog in another browser is not the target's", () => {
  install([{ pid: 50, parent: 500, frame: { x: 1975, y: 120, w: 450, h: 160 }, texts: ["b.test says", "Hi"], buttons: ["OK"] }]);
  assert.deepEqual(dialogsOf(A), []);
  assert.deepEqual(dialogsOf({ tabId: "chrome:6" }), [{ kind: "alert", message: "Hi" }]);
});

test("a dialog over the target's window is not the target's while its window shows another tab", () => {
  install([confirmBox({ texts: ["c.test says", "x"] })]);
  assert.deepEqual(dialogsOf({ tabId: "canary:7" }), []);
});

test("a dialog without a matching CG child entry, or with two, is not attributed", () => {
  install([confirmBox({ parent: undefined })]);
  assert.deepEqual(dialogsOf(A), [], "no CG entry");
  install([confirmBox({ cgFrame: { x: 175, y: 130, w: 450, h: 160 } })]);
  assert.deepEqual(dialogsOf(A), [], "CG frame 10px off");
  install([confirmBox({ cgFrame: { x: 178, y: 117, w: 452, h: 157 } })]);
  assert.equal(dialogsOf(A).length, 1, "within 4px");
  // Two identical children of window 400: the upper one's next entry is the other dialog.
  install([confirmBox(), confirmBox()]);
  assert.deepEqual(dialogsOf(A), []);
});

test("only the recorded alert/confirm/prompt shapes count; other shapes are never reported", () => {
  const shapes = {
    secure: promptBox({ secure: true }),
    twoFields: promptBox({ fields: 2 }),
    threeButtons: confirmBox({ buttons: ["Cancel", "Maybe", "OK"] }),
    noButtons: confirmBox({ buttons: [] }),
    noHeading: confirmBox({ noHeading: true }),
    oneButtonField: promptBox({ buttons: ["OK"] }),
  };
  for (const [name, d] of Object.entries(shapes)) {
    install([d]);
    assert.deepEqual(dialogsOf(A), [], name);
  }
});

test("dialogs() ignores a page's own role=dialog inside a browser window", () => {
  install([]);
  assert.deepEqual(dialogsOf(A), []);
});

test("dialogs() joins multi-line messages and caps them at 200 chars", () => {
  install([confirmBox({ texts: ["a.test says", "line one", "x".repeat(300)], buttons: ["OK"] })]);
  const [d] = dialogsOf(A);
  assert.equal(d.message.length, 200);
  assert.ok(d.message.startsWith("line one x"));
});

test("dialogs() returns [] without an Accessibility grant, and never prompts", () => {
  install([confirmBox()]);
  world.state.ax = false;
  assert.deepEqual(dialogsOf(A), []);
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
  const { o } = await call("press", { key: "Escape", dialog: true, target: A });
  assert.equal(o.ok, true);
  assert.equal(o.answer, "dismiss");
  assert.deepEqual(w.state.axActions.map((a) => a.title), ["Abbrechen"]);
});

test("press {dialog} Escape on an alert presses its only button", async () => {
  const w = install([confirmBox({ texts: ["a.test says", "Done"], buttons: ["OK"] })]);
  const { o } = await call("press", { key: "Escape", dialog: true, target: A });
  assert.equal(o.dialog, "alert");
  assert.deepEqual(w.state.axActions.map((a) => a.title), ["OK"]);
});

test("press {dialog: text} sets the prompt's field, then presses OK", async () => {
  const d = promptBox();
  install([d]);
  const { o } = await call("press", { key: "Enter", dialog: "Ada Lovelace", target: A });
  assert.deepEqual(o, { ok: true, dialog: "prompt", message: "Your name?", answer: "accept", text: "Ada Lovelace" });
  assert.equal(d.value, "Ada Lovelace");
  assert.equal(d.answer, "OK");
});

test("press {dialog: text} on a non-prompt presses nothing", async () => {
  const w = install([confirmBox()]);
  const { o } = await call("press", { key: "Enter", dialog: "hi", target: A });
  assert.equal(o.ok, false);
  assert.match(o.error, /not a prompt/);
  assert.deepEqual(w.state.axActions, []);
});

test("press {dialog} never answers the dialog of another tab, window or browser", async () => {
  const other = [
    confirmBox({ parent: 410, frame: B, texts: ["www.d.test says", "Leave?"] }),
    { pid: 50, parent: 500, frame: { x: 1975, y: 120, w: 450, h: 160 }, texts: ["b.test says", "Hi"], buttons: ["OK"] },
  ];
  const w = install(other.slice());
  assert.deepEqual((await call("press", { key: "Enter", dialog: true, target: A })).o, { ok: false, error: "no open alert/confirm/prompt on the target tab" });
  assert.deepEqual((await call("press", { key: "Enter", dialog: true })).o, { ok: false, error: "no open alert/confirm/prompt on the target tab" });
  install([confirmBox({ texts: ["c.test says", "x"] })]);
  assert.deepEqual((await call("press", { key: "Enter", dialog: true, target: { tabId: "canary:7" } })).o.error, "no open alert/confirm/prompt on the target tab");
  assert.deepEqual(w.state.axActions, []);
  assert.deepEqual(world.state.axActions, []);
});

test("press {dialog} refuses sign-in sheets and other shapes, and presses nothing", async () => {
  for (const d of [promptBox({ secure: true }), promptBox({ fields: 2 }), confirmBox({ buttons: ["A", "B", "C"] }), confirmBox({ noHeading: true })]) {
    const w = install([d]);
    const { o } = await call("press", { key: "Escape", dialog: true, target: A });
    assert.deepEqual(o, { ok: false, error: "the open dialog is not a page alert/confirm/prompt (sign-in, leave-page or permission prompt); perch does not answer it, hand it to the user" });
    assert.deepEqual(w.state.axActions, []);
    assert.equal(w.counts.AXSet, undefined);
  }
});

test("press {dialog} answers only a dialog whose origin line names the tab's host", async () => {
  let w = install([confirmBox({ texts: ["evil.test says", "Allow?"] })]);
  assert.deepEqual((await call("press", { key: "Enter", dialog: true, target: A })).o, { ok: false, error: "the dialog is from evil.test says, not this tab's origin a.test" });
  w = install([confirmBox({ texts: ["Leave site?", "Changes you made may not be saved."], buttons: ["Cancel", "Leave"] })]);
  assert.match((await call("press", { key: "Enter", dialog: true, target: A })).o.error, /^the dialog is from Leave site\?, not this tab's origin a\.test$/);
  // A look-alike host that merely contains the tab's host is not it.
  w = install([confirmBox({ texts: ["nota.test says", "x"] })]);
  assert.equal((await call("press", { key: "Enter", dialog: true, target: A })).o.ok, false);
  assert.deepEqual(w.state.axActions, []);
  // A leading www. is optional on either side, and case does not matter.
  install([confirmBox({ texts: ["WWW.A.TEST says", "x"] })]);
  assert.equal((await call("press", { key: "Enter", dialog: true, target: A })).o.ok, true);
  install([confirmBox({ parent: 410, frame: B, texts: ["d.test says", "x"] })]);
  assert.equal((await call("press", { key: "Enter", dialog: true, target: { tabId: "canary:8" } })).o.ok, true);
  install([confirmBox({ texts: ["a.test:8080 says", "x"] })], { urls: { 5: "http://a.test:8080/p" } });
  assert.equal((await call("press", { key: "Enter", dialog: true, target: A })).o.ok, true);
});

test("press {dialog} refuses on a page without a host", async () => {
  for (const url of ["about:blank", "data:text/html,x", "file:///tmp/x.html", "blob:https://a.test/1"]) {
    const w = install([confirmBox()], { urls: { 5: url } });
    assert.deepEqual((await call("press", { key: "Enter", dialog: true, target: A })).o, { ok: false, error: "cannot check the dialog's origin on a page without a host" }, url);
    assert.deepEqual(w.state.axActions, []);
  }
});

test("press {dialog} reports an identical dialog the page reopens as next, not 'still open'", async () => {
  install([confirmBox()]);
  world.state.onAxPress = () => world.state.dialogs.push(confirmBox());
  const { o } = await call("press", { key: "Enter", dialog: true, target: A });
  assert.deepEqual(o, { ok: true, dialog: "confirm", message: "Delete the draft?", answer: "accept", next: "confirm" });
});

test("press {dialog} reports a different next dialog", async () => {
  install([confirmBox()]);
  world.state.onAxPress = () => world.state.dialogs.push(promptBox());
  const { o } = await call("press", { key: "Escape", dialog: true, target: A });
  assert.deepEqual(o, { ok: true, dialog: "confirm", message: "Delete the draft?", answer: "dismiss", next: "prompt" });
});

test("press {dialog}: several attributed dialogs, and one that stays open", async () => {
  // A second AX dialog with the same frame and no CG entry of its own matches the same child.
  let w = install([confirmBox(), confirmBox({ parent: undefined })]);
  assert.deepEqual((await call("press", { key: "Enter", dialog: true, target: A })).o, { ok: false, error: "several dialogs open on the target tab" });
  assert.deepEqual(w.state.axActions, []);
  w = install([confirmBox({ sticky: true })]);
  assert.deepEqual((await call("press", { key: "Enter", dialog: true, target: A })).o, { ok: false, error: "the dialog is still open" });
});

test("press {dialog} never activates or raises the browser", async () => {
  const w = install([confirmBox()]);
  await call("press", { key: "Enter", dialog: true, target: A });
  assert.equal(Object.keys(w.counts).filter((k) => k.startsWith("activate(")).length, 0);
  assert.ok(w.state.axActions.every((a) => a.action === "AXPress"));
  assert.equal(w.log.filter((l) => l[0] === "activate").length, 0);
  assert.equal(w.counts["tab.execute"], undefined, "no page JS");
  assert.equal(w.counts["win.activeTabIndex="], undefined, "no tab selection");
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
const OPEN = [{ kind: "confirm", message: "Delete the draft?" }];

test("a call stuck behind a dialog fails with dialog_open in about 1.5s, not at the timeout", { timeout: 10000 }, async () => {
  const { d, f } = hung();
  DAEMONS.fast = d;
  const asked = [];
  deps.dialogs = async (target) => { asked.push(target); return OPEN; };
  const t0 = Date.now();
  const { r, t } = await call("eval_js", { script: "return 1", target: A });
  const ms = Date.now() - t0;
  assert.equal(r.isError, true);
  assert.ok(t.startsWith('error: dialog_open: a confirm ("Delete the draft?") is open and pauses the page; answer it with press {key:"Enter"|"Escape", dialog:true}'), t);
  assert.ok(ms >= 1400 && ms < 3000, `${ms}ms`);
  assert.deepEqual(asked, [A], "the probe asks about the call's own target");
  assert.equal(f.spawned[0].killed, true, "the hung REPL is killed");
});

test("the watchdog keeps probing every 2s and stays quiet while the target has no dialog", { timeout: 10000 }, async () => {
  const { d } = hung();
  DAEMONS.slow = d;
  let n = 0;
  deps.dialogs = async (target) => { n++; assert.deepEqual(target, {}); return n >= 2 ? OPEN : []; };
  const t0 = Date.now();
  const { t } = await call("wait", { expression: "false", timeout: 20000 });
  const ms = Date.now() - t0;
  assert.match(t, /^error: dialog_open: a confirm/);
  assert.equal(n, 2);
  assert.ok(ms >= 3400 && ms < 5000, `${ms}ms`);
});

test("probeDialogs asks the runtime about the target, and any failure is no hit", { timeout: 10000 }, async () => {
  const { d } = hung();
  DAEMONS.fast = d;
  deps.dialogs = saved.dialogs;
  const scripts = [];
  deps.exec = async (cmd, args) => {
    scripts.push(args[args.length - 1]);
    if (scripts.length === 1) throw new Error("osascript failed");
    return { stdout: JSON.stringify([{ kind: "alert", message: "hi" }]) + "\n" };
  };
  const { t } = await call("eval_js", { script: "return 1", target: A });
  assert.match(t, /^error: dialog_open: a alert \("hi"\)/);
  assert.equal(scripts.length, 2, "the failed probe was no hit; the next one found it");
  assert.ok(scripts[0].endsWith(`JSON.stringify(__perch.dialogs({"target":{"tabId":"canary:5"}}))`), scripts[0].slice(-120));
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
  const { t } = await call("eval_js", { script: "return 1", target: A });
  assert.match(t, /^error: dialog_open: a confirm \("Delete the draft\?"\)/);
  assert.equal(n, 1);
  deps.dialogs = async () => [];
  assert.match((await call("eval_js", { script: "return 1" })).t, /^error: timeout:/);
});
