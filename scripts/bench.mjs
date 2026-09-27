#!/usr/bin/env node
// Latency + payload bench against a live browser. Read-only by default: every
// scenario runs on the frontmost browser's active tab and changes nothing.
//   node scripts/bench.mjs [--runs 20] [--out bench/after.json] [--compare bench/before.json]
//   --navigate   also time navigate (opens a scratch about:blank tab first)

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { connect, text, ROOT } from "./mcp-client.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RUNS = Number(opt("--runs", 20));
const WARMUP = 3;
const OUT = opt("--out");
const COMPARE = opt("--compare");

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

const client = await connect({ timeoutMs: 60000 });
const results = {};

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

try {
  const listed = JSON.parse(text(await client.call("list_tabs")));
  const tabs = Array.isArray(listed) ? listed : listed.tabs;
  if (!tabs.length) throw new Error("no browser tabs; open a browser first");
  const active = tabs.find((t) => t.active) || tabs[0];
  const target = { tabId: active.tabId };

  await time("list_tabs", () => client.call("list_tabs"));
  await time("list_tabs limit:1", () => client.call("list_tabs", { limit: 1 }));
  await time("eval_js default target", () => client.call("eval_js", { script: "return 1" }));
  await time("eval_js explicit target", () => client.call("eval_js", { script: "return 1", target }));
  await time("eval_js awaitPromise", () => client.call("eval_js", { script: "return 1", awaitPromise: true, target }));
  await time("wait readyState", () => client.call("wait", { readyState: "complete", target }));
  await time("accessibility_snapshot", () => client.call("accessibility_snapshot", { target }));
  await time("get_text 2000", () => client.call("get_text", { maxChars: 2000, target }));
  await time("screenshot png", () => client.call("screenshot", { target }));
  await time("screenshot jpeg", () => client.call("screenshot", { target, format: "jpeg" }));
  if (argv.includes("--navigate")) {
    const out = JSON.parse(text(await client.call("new_tab", { app: active.app, url: "about:blank" })));
    const scratch = { tabId: out.tabId };
    await time("navigate about:blank", () => client.call("navigate", { url: "about:blank", target: scratch }));
  }
  const tools = (await client.rpc("tools/list", {})).result.tools;
  results.schema = { tools: tools.length, chars: JSON.stringify(tools).length };
  console.log("schema".padEnd(28), JSON.stringify(results.schema));
} finally {
  client.close();
}

const report = {
  rev: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim(),
  date: new Date().toISOString(),
  runs: RUNS,
  results,
};
if (OUT) {
  const p = resolve(ROOT, OUT);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(report, null, 2) + "\n");
}
if (COMPARE) {
  const before = JSON.parse(await readFile(resolve(ROOT, COMPARE), "utf8")).results;
  console.log("\nscenario                     p50 before -> after      bytes before -> after");
  for (const [k, v] of Object.entries(results)) {
    const b = before[k];
    if (!b || k === "schema") continue;
    if (b.error || v.error) { console.log(k.padEnd(28), b.error ? "before: error" : "", v.error ? "after: error" : ""); continue; }
    const d = ((v.p50 - b.p50) / b.p50 * 100).toFixed(0);
    console.log(k.padEnd(28), `${b.p50} -> ${v.p50} (${d > 0 ? "+" : ""}${d}%)`.padEnd(24), `${b.bytes} -> ${v.bytes}`);
  }
  if (before.schema) console.log("schema chars".padEnd(28), `${before.schema.chars} -> ${results.schema.chars}`);
}
