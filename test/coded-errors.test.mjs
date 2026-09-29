// Raw AppleScript failures never reach a caller bare: a browser that quit, an
// Apple Event that timed out, an object that vanished or a denied permission each
// lead with a neutral code (or the permission wording), and keep the AppleScript
// error number as a short suffix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, ERR, handleCall, deps, jxa, formatOsaFailure } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const tabs = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://t${i}.test/`, title: `t${i}`, id: `t${i}` }));

function install() {
  const world = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: tabs(2) }] }], cg: [{ owner: "Google Chrome", pid: 100, wid: 1 }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}

const CALLS = [
  ["eval_js", { script: "return 1" }],
  ["click", { selector: "#go" }],
  ["list_tabs", {}],
  ["screenshot", {}],
];

async function text(name, args) {
  const r = await handleCall(name, args);
  assert.equal(r.isError, true, `${name} should fail`);
  return r.content[0].text;
}

const CASES = [
  [-600, "Application isn't running.", /^error: no_browser: .*\(AppleScript -600\)$/],
  [-609, "Connection is invalid.", /^error: no_browser: .*\(AppleScript -609\)$/],
  [-1712, "AppleEvent timed out.", /^error: timeout: .*\(AppleScript -1712\)$/],
  [-10000, "AppleEvent handler failed.", /^error: (stale_tab: .*re-run list_tabs|timeout: .*retry in a moment.*) \(AppleScript -10000\)$/],
  [-1708, "Message not understood.", /^error: (stale_tab: .*re-run list_tabs|timeout: .*retry in a moment.*) \(AppleScript -1708\)$/],
  [-1743, "Not authorized to send Apple events to Google Chrome.", null],
];

// A browser whose handler failed or didn't understand the event was never
// listed, so list_tabs answers a transient timeout (never stale_tab, which
// would send the caller back to list_tabs). A page call's own execute failing
// stays stale_tab; finding the tab failing is a transient timeout, since no tab
// matched to go stale.
const LISTED_RE = {
  "-10000": /^error: timeout: Google Chrome did not answer the tab listing .*\(AppleScript -10000\)$/,
  "-1708": /^error: timeout: Google Chrome did not answer the tab listing .*\(AppleScript -1708\)$/,
};

// A browser that quit has no tabs to list, so list_tabs lists none rather than failing.
const QUIT = new Set([-600, -609]);

for (const [errorNumber, message, re] of CASES) {
  test(`AppleScript ${errorNumber} leads with its code through eval_js, click, list_tabs and screenshot`, async () => {
    const exec = deps.exec;
    deps.exec = async () => ({ stdout: "" });
    try {
      for (const [name, args] of CALLS) {
        const world = install();
        world.state.aeFail = { errorNumber, message };
        if (name === "list_tabs" && QUIT.has(errorNumber)) {
          const r = await handleCall(name, args);
          assert.equal(r.isError, undefined);
          assert.deepEqual(JSON.parse(r.content[0].text), { tabs: [], total: 0 });
          continue;
        }
        const t = await text(name, args);
        if (LISTED_RE[errorNumber] && name === "list_tabs") assert.match(t, LISTED_RE[errorNumber], `${name}: ${t}`);
        else if (re) assert.match(t, re, `${name}: ${t}`);
        else assert.equal(t, `error: ${ERR.automation}`, name);
        assert.doesNotMatch(t, new RegExp("^error: " + message.replace(/[.]/g, "\\.")), name);
      }
    } finally {
      deps.exec = exec;
    }
  });
}

test("an object gone mid-call (-1728) leads with a code through eval_js, click and screenshot", async () => {
  const exec = deps.exec;
  deps.exec = async () => ({ stdout: "" });
  try {
    for (const [name, args] of CALLS.filter(([n]) => n !== "list_tabs")) {
      const world = install();
      world.state.aeFail = { errorNumber: -1728, message: "Can't get object." };
      assert.match(await text(name, args), /^error: (stale_tab|no_browser): /, name);
    }
  } finally {
    deps.exec = exec;
  }
});

