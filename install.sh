#!/usr/bin/env bash
# perch installer: clones, installs deps, registers perch as an MCP server in each
# client it finds (Claude Code, Codex, GitHub Copilot, Gemini CLI, opencode, Cursor,
# VS Code), then checks
# the permissions perch needs. Re-runnable: an entry already right is left as is.
#
#   install.sh              install or update, then check permissions
#   install.sh --check      only check permissions
#   install.sh --uninstall  remove the client entries pointing at this perch
#
# Overrides:
#   PERCH_REPO=...   git URL to clone from
#   PERCH_DIR=...    install location (default: ~/.perch)
#   PERCH_SCOPE=...  Claude Code scope: user | local | project (default: user)

set -euo pipefail

MODE=install
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  --uninstall) MODE=uninstall ;;
  *) echo "usage: install.sh [--check | --uninstall]" >&2; exit 2 ;;
esac

PERCH_REPO="${PERCH_REPO:-https://github.com/sryo/perch.git}"
PERCH_DIR="${PERCH_DIR:-$HOME/.perch}"
PERCH_SCOPE="${PERCH_SCOPE:-user}"
export PERCH_DIR PERCH_SCOPE

[[ "$(uname -s)" == "Darwin" ]] || { echo "perch only works on macOS." >&2; exit 1; }
command -v node >/dev/null || { echo "node not found. Install Node 20+ from https://nodejs.org" >&2; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 20 ]] || { echo "node $node_major < 20. Upgrade Node." >&2; exit 1; }

# Client registration and the permission check. Config files are only written when
# they parse as JSON objects, and re-read just before the write; anything else gets
# the snippet printed for a manual paste.
IFS= read -r -d '' PERCH_JS <<'JS' || true
const fs = require("fs"), path = require("path"), cp = require("child_process");
const HOME = process.env.HOME, DIR = process.env.PERCH_DIR, SCOPE = process.env.PERCH_SCOPE || "user";
const SERVER = path.join(DIR, "server.js");
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const canon = (v) => Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const ours = (e) => isObj(e) && ((Array.isArray(e.args) && e.args[0] === SERVER) || (Array.isArray(e.command) && e.command[1] === SERVER));
const say = (label, what) => console.log(`  ${label}: ${what}`);
const has = (cmd) => cp.spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
const run = (cmd, args) => {
  const r = cp.spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60000 });
  return { ok: r.status === 0, err: ((r.stderr || "") + (r.stdout || "")).trim() || String(r.error || "") };
};
// The rename lands on the symlink's target, with the file's own mode (configs can hold tokens).
function writeIfUnchanged(file, raw, text) {
  const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (now !== raw) return false;
  const real = now === null ? file : fs.realpathSync(file);
  const mode = now === null ? 0o644 : fs.statSync(real).mode & 0o777;
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const tmp = `${real}.perch-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, real);
  return true;
}
function readJson(file, key) {
  if (!fs.existsSync(file)) return { cfg: {}, raw: null };
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return { cfg: {}, raw };
  let cfg;
  try { cfg = JSON.parse(raw); } catch { return { raw, why: "is not plain JSON (comments, or a half-written edit)" }; }
  if (!isObj(cfg)) return { raw, why: "is not a JSON object" };
  if (cfg[key] !== undefined && !isObj(cfg[key])) return { raw, why: `has a "${key}" that is not an object` };
  return { cfg, raw };
}
const snippet = (key, entry) => JSON.stringify({ [key]: { perch: entry } }, null, 2).replace(/^/gm, "      ");

// One JSON client: Added, Updated (the user's other keys kept), Unchanged, or left alone.
function jsonClient(label, file, key, entry, defaults = {}) {
  const r = readJson(file, key);
  if (r.why) return say(label, `left alone: ${file} ${r.why}. Add perch under "${key}" yourself:\n${snippet(key, { ...defaults, ...entry })}`);
  const servers = r.cfg[key] || {};
  const old = servers.perch;
  const want = isObj(old) ? { ...defaults, ...old, ...entry } : { ...defaults, ...entry };
  if (isObj(old) && same(old, want)) return say(label, "unchanged");
  r.cfg[key] = { ...servers, perch: want };
  if (!writeIfUnchanged(file, r.raw, JSON.stringify(r.cfg, null, 2) + "\n")) return say(label, `left alone: ${file} changed while perch was reading it; run the installer again`);
  say(label, isObj(old) ? "updated, kept its other settings" : "added");
}
function jsonUninstall(label, file, key) {
  if (!fs.existsSync(file)) return;
  const r = readJson(file, key);
  if (r.why) return say(label, `left alone: ${file} ${r.why}; remove perch there yourself if it's listed`);
  const old = (r.cfg[key] || {}).perch;
  if (old === undefined) return;
  if (!ours(old)) return say(label, "left alone: its perch entry points at another copy of perch");
  delete r.cfg[key].perch;
  if (!writeIfUnchanged(file, r.raw, JSON.stringify(r.cfg, null, 2) + "\n")) return say(label, `left alone: ${file} changed while perch was reading it`);
  say(label, "removed");
}

