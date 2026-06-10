#!/usr/bin/env node
// Smoke test for the perch MCP server. Node stdlib only; speaks MCP stdio
// JSON-RPC directly. Assertions that need a live browser SKIP when none is
// running. Non-zero exit on any FAIL.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_CHAR_BUDGET = 15000;
const CALL_TIMEOUT_MS = 20000;

const child = spawn("node", [join(ROOT, "server.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter.resolve(msg); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${CALL_TIMEOUT_MS}ms`)); }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
async function call(name, args = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name}: rpc error ${JSON.stringify(res.error)}`);
  return res.result;
}
function text(result) { return result.content.find((c) => c.type === "text")?.text; }

let failures = 0;
function report(status, label, detail = "") {
  if (status === "FAIL") failures++;
  console.log(`${status.padEnd(4)} ${label}${detail ? ` — ${detail}` : ""}`);
}
async function check(label, fn) {
  try {
    const detail = await fn();
    if (detail === SKIP) report("SKIP", label, SKIP.reason);
    else report("PASS", label, detail || "");
  } catch (e) {
    report("FAIL", label, e.message);
  }
}
const SKIP = { reason: "" };
function skip(reason) { SKIP.reason = reason; return SKIP; }

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "perch-smoke", version: "0" },
  });
  notify("notifications/initialized");

  await check("tools/list within schema budget", async () => {
    const res = await rpc("tools/list", {});
    const size = JSON.stringify(res.result.tools).length;
    if (size >= SCHEMA_CHAR_BUDGET) throw new Error(`${size} chars >= budget ${SCHEMA_CHAR_BUDGET}`);
    return `${res.result.tools.length} tools, ${size} chars`;
  });

  let tabs = null;
  await check("list_tabs bare shape (no params)", async () => {
    tabs = JSON.parse(text(await call("list_tabs")));
    if (!Array.isArray(tabs)) throw new Error(`expected bare array, got ${typeof tabs}`);
    return `${tabs.length} tabs`;
  });

  await check("list_tabs filtered shape ({limit: 1})", async () => {
    const out = JSON.parse(text(await call("list_tabs", { limit: 1 })));
    if (Array.isArray(out) || !Array.isArray(out.tabs) || typeof out.total !== "number") {
      throw new Error(`expected {tabs, total}, got ${JSON.stringify(out).slice(0, 80)}`);
    }
    return `total ${out.total}`;
  });

  const haveBrowser = Array.isArray(tabs) && tabs.length > 0;

  await check("eval_js round-trip", async () => {
    if (!haveBrowser) return skip("no browser running");
    const target = { app: tabs[0].app, windowId: tabs[0].windowId, tabIndex: tabs[0].tabIndex };
    const out = text(await call("eval_js", { script: "return 1+1", target }));
    if (out !== "2") throw new Error(`expected "2", got ${JSON.stringify(out)}`);
  });

  await check("screenshot image + metadata block", async () => {
    if (!haveBrowser) return skip("no browser running");
    const target = { app: tabs[0].app, windowId: tabs[0].windowId };
    const res = await call("screenshot", { target });
    const img = res.content.find((c) => c.type === "image");
    if (!img) throw new Error(`no image block: ${JSON.stringify(res.content.map((c) => c.type))}`);
    const metaText = text(res);
    if (!metaText) throw new Error("no metadata text block");
    const meta = JSON.parse(metaText);
    for (const k of ["x", "y", "w", "h"]) if (typeof meta.window?.[k] !== "number") throw new Error(`window.${k} missing in ${metaText}`);
    for (const k of ["w", "h"]) if (typeof meta.image?.[k] !== "number") throw new Error(`image.${k} missing in ${metaText}`);
    return `window ${meta.window.w}x${meta.window.h}pt, image ${meta.image.w}x${meta.image.h}px`;
  });
} catch (e) {
  report("FAIL", "harness", e.message);
} finally {
  child.kill();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