test("list_tabs: a browser it couldn't read is a warning beside the others' tabs", async () => {
  const world = makeWorld({
    browsers: [
      { name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: tabs(2) }] },
      { name: "Safari", kind: "safari", windows: [{ id: 3, active: 0, tabs: [{ url: "https://s.test/", title: "s" }] }] },
    ],
    cg: [{ owner: "Google Chrome", pid: 100, wid: 1 }, { owner: "Safari", pid: 200, wid: 3 }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = DAEMONS.slow = world.daemon;
  world.state.aeFail = { errorNumber: -1743, message: "Not authorized to send Apple events to Safari.", app: "Safari" };
  const out = JSON.parse((await handleCall("list_tabs", {})).content[0].text);
  assert.equal(out.tabs.length, 2);
  assert.ok(out.tabs.every((t) => t.app === "Google Chrome"));
  assert.match(out.warning, /^Safari not listed: Automation permission denied/);
  // Alone, the same browser fails the call: an empty list would claim it has no tabs.
  assert.match(await text("list_tabs", { app: "Safari" }), /^error: Automation permission denied/);
});

test("list_tabs never answers stale_tab, alone or as a warning beside another browser's tabs", async () => {
  for (const errorNumber of [-10000, -1708]) {
    const world = makeWorld({
      browsers: [
        { name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: tabs(2) }] },
        { name: "Safari", kind: "safari", windows: [{ id: 3, active: 0, tabs: [{ url: "https://s.test/", title: "s" }] }] },
      ],
      cg: [{ owner: "Google Chrome", pid: 100, wid: 1 }, { owner: "Safari", pid: 200, wid: 3 }],
    });
    world.run(JXA_PRELUDE);
    DAEMONS.fast = DAEMONS.slow = world.daemon;
    // Only the bulk reads fail: the per-window walk that follows finds nothing either.
    world.state.aeFail = { errorNumber, message: "AppleEvent handler failed.", app: "Safari" };
    const out = JSON.parse((await handleCall("list_tabs", {})).content[0].text);
    assert.equal(out.tabs.length, 2);
    assert.match(out.warning, new RegExp(`^Safari not listed: timeout: Safari did not answer the tab listing .*\\(AppleScript ${errorNumber}\\)$`));
    const alone = await text("list_tabs", { app: "Safari" });
    assert.match(alone, /^error: timeout: /);
    assert.doesNotMatch(alone, /stale_tab|re-run list_tabs/);
  }
});

test("a default target no readable browser matched is a timeout naming the one that didn't answer", async () => {
  for (const errorNumber of [-10000, -1708]) {
    const world = install();
    world.state.aeFail = { errorNumber, message: "AppleEvent handler failed.", key: /^(tab\.id|tabs\.|windows)/ };
    const t = await text("click", { selector: "#go", target: { app: "Google Chrome" } });
    assert.match(t, new RegExp(`^error: timeout: .*Google Chrome did not answer .*\\(AppleScript ${errorNumber}\\)$`), t);
  }
});

test("a lane that died or was killed mid-call is a timeout that says the call may have run", async () => {
  for (const [name, args] of CALLS) {
    install();
    DAEMONS.fast = DAEMONS.slow = { run: async () => { throw new Error("osascript exited mid-call"); } };
    const t = await text(name, args);
    assert.match(t, /^error: timeout: .*osascript exited mid-call.*may have run/, name);
  }
  for (const [name, args] of CALLS) {
    install();
    DAEMONS.fast = DAEMONS.slow = { run: async () => { throw new Error(ERR.timeout(30000)); } };
    assert.match(await text(name, args), /^error: timeout: /, name);
  }
});

test("a raw Apple Event timeout counts as a hang, so the dialog probe runs", async () => {
  const world = install();
  world.state.aeFail = { errorNumber: -1712, message: "AppleEvent timed out.", key: /execute/ };
  const probe = deps.dialogs;
  let probed = 0;
  deps.dialogs = async () => { probed++; return []; };
  try {
    assert.match(await text("eval_js", { script: "return 1" }), /^error: timeout: /);
  } finally {
    deps.dialogs = probe;
  }
  assert.ok(probed >= 1);
});

test("one-shot failures map the same way and keep the number", async () => {
  assert.match(formatOsaFailure({ stderr: "execution error: Error: Application isn't running. (-600)" }, 1), /^no_browser: .*\(AppleScript -600\)$/);
  assert.match(formatOsaFailure({ stderr: "execution error: Error: AppleEvent timed out. (-1712)" }, 1), /^timeout: .*\(AppleScript -1712\)$/);
  assert.match(formatOsaFailure({ stderr: "execution error: Error: Can't get object. (-1728)" }, 1), /^stale_tab: .*\(AppleScript -1728\)$/);
  // A script's own throw (-2700) is not an Apple Event failure: its message stands.
  assert.equal(formatOsaFailure({ stderr: "execution error: Error: stale_tab: tab c1 is gone; re-run list_tabs (-2700)" }, 1), "stale_tab: tab c1 is gone; re-run list_tabs");
  // Without a number, the wording alone still maps.
  const via = (message) => jxa("1", { daemons: { fast: { run: async () => { throw new Error(message); } } } });
  await assert.rejects(via("Application isn't running."), (e) => /^no_browser: .*\(AppleScript -600\)$/.test(e.message));
  await assert.rejects(via("Connection is invalid."), (e) => /^no_browser: .*\(AppleScript -609\)$/.test(e.message));
});

test("an error number the map doesn't know keeps its message and its number", async () => {
  await assert.rejects(jxa("1", { daemons: { fast: { run: async () => { throw new Error("Something odd. (-2753)"); } } } }), (e) => e.message === "Something odd. (AppleScript -2753)");
});
