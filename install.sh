#!/usr/bin/env bash
# perch installer — clones, installs deps, registers as an MCP server in every
# client CLI it finds: Claude Code, Codex, GitHub Copilot, Gemini CLI, opencode.
# Re-runnable: skips clone if already present, idempotent registration.
#
# Overrides:
#   PERCH_REPO=...   git URL to clone from
#   PERCH_DIR=...    install location (default: ~/.perch)
#   PERCH_SCOPE=...  Claude Code scope: user | local | project (default: user)

set -euo pipefail

# merge_json FILE KEY NAME ENTRY_JSON: sets FILE[KEY][NAME] = ENTRY. Refuses a
# file that isn't a JSON object rather than replacing it, writes through a temp
# file and rename, and leaves an unchanged file untouched.
merge_json() {
  MJ_FILE="$1" MJ_KEY="$2" MJ_NAME="$3" MJ_ENTRY="$4" node -e '
    const fs = require("fs"), path = require("path"), e = process.env, f = e.MJ_FILE;
    let text = null, cfg = {};
    try { text = fs.readFileSync(f, "utf8"); } catch (err) { if (err.code !== "ENOENT") throw err; }
    if (text !== null && text.trim()) {
      try { cfg = JSON.parse(text); } catch { cfg = null; }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        console.error(`${f} is not a JSON object; left it alone. Add perch by hand.`);
        process.exit(1);
      }
    }
    const box = cfg[e.MJ_KEY];
    if (box !== undefined && (!box || typeof box !== "object" || Array.isArray(box))) {
      console.error(`${f}: "${e.MJ_KEY}" is not an object; left it alone. Add perch by hand.`);
      process.exit(1);
    }
    cfg[e.MJ_KEY] = Object.assign({}, box, { [e.MJ_NAME]: JSON.parse(e.MJ_ENTRY) });
    const out = JSON.stringify(cfg, null, 2) + "\n";
    if (out === text) process.exit(0);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.perch-${process.pid}.tmp`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, f);
  '
}
[[ "${PERCH_INSTALL_LIB:-}" == "1" ]] && return 0

PERCH_REPO="${PERCH_REPO:-https://github.com/sryo/perch.git}"
PERCH_DIR="${PERCH_DIR:-$HOME/.perch}"
PERCH_SCOPE="${PERCH_SCOPE:-user}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "perch only works on macOS." >&2; exit 1; }

command -v git >/dev/null || { echo "git not found. Run: xcode-select --install" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found. Install Node 20+ from https://nodejs.org" >&2; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 20 ]] || { echo "node $node_major < 20. Upgrade Node." >&2; exit 1; }
HAS_CLAUDE=0; HAS_CODEX=0; HAS_COPILOT=0; HAS_GEMINI=0; HAS_OPENCODE=0
command -v claude >/dev/null && HAS_CLAUDE=1
command -v codex >/dev/null && HAS_CODEX=1
command -v copilot >/dev/null && HAS_COPILOT=1
command -v gemini >/dev/null && HAS_GEMINI=1
command -v opencode >/dev/null && HAS_OPENCODE=1
if [[ "$HAS_CLAUDE$HAS_CODEX$HAS_COPILOT$HAS_GEMINI$HAS_OPENCODE" == "00000" ]]; then
  echo "No claude, codex, copilot, gemini or opencode CLI found; config snippets will be printed for manual paste."
fi

if [[ -f "$PERCH_DIR/server.js" ]]; then
  if [[ -d "$PERCH_DIR/.git" ]]; then
    echo "perch already at $PERCH_DIR — pulling latest..."
    git -C "$PERCH_DIR" pull --ff-only
  else
    echo "perch already at $PERCH_DIR (local, no git repo — skipping pull)..."
  fi
else
  echo "Cloning perch to $PERCH_DIR..."
  git clone "$PERCH_REPO" "$PERCH_DIR"
fi

echo "Installing dependencies..."
(cd "$PERCH_DIR" && npm install --silent)

if [[ "$HAS_CLAUDE" == "1" ]]; then
  echo "Registering perch in Claude Code ($PERCH_SCOPE scope)..."
  claude mcp remove perch --scope "$PERCH_SCOPE" 2>/dev/null || true
  claude mcp add perch --scope "$PERCH_SCOPE" -- node "$PERCH_DIR/server.js"
fi

# Codex and Copilot cut tool calls at 60s and 30s by default; eval_js may await
# up to 300s, so both entries get a longer tool timeout.
if [[ "$HAS_CODEX" == "1" ]]; then
  echo "Registering perch in Codex..."
  codex mcp remove perch >/dev/null 2>&1 || true
  codex mcp add perch -- node "$PERCH_DIR/server.js"
  CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml" node -e '
    const fs = require("fs"), f = process.env.CODEX_CONFIG;
    const s = fs.readFileSync(f, "utf8"), head = "[mcp_servers.perch]\n";
    const at = s.indexOf(head);
    if (at < 0) process.exit(0);
    const end = s.indexOf("\n[", at + head.length);
    if (/tool_timeout_sec/.test(s.slice(at, end < 0 ? s.length : end))) process.exit(0);
    fs.writeFileSync(f, s.slice(0, at + head.length) + "tool_timeout_sec = 330\n" + s.slice(at + head.length));
  '
fi

if [[ "$HAS_COPILOT" == "1" ]]; then
  echo "Registering perch in GitHub Copilot..."
  merge_json "${COPILOT_HOME:-$HOME/.copilot}/mcp-config.json" mcpServers perch "$(PD="$PERCH_DIR" node -p \
    'JSON.stringify({ type: "local", command: "node", args: [process.env.PD + "/server.js"], tools: ["*"], timeout: 330000 })')" || true
fi

if [[ "$HAS_GEMINI" == "1" ]]; then
  echo "Registering perch in Gemini CLI..."
  gemini mcp remove --scope user perch >/dev/null 2>&1 || true
  gemini mcp add --scope user --timeout 330000 perch node "$PERCH_DIR/server.js" >/dev/null || true
fi

if [[ "$HAS_OPENCODE" == "1" ]]; then
  echo "Registering perch in opencode..."
  merge_json "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json" mcp perch "$(PD="$PERCH_DIR" node -p \
    'JSON.stringify({ type: "local", command: ["node", process.env.PD + "/server.js"], enabled: true })')" || true
fi

cat <<EOF

perch installed at $PERCH_DIR

Two one-time permissions before perch can drive your browser:

1. In each browser you'll use:
   - Chrome / Brave / Edge / Vivaldi / Arc: View > Developer > Allow JavaScript from Apple Events
   - Safari: Preferences > Advanced > Show Develop menu, then Develop > Allow JavaScript from Apple Events

2. macOS Automation: System Settings > Privacy & Security > Automation
   The first perch call surfaces an OS prompt — tick the target browser under
   the app that launched perch (Terminal, iTerm, VS Code, Claude, Codex...).

For other MCP-capable clients, register perch by hand:

  Codex — append to ~/.codex/config.toml:
    [mcp_servers.perch]
    command = "node"
    args = ["$PERCH_DIR/server.js"]
    tool_timeout_sec = 330

  Cursor / generic MCP — merge into ~/.cursor/mcp.json (or equivalent):
    {
      "mcpServers": {
        "perch": {
          "command": "node",
          "args": ["$PERCH_DIR/server.js"]
        }
      }
    }

Restart your MCP client and check its MCP list (/mcp in Claude Code or Copilot,
codex mcp list): you should see perch connected.
EOF
