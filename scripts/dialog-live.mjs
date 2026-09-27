#!/usr/bin/env node
// Live check for native JS dialogs: a call stuck behind confirm() must fail with
// dialog_open in about 2s, and press {dialog} must answer confirm, prompt and
// alert through Accessibility without raising the window. With a second scratch
// window, a dialog there must neither abort nor be answered by calls on the first.
//   node scripts/dialog-live.mjs --yes [--app "Google Chrome Canary"]
// Needs an existing about:blank tab already active in its window (a background
// tab's dialog waits until the tab is shown); the two-window case needs one more,
// in another window, and is skipped without it. The script serves its own page on
// 127.0.0.1 (press {dialog} checks the dialog's origin against the tab's host, and
// about:blank has none) and loads it into those tabs, then puts them back on
// about:blank. It never creates, selects or closes tabs and never switches apps;
// without the tab it defers. The page's own dialogs bring the browser forward by
// themselves and take the keyboard (live, keys typed elsewhere landed in a
// prompt's field), so run it while nobody is typing; the front app and key
// process are recorded around every step.

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { connect, text, sameTab } from "./mcp-client.mjs";

const argv = process.argv.slice(2);
if (!argv.includes("--yes")) {
  console.error("dialog-live opens real alert/confirm/prompt dialogs in a scratch tab. Re-run with --yes to consent.");
  process.exit(2);
}
const app = argv.includes("--app") ? argv[argv.indexOf("--app") + 1] : "Google Chrome Canary";

const osa = (js) => execFileSync("osascript", ["-l", "JavaScript", "-e", js]).toString().trim();
const frontApp = () => osa("ObjC.import('CoreGraphics');const l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17,0)));" +
  "(l.find(w=>w.kCGWindowLayer===0&&w.kCGWindowBounds.Width>100)||{}).kCGWindowOwnerName||''");
const keyProcess = () => osa("ObjC.import('Foundation');ObjC.bindFunction('dlopen',['void *',['char *','int']]);" +
  "$.dlopen('/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight',2);" +
  "ObjC.bindFunction('_SLPSGetFrontProcess',['int',['void *']]);" +
  "const d=$.NSMutableData.dataWithLength(8);if($._SLPSGetFrontProcess(d.mutableBytes)!==0)throw Error('front process unavailable');ObjC.unwrap(d.description)");
const focus = () => ({ front: frontApp(), key: keyProcess() });

