#!/usr/bin/env node
// Live check for navigate on a raised Arc tab its window doesn't show, where no
// page JS runs and the load is followed through the tab's url and loading reads.
//   node scripts/navigate-live.mjs --yes --arc [--runs 5]
//   node scripts/navigate-live.mjs --yes --arc --background
// Serves on 127.0.0.1 a page answered after 20s, a 204 and a small download
// (saved to the Downloads folder by the browser), then navigates a scratch tab to
// each while a second process logs the tab's url and loading every 50ms. It
// checks that:
// - the delayed page ends in the coded timeout, not ok (Arc shows the pending url
//   while the old document still answers);
// - the 204 and the download end in load_failed;
// - how long Arc reads not loading after the set (the start lag that
//   ARC_START_GRACE in server.js has to cover), printed for each run.
// Needs an existing about:blank tab in Arc's front window that the window does
// not show, with Arc the front app. --background needs the same tab with another
// app in front: navigate without raise:true must be refused, and the front app,
// key process and cursor must not change. It never creates, selects or closes
// tabs and never switches apps; without the tab it defers.

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect, text } from "./mcp-client.mjs";

const argv = process.argv.slice(2);
if (!argv.includes("--yes")) {
  console.error("navigate-live loads pages into a scratch Arc tab and saves one small file to Downloads. Re-run with --yes to consent.");
  process.exit(2);
}
if (!argv.includes("--arc")) {
  console.error("navigate-live checks only Arc for now: pass --arc.");
  process.exit(2);
}
const app = "Arc";
const background = argv.includes("--background");
const runs = argv.includes("--runs") ? Math.max(1, Number(argv[argv.indexOf("--runs") + 1]) || 5) : 5;

const osa = (js) => execFileSync("osascript", ["-l", "JavaScript", "-e", js]).toString().trim();
const frontApp = () => osa("ObjC.import('CoreGraphics');const l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17,0)));" +
  "(l.find(w=>w.kCGWindowLayer===0&&w.kCGWindowBounds.Width>100)||{}).kCGWindowOwnerName||''");
const keyProcess = () => osa("ObjC.import('Foundation');ObjC.bindFunction('dlopen',['void *',['char *','int']]);" +
  "$.dlopen('/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight',2);" +
  "ObjC.bindFunction('_SLPSGetFrontProcess',['int',['void *']]);" +
  "const d=$.NSMutableData.dataWithLength(8);if($._SLPSGetFrontProcess(d.mutableBytes)!==0)throw Error('front process unavailable');ObjC.unwrap(d.description)");
const cursorAt = () => osa("ObjC.import('CoreGraphics');const p=$.CGEventGetLocation($.CGEventCreate($()));p.x+','+p.y");
const focus = () => ({ front: frontApp(), key: keyProcess(), cursor: cursorAt() });

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/slow") { const t = setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>slow</title>"); }, 20000); res.on("close", () => clearTimeout(t)); return; }
  if (path === "/nocontent") { res.writeHead(204); res.end(); return; }
  if (path === "/download") { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=perch-navigate-live.txt" }); res.end("perch navigate-live\n"); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>perch navigate-live</title><p>perch navigate-live");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const client = await connect({ timeoutMs: 40000 });
const call = async (name, args) => text(await client.call(name, args));
const parse = (s) => { try { return JSON.parse(s); } catch { return { raw: s }; } };

// Logs [ms since epoch, url, loading] for the tab every 50ms until killed.
function watch(rawId) {
  const js = `const a=Application('Arc');const id=${JSON.stringify(rawId)};` +
    "function row(){for(let i=0;i<a.windows.length;i++){try{const t=a.windows[i].tabs.byId(id);return [t.url(),t.loading()]}catch(e){}}return [null,null]}" +
    "for(;;){const r=row();console.log(JSON.stringify([Date.now(),r[0],r[1]]));delay(0.05)}";
  const p = spawn("osascript", ["-l", "JavaScript", "-e", js], { stdio: ["ignore", "ignore", "pipe"] });
  const rows = [];
  let buf = "";
  p.stderr.on("data", (c) => {
    buf += c.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); try { rows.push(JSON.parse(l)); } catch {} }
  });
  return { rows, stop: () => p.kill() };
}

