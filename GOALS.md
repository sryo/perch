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
  (`screenshot {raise:true}`, `activate_tab`, trusted input with `raise`).
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

### Trusted input (2026-05): foreground CGEventPostToPid
- ❌ Bridge-style background activation — `CGEvent.tapCreateForPid` needs a
  C function-pointer callback to suppress focus-switch messages; JXA can't
  construct one. Would force a compiled helper binary and break single-file.
- ✅ Foreground `click {trusted:true}` / `fill {trusted:true}` via
  `$.CGEventPostToPid`. Adds Accessibility permission. `raise: true` opt-in
  mirrors `screenshot{raise:true}`. See AGENTS.md "Trusted input via
  CGEventPostToPid" for the field table.

### Surface diet and runtime (2026-09): fewer tools, fewer tokens, one runtime
- ✅ 17 tools became 15: `get_html` folded into `get_text {html}`, and the
  old page-state tool into the `accessibility_snapshot` header (neither
  consumer used it). Unused params dropped. Shared guidance moved to server
  `instructions`. `tools/list` went from 14,465 to about 7,500 chars, enforced
  by `SCHEMA_BUDGET`.
- ✅ Snapshot switched to a line format (`ref role "name" key=json flags`),
  about 30% smaller on form pages; `list_tabs` always returns `{tabs,total}`,
  capped at 50 rows.
- ✅ JXA moved from string templates to one `jxaRuntime()` function shipped as
  the daemon prelude, so it's parse-checked and unit-tested under `node:vm`.
  Targeting reads one CGWindowList instead of querying System Events.
- ✅ TDD: `npm test` (node:test, happy-dom as a devDependency) runs without a
  browser; `npm run smoke` and `scripts/bench.mjs` run against a live one.
- ❌ Splitting server.js into modules. Rejected to keep the single-file rule;
  the test seams are exports plus a realpath start guard instead.
