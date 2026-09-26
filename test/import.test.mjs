import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
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
  } finally { child.kill(); }
});