// Claude Code: read the entry from its own config, so a re-add keeps env and the rest.
function claudeEntry() {
  const project = SCOPE === "project";
  const file = project ? path.resolve(".mcp.json") : path.join(process.env.CLAUDE_CONFIG_DIR || HOME, ".claude.json");
  if (!fs.existsSync(file)) return {};
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return { entry: SCOPE === "local" ? c.projects?.[process.cwd()]?.mcpServers?.perch : c.mcpServers?.perch };
  } catch { return { why: `couldn't read ${file}` }; }
}
function claudeInstall() {
  const label = `Claude Code (${SCOPE} scope)`, base = { type: "stdio", command: "node", args: [SERVER] };
  const { entry, why } = claudeEntry();
  const manual = (w) => `claude mcp add-json perch '${JSON.stringify(w)}' --scope ${SCOPE}`;
  if (why) return say(label, `left alone: ${why}. Register it yourself:\n      ${manual(base)}`);
  if (isObj(entry) && entry.command === "node" && same(entry.args, [SERVER])) return say(label, "unchanged");
  const want = isObj(entry) ? { ...entry, command: "node", args: [SERVER] } : base;
  if (isObj(entry)) {
    const rm = run("claude", ["mcp", "remove", "perch", "--scope", SCOPE]);
    if (!rm.ok) return say(label, `left alone: claude mcp remove failed (${rm.err}). Register it yourself:\n      ${manual(want)}`);
  }
  const add = run("claude", ["mcp", "add-json", "perch", JSON.stringify(want), "--scope", SCOPE]);
  if (!add.ok) return say(label, `failed: ${add.err}. Register it yourself:\n      ${manual(want)}`);
  say(label, isObj(entry) ? "updated, kept its other settings" : "added");
}
function claudeUninstall() {
  const label = `Claude Code (${SCOPE} scope)`, { entry } = claudeEntry();
  if (entry === undefined) return;
  if (!ours(entry)) return say(label, "left alone: its perch entry points at another copy of perch");
  const rm = run("claude", ["mcp", "remove", "perch", "--scope", SCOPE]);
  say(label, rm.ok ? "removed" : `failed: ${rm.err}`);
}

