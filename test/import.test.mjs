import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/mcp-client.mjs";

test("importing server.js exposes the seams without starting stdio", async () => {
  const m = await import("../server.js");
  for (const k of ["TOOLS", "HANDLERS", "handleCall", "formatResult"]) assert.ok(m[k], `missing export ${k}`);
});

test("HANDLERS and TOOLS name the same tools", async () => {
  const { TOOLS, HANDLERS } = await import("../server.js");
  assert.deepEqual(Object.keys(HANDLERS).sort(), TOOLS.map((t) => t.name).sort());
});

test("server started through a symlink still answers tools/list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perch-"));
  const link = join(dir, "perch");
  await symlink(join(ROOT, "server.js"), link);
  const child = spawn("node", [link], { stdio: ["pipe", "pipe", "ignore"] });
  const reply = new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const line = buf.split("\n").find((l) => l.includes('"id":2'));
      if (line) resolve(JSON.parse(line));
    });
    setTimeout(() => reject(new Error("no tools/list reply")), 5000).unref();
  });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list", params: {} });
  try {
    const msg = await reply;
    assert.ok(msg.result.tools.length > 0);
  } finally { child.kill(); await rm(dir, { recursive: true, force: true }); }
});

// Once a client disconnects, the server and its osascript daemons must go:
// otherwise every ended session leaves a node process and its REPLs running.
test("server exits with its daemons when stdin closes", { skip: process.platform !== "darwin" || process.env.PERCH_LIVE === "0" }, async () => {
  const { execFileSync } = await import("node:child_process");
  const child = spawn("node", [join(ROOT, "server.js")], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = [];
  const reply = (id) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no reply ${id}`)), 15000);
    child.stdout.on("data", (d) => {
      lines.push(...String(d).split("\n"));
      if (lines.some((l) => l.includes(`"id":${id}`))) { clearTimeout(t); resolve(); }
    });
  });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ method: "notifications/initialized" });
  // A filter nothing matches: read-only, and enough to start the daemons.
  send({ id: 2, method: "tools/call", params: { name: "list_tabs", arguments: { urlContains: "perch-exit-test-no-match" } } });
  await reply(2);
  const kids = () => { try { return execFileSync("pgrep", ["-P", String(child.pid)]).toString().trim().split("\n").filter(Boolean); } catch { return []; } };
  assert.ok(kids().length > 0, "the call should have started a daemon");
  const orphans = kids();
  const exited = new Promise((resolve) => child.on("exit", () => resolve(true)));
  child.stdin.end();
  const ok = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 3000))]);
  if (!ok) child.kill("SIGKILL");
  for (const p of orphans) { try { process.kill(Number(p), 0); if (!ok) process.kill(Number(p), "SIGKILL"); } catch {} }
  assert.equal(ok, true, "server should exit within 3s of stdin closing");
  // SIGKILL lands asynchronously, so give the daemons a moment to be reaped.
  const living = () => orphans.filter((p) => { try { process.kill(Number(p), 0); return true; } catch { return false; } });
  for (let i = 0; i < 20 && living().length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(living().length, 0, "its osascript daemons should be gone");
});
