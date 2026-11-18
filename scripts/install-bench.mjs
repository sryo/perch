// install.sh on a HOME that already has other servers and the user's own keys in each
// client config, one of them commented: what the install, a rerun and --uninstall lose
// or rewrite. Writes a fium run file and prints its path.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { world, CURSOR, VSCODE, COPILOT, CODEX } from "../test/helpers/install-world.mjs";

const w = world();
const claudeF = w.f(".claude.json"), codexF = w.f(...CODEX), copilotF = w.f(...COPILOT), cursorF = w.f(...CURSOR), vscodeF = w.f(...VSCODE);
const commented = `{\n  // mine\n  "mcpServers": { "other": { "command": "x" } }\n}\n`;
w.put(claudeF, { mcpServers: { perch: { type: "stdio", command: "node", args: ["/old/server.js"], env: { K: "v" } }, other: { command: "x" } } });
w.put(codexF, `[mcp_servers.perch]\ncommand = "node"\nargs = ["/old/server.js"]\n\n[mcp_servers.perch.env]\nK = "v"\n\n[mcp_servers.other]\ncommand = "x"\n`);
w.put(copilotF, commented);
w.put(cursorF, { mcpServers: { perch: { command: "node", args: ["/old/server.js"], env: { K: "v" } }, other: { command: "x" } } });
w.put(vscodeF, { servers: { other: { command: "x" } } });

const json = (f, key) => { try { return JSON.parse(w.get(f))[key] || {}; } catch { return null; } };
// One per other server gone, perch's own env gone, or the commented file rewritten.
function lost({ perch }) {
  let n = 0;
  const claude = json(claudeF, "mcpServers"), cursor = json(cursorF, "mcpServers"), vscode = json(vscodeF, "servers");
  const toml = existsSync(codexF) ? w.get(codexF) : "";
  for (const s of [claude, cursor, vscode]) n += s?.other ? 0 : 1;
  n += /\[mcp_servers\.other\]\ncommand = "x"/.test(toml) ? 0 : 1;
  n += w.get(copilotF) === commented ? 0 : 1;
  if (perch) {
    for (const s of [claude, cursor]) n += s?.perch?.env?.K === "v" ? 0 : 1;
    n += /\[mcp_servers\.perch\.env\]\nK = "v"/.test(toml) ? 0 : 1;
  }
  return n;
}
const files = [claudeF, codexF, copilotF, cursorF, vscodeF];
const snap = () => files.map((f) => (existsSync(f) ? w.get(f) : null));

const ok = (r) => { if (r.status !== 0) throw new Error(`install.sh exited ${r.status}:\n${r.out}`); };
ok(w.run());
const lostInstall = lost({ perch: true });
const before = snap();
ok(w.run());
const rerunWrites = snap().filter((s, i) => s !== before[i]).length;
ok(w.run(["--uninstall"]));
const lostUninstall = lost({ perch: false });

const metric = (v) => ({ dir: "lower", kind: "count", samples: [v] });
const out = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
  metrics: {
    "install entries lost": metric(lostInstall + lostUninstall),
    "install rerun writes": metric(rerunWrites),
  },
};
const dir = join(homedir(), ".fium", "runs", "perch");
mkdirSync(dir, { recursive: true });
const file = join(dir, "install.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(file);
