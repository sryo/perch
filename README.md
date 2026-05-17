# perch

MCP server for driving the macOS browser the user already has open. Chrome family + Safari, via AppleScript/JXA. Built for [avis](https://github.com/sryo/avis).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/sryo/perch/main/install.sh | bash
```

The installer detects supported client CLIs and registers automatically; otherwise it prints paste-ready MCP config. Restart your client; `perch` should appear in its MCP listing.
