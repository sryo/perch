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
    const t = tabs.find((x) => x.active) || tabs[0];
    const target = { app: t.app, windowId: t.windowId, tabIndex: t.tabIndex };
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

  // --- status-first changes (A–E). Run on a disposable scratch tab so real tabs
  // are never navigated. Prefer a Chrome-family browser (Arc restricts bg-tab eval).
  const chromeTab = Array.isArray(tabs) && tabs.find((t) => /chrome|chromium/i.test(t.app));
  let scratch = null;
  const body = "Hi there, this is a multi-line reply body.\nSecond line.\n\nA second paragraph that makes the text comfortably longer than fifty characters.";
  // data: navigation via AppleScript doesn't load content in Chrome, so build test DOM
  // in-page with eval_js instead (about:blank has no Trusted Types, so innerHTML is fine here).
  const setDom = (html) => call("eval_js", { script: `document.body.innerHTML = ${JSON.stringify(html)}; return document.body.children.length;`, target: scratch });

  await check("open scratch tab for status-first tests", async () => {
    if (!haveBrowser) return skip("no browser running");
    if (!chromeTab) return skip("no chrome-family browser for a safe scratch tab");
    const out = JSON.parse(text(await call("new_tab", { app: chromeTab.app, url: "about:blank" })));
    scratch = { app: out.app, windowId: out.windowId, tabIndex: out.tabIndex };
    return `scratch in ${out.app} @${out.tabIndex}`;
  });

  await check("eval_js typed error sets isError + name", async () => {
    if (!scratch) return skip("no scratch tab");
    const res = await call("eval_js", { script: "throw new TypeError('boom')", target: scratch });
    if (res.isError !== true) throw new Error(`isError not set: ${JSON.stringify(res).slice(0, 120)}`);
    const o = JSON.parse(text(res));
    if (o.__perch_error_name !== "TypeError") throw new Error(`name=${o.__perch_error_name}`);
    if (!/boom/.test(o.__perch_error || "")) throw new Error("message missing");
    return "isError + TypeError";
  });

  await check("fill skips hidden textarea, hits visible contenteditable", async () => {
    if (!scratch) return skip("no scratch tab");
    await setDom(`<textarea name="bodyHtml" style="display:none"></textarea><div contenteditable aria-label="Message Body"></div>`);
    const o = JSON.parse(text(await call("fill", { label_pattern: "body", text: body, target: scratch })));
    if (!o.ok) throw new Error(`not ok: ${JSON.stringify(o)}`);
    if (!o.matched || o.matched.tag !== "div") throw new Error(`matched=${JSON.stringify(o.matched)}`);
    if (!o.matched.visible) throw new Error("matched not visible");
    if (!/^Hi there/.test(o.value || "")) throw new Error(`value=${JSON.stringify(o.value)}`);
    return `matched ${o.matched.tag} "${o.matched.name}"`;
  });

  await check("page_state reports an open, empty editor", async () => {
    if (!scratch) return skip("no scratch tab");
    await setDom(`<div contenteditable aria-label="Reply"></div>`);
    const o = JSON.parse(text(await call("page_state", { target: scratch })));
    if (!Array.isArray(o.editors) || !o.editors.some((e) => e.name === "Reply" && e.empty)) throw new Error(`editors=${JSON.stringify(o.editors)}`);
    return `${o.editors.length} editor(s)`;
  });

  await check("select picks from a native <select>", async () => {
    if (!scratch) return skip("no scratch tab");
    await setDom(`<label>Country <select><option>Pick</option><option>Argentina</option><option>Brazil</option></select></label>`);
    const o = JSON.parse(text(await call("select", { label_pattern: "country", text: "Argentina", target: scratch })));
    if (!o.ok || o.selected !== "Argentina") throw new Error(`select result ${JSON.stringify(o)}`);
    return `selected ${o.selected}`;
  });

  await check("TT-safe rich fill under Trusted Types", async () => {
    if (!haveBrowser || !chromeTab) return skip("no chrome-family browser");
    // Trusted Types only engages when the page LOADS with the CSP, so set it at tab creation.
    const ttHtml = `<!doctype html><meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'"><div contenteditable aria-label="Body"></div>`;
    const out = JSON.parse(text(await call("new_tab", { app: chromeTab.app, url: "data:text/html," + encodeURIComponent(ttHtml) })));
    const tt = { app: out.app, windowId: out.windowId, tabIndex: out.tabIndex };
    const present = text(await call("eval_js", { script: "return !!document.querySelector('[contenteditable]')", target: tt }));
    if (present !== "true") { try { await call("eval_js", { script: "location.href='about:blank'; return true", target: tt }); } catch { /* ignore */ } return skip("browser did not load data: URL for CSP test"); }
    const o = JSON.parse(text(await call("fill", { label_pattern: "body", text: body, target: tt })));
    try { await call("eval_js", { script: "location.href='about:blank'; return true", target: tt }); } catch { /* ignore */ }
    if (!o.ok) throw new Error(`not ok under Trusted Types: ${JSON.stringify(o)}`);
    return `ok under TT, kind ${o.kind}`;
  });

  if (scratch) { try { await call("eval_js", { script: "document.body.innerHTML=''; return true", target: scratch }); } catch { /* leave clean */ } }
} catch (e) {
  report("FAIL", "harness", e.message);
} finally {
  child.kill();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