// Codex: edit only the command, args and timeout lines of [mcp_servers.perch], so env
// subtables and any other key stay. Codex cuts tool calls at 60s by default; eval_js
// may await up to 300s.
const CODEX = path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "config.toml");
const CODEX_LINES = { command: `command = "node"`, args: `args = [${JSON.stringify(SERVER)}]`, tool_timeout_sec: "tool_timeout_sec = 330" };
const CODEX_SNIPPET = ["[mcp_servers.perch]", ...Object.values(CODEX_LINES)].join("\n").replace(/^/gm, "      ");
function codexSection(s) {
  const m = /^\[mcp_servers\.perch\][ \t]*(#.*)?$/m.exec(s);
  if (!m) return null;
  const start = m.index + m[0].length, n = s.slice(start).search(/^[ \t]*\[/m);
  return { start, end: n < 0 ? s.length : start + n };
}
const codexLine = (body, key) => new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m").exec(body);
function codexArgs(body) {
  const m = codexLine(body, "args");
  try { return m && JSON.parse(m[0].replace(/^[^=]*=/, "")); } catch { return undefined; }
}
function codexInstall() {
  const label = "Codex";
  let raw = fs.existsSync(CODEX) ? fs.readFileSync(CODEX, "utf8") : "";
  let sec = codexSection(raw), added = false;
  if (!sec) {
    const add = run("codex", ["mcp", "add", "perch", "--", "node", SERVER]);
    raw = fs.existsSync(CODEX) ? fs.readFileSync(CODEX, "utf8") : "";
    sec = add.ok && codexSection(raw);
    if (!sec) return say(label, `failed: ${add.err || "no [mcp_servers.perch] after codex mcp add"}. Add to ${CODEX}:\n${CODEX_SNIPPET}`);
    added = true;
  }
  let body = raw.slice(sec.start, sec.end);
  if (codexLine(body, "args") && codexArgs(body) === undefined) return say(label, `left alone: perch's args in ${CODEX} span lines. Set them to:\n      ${CODEX_LINES.args}`);
  for (const [key, line] of Object.entries(CODEX_LINES)) {
    const m = codexLine(body, key);
    if (key === "tool_timeout_sec" && m) continue;
    body = m ? body.slice(0, m.index) + line + body.slice(m.index + m[0].length) : "\n" + line + body;
  }
  const text = raw.slice(0, sec.start) + body + raw.slice(sec.end);
  if (text === raw) return say(label, added ? "added" : "unchanged");
  if (!writeIfUnchanged(CODEX, raw, text)) return say(label, `left alone: ${CODEX} changed while perch was reading it; run the installer again`);
  say(label, added ? "added" : "updated, kept its other settings");
}
function codexUninstall() {
  if (!fs.existsSync(CODEX)) return;
  const raw = fs.readFileSync(CODEX, "utf8"), sec = codexSection(raw);
  if (!sec) return;
  if (!same(codexArgs(raw.slice(sec.start, sec.end)), [SERVER])) return say("Codex", "left alone: its perch entry points at another copy of perch");
  const rm = run("codex", ["mcp", "remove", "perch"]);
  say("Codex", rm.ok ? "removed" : `failed: ${rm.err}`);
}

// Copilot cuts tool calls at 30s by default, Gemini CLI at 10 minutes.
const COPILOT = path.join(process.env.COPILOT_HOME || path.join(HOME, ".copilot"), "mcp-config.json");
const GEMINI = path.join(process.env.GEMINI_CLI_HOME || HOME, ".gemini", "settings.json");
const OPENCODE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "opencode", "opencode.json");
const CURSOR_DIR = path.join(HOME, ".cursor"), VSCODE_DIR = path.join(HOME, "Library", "Application Support", "Code", "User");
const entry = { command: "node", args: [SERVER] };

function clients(uninstall) {
  const found = [];
  if (has("claude")) { found.push(1); uninstall ? claudeUninstall() : claudeInstall(); }
  if (has("codex")) { found.push(1); uninstall ? codexUninstall() : codexInstall(); }
  if (has("copilot")) {
    found.push(1);
    uninstall ? jsonUninstall("GitHub Copilot", COPILOT, "mcpServers")
      : jsonClient("GitHub Copilot", COPILOT, "mcpServers", entry, { type: "local", tools: ["*"], timeout: 330000 });
  }
  if (has("gemini")) {
    found.push(1);
    uninstall ? jsonUninstall("Gemini CLI", GEMINI, "mcpServers")
      : jsonClient("Gemini CLI", GEMINI, "mcpServers", entry, { timeout: 330000 });
  }
  if (has("opencode")) {
    found.push(1);
    uninstall ? jsonUninstall("opencode", OPENCODE, "mcp")
      : jsonClient("opencode", OPENCODE, "mcp", { command: ["node", SERVER] }, { type: "local", enabled: true });
  }
  if (fs.existsSync(CURSOR_DIR)) {
    found.push(1);
    uninstall ? jsonUninstall("Cursor", path.join(CURSOR_DIR, "mcp.json"), "mcpServers")
      : jsonClient("Cursor", path.join(CURSOR_DIR, "mcp.json"), "mcpServers", entry);
  }
  if (fs.existsSync(VSCODE_DIR)) {
    found.push(1);
    uninstall ? jsonUninstall("VS Code", path.join(VSCODE_DIR, "mcp.json"), "servers")
      : jsonClient("VS Code", path.join(VSCODE_DIR, "mcp.json"), "servers", entry, { type: "stdio" });
  }
  if (!found.length && !uninstall) console.log(`  No MCP client found. Register perch in yours by hand:\n${snippet("mcpServers", entry)}`);
}

// Permission check. Reads only: no Apple Event to a browser that isn't running (JXA
// would launch it), only the tab each window already shows, and never the prompting
// variants of the Accessibility and Screen Recording checks.
const BROWSERS = [["Google Chrome","chrome","com.google.Chrome"],["Google Chrome Beta","chrome","com.google.Chrome.beta"],["Google Chrome Canary","chrome","com.google.Chrome.canary"],["Brave Browser","chrome","com.brave.Browser"],["Microsoft Edge","chrome","com.microsoft.edgemac"],["Vivaldi","chrome","com.vivaldi.Vivaldi"],["Helium","chrome","net.imput.helium"],["Arc","arc","company.thebrowser.Browser"],["Safari","safari","com.apple.Safari"]];
const ERR_JS_OFF = "JavaScript-from-AppleEvents is off. Enable it: Chromium-family → View > Developer > Allow JavaScript from Apple Events. Safari → Settings > Advanced > Show Develop menu, then Develop > Allow JavaScript from Apple Events.";
const ERR_AUTOMATION = "Automation permission denied. Grant it in System Settings > Privacy & Security > Automation, ticking the target browser under the app running perch.";
const PANE = (p) => `x-apple.systempreferences:com.apple.preference.security?Privacy_${p}`;
const JS_OFF_RE = /Allow JavaScript from Apple Events|JavaScript through AppleScript is turned off|JavaScript from Apple events is turned off/i;
const AUTOMATION_RE = /Not authorized to send Apple events|errAEEventNotPermitted|-1743/i;
const LIMIT = Number(process.env.PERCH_CHECK_TIMEOUT_MS) || 30000;
function osa(script, arg) {
  const r = cp.spawnSync("osascript", ["-l", "JavaScript", "-e", script, ...(arg ? [arg] : [])],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: LIMIT, killSignal: "SIGKILL" });
  if (r.error || r.signal) return { hung: true };
  try { return JSON.parse(r.stdout.trim()); } catch { return { err: (r.stderr || r.stdout).trim() }; }
}
const RUNNING = `ObjC.import("AppKit"); JSON.stringify(ObjC.deepUnwrap($.NSWorkspace.sharedWorkspace.runningApplications.valueForKey("bundleIdentifier")).filter(Boolean))`;
const TCC = `ObjC.import("ApplicationServices"); ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); JSON.stringify({ ax: !!$.AXIsProcessTrusted(), sr: !!$.CGPreflightScreenCaptureAccess() })`;
const PROBE = `function run(argv) {
  const a = JSON.parse(argv[0]), app = Application(a.name);
  let n;
  try { n = app.windows.length; } catch (e) { return JSON.stringify({ auto: "fail", msg: String(e) }); }
  for (let i = 0; i < n; i++) {
    let tab, url;
    try { const w = app.windows[i]; tab = a.kind === "safari" ? w.currentTab : w.activeTab; url = tab.url(); } catch (e) { continue; }
    if (!/^(https?:|file:|about:blank)/.test(url || "")) continue;
    try { a.kind === "safari" ? app.doJavaScript("1", { in: tab }) : tab.execute({ javascript: "1" }); return JSON.stringify({ auto: "ok", js: "ok" }); }
    catch (e) { return JSON.stringify({ auto: "ok", js: "err", msg: String(e) }); }
  }
  return JSON.stringify({ auto: "ok", js: "none" });
}`;
function check() {
  const host = process.env.__CFBundleIdentifier || process.env.TERM_PROGRAM || "this terminal";
  console.log(`Checking permissions (macOS grants them per app; this check runs as ${host}):`);
  let failed = 0;
  const panes = new Set();
  const row = (state, what, help) => {
    console.log(`  ${state.padEnd(5)} ${what}`);
    if (help) console.log(`        ${help}`);
  };
  const fail = (what, help, pane) => { failed++; row("FAIL", what, help); if (pane) panes.add(pane); };
  const running = osa(RUNNING);
  const open = Array.isArray(running) ? BROWSERS.filter(([, , id]) => running.includes(id)) : [];
  if (!Array.isArray(running)) row("?", "Browsers: couldn't list running apps");
  else if (!open.length) row("?", "Browsers: none running; open the one you'll use and run the check again");
  for (const [name, kind] of open) {
    const p = osa(PROBE, JSON.stringify({ name, kind }));
    if (p.hung) { row("?", `${name}: couldn't tell (no answer; answer any macOS prompt, then run the check again)`); continue; }
    if (p.auto !== "ok") {
      if (AUTOMATION_RE.test(p.msg || p.err || "")) fail(`${name}: Automation`, ERR_AUTOMATION, PANE("Automation"));
      else row("?", `${name}: couldn't tell (${(p.msg || p.err || "no answer").slice(0, 160)})`);
      continue;
    }
    row("ok", `${name}: Automation`);
    if (p.js === "ok") row("ok", `${name}: JavaScript from Apple Events`);
    else if (p.js === "none") row("?", `${name}: no open web page to test JavaScript on; open one and run the check again`);
    else if (JS_OFF_RE.test(p.msg || "")) fail(`${name}: JavaScript from Apple Events`, ERR_JS_OFF);
    else row("?", `${name}: JavaScript from Apple Events: couldn't tell (${(p.msg || "").slice(0, 160)})`);
  }
  const t = osa(TCC);
  if (typeof t.ax !== "boolean") row("?", "Accessibility and Screen Recording: couldn't tell");
  else {
    if (t.ax) row("ok", "Accessibility");
    else fail("Accessibility", "Needed for trusted clicks and key presses, element screenshots and dialogs. Grant it in System Settings > Privacy & Security > Accessibility, ticking the app running your agent.", PANE("Accessibility"));
    if (t.sr) row("ok", "Screen Recording");
    else fail("Screen Recording", "Needed for screenshots. Grant it in System Settings > Privacy & Security > Screen & System Audio Recording, ticking the app running your agent.", PANE("ScreenCapture"));
  }
  for (const url of panes) cp.spawnSync("open", ["-g", url], { stdio: "ignore", timeout: 10000 });
  if (panes.size) console.log("  The matching System Settings panes are open behind this window.");
  return failed;
}

