# perch

Architecture and invariants for the perch MCP server.

perch exposes MCP tools for driving macOS browsers — tab management, navigation, JS evaluation, condition waits, screenshots, DOM extraction. It shells out to `osascript -l JavaScript` and uses each browser's AppleScript dictionary. No browser extension, no debug ports. The current tool surface is the `TOOLS` array in `server.js`; `SKILL.md` mirrors it for skill authors.

## Layout

```
.
├── server.js     # single-file MCP server
├── install.sh    # macOS installer — clones, npm install, registers via `claude mcp add`
├── package.json  # one dep: @modelcontextprotocol/sdk
├── README.md     # public-facing intro + install
├── SKILL.md      # usage reference for skill authors and agents using perch
├── AGENTS.md     # this file
├── CLAUDE.md     # pointer to AGENTS.md
└── LICENSE
```

## Architecture

```
MCP client (Claude Code, etc.) <--stdio--> server.js <--osascript--> Chrome / Safari / Brave / Edge / Arc / Vivaldi
```

JXA scripts are built as strings and passed to `osascript -l JavaScript -e <script>` via `execFile`. User JS is embedded via `JSON.stringify` and wrapped in an IIFE that JSON-stringifies its return; errors come back as `{__perch_error: msg}`. Tab targeting goes through `targetClause(target)`, which walks `BROWSERS`, prefers the frontmost app, and binds `tab`, `tab_kind`, `tab_app`, `tab_window` for downstream snippets. Chrome-family tabs use `tab.execute({javascript: code})`; Safari uses `Application('Safari').doJavaScript(code, {in: tab})`. Both are synchronous.

**JXA access patterns.** Collections are always read lazily — `app.windows[i]` and `win.tabs[i]`, never `app.windows()` or `win.tabs()`. The called form unwraps to a plain Array on some browsers (Chrome) but loses the bridge context on others (Arc), making subsequent property chains throw "cannot convert types." Multi-tab reads use bulk property access — `win.tabs.url()` returns all URLs in one call, ~30× faster than per-tab loops and the difference between working and timing out on Arc windows with hundreds of tabs.

**Arc-specific quirks.** Arc shares Chrome's `tab.execute` verb but auto-applies `JSON.stringify` to whatever value the executed function returns. perch's wrappers already JSON-stringify, so Arc's bridge double-encodes; the Arc dispatch path unwraps one layer before handing the value back to the caller. Arc also can't return window geometry — `position()`, `size()`, and `bounds()` all throw — so `screenshot` falls back to the System Events accessibility frame, which works for any visible window. Active-tab detection on Arc isn't implemented either; callers pass `tabIndex` explicitly or accept tab 0.

**Screenshot geometry order.** `position()` + `size()` (Chrome), then `bounds()` (Safari), then System Events `processes.byName(app).windows[0].position()` + `.size()` as a final accessibility-API fallback. `screencapture -R` reads pixels at the screen rect, so the target window must be on top — handled by the default `raise: true`.

**Tab indices are positional, not identifiers.** `tabIndex` reflects a tab's current position in its window — opening or closing other tabs shifts every index after them. Callers that cache a `tabIndex` from one `list_tabs` call and use it minutes later will race with the user. Re-target by URL match (or by re-listing) when in doubt. `new_tab` returns the index of the tab it just created, but only as a hint; treat it as valid only for the immediate next call.

## Browser support

| Browser | JS eval | Navigation | New/close/activate tab | Notes |
|---|---|---|---|---|
| Google Chrome (+Beta/Canary) | yes | yes | yes | Reference target. |
| Brave / Edge / Vivaldi | yes | yes | yes | Same AppleScript dictionary as Chrome. |
| Arc | yes | yes | yes | Separate dictionary; covered by the JXA access patterns + Arc-specific quirks above. Active-tab detection isn't implemented — callers pass `tabIndex` explicitly or accept tab 0 (which may be suspended). |
| Safari | yes | yes | tab create sometimes flaky | Tab creation falls back to System Events Cmd+T if the JXA path fails. |

## Permissions

Two layers, both prompted once:

1. **Browser side** — `Allow JavaScript from Apple Events`:
   - Chromium-family: `View > Developer > Allow JavaScript from Apple Events`. Per-profile.
   - Safari: `Preferences > Advanced > Show Develop menu`, then `Develop > Allow JavaScript from Apple Events`.
2. **macOS side** — Automation permission for the controlling app (Claude Code, Terminal, iTerm) to talk to each target browser and to System Events. `System Settings > Privacy & Security > Automation`. First call surfaces an OS prompt.

The server returns an actionable error when either layer blocks a call.

## Rules for changes

- **Single-file server, one dep.** Only `@modelcontextprotocol/sdk` plus Node built-ins (`child_process`, `fs/promises`). No build step.
- **No shell concatenation of user input.** Always pass JXA as one `-e` argument to `osascript` via `execFile`. Embed user JS only through `JSON.stringify`.
- **Tools earn their slot.** New tools should solve a real workflow, not mirror CDP for completeness.
- **Synchronous-only JS in `eval_js`.** The AppleScript bridges return the value of the last expression; they don't await Promises. Use `wait_for` for async work.
- **Background-friendly by default.** `activate_tab`, `screenshot{raise:true}`, and the `close_tab` Safari fallback are the only focus-stealers.

## Ceiling — what AppleScript can't do

- **Network interception** (request/response capture, header injection). CDP or a real extension only.
- **Pre-page-load instrumentation** (`run_at: document_start`). Both bridges run after navigation completes.
- **Background-tab JS in Safari while not current.** Safari's `doJavaScript` requires the target tab to be the document's `currentTab`. Chrome's `execute` does not. Workaround: `activate_tab` first when Safari is the target.
- **Headless / off-screen capture.** `screencapture -R` grabs whatever pixels are at the screen rect, so the target window has to be on top. `raise: true` handles this; `raise: false` is best-effort.
- **Console subscription.** Page-side `console.*` events aren't surfaced over AppleScript. Patch `console` from inside `eval_js` and read it back later.
