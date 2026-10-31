#!/usr/bin/env node
// Live check that new_tab takes no focus: one new_tab {about:blank} into Canary with
// another app in front, under frontGuard. It records the front app's pid and every
// Canary window's minimized state before and after, so a raise or a restored window
// fails it, then closes only the tab it made. It never opens a window, minimizes or
// restores one, or activates an app; the user's windows are read, not changed.
//   node scripts/new-tab-live.mjs --yes
// Expect: front pid unchanged; minimized states unchanged; the tab in the first
// window that isn't minimized; no_browser (and nothing made) if every window is.

import { execFileSync } from "node:child_process";
import { connect, text } from "./mcp-client.mjs";
import { frontGuard } from "./bench.mjs";

if (!process.argv.includes("--yes")) {
  console.error("new-tab-live makes one tab in Canary and closes it; pass --yes to run it");
  process.exit(2);
}
const jxa = (src) => execFileSync("osascript", ["-l", "JavaScript", "-e", src], { encoding: "utf8" }).trim();
const frontPid = () => Number(jxa(`ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier`));
const minimized = () => JSON.parse(jxa(`const a = Application("Google Chrome Canary"); JSON.stringify(a.running() ? a.windows().map((w) => [w.id(), w.minimized()]) : null)`));

const before = minimized();
if (!before) { console.error("Canary isn't running; new_tab never launches it, so there is nothing to check"); process.exit(2); }
const client = await connect({ timeoutMs: 60000, env: { ...process.env, PERCH_AWAKE: "0" } });
let made = null, failed = 0;
try {
  const r = await frontGuard(frontPid).step("new_tab about:blank", () => client.call("new_tab", { app: "canary", url: "about:blank" }));
  const out = text(r);
  const after = minimized();
  const same = JSON.stringify(after) === JSON.stringify(before);
  if (!same) failed++;
  console.log(`${same ? "PASS" : "FAIL"} minimized states ${same ? "unchanged" : `changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`}`);
  if (r.isError) {
    const allMin = before.every(([, m]) => m);
    if (!(allMin && /no_browser: every .* window is minimized/.test(out))) failed++;
    console.log(`${allMin && /no_browser/.test(out) ? "PASS" : "FAIL"} new_tab answered: ${out}`);
  } else {
    made = JSON.parse(out).tabId;
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
