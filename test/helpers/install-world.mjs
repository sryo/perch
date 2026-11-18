// A throwaway HOME for install.sh: stub claude/codex/copilot/osascript/open/npm/git on
// PATH and a stub perch dir. Shared by test/install.test.mjs and scripts/install-bench.mjs.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../scripts/temp-dirs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const INSTALL = join(ROOT, "install.sh");
export const SRC = readFileSync(INSTALL, "utf8");

// Fake CLIs. claude and codex edit the files the real ones keep, so a second run
// sees what the first wrote; every call is logged to $FAKE_LOG.
const STUBS = {
  claude: `
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2), f = path.join(process.env.HOME, ".claude.json");
fs.appendFileSync(process.env.FAKE_LOG, "claude " + a.join(" ") + "\\n");
const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
c.mcpServers = c.mcpServers || {};
if (a[1] === "add-json") { if (c.mcpServers[a[2]]) { console.error("exists"); process.exit(1); } c.mcpServers[a[2]] = JSON.parse(a[3]); }
else if (a[1] === "remove") delete c.mcpServers[a[2]];
fs.writeFileSync(f, JSON.stringify(c, null, 2));`,
  codex: `
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2), f = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "config.toml");
fs.appendFileSync(process.env.FAKE_LOG, "codex " + a.join(" ") + "\\n");
let s = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
if (a[1] === "add") { fs.mkdirSync(path.dirname(f), { recursive: true }); s += "\\n[mcp_servers." + a[2] + "]\\ncommand = " + JSON.stringify(a[4]) + "\\nargs = " + JSON.stringify(a.slice(5)) + "\\n"; }
else if (a[1] === "remove") s = s.replace(/\\n?\\[mcp_servers\\.perch\\][\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.perch\\.)|$)/, "");
fs.writeFileSync(f, s);`,
  copilot: `require("fs").appendFileSync(process.env.FAKE_LOG, "copilot " + process.argv.slice(2).join(" ") + "\\n");`,
  npm: `require("fs").appendFileSync(process.env.FAKE_LOG, "npm " + process.argv.slice(2).join(" ") + "\\n");`,
  git: `require("fs").appendFileSync(process.env.FAKE_LOG, "git " + process.argv.slice(2).join(" ") + "\\n");`,
  open: `require("fs").appendFileSync(process.env.FAKE_LOG, "open " + process.argv.slice(2).join(" ") + "\\n");`,
  // Answers by what the script asks: running apps, the AX/screen-recording read, or a browser probe.
  osascript: `
const fs = require("fs"), a = process.argv.slice(2), js = a[a.indexOf("-e") + 1] || "";
fs.appendFileSync(process.env.FAKE_LOG, "osascript " + js.replace(/\\s+/g, " ").slice(0, 80) + "\\n");
if (js.includes("runningApplications")) console.log(process.env.FAKE_RUNNING || "[]");
else if (js.includes("AXIsProcessTrusted")) console.log(process.env.FAKE_TCC || '{"ax":true,"sr":true}');
else { const probes = JSON.parse(process.env.FAKE_PROBE || "{}"); const name = JSON.parse(a[a.length - 1]).name;
  const p = probes[name] || { auto: "ok", js: "ok" }; if (p.hang) setTimeout(() => {}, 1e6); else console.log(JSON.stringify(p)); }`,
};

export function world(t, { clients = ["claude", "codex", "copilot"] } = {}) {
  const home = tempDir("perch-install-home-", t);
  const bin = tempDir("perch-install-bin-", t);
  const dir = join(home, ".perch");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "server.js"), "// stub\n");
  symlinkSync(process.execPath, join(bin, "node"));
  for (const [name, body] of Object.entries(STUBS)) {
    if (["claude", "codex", "copilot"].includes(name) && !clients.includes(name)) continue;
    writeFileSync(join(bin, name), "#!/usr/bin/env node\n" + body + "\n");
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(home, "calls.log");
  writeFileSync(log, "");
  const server = join(dir, "server.js");
  // piped: the way the README runs it, script on stdin.
  const run = (args = [], env = {}, { piped = false } = {}) => {
    const r = spawnSync("/bin/bash", piped ? ["-s", "--", ...args] : [INSTALL, ...args], {
      input: piped ? SRC : undefined,
      cwd: home, encoding: "utf8", timeout: 60000,
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, PERCH_DIR: dir, FAKE_LOG: log, TMPDIR: home, ...env },
    });
    return { ...r, out: r.stdout + r.stderr };
  };
  const calls = () => readFileSync(log, "utf8");
  const f = (...p) => join(home, ...p);
  const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof s === "string" ? s : JSON.stringify(s, null, 2)); };
  const get = (p) => readFileSync(p, "utf8");
  return { home, dir, server, run, calls, f, put, get };
}

export const CURSOR = [".cursor", "mcp.json"];
export const VSCODE = ["Library", "Application Support", "Code", "User", "mcp.json"];
export const COPILOT = [".copilot", "mcp-config.json"];
export const CODEX = [".codex", "config.toml"];
