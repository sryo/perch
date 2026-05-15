#!/usr/bin/env bash
# perch installer — clones, installs deps, registers as an MCP server in Claude Code.
# Re-runnable: skips clone if already present, idempotent registration.
#
# Overrides:
#   PERCH_REPO=...   git URL to clone from
#   PERCH_DIR=...    install location (default: ~/.perch)
#   PERCH_SCOPE=...  Claude Code scope: user | local | project (default: user)

set -euo pipefail

PERCH_REPO="${PERCH_REPO:-https://github.com/sryo/perch.git}"
PERCH_DIR="${PERCH_DIR:-$HOME/.perch}"
PERCH_SCOPE="${PERCH_SCOPE:-user}"

[[ "$(uname -s)" == "Darwin" ]] || { echo "perch only works on macOS." >&2; exit 1; }

command -v git >/dev/null || { echo "git not found. Run: xcode-select --install" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found. Install Node 18+ from https://nodejs.org" >&2; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 18 ]] || { echo "node $node_major < 18. Upgrade Node." >&2; exit 1; }
command -v claude >/dev/null || { echo "claude CLI not found. Install Claude Code first: https://claude.com/claude-code" >&2; exit 1; }

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

echo "Registering perch in Claude Code ($PERCH_SCOPE scope)..."
claude mcp remove perch --scope "$PERCH_SCOPE" 2>/dev/null || true
claude mcp add perch --scope "$PERCH_SCOPE" -- node "$PERCH_DIR/server.js"

cat <<EOF

perch installed at $PERCH_DIR

Two one-time permissions before perch can drive your browser:

1. In each browser you'll use:
   - Chrome / Brave / Edge / Vivaldi / Arc: View > Developer > Allow JavaScript from Apple Events
   - Safari: Preferences > Advanced > Show Develop menu, then Develop > Allow JavaScript from Apple Events

2. macOS Automation: System Settings > Privacy & Security > Automation
   The first perch call surfaces an OS prompt — tick the target browser under
   Claude Code / Terminal / iTerm (whichever launched perch).

Restart Claude Code. Verify with /mcp — you should see perch connected.
EOF
