# perch

Architecture and invariants for the perch MCP server.

perch exposes MCP tools for driving macOS browsers — tab listing, tab creation/activation, navigation, JS evaluation, condition waits, screenshots, DOM extraction, accessibility snapshots, console capture, file/text input, user-facing notifications. It shells out to `osascript -l JavaScript` and uses each browser's AppleScript dictionary. No browser extension, no debug ports. The current tool surface is the `TOOLS` array in `server.js`; `SKILL.md` mirrors it for skill authors.

## Layout

```
.
├── server.js     # single-file MCP server
├── scripts/
│   └── smoke.mjs # stdio MCP smoke test (`npm run smoke`)
├── install.sh    # macOS installer — clones, npm install, registers via `claude mcp add`
├── package.json  # one dep: @modelcontextprotocol/sdk
├── README.md     # public-facing intro + install
├── GOALS.md      # goals, non-goals, and decisions on record. Read before adding a new tool.
├── SKILL.md      # usage reference for skill authors and agents using perch
├── AGENTS.md     # this file
├── CLAUDE.md     # pointer to AGENTS.md
└── LICENSE
```

## Architecture

```
MCP client (Claude Code, etc.) <--stdio--> server.js <--osascript--> Chrome / Safari / Brave / Edge / Arc / Vivaldi
```

JXA scripts are built as strings and passed to `osascript -l JavaScript` via a long-lived REPL subprocess (see "osascript daemon" below) with a one-shot `execFile` fallback. User JS is embedded via `JSON.stringify` and wrapped in an IIFE that JSON-stringifies its return; errors come back as `{__perch_error: msg}`. Tab targeting goes through `targetClause(target)`, which walks `BROWSERS`, prefers the frontmost app, and binds `tab`, `tab_kind`, `tab_app`, `tab_window` for downstream snippets. Chrome-family tabs use `tab.execute({javascript: code})`; Safari uses `Application('Safari').doJavaScript(code, {in: tab})`. Both are synchronous on the AppleScript side. For async user code, `eval_js` with `awaitPromise: true` wraps the script in an async IIFE that stashes its result on a `window.__perch_async_*` slot, then polls from JXA until it lands.

**osascript daemon.** A single `osascript -i -l JavaScript` REPL subprocess is kept alive across tool calls and fed via stdin. Realistic perch scripts (e.g. `list_tabs`) drop from ~90ms cold-spawn to ~25ms in the warm REPL — the savings are dominated by the JXA bridge's startup, not the fork. Commands serialize through a FIFO queue. Framing: each script is URI-encoded (single ASCII line, no quotes, no newlines) and sent as `eval(decodeURIComponent("..."))` inside an IIFE that prints a `<<P:<id>:O:...>>` / `<<P:<id>:E:...>>` marker. `<`, `>`, and `:` are always percent-encoded by `encodeURIComponent`, so the markers can't collide with the payload. On any infrastructure failure (process exit, stdin write error, per-call framing timeout) the daemon is killed and the call falls through to the one-shot path; the next call lazily respawns. Disable with `PERCH_DAEMON=0`.

