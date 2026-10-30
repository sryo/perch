#!/usr/bin/env node
// Live comparison of perch versions: the same calls, on the same local page,
// through each version's own server.js, run from a detached worktree so main's
// checkout is never touched.
//   node scripts/versions.mjs [--refs c4010f4,6b0d9cf,main] [--reps 10] [--out bench/runs/versions.json]
//                             [--baseline bench/versions-baseline.json [--against <ref>]]
// It opens one scratch Chrome Canary window of its own (Canary may come to the
// front while it opens), with bench/versions-fixture.html served on 127.0.0.1
// in a shown tab and a background tab, runs every version there, minimizes
// that window for the minimized-window calls, and closes it at the end. Trusted
// calls post real input to that window only. With --baseline it prints each
// call's flags (slower, bigger, fails, missing) against that baseline's
// --against version (default its last), and exits 1 when any are raised.
// --offline runs no browser: it records main's behaviour-lock scenarios
// (test/lock) against each version's server.js in the fake world and prints
// per-tool Apple Events, result bytes and failed steps, plus each step that
// costs more events or newly fails against the first --refs entry.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { serveFixture } from "./bench.mjs";
import { stats, compareRuns, lockSteps, lockTotals, lockDiff } from "./versions-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "Google Chrome Canary", KEY = "canary";
const arg = (k, d) => { const i = process.argv.lastIndexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const REFS = arg("--refs", "c4010f4,main").split(","), REPS = Number(arg("--reps", 10));
const OUT = arg("--out", "bench/runs/versions.json"), BASELINE = arg("--baseline"), AGAINST = arg("--against");
const OFFLINE = process.argv.includes("--offline");

const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).trim();
const jxa = (src) => execFileSync("osascript", ["-l", "JavaScript", "-e", src], { encoding: "utf8" }).trim();

// A detached worktree per ref, sharing main's node_modules.
function tree(ref) {
  const sha = git("rev-parse", "--short", ref), dir = join(tmpdir(), `perch-versions-${sha}`);
  if (!existsSync(join(dir, "server.js"))) {
    git("worktree", "add", "-f", "--detach", dir, sha);
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  }
  return { ref, sha, dir };
}

// One scratch window: tab 1 shown, tab 2 behind it, both on the fixture.
function openWindow(url) {
  const r = JSON.parse(jxa(`const a = Application(${JSON.stringify(APP)});
    const w = a.Window().make(); w.bounds = { x: 40, y: 60, width: 900, height: 760 };
    w.activeTab.url = ${JSON.stringify(url)};
    const t2 = a.Tab({ url: ${JSON.stringify(url + "#bg")} }); w.tabs.push(t2);
    w.activeTabIndex = 1; delay(1.5);
    JSON.stringify({ win: w.id(), shown: w.tabs[0].id(), bg: w.tabs[1].id() });`));
  return { win: r.win, shown: `${KEY}:${r.shown}`, bg: `${KEY}:${r.bg}` };
}
// The scratch window, found by its shown tab: a window's id can change under it.
const winOf = (tabId) => `Application(${JSON.stringify(APP)}).windows().find((w) => w.tabs.id().map(String).includes(${JSON.stringify(String(tabId).split(":")[1])}))`;
const minimize = (W, on) => jxa(`const w = ${winOf(W.shown)}; if (!w) throw new Error("scratch window gone"); w.minimized = ${on}; delay(${on ? 1 : 1.5}); "ok"`);
const screenLocked = () => { try { return JSON.parse(jxa(`ObjC.import("CoreGraphics"); JSON.stringify(!!ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary())).CGSSessionScreenIsLocked)`)); } catch { return null; } };
const closeWindow = (W) => { try { jxa(`const w = ${winOf(W.shown)}; if (w) w.close(); "ok"`); } catch {} };

// A result's size as the caller gets it: text characters plus image base64.
const size = (r) => (r.content || []).reduce((n, c) => n + (c.type === "image" ? c.data.length : c.text.length), 0);
const failed = (r) => {
  if (r.isError) return r.content?.[0]?.text || "error";
  try { const o = JSON.parse(r.content[0].text); if (o && o.ok === false) return o.error || "ok:false"; } catch {}
  return null;
};

async function rep(client, name, args) {
  const s = performance.now();
  let r;
  try { r = await client.rpc("tools/call", { name, arguments: args }).then((m) => m.result); }
  catch (e) { return { ms: performance.now() - s, bytes: 0, ok: false, error: String(e.message) }; }
  const ms = performance.now() - s, error = failed(r);
  // A screenshot's pixel size: images cost tokens by area, not by their bytes.
  let image;
  if (r.content?.[0]?.type === "image") { try { image = JSON.parse(r.content[1].text).image; } catch {} }
  return { ms, bytes: size(r), ok: !error, ...(error ? { error: error.slice(0, 200) } : {}), ...(image ? { image } : {}) };
}

