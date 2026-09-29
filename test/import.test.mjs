import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { tempDir } from "../scripts/temp.mjs";
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

test("server started through a symlink still answers tools/list", async (t) => {
  const dir = tempDir("perch-", t);
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
    setTimeout(() => reject(new Error("no tools/list reply")), 15000).unref();
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

// Once a client disconnects, the server and its osascript daemons must go:
// otherwise every ended session leaves a node process and its REPLs running.
// A fake `osascript` on PATH answers each line with an empty result, so the
// daemons pass their handshake and stay up, and ignores stdin EOF, so only the
// server's own shutdown can end it. The ceilings only catch a hang.
test("server exits with its daemons when stdin closes", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const dir = tempDir("perch-exit-", t);
  const log = join(dir, "replies");
  await writeFile(join(dir, "osascript"), [
    "#!/bin/sh",
    "while IFS= read -r line; do",
    "  id=$(printf '%s\\n' \"$line\" | sed -n 's/.*<<P:\\([a-z0-9]*\\):O:.*/\\1/p')",
    "  printf '<<P:%s:O:>>\\n' \"$id\"",
    `  echo reply >> "${log}"`,
    "done",
    "exec tail -f /dev/null",
    "",
  ].join("\n"));
  await chmod(join(dir, "osascript"), 0o755);
  const child = spawn(process.execPath, [join(ROOT, "server.js")], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const kids = () => { try { return execFileSync("pgrep", ["-P", String(child.pid)]).toString().trim().split("\n").filter(Boolean); } catch { return []; } };
  const alive = (p) => { try { process.kill(Number(p), 0); return true; } catch { return false; } };
  const until = async (f, ms) => { for (const end = Date.now() + ms; !(await f()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 20)); return f(); };
  let orphans = [];
  t.after(() => { child.kill("SIGKILL"); for (const p of orphans) { try { process.kill(Number(p), "SIGKILL"); } catch {} } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
  // Connecting warms both lanes: two handshakes answered.
  const replies = () => readFile(log, "utf8").then((s) => s.split("\n").filter(Boolean).length, () => 0);
  assert.equal(await until(async () => (await replies()) >= 2 && kids().length >= 2, 15000), true, "the server should have started its daemons");
  orphans = kids();
  child.stdin.end();
  const ended = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15000))]);
  assert.deepEqual(ended, { code: 0, signal: null }, "the server should exit on its own once stdin closes");
  assert.equal(await until(() => orphans.every((p) => !alive(p)), 15000), true, "its osascript daemons should be gone");
});
