# perch

MCP server for driving the macOS browser the user already has open. Chrome family + Safari, via AppleScript/JXA. Built for [avis](https://github.com/sryo/avis). It also lets [figma-cdp](https://github.com/sryo/figma-cdp) work in your open Figma tabs without Chrome asking you to allow remote debugging.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/sryo/perch/main/install.sh | bash
```

The installer sets perch up in Claude Code, Codex and GitHub Copilot when it finds them; for anything else it prints config to paste. perch needs an agent running on your Mac, so cloud agents can't use it. Restart your client; `perch` should appear in its MCP listing.
