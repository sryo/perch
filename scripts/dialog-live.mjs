#!/usr/bin/env node
// Live check for native JS dialogs: a call stuck behind confirm() must fail with
// dialog_open in about 2s, and press {dialog} must answer confirm, prompt and
// alert through Accessibility without raising the window.
//   node scripts/dialog-live.mjs --yes [--app "Google Chrome Canary"]
// Needs an existing about:blank tab already active in its window (a background
// tab's dialog waits until the tab is shown). It never creates, selects or closes
// tabs and never switches apps; without that tab it defers. The page's own
// confirm() may bring the browser forward by itself; the front app and key
// process are recorded around every dialog step so that shows up.

import { execFileSync } from "node:child_process";
import { connect, text } from "./mcp-client.mjs";

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

const client = await connect({ timeoutMs: 40000 });
const call = async (name, args) => text(await client.call(name, args));
const json = async (name, args) => JSON.parse(await call(name, args));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
async function step(label, fn) {
  const before = focus();
  let status = "PASS", detail = "";
  try { detail = (await fn()) || ""; } catch (e) { status = "FAIL"; detail = e.message; failures++; }
  const after = focus();
  const moved = before.front !== after.front || before.key !== after.key;
  console.log(`${status.padEnd(4)} ${label}${detail ? `: ${detail}` : ""}${moved ? ` [focus moved: ${before.front} -> ${after.front}]` : ""}`);
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

let target = null, deferred = false;
try {
  const tabs = (await json("list_tabs", { app, urlContains: "about:blank", limit: 50 })).tabs;
  const row = tabs.find((t) => t.active && t.url.startsWith("about:blank"));
  if (!row) {
    console.log(`DEFER no about:blank tab is active in a ${app} window; not creating or selecting one`);
    deferred = true;
  } else await run(row);
} finally {
  if (target) {
    // Leave nothing open: dismiss a dialog a failed step left behind, then blank the page.
    await call("press", { key: "Escape", dialog: true, target }).catch(() => {});
    await call("eval_js", { script: "document.body.innerHTML = ''; history.replaceState(null, '', 'about:blank'); return 1", target }).catch(() => {});
  }
  console.log(`end ${JSON.stringify(focus())}`);
  client.close();
}
process.exit(deferred ? 3 : failures ? 1 : 0);

async function run(row) {
  target = { tabId: row.tabId };
  const token = `perch-dialog-${Date.now()}`;
  await json("eval_js", { script: `location.hash = ${JSON.stringify(token)}; return 1`, target });
  const mine = (await json("list_tabs", { app, urlContains: token })).tabs;
  expect(mine.length === 1 && mine[0].tabId === row.tabId, `token ${token} did not single out the scratch tab`);
  console.log(`scratch ${row.tabId} (${token}); start ${JSON.stringify(focus())}`);

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
  await step("with no dialog open, press {dialog} says so", async () => {
    const o = await json("press", { key: "Enter", dialog: true, target });
    expect(!o.ok && o.error === "no open dialog", JSON.stringify(o));
  });
}
