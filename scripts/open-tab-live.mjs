#!/usr/bin/env node
// Live check for a tab that opens without taking focus: a page's own window.open,
// fired by a trusted background click (SkyLight, no raise). The scratch tab the user
// names (--tab) must be its window's shown tab, in a window they aren't working in,
// on screen behind another app. It is navigated to a 127.0.0.1 page with one button
// that calls window.open("about:blank"), clicked without raise under frontGuard, and
// navigated back to where it was. The opened tab, if any, is closed. Nothing else is
// touched: no window is made, raised, minimized or restored.
//   node scripts/open-tab-live.mjs --yes --tab canary:<id>
// Prints: whether the click landed, whether a tab opened, and whether the front
// app's pid and every window's minimized state stayed the same.

import { execFileSync } from "node:child_process";
import { connect, text } from "./mcp-client.mjs";
import { frontGuard, serveFixture } from "./bench.mjs";

const argv = process.argv.slice(2);
const tabArg = argv.includes("--tab") ? argv[argv.indexOf("--tab") + 1] : null;
if (!argv.includes("--yes") || !tabArg) {
  console.error("open-tab-live clicks one button on a scratch tab you name; run it as: node scripts/open-tab-live.mjs --yes --tab <tabId>");
  process.exit(2);
}
const APP = { canary: "Google Chrome Canary", chrome: "Google Chrome", arc: "Arc", safari: "Safari" }[tabArg.split(":")[0]];
if (!APP) { console.error(`unknown browser in ${tabArg}`); process.exit(2); }
const jxa = (src) => execFileSync("osascript", ["-l", "JavaScript", "-e", src], { encoding: "utf8" }).trim();
const frontPid = () => Number(jxa(`ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier`));
const prop = APP === "Safari" ? "miniaturized" : "minimized";
const windows = () => JSON.parse(jxa(`const a = Application(${JSON.stringify(APP)}); JSON.stringify(a.windows().map((w) => [w.id(), w.${prop}(), w.tabs.length]))`));

const server = await serveFixture(`<!doctype html><title>open-tab-live</title>
<button id=open style="position:absolute;left:40px;top:40px;width:240px;height:80px" onclick="window.__opened = !!window.open('about:blank', '_blank')">open</button>`);
const client = await connect({ timeoutMs: 60000, env: { ...process.env, PERCH_AWAKE: "0" } });
const call = async (name, args) => { const r = await client.call(name, args); const t = text(r); let o = t; try { o = JSON.parse(t); } catch {} return { r, o, t }; };
const guard = frontGuard(frontPid);
let target = { tabId: tabArg }, home = null, opened = [], failed = 0;
try {
  const rows = (await call("list_tabs", { limit: 10000 })).o.tabs;
  const row = rows.find((t) => t.tabId === tabArg);
  if (!row) throw new Error(`${tabArg} not found; re-run list_tabs`);
  if (!row.active) throw new Error(`${tabArg} isn't its window's shown tab; a background click needs the shown tab`);
  home = row.url;
  const before = windows(), beforeIds = new Set(rows.map((t) => t.tabId));
  const nav = await guard.step("navigate to the scratch page", () => call("navigate", { url: server.url, target }));
  if (nav.o && nav.o.tabId) target = { tabId: nav.o.tabId };
  const click = await guard.step("trusted background click on window.open", () => call("click", { selector: "#open", trusted: true, target }));
  console.log(`${click.o && click.o.ok ? "PASS" : "FAIL"} the click landed: ${click.t}`);
  if (!(click.o && click.o.ok)) failed++;
  const after = await call("list_tabs", { limit: 10000 });
  opened = after.o.tabs.filter((t) => !beforeIds.has(t.tabId) && t.tabId !== target.tabId).map((t) => t.tabId);
  console.log(`${opened.length === 1 ? "PASS" : "INFO"} tabs opened: ${opened.length}`);
  const same = JSON.stringify(windows().map(([id, m]) => [id, m])) === JSON.stringify(before.map(([id, m]) => [id, m]));
  if (!same) failed++;
  console.log(`${same ? "PASS" : "FAIL"} minimized states ${same ? "unchanged" : "changed"}; front app unchanged (the guard passed)`);
} catch (e) {
  failed++;
  console.log(`FAIL ${e.message}`);
} finally {
  for (const tabId of opened) await call("close_tab", { tabId }).catch((e) => console.error(`could not close ${tabId}: ${e.message}`));
  if (home && /^(https?:|about:blank)/.test(home)) await call("navigate", { url: home, target }).catch((e) => console.error(`could not restore ${target.tabId}: ${e.message}`));
  client.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
