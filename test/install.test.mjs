// install.sh against a throwaway HOME with stub claude/codex/copilot/osascript/open/npm/git
// on PATH: client configs perch registers in (merged, never clobbered, second run a
// no-op), --uninstall removing only perch's own entries, and the permission check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, symlinkSync, chmodSync, lstatSync, statSync } from "node:fs";
import { world, INSTALL, SRC, CURSOR, VSCODE, COPILOT, CODEX, GEMINI, OPENCODE } from "./helpers/install-world.mjs";
import { ERR, BROWSERS } from "../server.js";

// install.sh refuses anything but macOS.
const mac = { skip: process.platform !== "darwin" };

test("fresh install registers in every client present; a second run changes nothing", mac, (t) => {
  const w = world(t);
  mkdirSync(w.f(".cursor"));
  mkdirSync(w.f(...VSCODE.slice(0, -1)), { recursive: true });
  const r = w.run();
  assert.equal(r.status, 0, r.out);
  assert.ok(!/git clone/.test(w.calls()), "a local PERCH_DIR is not cloned over");
  const claude = JSON.parse(w.get(w.f(".claude.json"))).mcpServers.perch;
  assert.deepEqual(claude.args, [w.server]);
  assert.match(w.get(w.f(...CODEX)), /\[mcp_servers\.perch\][\s\S]*tool_timeout_sec = 330/);
  const cop = JSON.parse(w.get(w.f(...COPILOT))).mcpServers.perch;
  assert.deepEqual([cop.command, cop.args, cop.timeout], ["node", [w.server], 330000]);
  assert.deepEqual(JSON.parse(w.get(w.f(...CURSOR))).mcpServers.perch, { command: "node", args: [w.server] });
  assert.deepEqual(JSON.parse(w.get(w.f(...VSCODE))).servers.perch, { type: "stdio", command: "node", args: [w.server] });

  const files = [[".claude.json"], CODEX, COPILOT, CURSOR, VSCODE].map((p) => w.f(...p));
  const before = files.map(w.get);
  const callsBefore = w.calls();
  const again = w.run();
  assert.equal(again.status, 0, again.out);
  assert.deepEqual(files.map(w.get), before, "second run rewrote a config");
  const newCalls = w.calls().slice(callsBefore.length);
  assert.ok(!/claude mcp (add|remove)|codex mcp (add|remove)/.test(newCalls), newCalls);
  assert.match(again.out, /unchanged/);
});

test("other servers and the user's keys on perch survive; a stale perch entry is updated in place", mac, (t) => {
  const w = world(t);
  w.put(w.f(".claude.json"), { mcpServers: { perch: { type: "stdio", command: "node", args: ["/old/server.js"], env: { A: "1" } }, other: { command: "x" } } });
  w.put(w.f(...CODEX), `model = "o3"\n\n[mcp_servers.perch]\ncommand = "node"\nargs = ["/old/server.js"]\n\n[mcp_servers.perch.env]\nB = "2"\n\n[mcp_servers.other]\ncommand = "y"\n`);
  w.put(w.f(...COPILOT), { mcpServers: { perch: { type: "local", command: "node", args: ["/old"], env: { C: "3" }, tools: ["click"] }, other: { command: "z" } } });
  const r = w.run();
  assert.equal(r.status, 0, r.out);
  const claude = JSON.parse(w.get(w.f(".claude.json"))).mcpServers;
  assert.deepEqual(claude.perch.env, { A: "1" }, "claude env dropped");
  assert.deepEqual(claude.perch.args, [w.server]);
  assert.ok(claude.other);
  const toml = w.get(w.f(...CODEX));
  assert.ok(!/codex mcp remove/.test(w.calls()), "codex entry removed and re-added");
  assert.match(toml, /args = \[".*\.perch\/server\.js"\]/);
  assert.match(toml, /\[mcp_servers\.perch\.env\]\nB = "2"/);
  assert.match(toml, /\[mcp_servers\.other\]\ncommand = "y"/);
  assert.match(toml, /^model = "o3"/);
  const cop = JSON.parse(w.get(w.f(...COPILOT))).mcpServers;
  assert.deepEqual(cop.perch.env, { C: "3" });
  assert.deepEqual(cop.perch.tools, ["click"], "the user's tool list was replaced");
  assert.deepEqual(cop.perch.args, [w.server]);
  assert.deepEqual(cop.other, { command: "z" });
});