// From the samples after `t0`: when loading first read true, when the url first
// moved off `pre`, and whether the asked url showed while loading.
function summarize(rows, t0, pre, asked) {
  const after = rows.filter((r) => r[0] >= t0);
  const busy = after.find((r) => r[2] === true), moved = after.find((r) => r[1] != null && r[1] !== pre);
  return {
    firstBusyMs: busy ? busy[0] - t0 : null,
    firstMovedMs: moved ? moved[0] - t0 : null,
    pendingShown: after.some((r) => r[2] === true && r[1] === asked),
    samples: after.length,
  };
}

let failures = 0;
const report = (ok, label, detail) => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`); };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

let target = null, deferred = false;
try {
  const rows = parse(await call("list_tabs", { app, urlContains: "about:blank", limit: 50 })).tabs || [];
  const row = rows.find((t) => !t.active && t.url.startsWith("about:blank"));
  if (!row) {
    console.log("DEFER no about:blank tab that its Arc window doesn't show; not creating or selecting one");
    deferred = true;
  } else if (background !== (frontApp() !== app)) {
    console.log(`DEFER ${background ? "--background needs another app in front of Arc" : "Arc must be the front app (or pass --background)"}; not switching apps`);
    deferred = true;
  } else {
    target = { tabId: row.tabId };
    await (background ? runBackground() : runRaised());
  }
} finally {
  if (target && !background) await call("navigate", { url: "about:blank", target }).catch(() => {});
  client.close();
  server.closeAllConnections();
  server.close();
}
process.exit(deferred ? 3 : failures ? 1 : 0);

async function runBackground() {
  const before = focus();
  const out = await call("navigate", { url: `${origin}/start`, target });
  const after = focus();
  report(/tab_not_visible/.test(out) && /raise:true/.test(out), "navigate without raise:true is refused", out);
  report(before.front === after.front && before.key === after.key, "front app and key process unchanged", `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  report(before.cursor === after.cursor, "cursor unchanged", `${before.cursor} -> ${after.cursor}`);
  const url = (parse(await call("list_tabs", { app, urlContains: "about:blank", limit: 50 })).tabs || []).some((t) => t.tabId === target.tabId);
  report(url, "the tab still shows about:blank");
}

// Navigates to `path` from the start page, logging the tab meanwhile.
async function attempt(path) {
  const start = parse(await call("navigate", { url: `${origin}/start`, target }));
  if (start.tabId) target.tabId = start.tabId;
  const pre = `${origin}/start`, asked = `${origin}${path}`;
  const w = watch(String(target.tabId).replace(/^arc:/, ""));
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  const out = parse(await call("navigate", { url: asked, target }));
  const ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 100));
  w.stop();
  return { out, ms, log: summarize(w.rows, t0, pre, asked) };
}

async function runRaised() {
  const before = focus();
  const slow = await attempt("/slow");
  report(slow.out.ok === false && /^timeout: .* had not committed/.test(slow.out.error || ""), "a page answered after 20s ends in the coded timeout", `${slow.ms}ms ${JSON.stringify(slow.out)} ${JSON.stringify(slow.log)}`);
  report(slow.log.pendingShown, "Arc shows the pending url while loading", JSON.stringify(slow.log));

  const lags = [], took = [];
  for (const [label, path, n] of [["204", "/nocontent", runs], ["download", "/download", 1]]) {
    for (let i = 0; i < n; i++) {
      const r = await attempt(path);
      report(r.out.ok === false && /^load_failed: the tab stayed on /.test(r.out.error || ""), `${label} run ${i + 1} ends in load_failed`, `${r.ms}ms ${JSON.stringify(r.out)} ${JSON.stringify(r.log)}`);
      if (r.log.firstBusyMs != null) lags.push(r.log.firstBusyMs);
      if (label === "204") took.push(r.ms);
    }
  }
  console.log(`INFO start lag (first loading read true after the call), ms: ${lags.length ? lags.join(", ") : "loading never read true"}; max ${lags.length ? Math.max(...lags) : "n/a"}`);
  console.log(`INFO navigate to a 204, ms: p50 ${pct(took, 50)} p95 ${pct(took, 95)} over ${took.length} runs`);
  const after = focus();
  console.log(`INFO focus ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
}
