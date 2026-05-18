# perch — goals

## What perch is
A macOS MCP server that drives the browser the user already has open.
Built for [avis](https://github.com/sryo/avis). Useful to any client that
needs background browser automation without installing anything in the browser.

## Goals
- **Drive the user's already-open browser.** No relaunch, no separate
  profile, no debug port.
- **Background-friendly by default.** The user owns the foreground. perch
  doesn't activate apps or steal focus unless a tool explicitly opts in
  (`screenshot {raise:true}`, `activate_tab`, `open_devtools`).
- **Cross-browser within macOS.** Chrome family, Arc, Safari. Per-browser
  quirks live behind the same tool API.
- **Cheap on agent tokens.** Large payloads (file bytes, long text) stay
  out of agent tool args — perch reads them from disk and ships to the
  page itself.
- **Minimum install surface.** Single-file server, one runtime dependency,
  one-command install.

## Non-goals
- Chrome DevTools Protocol or `--remote-debugging-port`.
- A browser extension.
- Playwright/Puppeteer-level DOM automation.
- Multi-browser concurrent driving.
- See `AGENTS.md` "Ceiling" for the deeper list of AppleScript limits
  (network interception, pre-load instrumentation, console subscription).

## Decisions on record

### File uploads (2026-05): server-side base64 + DataTransfer
- ❌ OS file dialog via keystrokes — focus stealing, violates Background-friendly.
- ❌ Localhost HTTP server + page fetch — Chrome 142 LNA permission prompt
  breaks the silent-background goal.
- ❌ claude-in-chrome — Chrome-only, no Arc/Safari.
- ✅ Server-side base64 in `file_upload` — perch reads the file, encodes
  in Node, ships through the AppleScript bridge in one `eval_js`. The
  ~80 KB bridge transit is the price for background-only + browser-agnostic.