// The workload: [name, tool, args, reps]. S is the shown tab, B the background one.
function workload(W, upload) {
  const S = { tabId: W.shown }, B = { tabId: W.bg };
  const calls = [
    ["list_tabs", "list_tabs", { urlContains: "127.0.0.1", limit: 5 }],
    ["list_tabs arc", "list_tabs", { app: "arc", limit: 3 }],
  ];
  for (const [tag, target] of [["shown", S], ["bg", B]]) {
    calls.push(
      [`eval_js ${tag}`, "eval_js", { script: "return document.title", target }],
      [`eval_js await ${tag}`, "eval_js", { script: "await Promise.resolve(); return 2", awaitPromise: true, target }],
      [`eval_js main ${tag}`, "eval_js", { script: "return location.pathname", world: "main", target }],
      [`eval_js main await ${tag}`, "eval_js", { script: "await Promise.resolve(); return 3", world: "main", awaitPromise: true, target }],
      [`eval_js main await long ${tag}`, "eval_js", { script: "await Promise.resolve(); return 4", world: "main", awaitPromise: true, timeout: 60000, target }],
      [`accessibility_snapshot ${tag}`, "accessibility_snapshot", { target }],
      [`get_text ${tag}`, "get_text", { maxChars: 2000, target }],
      [`click ${tag}`, "click", { selector: "#b", target }],
      [`fill ${tag}`, "fill", { selector: "#t", text: "hello", target }],
      [`press ${tag}`, "press", { key: "Tab", selector: "#t", target }],
      [`select ${tag}`, "select", { selector: "#s", text: "Two", target }],
      [`wait ${tag}`, "wait", { selector: "#b", target }],
      [`file_upload ${tag}`, "file_upload", { selector: "#up", path: upload, target }],
      [`screenshot ${tag}`, "screenshot", { format: "jpeg", target }],
    );
  }
  calls.push(
    ["click trusted shown", "click", { selector: "#b", trusted: true, target: S }],
    ["fill trusted shown", "fill", { selector: "#t", text: "trusted", trusted: true, target: S }],
    ["navigate shown", "navigate", { url: W.url, target: S }, 3],
    ["notify", "notify", { message: "perch versions bench", title: "perch" }, 1],
  );
  return calls;
}
const minimized = (W) => [
  ["minimized eval_js", "eval_js", { script: "return document.title", target: { tabId: W.shown } }],
  ["minimized screenshot", "screenshot", { format: "jpeg", target: { tabId: W.shown } }],
  ["minimized click trusted", "click", { selector: "#b", trusted: true, target: { tabId: W.shown } }],
];

// Four awaits at once on the shown tab, each 500ms, past the default timeout
// (the long lane): the whole batch's wall time per rep.
async function parallel(client, W, reps) {
  const out = [];
  for (let i = 0; i < reps; i++) {
    const s = performance.now();
    const rs = await Promise.all([0, 1, 2, 3].map((k) => rep(client, "eval_js", { script: `await new Promise((r) => setTimeout(r, 500)); return ${k}`, world: "main", awaitPromise: true, timeout: 60000, target: { tabId: W.shown } })));
    const bad = rs.find((r) => !r.ok);
    out.push({ ms: performance.now() - s, bytes: rs.reduce((n, r) => n + r.bytes, 0), ok: !bad, ...(bad ? { error: bad.error } : {}) });
  }
  return out;
}

async function runVersion(T, W, upload) {
  const { connect } = await import(join(T.dir, "scripts", "mcp-client.mjs"));
  const client = await connect({ timeoutMs: 120000 });
  const results = {};
  try {
    // Each version starts on a fresh copy of the page: clicks and presses append to its log.
    // A new query string reloads it; a changed fragment alone would not.
    for (const tabId of [W.shown, W.bg]) await rep(client, "navigate", { url: `${W.url}?v=${T.sha}${tabId === W.bg ? "#bg" : ""}`, target: { tabId } });
    for (const [name, tool, args] of workload(W, upload)) await rep(client, tool, args); // warm each path once
    for (const [name, tool, args, n = REPS] of workload(W, upload)) {
      const reps = [];
      for (let i = 0; i < n; i++) reps.push(await rep(client, tool, args));
      results[name] = stats(reps);
      const shot = reps.find((x) => x.image);
      if (shot) results[name].image = shot.image;
    }
    results["parallel 4x500ms await"] = stats(await parallel(client, W, Math.min(REPS, 5)));
    let down = null;
    try { minimize(W, true); } catch (e) { down = String(e.message).split("\n")[0]; }
    if (down) for (const [name] of minimized(W)) results[name] = { n: 0, p50: 0, p90: 0, bytes: 0, ok: 0, err: 1, error: `harness: could not minimize: ${down}` };
    else try {
      for (const [name, tool, args] of minimized(W)) {
        const reps = [];
        for (let i = 0; i < Math.min(REPS, 5); i++) reps.push(await rep(client, tool, args));
        results[name] = stats(reps);
        const shot = reps.find((x) => x.image);
        if (shot) results[name].image = shot.image;
      }
    } finally { try { minimize(W, false); } catch {} }
  } finally { client.close(); }
  return results;
}

