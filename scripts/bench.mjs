#!/usr/bin/env node
// Latency + payload bench against a live browser, on a fixed page: bench/fixture.html
// served from an in-process http server on 127.0.0.1, so byte counts compare
// like-for-like across runs. The rows run on an existing scratch tab, which is
// navigated to the fixture and back; the bench never opens, closes or activates a tab.
//   node scripts/bench.mjs [--app canary] [--tab <tabId>] [--runs 20] [--out bench/runs/bench.json] [--compare bench/baseline.json]
// --app benches that browser; npm run bench passes --app canary; npm run bench -- --app arc overrides it.
// The scratch tab is an about:blank tab of that browser, the one its window shows
// if any (screenshot rows need a shown tab), or --tab: any http(s)/about:blank tab.
// Runs land in bench/runs/ (gitignored) and compare against bench/baseline.json;
// byte counts are compared only when both runs used the same fixture (its sha256).
// Replacing the baseline is a deliberate copy: cp bench/runs/bench.json bench/baseline.json
//   --navigate   also time navigate (reloads the fixture in the scratch tab)

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, text, ROOT } from "./mcp-client.mjs";

// The last occurrence of a flag wins, so `npm run bench -- --app arc` overrides
// the --app canary that the npm script passes first.
export function parseArgs(argv) {
  const opt = (k, d) => { const i = argv.lastIndexOf(k); return i >= 0 ? argv[i + 1] : d; };
  return {
    runs: Number(opt("--runs", 20)),
    out: opt("--out", "bench/runs/bench.json"),
    compare: opt("--compare", "bench/baseline.json"),
    app: opt("--app"),
    tab: opt("--tab"),
    navigate: argv.includes("--navigate"),
  };
}

export const FIXTURE_FILE = "bench/fixture.html";
export const fixtureHash = (buf) => createHash("sha256").update(buf).digest("hex");