const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>perch dialog-live</title><p>perch dialog-live"); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const client = await connect({ timeoutMs: 40000 });
const call = async (name, args) => text(await client.call(name, args));
const json = async (name, args) => JSON.parse(await call(name, args));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
// After a failure a dialog may still be open, and every later step would queue
// another behind it, each one taking the keyboard when it shows. Stop instead.
async function step(label, fn) {
  if (failures) { console.log(`SKIP ${label}: an earlier step failed`); return; }
  const before = focus();
  let status = "PASS", detail = "";
  try { detail = (await fn()) || ""; } catch (e) { status = "FAIL"; detail = e.message; failures++; }
  const after = focus();
  const moved = before.front !== after.front || before.key !== after.key;
  console.log(`${status.padEnd(4)} ${label}${detail ? `: ${detail}` : ""}${moved ? ` [focus moved: ${before.front} -> ${after.front}]` : ""}`);
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

const loaded = [];
let deferred = false;
try {
  const tabs = (await json("list_tabs", { app, urlContains: "about:blank", limit: 50 })).tabs.filter((t) => t.active && t.url.startsWith("about:blank"));
  if (!tabs.length) {
    console.log(`DEFER no about:blank tab is active in a ${app} window; not creating or selecting one`);
    deferred = true;
  } else await run(tabs);
} finally {
  // Leave nothing open: dismiss a dialog a failed step left behind, then blank the page.
  for (const target of loaded) {
    await call("press", { key: "Escape", dialog: true, target }).catch(() => {});
    await call("navigate", { url: "about:blank", target }).catch(() => {});
  }
  console.log(`end ${JSON.stringify(focus())}`);
  client.close();
  server.close();
}
process.exit(deferred ? 3 : failures ? 1 : 0);

// Loads the served page into a scratch tab; returns the tab's current handle.
async function load(row, token) {
  const target = { tabId: row.tabId };
  loaded.push(target);
  const out = await json("navigate", { url: `${origin}/#${token}`, target });
  if (out.tabId) target.tabId = out.tabId;
  const mine = (await json("list_tabs", { app, urlContains: token })).tabs;
  expect(mine.length === 1 && sameTab(mine[0].tabId, target.tabId), `token ${token} did not single out the scratch tab`);
  return target;
}

async function run(rows) {
  const token = `perch-dialog-${Date.now()}`;
  const target = await load(rows[0], token);
  console.log(`scratch ${target.tabId} (${origin}/#${token}); start ${JSON.stringify(focus())}`);

  await step("confirm() blocking eval_js fails fast with dialog_open", async () => {
    const t0 = Date.now();
    const out = await call("eval_js", { script: "return confirm('perch dialog-live: confirm')", target });
    const ms = Date.now() - t0;
    expect(/^error: dialog_open: a confirm \("perch dialog-live: confirm"\)/.test(out), out);
    expect(ms < 5000, `took ${ms}ms`);
    return `${ms}ms`;
  });
  await step("press {Escape, dialog} dismisses the confirm", async () => {
    const o = await json("press", { key: "Escape", dialog: true, target });
    expect(o.ok && o.dialog === "confirm" && o.answer === "dismiss", JSON.stringify(o));
    return JSON.stringify(o);
  });
  await step("press {Enter, dialog:text} answers a prompt", async () => {
    await json("eval_js", { script: "setTimeout(() => { window.__pdl = prompt('perch dialog-live: name?') }, 0); return 1", target });
    await sleep(500);
    const o = await json("press", { key: "Enter", dialog: "perch-ok", target });
    expect(o.ok && o.dialog === "prompt" && o.text === "perch-ok", JSON.stringify(o));
    const got = await json("eval_js", { script: "return window.__pdl", target });
    expect(got === "perch-ok", `page read ${JSON.stringify(got)}`);
    return JSON.stringify(o);
  });
  await step("press {Enter, dialog} accepts an alert", async () => {
    await json("eval_js", { script: "setTimeout(() => alert('perch dialog-live: alert'), 0); return 1", target });
    await sleep(500);
    const o = await json("press", { key: "Enter", dialog: true, target });
    expect(o.ok && o.dialog === "alert" && o.answer === "accept", JSON.stringify(o));
    return JSON.stringify(o);
  });
  await step("an identical confirm reopened at once is reported as next", async () => {
    await json("eval_js", { script: "setTimeout(() => { confirm('perch dialog-live: again'); confirm('perch dialog-live: again') }, 0); return 1", target });
    await sleep(500);
    const o = await json("press", { key: "Escape", dialog: true, target });
    expect(o.ok && o.next === "confirm", JSON.stringify(o));
    const o2 = await json("press", { key: "Escape", dialog: true, target });
    expect(o2.ok && !o2.next, JSON.stringify(o2));
    return JSON.stringify(o);
  });
  await step("with no dialog open, press {dialog} says so", async () => {
    const o = await json("press", { key: "Enter", dialog: true, target });
    expect(!o.ok && o.error === "no open alert/confirm/prompt on the target tab", JSON.stringify(o));
  });

  // Each window shows one tab, so a second active row is in another window.
  const second = rows.find((r) => !sameTab(r.tabId, rows[0].tabId));
  if (!second) { console.log("SKIP two-window case: no about:blank tab active in a second window"); return; }
  const other = await load(second, `${token}-b`);
  await step("a dialog in another window neither aborts nor is answered by calls on this tab", async () => {
    await json("eval_js", { script: "setTimeout(() => confirm('perch dialog-live: other window'), 0); return 1", target: other });
    await sleep(500);
    const t0 = Date.now();
    const got = await json("eval_js", { script: "return 7", target });
    expect(got === 7, `eval_js on this tab read ${JSON.stringify(got)}`);
    const o = await json("press", { key: "Enter", dialog: true, target });
    expect(!o.ok && o.error === "no open alert/confirm/prompt on the target tab", JSON.stringify(o));
    const mine = await json("press", { key: "Escape", dialog: true, target: other });
    expect(mine.ok && mine.dialog === "confirm", JSON.stringify(mine));
    return `${Date.now() - t0}ms`;
  });
}