function table(versions) {
  const names = [...new Set(versions.flatMap((v) => Object.keys(v.results)))];
  const head = ["call".padEnd(30), ...versions.map((v) => v.sha.padEnd(22))].join(" ");
  const cell = (s) => !s ? "-" : s.err === s.n ? `fail: ${String(s.error).slice(7, 27)}` : `${s.p50}/${s.p90}ms ${s.bytes}B${s.err ? ` ${s.err}err` : ""}`;
  return [head, ...names.map((n) => [n.padEnd(30), ...versions.map((v) => cell(v.results[n]).padEnd(22))].join(" "))].join("\n");
}

// One version's server.js with this checkout's lock harness and fake world, in a
// scratch directory, recorded fresh: the golden it writes is that version's.
function offlineSteps(ref) {
  const sha = git("rev-parse", "--short", ref), dir = join(tmpdir(), `perch-versions-lock-${sha}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "server.js"), git("show", `${sha}:server.js`) + "\n");
  for (const f of ["package.json", "scripts/temp.mjs", "test/lock.test.mjs"]) writeFileSync(join(dir, f), readFileSync(join(ROOT, f)));
  for (const d of ["test/lock", "test/fakes", "test/helpers", "test/fixtures"]) execFileSync("cp", ["-R", join(ROOT, d), join(dir, d)]);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  execFileSync("node", ["--import", "./test/helpers/isolate.mjs", "--test", "test/lock.test.mjs"], { cwd: dir, env: { ...process.env, PERCH_LOCK_WRITE: "1" }, stdio: "ignore" });
  return { ref, sha, steps: lockSteps(JSON.parse(readFileSync(join(dir, "test/lock/golden.json"), "utf8"))) };
}

function offline() {
  const vs = REFS.map(offlineSteps), totals = vs.map((v) => lockTotals(v.steps));
  const tools = [...new Set(totals.flatMap((t) => Object.keys(t)))];
  const cell = (t) => t ? `${t.ev}AE ${t.bytes}B ${t.err}err` : "-";
  console.log(["tool".padEnd(24), ...vs.map((v) => v.sha.padEnd(24))].join(" "));
  for (const tool of tools) console.log([tool.padEnd(24), ...totals.map((t) => cell(t[tool]).padEnd(24))].join(" "));
  for (const v of vs.slice(1)) {
    const d = lockDiff(vs[0].steps, v.steps);
    console.log(`\n${vs[0].sha} -> ${v.sha}: ${d.length ? "" : "no step costs more or newly fails"}`);
    for (const x of d) console.log(`  ${x.kind.padEnd(12)} ${x.step} ${x.detail}`);
  }
  return vs.map((v, i) => ({ ref: v.ref, sha: v.sha, totals: totals[i] }));
}

async function main() {
  if (OFFLINE) {
    const report = { date: new Date().toISOString(), offline: offline() };
    mkdirSync(dirname(resolve(ROOT, OUT)), { recursive: true });
    writeFileSync(resolve(ROOT, OUT), JSON.stringify(report, null, 2) + "\n");
    console.log(`\nwrote ${OUT}`);
    return;
  }
  const html = readFileSync(join(ROOT, "bench/versions-fixture.html"));
  const fixture = { file: "bench/versions-fixture.html", sha256: createHash("sha256").update(html).digest("hex") };
  const server = await serveFixture(html);
  const upload = join(tmpdir(), "perch-versions-upload.txt");
  writeFileSync(upload, "perch versions upload\n");
  const W = { ...openWindow(server.url), url: server.url };
  const save = (versions) => {
    const report = { date: new Date().toISOString(), macos: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(), browser: APP, fixture, reps: REPS, versions };
    mkdirSync(dirname(resolve(ROOT, OUT)), { recursive: true });
    writeFileSync(resolve(ROOT, OUT), JSON.stringify(report, null, 2) + "\n");
    return report;
  };
  const versions = [];
  try {
    for (const ref of REFS) {
      const T = tree(ref);
      console.error(`running ${ref} (${T.sha}) from ${T.dir}`);
      const locked = [screenLocked()], results = await runVersion(T, W, upload);
      locked.push(screenLocked());
      versions.push({ ref, sha: T.sha, locked, results });
      save(versions);
    }
  } finally { closeWindow(W); await server.close(); }
  const report = save(versions);
  console.log(table(versions));
  let flagged = 0;
  const pairs = [];
  if (BASELINE) {
    const base = JSON.parse(readFileSync(resolve(ROOT, BASELINE), "utf8"));
    const b = AGAINST ? base.versions.find((v) => v.ref === AGAINST || v.sha === AGAINST) : base.versions.at(-1);
    for (const v of versions) pairs.push([`${b.sha} (baseline)`, b.results, v]);
  } else for (let i = 1; i < versions.length; i++) pairs.push([versions[0].sha, versions[0].results, versions[i]]);
  for (const [from, results, v] of pairs) {
    const flags = compareRuns(results, v.results);
    flagged += flags.length;
    console.log(`\n${from} -> ${v.sha}: ${flags.length ? "" : "no flags"}`);
    for (const f of flags) console.log(`  ${f.kind.padEnd(8)} ${f.call}: ${f.detail}`);
  }
  console.log(`\nwrote ${OUT}`);
  process.exit(BASELINE && flagged ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(2); });
