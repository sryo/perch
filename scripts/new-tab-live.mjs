#!/usr/bin/env node
// Live check that new_tab takes no focus: one new_tab {about:blank} into Canary with
// another app in front, under frontGuard. new_tab on Chromium needs the user's focus
// grant (it raised the window live), which this client can't be asked for, so this
// checks it is refused. It
// records the front app's pid and every Canary window's minimized state before and
// after, so a raise or a restored window fails it, then closes only the tab it made. It never opens a window, minimizes or
// restores one, or activates an app; the user's windows are read, not changed.
//   node scripts/new-tab-live.mjs --yes
// Expect: front pid unchanged; minimized states unchanged; the tab in the first
// window that isn't minimized; no_browser (and nothing made) if every window is.
//   node scripts/new-tab-live.mjs --yes --loft
// With the loft up (loft up) and Safari running: new_tab {loft:true} in Safari,
// which needs no focus grant. Expect: front pid unchanged; one new Safari window,
// inside the loft's bounds; its page visible; an untargeted eval_js not reaching
// it; close_tab on its only tab closing the window, with no window left behind.
// The last line is the number of failed checks.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { connect, text, ROOT } from "./mcp-client.mjs";
import { frontGuard } from "./bench.mjs";

if (!process.argv.includes("--yes")) {
  console.error("new-tab-live makes one tab in Canary (or with --loft one Safari window on the loft) and closes it; pass --yes to run it");
  process.exit(2);
}
const jxa = (src) => execFileSync("osascript", ["-l", "JavaScript", "-e", src], { encoding: "utf8" }).trim();
const frontPid = () => Number(jxa(`ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier`));
if (process.argv.includes("--loft")) process.exit(await loftCheck());

async function loftCheck() {
  let st = null;
  try { st = JSON.parse(execFileSync("loft", ["status", "--json"], { encoding: "utf8" })); } catch {}
  if (!st || !st.up) { console.error("the loft is down; run loft up first"); return 2; }
  const B = st.bounds;
  const windows = () => JSON.parse(jxa(`const a = Application("Safari"); JSON.stringify(a.running() ? a.windows().map((w) => [w.id(), w.bounds()]) : null)`));
  const before = windows();
  if (!before) { console.error("Safari isn't running; new_tab never launches it"); return 2; }
  const url = `file://${join(ROOT, "bench", "fixture.html")}#loft`;
  const client = await connect({ timeoutMs: 60000, env: { ...process.env, PERCH_AWAKE: "0" } });
  const guard = frontGuard(frontPid);
  let failed = 0, made = null;
  const check = (ok, what) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${what}`); };
  try {
    const r = await guard.step("new_tab loft", () => client.call("new_tab", { app: "Safari", url, loft: true }).then((res) => {
      try { if (!res.isError) made = JSON.parse(text(res)).tabId; } catch {}
      return res;
    }));
    check(!r.isError && !/warning/.test(text(r)), `new_tab {loft:true}, front app unchanged: ${text(r)}`);
    if (made) {
      const mine = windows().filter(([id]) => !before.some(([b]) => b === id));
      const c = mine.length === 1 && { x: mine[0][1].x + mine[0][1].width / 2, y: mine[0][1].y + mine[0][1].height / 2 };
      check(c && c.x >= B.x && c.x < B.x + B.w && c.y >= B.y && c.y < B.y + B.h, `one new window, on the loft: ${JSON.stringify(mine)} in ${JSON.stringify(B)}`);
      const v = await guard.step("eval_js", () => client.call("eval_js", { target: { tabId: made }, script: "return document.visibilityState" }));
      check(text(v) === "visible", `its page is visible: ${text(v)}`);
      const u = await guard.step("untargeted eval_js", () => client.call("eval_js", { script: "return location.href" }));
      check(text(u) !== url, `an untargeted call skips it: ${text(u)}`);
      const x = await guard.step("close_tab", () => client.call("close_tab", { tabId: made }));
      let xo = {}; try { xo = JSON.parse(text(x)); } catch {}
      if (xo.ok) made = null;
      check(xo.ok && xo.window === true, `close_tab closed the window: ${text(x)}`);
      check(windows().length === before.length, "no window left behind");
    }
  } catch (e) {
    failed++;
    console.log(`FAIL ${e.message}`);
  } finally {
    if (made) await client.call("close_tab", { tabId: made }).catch((e) => console.error(`could not close ${made}: ${e.message}`));
    client.close();
  }
  console.log(failed);
  return failed ? 1 : 0;
}
const minimized = () => JSON.parse(jxa(`const a = Application("Google Chrome Canary"); JSON.stringify(a.running() ? a.windows().map((w) => [w.id(), w.minimized()]) : null)`));

const before = minimized();
if (!before) { console.error("Canary isn't running; new_tab never launches it, so there is nothing to check"); process.exit(2); }
const client = await connect({ timeoutMs: 60000, env: { ...process.env, PERCH_AWAKE: "0" } });
let made = null, failed = 0;
try {
  // The tab is noted as soon as it exists, so a raise that trips the guard still has it closed.
  const r = await frontGuard(frontPid).step("new_tab about:blank", () => client.call("new_tab", { app: "canary", url: "about:blank" }).then((res) => {
    try { if (!res.isError) made = JSON.parse(text(res)).tabId; } catch {}
    return res;
  }));
  const out = text(r);
  const after = minimized();
  const same = JSON.stringify(after) === JSON.stringify(before);
  if (!same) failed++;
  console.log(`${same ? "PASS" : "FAIL"} minimized states ${same ? "unchanged" : `changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`}`);
  if (r.isError) {
    // No grant: refused, nothing made. All windows minimized: no_browser, nothing restored.
    const ok = /^error: needs_focus: /.test(out) || (before.every(([, m]) => m) && /no_browser: every .* window is minimized/.test(out));
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} new_tab answered: ${out}`);
  } else {
    console.log(`PASS front app unchanged; made ${made}`);
  }
} catch (e) {
  failed++;
  console.log(`FAIL ${e.message}`);
} finally {
  if (made) await client.call("close_tab", { tabId: made }).catch((e) => console.error(`could not close ${made}: ${e.message}`));
  client.close();
}
process.exit(failed ? 1 : 0);