const cmd = process.argv[1];
if (cmd === "clients") clients(false);
else if (cmd === "uninstall") clients(true);
else if (cmd === "check") process.exit(check() ? 1 : 0);
JS
perch_js() { node -e "$PERCH_JS" "$@" </dev/null; }

if [[ "$MODE" == "check" ]]; then
  perch_js check
  exit $?
fi

if [[ "$MODE" == "uninstall" ]]; then
  echo "Removing perch from MCP clients (only entries pointing at $PERCH_DIR/server.js)..."
  perch_js uninstall
  echo
  echo "perch's files are still at $PERCH_DIR; delete that folder to remove them too."
  exit 0
fi

command -v git >/dev/null || { echo "git not found. Run: xcode-select --install" >&2; exit 1; }

if [[ -f "$PERCH_DIR/server.js" ]]; then
  if [[ -d "$PERCH_DIR/.git" ]]; then
    echo "perch already at $PERCH_DIR, pulling latest..."
    git -C "$PERCH_DIR" pull --ff-only </dev/null
  else
    echo "perch already at $PERCH_DIR (local, no git repo, skipping pull)..."
  fi
else
  echo "Cloning perch to $PERCH_DIR..."
  git clone "$PERCH_REPO" "$PERCH_DIR" </dev/null
fi

echo "Installing dependencies..."
(cd "$PERCH_DIR" && npm install --silent </dev/null)

echo
echo "Registering perch:"
perch_js clients

echo
perch_js check || true

cat <<EOF

perch installed at $PERCH_DIR

Restart your MCP client and check its MCP list (/mcp in Claude Code or Copilot,
codex mcp list): you should see perch connected.

Check permissions again any time:  bash $PERCH_DIR/install.sh --check
Remove perch from your clients:    bash $PERCH_DIR/install.sh --uninstall
EOF
