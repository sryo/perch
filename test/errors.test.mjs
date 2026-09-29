// The error contract clients branch on: every failure is { isError: true } with one
// text block reading `error: <message>`, and the documented failures lead with a
// code (tab_not_visible, stale_tab, no_browser, window_offscreen, timeout).
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const chrome = (windows) => ({ name: "Google Chrome", kind: "chrome", windows });
const arc = (windows) => ({ name: "Arc", kind: "arc", windows });
const safari = (windows) => ({ name: "Safari", kind: "safari", windows });
const tabs = (n, p = "t") => Array.from({ length: n }, (_, i) => ({ url: `https://${p}${i}.test/`, title: `${p}${i}`, id: `${p}${i}` }));

function install(spec) {
  const world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}

async function fails(name, args, re) {
  const r = await handleCall(name, args);
  assert.equal(r.isError, true, `${name} should fail`);
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, "text");
  assert.match(r.content[0].text, re);
  return r.content[0].text;
}

const oneChrome = () => install({ browsers: [chrome([{ id: 1, active: 0, tabs: tabs(2) }])], cg: [{ owner: "Google Chrome" }] });

// ---- coded errors ----

test("tab_not_visible: Arc background tab", async () => {
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(2, "a") }])], cg: [{ owner: "Arc" }] });
  await fails("eval_js", { script: "return 1", target: { app: "Arc", tabIndex: 1 } }, /^error: tab_not_visible: /);
});

test("tab_not_visible: Safari page JS in a tab that isn't its window's current one, where Safari requires that", async () => {
  const world = install({ browsers: [safari([{ id: 3, active: 0, tabs: tabs(2, "s") }])], cg: [{ owner: "Safari" }] });
  world.state.safariCurrentOnly = true;
  await fails("eval_js", { script: "return 1", target: { app: "Safari", tabIndex: 1 } }, /^error: tab_not_visible: /);
  assert.equal(world.counts["doJavaScript"], 1);
});

test("stale_tab: unknown tabId, and tabIndex out of range in Chrome and Arc", async () => {
  oneChrome();
  await fails("eval_js", { script: "return 1", target: { tabId: "chrome:nope" } }, /^error: stale_tab: .*re-run list_tabs/);
  await fails("eval_js", { script: "return 1", target: { app: "Google Chrome", tabIndex: 9 } }, /^error: stale_tab: tabIndex 9 out of range; window has 2 tabs/);
  install({ browsers: [arc([{ id: "A", active: 0, tabs: tabs(2, "a") }])], cg: [{ owner: "Arc" }] });
  await fails("eval_js", { script: "return 1", target: { app: "Arc", tabIndex: 9 } }, /^error: stale_tab: tabIndex 9 out of range/);
});

test("no_browser: unknown, ambiguous, no window, and new_tab with nothing running", async () => {
  oneChrome();
  await fails("list_tabs", { app: "netscape" }, /^error: no_browser: unknown browser 'netscape'/);
  // "google" matches Chrome, Chrome Beta and Chrome Canary.
  await fails("eval_js", { script: "return 1", target: { app: "google" } }, /^error: no_browser: ambiguous browser 'google'/);
  install({ browsers: [chrome([])], cg: [] });
  await fails("eval_js", { script: "return 1" }, /^error: no_browser: no browser window with an open tab/);
  install({ browsers: [], cg: [] });
  await fails("new_tab", { url: "https://x.test/" }, /^error: no_browser: /);
});

test("window_offscreen: screenshot of a window with no on-screen CG entry never captures", async () => {
  const { deps } = await import("../server.js");
  const exec = deps.exec;
  let captured = 0;
  deps.exec = async () => { captured++; };
  try {
    install({ browsers: [chrome([{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: tabs(1) }])], cg: [{ owner: "Terminal", pid: 1, wid: 10 }] });
    await fails("screenshot", { target: { app: "Google Chrome", windowId: 1 } }, /^error: window_offscreen: /);
    assert.equal(captured, 0);
  } finally {
    deps.exec = exec;
  }
});

test("timeout: wait and eval_js awaitPromise", async () => {
  oneChrome();
  await fails("wait", { expression: "false", timeout: 500 }, /^error: timeout: wait timed out after 500ms/);
  await fails("eval_js", { script: "return new Promise(() => {})", awaitPromise: true }, /^error: timeout: eval_js \(awaitPromise\) timed out after 30000ms/);
  // A background tab throttles timers, so a page-side sleep can outlast the cap.
  await fails("eval_js", { script: "return new Promise(() => {})", awaitPromise: true }, /background tabs throttle timers/);
});

// ---- argument errors: rejected before any Apple Event ----

test("bad arguments fail with the tool's own message and send nothing to the browser", async () => {
  const world = oneChrome();
  const cases = [
    ["nope", {}, /^error: unknown tool: nope/],
    ["eval_js", {}, /^error: eval_js requires `script` or `script_path`/],
    ["console_capture", { mode: "pause" }, /^error: console_capture: unknown mode 'pause'/],
    ["click", {}, /^error: click requires `ref`, `selector`, or `label_pattern`/],
    ["click", { trusted: true }, /^error: click \{trusted:true\} requires `ref`, `selector`, `label_pattern`, or both `x` and `y`/],
    ["fill", { selector: "#a" }, /^error: fill requires `text` or `text_path`/],
    ["fill", { selector: "#a", text: "x", text_path: "/tmp/x" }, /^error: fill: pass `text` OR `text_path`, not both/],
    ["fill", { text: "x" }, /^error: fill requires `ref`, `selector`, or `label_pattern`/],
    ["fill", { label_pattern: "(", text: "x" }, /^error: fill: invalid label_pattern: /],
    ["select", { selector: "#a" }, /^error: select requires `text`/],
    ["select", { text: "x" }, /^error: select requires `ref`, `selector`, or `label_pattern`/],
    ["file_upload", { selector: "#a" }, /^error: file_upload requires `path`/],
  ];
  for (const [name, args, re] of cases) await fails(name, args, re);
  assert.equal(world.counts["tab.execute"] || 0, 0);
});

test("bad_url: navigate and new_tab take only absolute http(s) URLs and about:blank", async () => {
  const world = oneChrome();
  await fails("navigate", { url: "file:///etc/hosts" }, /^error: bad_url: navigate takes an absolute http\(s\) URL or about:blank; got file$/);
  await fails("new_tab", { url: "example.com" }, /^error: bad_url: new_tab takes .*; got no scheme; pass https:\/\/example\.com$/);
  assert.deepEqual(world.counts, {});
});

test("a path that can't be read names the resolved path", async () => {
  oneChrome();
  await fails("eval_js", { script_path: "/nonexistent/perch.js" }, /^error: cannot read \/nonexistent\/perch\.js: /);
  await fails("fill", { selector: "#a", text_path: "/nonexistent/body.txt" }, /^error: cannot read \/nonexistent\/body\.txt: /);
  await fails("file_upload", { selector: "#a", path: "/nonexistent/cv.pdf" }, /^error: cannot read \/nonexistent\/cv\.pdf: /);
});