test("a config it can't parse is never written; the snippet is printed instead", mac, (t) => {
  const w = world(t, { clients: ["copilot"] });
  const commented = `{\n  // my servers\n  "mcpServers": { "other": { "command": "x" } }\n}\n`;
  const half = `{ "mcpServers": { "other": `;
  w.put(w.f(...COPILOT), half);
  w.put(w.f(...CURSOR), commented);
  w.put(w.f(...VSCODE), `{ "servers": [] }`);
  const r = w.run();
  assert.equal(r.status, 0, r.out);
  assert.equal(w.get(w.f(...COPILOT)), half);
  assert.equal(w.get(w.f(...CURSOR)), commented);
  assert.equal(w.get(w.f(...VSCODE)), `{ "servers": [] }`);
  assert.equal((r.out.match(/left alone/g) || []).length, 3, r.out);
  assert.ok(r.out.includes(JSON.stringify(w.server)), "snippet missing");
});

test("--uninstall removes only the entries pointing at this perch", mac, (t) => {
  const w = world(t);
  mkdirSync(w.f(".cursor"));
  assert.equal(w.run().status, 0);
  // Another server, and a perch entry pointing at someone's own checkout, in Cursor.
  const cur = JSON.parse(w.get(w.f(...CURSOR)));
  cur.mcpServers.other = { command: "x" };
  w.put(w.f(...CURSOR), cur);
  w.put(w.f(...VSCODE), { servers: { perch: { command: "node", args: ["/dev/perch/server.js"] }, keep: { command: "y" } } });
  const vsBefore = w.get(w.f(...VSCODE));
  const mark = w.calls().length;
  const r = w.run(["--uninstall"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(!/^(npm|git) /m.test(w.calls().slice(mark)), "uninstall ran npm or git");
  assert.equal(JSON.parse(w.get(w.f(".claude.json"))).mcpServers.perch, undefined);
  assert.ok(!/mcp_servers\.perch/.test(w.get(w.f(...CODEX))));
  assert.deepEqual(JSON.parse(w.get(w.f(...COPILOT))).mcpServers, {});
  assert.deepEqual(JSON.parse(w.get(w.f(...CURSOR))).mcpServers, { other: { command: "x" } });
  assert.equal(w.get(w.f(...VSCODE)), vsBefore, "a perch entry perch didn't write was removed");
  assert.match(r.out, /left alone/);
});

test("--check reports each permission, opens the pane in the background and fails without installing", mac, (t) => {
  const w = world(t);
  const r = w.run(["--check"], {
    FAKE_RUNNING: JSON.stringify(["com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser", "com.example.other"]),
    FAKE_TCC: '{"ax":false,"sr":true}',
    FAKE_PROBE: JSON.stringify({
      "Google Chrome": { auto: "ok", js: "err", msg: "Error: Executing JavaScript through AppleScript is turned off." },
      Safari: { auto: "fail", msg: "Error: Not authorized to send Apple events to Safari. (-1743)" },
      Arc: { auto: "ok", js: "none" },
    }),
  });
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes(ERR.jsOff), r.out);
  assert.ok(r.out.includes(ERR.automation), r.out);
  assert.match(r.out, /Arc[^\n]*no open web page/);
  assert.match(r.out, /FAIL\s+Accessibility/);
  assert.match(r.out, /ok\s+Screen Recording/);
  const opens = w.calls().split("\n").filter((l) => l.startsWith("open "));
  assert.deepEqual(opens.sort(), [
    "open -g x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    "open -g x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  ]);
  assert.ok(!/npm|claude|codex|copilot/.test(w.calls()), w.calls());
});

test("--check passes when everything is granted, and a hung probe is a can't-tell, not a failure", mac, (t) => {
  const w = world(t);
  const ok = w.run(["--check"], { FAKE_RUNNING: '["com.google.Chrome"]' });
  assert.equal(ok.status, 0, ok.out);
  assert.ok(!/^open /m.test(w.calls()));
  const hung = w.run(["--check"], { FAKE_RUNNING: '["com.google.Chrome"]', FAKE_PROBE: '{"Google Chrome":{"hang":true}}', PERCH_CHECK_TIMEOUT_MS: "5000" });
  assert.equal(hung.status, 0, hung.out);
  assert.match(hung.out, /Google Chrome[^\n]*couldn't tell/);
});

test("the install itself never fails on a failed check", mac, (t) => {
  const w = world(t);
  const r = w.run([], { FAKE_RUNNING: '["com.google.Chrome"]', FAKE_TCC: '{"ax":false,"sr":false}' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /FAIL\s+Screen Recording/);
});

test("install.sh keeps the server's permission wording and browser list, and never prompts or moves tabs", () => {
  assert.ok(SRC.includes(JSON.stringify(ERR.jsOff).slice(1, -1)), "ERR.jsOff wording drifted");
  assert.ok(SRC.includes(JSON.stringify(ERR.automation).slice(1, -1)), "ERR.automation wording drifted");
  const list = JSON.parse(SRC.match(/const BROWSERS = (\[.*\]);/)[1]);
  assert.deepEqual(list, BROWSERS.map((b) => [b.app, b.kind, b.bundle]));
  for (const bad of ["AXIsProcessTrustedWithOptions", "CGRequestScreenCaptureAccess", ".activate(", ".select(", "Tab(", "make(", "activeTab =", "currentTab ="])
    assert.ok(!SRC.includes(bad), `install.sh uses ${bad}`);
  assert.ok(existsSync(INSTALL));
});

test("piped into bash, as the README runs it, it installs and checks", mac, (t) => {
  const w = world(t);
  const r = w.run([], {}, { piped: true });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Claude Code \(user scope\): added[\s\S]*Checking permissions/);
  const c = w.run(["--check"], { FAKE_RUNNING: '["com.google.Chrome"]' }, { piped: true });
  assert.equal(c.status, 0, c.out);
  assert.match(c.out, /ok\s+Google Chrome: JavaScript from Apple Events/);
});

test("a symlinked config stays a symlink, and a private one stays private", mac, (t) => {
  const w = world(t, { clients: ["copilot"] });
  const real = w.f("dotfiles", "cursor-mcp.json");
  w.put(real, { mcpServers: { other: { command: "x", env: { TOKEN: "t" } } } });
  chmodSync(real, 0o600);
  mkdirSync(w.f(".cursor"));
  symlinkSync(real, w.f(...CURSOR));
  const r = w.run();
  assert.equal(r.status, 0, r.out);
  assert.ok(lstatSync(w.f(...CURSOR)).isSymbolicLink(), "the symlink was replaced by a file");
  const cfg = JSON.parse(w.get(real)).mcpServers;
  assert.ok(cfg.perch && cfg.other);
  assert.equal(statSync(real).mode & 0o777, 0o600);
});

test("Gemini CLI and opencode: perch is merged into their configs beside other servers, and --uninstall takes it out", mac, (t) => {
  const w = world(t, { clients: ["gemini", "opencode"] });
  w.put(w.f(...GEMINI), { theme: "dark", mcpServers: { other: { command: "x" } } });
  const r = w.run();
  assert.equal(r.status, 0, r.out);
  const gem = JSON.parse(w.get(w.f(...GEMINI)));
  assert.deepEqual(gem.mcpServers.perch, { timeout: 330000, command: "node", args: [w.server] });
  assert.deepEqual([gem.theme, gem.mcpServers.other], ["dark", { command: "x" }]);
  assert.deepEqual(JSON.parse(w.get(w.f(...OPENCODE))).mcp.perch, { type: "local", enabled: true, command: ["node", w.server] });
  const before = [GEMINI, OPENCODE].map((p) => w.get(w.f(...p)));
  assert.equal(w.run().status, 0);
  assert.deepEqual([GEMINI, OPENCODE].map((p) => w.get(w.f(...p))), before, "second run rewrote a config");
  const u = w.run(["--uninstall"]);
  assert.equal(u.status, 0, u.out);
  assert.deepEqual(JSON.parse(w.get(w.f(...GEMINI))).mcpServers, { other: { command: "x" } });
  assert.deepEqual(JSON.parse(w.get(w.f(...OPENCODE))).mcp, {});
});

test("an opencode config with comments is left alone and gets the snippet", mac, (t) => {
  const w = world(t, { clients: ["opencode"] });
  const jsonc = `{\n  // mine\n  "mcp": {}\n}\n`;
  w.put(w.f(...OPENCODE), jsonc);
  const r = w.run();
  assert.equal(r.status, 0, r.out);
  assert.equal(w.get(w.f(...OPENCODE)), jsonc);
  assert.match(r.out, /opencode: left alone/);
});