// Serves `html` at /fixture.html on an ephemeral 127.0.0.1 port. Chrome raises
// itself for a navigation it has to start (file:// is one), so the page is http.
export function serveFixture(html) {
  const server = createServer((req, res) => {
    const hit = req.method === "GET" && new URL(req.url, "http://x").pathname === "/fixture.html";
    res.writeHead(hit ? 200 : 404, {
      "content-type": hit ? "text/html; charset=utf-8" : "text/plain",
      "cache-control": "no-store",
      connection: "close",
    });
    res.end(hit ? html : "not found");
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      ok({
        url: `http://127.0.0.1:${port}/fixture.html`,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

// Loads to and from these start in page JS, which doesn't raise the browser.
export const restorable = (url) => /^https?:\/\//i.test(url || "") || url === "about:blank";

// `tabs` are list_tabs rows, frontmost browser first.
export function pickScratch(tabs, { tabId } = {}) {
  if (!tabs.length) throw new Error("no browser tabs; open a browser first");
  if (tabId) {
    const t = tabs.find((r) => r.tabId === tabId);
    if (!t) throw new Error(`--tab ${tabId} not found; re-run list_tabs`);
    if (!restorable(t.url)) throw new Error(`--tab ${tabId} shows ${t.url}; the scratch tab must be http(s) or about:blank`);
    return t;
  }
  const blank = tabs.filter((t) => t.url === "about:blank");
  const t = blank.find((r) => r.active) || blank[0];
  if (!t) throw new Error("no about:blank scratch tab; open one in the benched browser, or pass --tab");
  return t;
}

// The before/after table against a baseline run. Byte counts depend on the page,
// so they are compared only when both runs benched the same fixture.
export function compareLines(baseline, report) {
  const before = baseline.results || {};
  const { results } = report;
  const same = !!baseline.fixture?.sha256 && baseline.fixture.sha256 === report.fixture?.sha256;
  const lines = [`baseline: ${baseline.rev} on macOS ${baseline.macos || "?"}, ${baseline.browser || "?"} (${baseline.date})`];
  if (!same) {
    const was = baseline.fixture?.sha256?.slice(0, 12) || "none recorded";
    const now = report.fixture?.sha256?.slice(0, 12) || "none";
    lines.push(`warning: baseline fixture (${was}) differs from this run's (${now}); bytes not compared`);
  }
  lines.push("", `scenario                     p50 before -> after${same ? "      bytes before -> after" : ""}`);
  for (const [k, v] of Object.entries(results)) {
    const b = before[k];
    if (!b || k === "schema") continue;
    if (b.error || v.error) { lines.push([k.padEnd(28), b.error ? "before: error" : "", v.error ? "after: error" : ""].join(" ")); continue; }
    const d = ((v.p50 - b.p50) / b.p50 * 100).toFixed(0);
    const p50 = `${b.p50} -> ${v.p50} (${d > 0 ? "+" : ""}${d}%)`;
    lines.push(same ? `${k.padEnd(28)} ${p50.padEnd(24)} ${b.bytes} -> ${v.bytes}` : `${k.padEnd(28)} ${p50}`);
  }
  if (before.schema && results.schema) lines.push(`${"schema chars".padEnd(28)} ${before.schema.chars} -> ${results.schema.chars}`);
  return lines;
}

const WARMUP = 3;
const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

async function main() {
  const { runs: RUNS, out: OUT, compare: COMPARE, app: APP, tab: TAB, navigate } = parseArgs(process.argv.slice(2));
  const html = await readFile(resolve(ROOT, FIXTURE_FILE));
  const fixture = { file: FIXTURE_FILE, sha256: fixtureHash(html) };
  const server = await serveFixture(html);
  const client = await connect({ timeoutMs: 60000 });
  const results = {};
  let benched = null;
  let scratch = null;
  let target = null;

  async function time(name, fn) {
    const ms = [];
    let bytes = 0;
    try {
      for (let i = 0; i < WARMUP + RUNS; i++) {
        const t0 = performance.now();
        const res = await fn();
        const dt = performance.now() - t0;
        if (res.isError) throw new Error(text(res));
        if (i >= WARMUP) ms.push(dt);
        bytes = JSON.stringify(res.content).length;
      }
      results[name] = { p50: +pct(ms, 0.5).toFixed(1), p95: +pct(ms, 0.95).toFixed(1), min: +Math.min(...ms).toFixed(1), bytes };
    } catch (e) {
      results[name] = { error: e.message.slice(0, 200) };
    }
    console.log(name.padEnd(28), JSON.stringify(results[name]));
  }

  // Some handles follow the page's URL; navigate returns the new one.
  async function go(url) {
    const res = await client.call("navigate", { url, target });
    if (res.isError) throw new Error(`navigate ${url}: ${text(res)}`);
    const out = JSON.parse(text(res));
    if (out.tabId) target = { tabId: out.tabId };
    return res;
  }

  try {
    // Past list_tabs' default limit of 50 the scratch row can be missing.
    const listed = JSON.parse(text(await client.call("list_tabs", { limit: 10000, ...(APP ? { app: APP } : {}) })));
    const tabs = Array.isArray(listed) ? listed : listed.tabs;
    scratch = pickScratch(tabs, { tabId: TAB });
    benched = scratch.app;
    target = { tabId: scratch.tabId };
    console.log(`fixture ${server.url} (${fixture.sha256.slice(0, 12)}) in ${benched} ${scratch.tabId}${scratch.active ? "" : "; not shown, so screenshot rows will error"}`);
    const loaded = JSON.parse(text(await go(server.url)));
    if (!loaded.waited) console.log("warning: the fixture load wasn't confirmed; rows may measure a loading page");

    await time("list_tabs", () => client.call("list_tabs"));
    await time("list_tabs limit:1", () => client.call("list_tabs", { limit: 1 }));
    // The default target is the frontmost browser's tab, which --app may not be.
    if (!APP) await time("eval_js default target", () => client.call("eval_js", { script: "return 1" }));
    await time("eval_js explicit target", () => client.call("eval_js", { script: "return 1", target }));
    await time("eval_js awaitPromise", () => client.call("eval_js", { script: "return 1", awaitPromise: true, target }));
    await time("wait readyState", () => client.call("wait", { readyState: "complete", target }));
    await time("accessibility_snapshot", () => client.call("accessibility_snapshot", { target }));
    await time("get_text 2000", () => client.call("get_text", { maxChars: 2000, target }));
    await time("screenshot png", () => client.call("screenshot", { target }));
    await time("screenshot jpeg", () => client.call("screenshot", { target, format: "jpeg" }));
    if (navigate) await time("navigate fixture", () => go(server.url));
    const tools = (await client.rpc("tools/list", {})).result.tools;
    results.schema = { tools: tools.length, chars: JSON.stringify(tools).length };
    console.log("schema".padEnd(28), JSON.stringify(results.schema));
  } finally {
    if (scratch && restorable(scratch.url)) {
      await go(scratch.url).catch((e) => console.error(`could not restore ${scratch.tabId} to ${scratch.url}: ${e.message}`));
    }
    client.close();
    await server.close();
  }

  const report = {
    rev: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim(),
    date: new Date().toISOString(),
    macos: execFileSync("sw_vers", ["-productVersion"]).toString().trim(),
    browser: benched,
    fixture,
    runs: RUNS,
    results,
  };
  if (OUT) {
    const p = resolve(ROOT, OUT);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(report, null, 2) + "\n");
  }
  // No baseline, or one that isn't bench JSON: just print this run.
  const baseline = await readFile(resolve(ROOT, COMPARE), "utf8").then((s) => JSON.parse(s)).catch(() => null);
  if (baseline?.results) console.log("\n" + compareLines(baseline, report).join("\n"));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