**accessibility_snapshot refs.** `accessibility_snapshot` walks `a[href], button, input, textarea, select, [role], [tabindex], h1-h6, [contenteditable], summary`, filters to visible elements, computes the accessible name (labelledby → aria-label → `<label>` → placeholder → innerText → name → title), and stashes each chosen element on `window.__perch_refs[ref]` (a plain object — Map would break the JSON round-trip via `tab.execute`'s return path). Refs are numeric strings ("1", "2", ...) reset on every snapshot, so callers that cache refs across snapshots will hit stale references. `fill`, `click`, `get_text`, and `get_html` consume refs through `window.__perch_refs[ref]`; missing refs return `{__perch_ref_miss: true, ref}` rather than throwing, so the caller can re-snapshot. Form fields carry `subtype` (only set when it adds info beyond `role` — `text/radio/checkbox/button/submit` are suppressed), `attr_name` (HTML `name` attribute, only for form elements), and `options` (visible `<select>` option texts, capped at 30). Optional `role` filter (string or array — `'textbox'`, `['textbox','combobox','checkbox','radio']`, etc.) is applied at element-emit time, before `visible()` and `accName()` run, so it shrinks both the walk cost and the JSON payload on form-heavy pages. Roles match perch's computed `role` field (the same value emitted in the result), not raw tag names.

**console_capture.** Patches `console.{log,info,warn,error,debug}` and pushes structured entries `{level, ts, args: [<stringified>]}` onto `window.__perch_console.entries`. Bounded ring buffer (default 500, oldest dropped). `safe()` stringifies functions as `[Function name]` and Errors as their `stack || message`. State lives on `window` so it survives between tool calls but dies on page navigation — `read` returns `{ok: false, error: '...not started...'}` after navigation, prompting the caller to `start` again. Misses messages issued before `start`.

**JXA access patterns.** Collections are always read lazily — `app.windows[i]` and `win.tabs[i]`, never `app.windows()` or `win.tabs()`. The called form unwraps to a plain Array on some browsers (Chrome) but loses the bridge context on others (Arc), making subsequent property chains throw "cannot convert types." Multi-tab reads use bulk property access — `win.tabs.url()` returns all URLs in one call, ~30× faster than per-tab loops and the difference between working and timing out on Arc windows with hundreds of tabs.

**Arc-specific quirks.** Arc shares Chrome's `tab.execute` verb but auto-applies `JSON.stringify` to whatever value the executed function returns. perch's wrappers already JSON-stringify, so Arc's bridge double-encodes; the Arc dispatch path unwraps one layer before handing the value back to the caller. Arc also can't return window geometry — `position()`, `size()`, and `bounds()` all throw — so `screenshot` falls back to the System Events accessibility frame, which works for any visible window. Active-tab *read* lands via `win.activeTab.id()` matched against bulk `win.tabs.id()` — neither `win.activeTabIndex()` nor `win.currentTab` works on Arc (both throw "Can't convert types"), but Arc's `activeTab` property returns a tab object with a stable UUID. If the UUID match fails, default targeting silently falls back to tab 0. Active-tab *write* via property assignment is forbidden — `win.activeTab = tab` throws "Access not authorized" and `win.currentTab = tab` throws "Can't convert types" — but Arc's dictionary has a `select` verb that works: `tab.select()` switches the active tab without raising the window or activating the app. All Arc tab-switching paths use it.

**Screenshot capture path.** Default is `screencapture -l <CGWindowID>`, which reads a window's pixels regardless of z-order, so a window obscured by other apps captures without being raised. perch resolves geometry first (`position()` + `size()` for Chrome, `bounds()` for Safari, System Events accessibility frame for Arc), then walks `CGWindowListCopyWindowInfo` via the JXA ObjC bridge, matching by `kCGWindowOwnerName` + bounds (2px tolerance) to find the CGWindowID. If no match (minimized window, on another Space, bridge fails), falls back to `screencapture -R` at the screen rect, which is only reliable if the window is already on top. `raise: true` forces the legacy focus-then-rect path. **Only the active tab in a window is rendered**, so capturing a specific tab requires it to be active first. When `tabIndex` targets a non-active tab, the default path silently switches the window to that tab (Chrome via `activeTabIndex`, Arc via `tab.select()`, Safari via `currentTab`) without raising the window or activating the app, then waits 150ms for the render to swap.

**Tab indices are positional, not identifiers.** `tabIndex` reflects a tab's current position in its window — opening or closing other tabs shifts every index after them. Callers that cache a `tabIndex` from one `list_tabs` call and use it minutes later will race with the user. Re-target by URL match (or by re-listing) when in doubt. `new_tab` returns the index of the tab it just created, but only as a hint; treat it as valid only for the immediate next call.

**Trusted input via CGEventPostToPid.** `click {trusted:true}` and `fill {trusted:true}` produce `isTrusted: true` events that pass Cloudflare/WAF gates and React/Workday-class validators which reject synthetic `el.click()` / `dispatchEvent`. The dispatch path:

1. `targetClause` resolves the tab.
2. `assertAccessibilityGrantedJxa()` checks `AXIsProcessTrustedWithOptions` with `kCFBooleanFalse` for prompt-suppression — throws an actionable error if the controlling app lacks Accessibility permission.
3. Frontmost guard: compares `tab_app` to `FRONTMOST`'s `fm`; throws if not frontmost and `raise: false`. `raise: true` calls `focusTabFragment()` first, mirroring `screenshot{raise:true}`.
4. `resolveTargetIdsJxa()` (shared with `screenshot`) binds `pid`, `windowNumber`, `geom`.
5. For ref/selector inputs, an inline `tab.execute({javascript})` / `doJavaScript` probe returns `window.screenX + r.left + r.width/2` etc. — single osascript round-trip for the whole dispatch.
6. `$.CGEventCreateMouseEvent` / `CGEventCreateKeyboardEvent` + field configuration + `$.CGEventPostToPid(pid, e)`.

Mouse event integer fields set on each event (raw indices because `$.kCG*` symbols aren't reliably bridged for CoreGraphics):

| Field | Raw idx | Value |
|---|---|---|
| `kCGMouseEventClickState` | 1 | `clickCount` (1 default, 2 for dblclick) |
| `kCGEventTargetUnixProcessID` | 9 | `pid` |
| `kCGMouseEventPressure` (double) | 11 | `1.0` on down, `0.0` on up |
| `kCGMouseEventWindowUnderMousePointer` | 27 | `windowNumber` |
| `kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent` | 28 | `windowNumber` |
| private (target window) | 51 | `windowNumber` |
| private (routing flag) | 58 | `1` |

Keyboard typing uses `CGEventCreateKeyboardEvent(nil, virtualKey=0, keyDown)` + `CGEventKeyboardSetUnicodeString(e, len, UniChar*)` + pid field, chunked at ~20 UTF-16 units (the cap of CGEvent's internal buffer). Buffer is allocated via `NSMutableData.dataWithLength(len*2)` and filled by `NSString.getCharactersRange`.

Foreground-only (Tier 1). True background dispatch — the Bridge "two cursors" demo — would need per-pid event taps via `CGEvent.tapCreateForPid` to suppress focus-switch messages, which requires a C-callback function pointer JXA cannot construct. That's the boundary that keeps the single-file-server rule intact; the focus-suppression half stays in the "Ceiling" section.

Chrome renderer-filter contingency: the cua blog reports Chromium's renderer rejects standard `CGEvent.postToPid` clicks unless they come via the private SkyLight `SLEventPostToPid`. The Bridge article disagrees. Public `CGEventPostToPid` is what we ship; if real-world Chrome targets reject `isTrusted: true` from this path, the fallback is `$.dlopen('/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight', $.RTLD_LAZY)` + `$.dlsym` for `SLEventPostToPid` — both achievable in pure JXA via the existing ObjC bridge.

## Browser support

| Browser | JS eval | Navigation | New/close/activate tab | Notes |
|---|---|---|---|---|
| Google Chrome (+Beta/Canary) | yes | yes | yes | Reference target. |
| Brave / Edge / Vivaldi | yes | yes | yes | Same AppleScript dictionary as Chrome. |
| Arc | yes | yes | yes | Separate dictionary; covered by the JXA access patterns + Arc-specific quirks above. |
| Safari | yes | yes | tab create sometimes flaky | Tab creation falls back to System Events Cmd+T if the JXA path fails. |

## Permissions

Three layers, each prompted once:

1. **Browser side** — `Allow JavaScript from Apple Events`:
   - Chromium-family: `View > Developer > Allow JavaScript from Apple Events`. Per-profile.
   - Safari: `Preferences > Advanced > Show Develop menu`, then `Develop > Allow JavaScript from Apple Events`.
2. **macOS Automation** — for the controlling app (Claude Code, Terminal, iTerm) to talk to each target browser and to System Events. `System Settings > Privacy & Security > Automation`. First call surfaces an OS prompt.
3. **macOS Accessibility** — required only for `click {trusted:true}` and `fill {trusted:true}`. `System Settings > Privacy & Security > Accessibility`, tick the controlling app. perch checks via `AXIsProcessTrustedWithOptions` (with `kAXTrustedCheckOptionPrompt: false` to keep the OS prompt out of the controlling-app context) and returns an actionable error before posting any CGEvent — silent drop is the default failure mode without this permission, and we want a loud one.

The server returns an actionable error when any layer blocks a call.

## Rules for changes

- **Single-file server, one dep.** Only `@modelcontextprotocol/sdk` plus Node built-ins (`child_process`, `fs/promises`). No build step.
- **No shell concatenation of user input.** Always pass JXA as one `-e` argument to `osascript` via `execFile`. Embed user JS only through `JSON.stringify`.
- **Tools earn their slot.** New tools should solve a real workflow, not mirror CDP for completeness.
- **AppleScript is synchronous; async is faked via polling.** `eval_js` defaults to sync (one osascript round-trip). `awaitPromise: true` wraps the script in an async IIFE, stashes the resolved value on `window.__perch_async_*`, and polls JXA-side until it appears. Adds latency (~50ms per poll tick) but unblocks Promise-using code — Figma Plugin API, async DOM extraction, fetch chains.
- **Background-friendly by default.** `activate_tab`, `screenshot{raise:true}` (opt-in), and `click{trusted:true, raise:true}` (opt-in) are the only focus-stealers. `screenshot` defaults to CGWindowID capture and does not steal focus. Trusted input tools fail loudly when target is not frontmost and `raise: false`; they don't silently raise.
- **Run `npm run smoke` after any server.js change.** It boots the server over stdio, asserts the tool-schema size budget and output shapes, and exercises the live JXA bridge when a browser is running (skips those checks otherwise).

## Ceiling — what AppleScript can't do

- **Network interception** (request/response capture, header injection). CDP or a real extension only. Passive `fetch` / `XHR` capture is achievable via in-page patching but not currently exposed.
- **Pre-page-load instrumentation** (`run_at: document_start`). Both bridges run after navigation completes.
- **Background-tab JS in Safari while not current.** Safari's `doJavaScript` requires the target tab to be the document's `currentTab`. Chrome's `execute` does not. Workaround: `activate_tab` first when Safari is the target.
- **Headless / off-screen capture.** `screencapture -R` grabs whatever pixels are at the screen rect, so the target window has to be on top. `raise: true` handles this; `raise: false` is best-effort.
- **True background trusted input.** Tier 1 (foreground) ships as `click {trusted:true}` / `fill {trusted:true}` via `CGEventPostToPid`. Tier 3 (background — the Bridge "two cursors" trick) needs per-pid event taps from `CGEvent.tapCreateForPid` to suppress focus-switch messages, which requires a C-callback function pointer JXA cannot construct. That would force a compiled helper binary and break "Single-file server, one dep." Until that rule changes, background trusted input is the ceiling.
