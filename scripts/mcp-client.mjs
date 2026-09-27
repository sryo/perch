// Minimal MCP stdio client for smoke/bench: spawns server.js and speaks
// newline-delimited JSON-RPC. Node stdlib only.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function connect({ timeoutMs = 20000, env = process.env } = {}) {
  const child = spawn("node", [join(ROOT, "server.js")], { stdio: ["pipe", "pipe", "inherit"], env });
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
      if (waiter) { pending.delete(msg.id); waiter(msg); }
    }
  });

  let nextId = 1;
  const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  function rpc(method, params) {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    });
  }
  async function call(name, args = {}) {
    const res = await rpc("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`${name}: rpc error ${JSON.stringify(res.error)}`);
    return res.result;
  }

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "perch-script", version: "0" },
  });
  send({ method: "notifications/initialized" });
  return { rpc, call, init: init.result, close: () => child.kill() };
}

// Whether two tab handles name the same tab. A Safari handle ends in a hash of
// the tab's URL, which a load changes, so that part is left out.
const stripHash = (h) => (/^safari:/.test(h) ? h.replace(/\.[^.]*$/, "") : h);
export const sameTab = (a, b) => a === b || stripHash(String(a)) === stripHash(String(b));

export function text(result) {
  return result.content.find((c) => c.type === "text")?.text;
}
