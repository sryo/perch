# perch

Architecture and invariants for the perch MCP server.

perch exposes MCP tools for driving the user's own macOS browsers: tabs, navigation, JS evaluation, waits, screenshots, page text, accessibility snapshots, console capture, form input, file upload, notifications. It runs `osascript -l JavaScript` against each browser's AppleScript dictionary. No extension, no debug port. The tool surface is `TOOLS` in `server.js`; `SKILL.md` mirrors it for skill authors, and `test/docs.test.mjs` keeps the two in sync.

## Layout

```
.
├── server.js        # the whole MCP server (single file)
├── test/            # node:test unit tests (npm test), no browser needed
│   ├── fakes/       # fake osascript REPL, fake JXA world (browsers, tabs, CGWindowList)
│   └── helpers/     # happy-dom page runner for page scripts
├── scripts/
│   ├── smoke.mjs    # live stdio smoke test (npm run smoke)
│   ├── bench.mjs    # live latency/payload bench (node scripts/bench.mjs --compare bench/before.json)
│   ├── mcp-client.mjs  # tiny MCP stdio client shared by smoke and bench
│   └── skylight-probe.js  # proof that SkyLight event routing binds from pure JXA
├── bench/           # recorded bench results
├── install.sh       # macOS installer: clone, npm install, `claude mcp add`
├── GOALS.md         # goals, non-goals, decisions on record. Read before adding a tool.
├── SKILL.md         # usage reference for agents
└── AGENTS.md        # this file (CLAUDE.md points here)
```

## Architecture

```
MCP client <--stdio--> server.js <--osascript REPL--> jxaRuntime --Apple Events--> Chrome / Arc / Safari / ...
                                                          \--tab.execute / doJavaScript--> page scripts
```

`server.js` has four layers, top to bottom:

1. **Transport.** `OsaDaemon` keeps one `osascript -i -l JavaScript` REPL per lane. `jxa(script, {lane})` runs a script there, falling back to one-shot `execFile` only when the script never reached stdin.
2. **JXA runtime.** `jxaRuntime()` is a real function whose source is sent once per daemon as the prelude. It defines `globalThis.__perch` with the per-call entry points. Node calls `rt(fn, args)`, which sends one short line: `__perch.fn(<json>)`.
3. **Page scripts.** `PAGE_PRELUDE` plus `PAGE_SCRIPTS[name]` are plain strings that run inside the tab. `pageScript(name, A)` prepends `const A = <json>`, and `buildEvalWrapper` wraps the result.
4. **Tools.** Thin Node handlers (`HANDLERS`) validate arguments, call `rt` or `evalJs`, and shape results. `formatResult` maps them to MCP content.

**osascript daemon.** A warm REPL runs a realistic script in about 25ms against about 90ms cold. That saving is JXA bridge startup, not the fork.
- **Lanes:** there are two, `fast` and `slow`, so a polling `wait`, `select`, `navigate` or `awaitPromise` never blocks quick calls.
- **Framing:** each script is URI-encoded onto one line and evaluated inside an IIFE that prints a `<<P:<id>:O|E:...>>` marker. `encodeURIComponent` always escapes `<`, `>` and `:`, so markers can't collide with the payload. Output is scanned incrementally.
- **Start-up:** the prelude round-trip is the ready handshake; there is no fixed settle delay.
- **Failure policy:** a timeout or a mid-call exit rejects and kills the REPL, and the next call respawns it. Neither is retried, because the script may already have opened a tab or posted a click. Only a script that never reached stdin (`notSent`) falls back to one-shot.
- **Off switch:** disable the daemon with `PERCH_DAEMON=0`.

**Targeting (`resolve`).** `procs()` does one `CGWindowListCopyWindowInfo` read, about 4ms. It gives the on-screen z-order of browsers, the frontmost app, and pids and CGWindowIDs. It replaces a System Events `frontmost` query, which took about 60ms per call and needed Automation permission for System Events.
- **Search order:** candidates are on-screen browsers topmost first, then the rest of `BROWSERS` in declared order, checked with `running()`.
- **Stopping:** the walk stops at the first match.
- **Window ids:** `win.id()` is read only when `windowId` was given.
- **Default target:** with no target, the active tab of the first window.

**JXA access patterns.** Read collections lazily (`app.windows[i]`, `win.tabs[i]`), never with the called form (`app.windows()`). The called form loses the bridge context on Arc, and later property chains throw "Can't convert types". Multi-tab reads use bulk property access (`win.tabs.url()`), about 30x faster than per-tab loops. That's the difference between working and timing out on Arc windows with hundreds of tabs.

**Arc quirks.**
- **Double encoding:** Arc's `execute` JSON-stringifies whatever the page function returns, so `exec` unwraps one layer.
- **Reading the active tab:** `win.activeTabIndex()` and `win.currentTab` both throw. `win.activeTab.id()` matched against `win.tabs.id()` works.
- **Switching tabs:** writing `activeTab`/`currentTab` is forbidden, but `tab.select()` switches without raising.
- **Background tabs:** `execute` hangs until timeout on a background tab, so `arcGuard` refuses first.
- **Geometry:** Arc has no window geometry verbs, so its frame comes from its own CGWindowList entry.

**Eval runs in an isolated world (Chrome family).** Chrome runs Apple Events JS in an isolated world. The DOM and `location` are shared with the page; JS globals are not.
- **Persistence:** globals set by one eval persist for later evals; `window.__perch_refs` and `window.__perch_console` rely on this.
- **Page globals:** the page's own globals are invisible, so probe page state through the DOM.
- **Events:** a plain `click` still fires main-world handlers, because DOM events cross worlds.
- **Console:** `console_capture` injects a `<script>` that patches the main world's console and relays entries as `perch:console` events. A ping/pong tells whether it ran; under a CSP that blocks inline scripts it patches the isolated console instead, which sees only perch's own evals.
- **Timers:** page timers are throttled to about 1/s in background tabs. Anything that must wait polls from JXA (`poll` in the runtime) instead of `setTimeout` in the page. `select` is start/pick/readback steps polled that way.

**Page scripts.** One prelude defines `vis`, `labelText`/`hintText`/`accName` (accessible-name precedence), `role`, `ident` (`role "name"`), `setNativeValue` (the prototype setter, which reaches React-controlled fields), `fire` and `resolveEl`.
- **Arguments:** every tool body reads its arguments from `A`; no user value is spliced into code.
- **Refs:** `resolveEl` treats a missing or detached ref as `{__perch_ref_miss}`, which `formatResult` turns into an error with a re-snapshot hint.
- **Snapshot:** `accessibility_snapshot` stores elements on `window.__perch_refs` (a plain object, since a Map breaks the JSON round trip). It emits a line format: a `# {header}` line, then `ref role "name" key=json... flags`.

**Tab indices are positional.** `tabIndex` is the tab's current position; opening or closing tabs shifts it. Re-target by URL or re-list rather than caching.

**Screenshots.**
- **Capture:** `screencapture -l <CGWindowID> -t png|jpg` reads a window's own pixels regardless of z-order.
- **Downscaling:** `sips` runs only when the image is wider than `maxWidth`. Dimensions come from the PNG/JPEG header (`imageDims`).
- **Fallback:** without a CGWindowID (minimized, another Space), perch captures the screen rect, which is reliable only on top.
- **Tab switching:** only the active tab of a window is rendered. An explicit `tabIndex` switches the window to that tab first, without raising it, and waits 150ms.

**Trusted input.** `click {trusted:true}` and `fill {trusted:true}` default to the SkyLight route, which addresses a background browser window and restores the user's AppKit key window without raising the browser or moving the shared cursor. The Chrome Canary scratch-page harness verified `isTrusted` mouse/input events, exact click position, full Unicode text, unchanged foreground app and cursor. `raise:true` keeps the foreground HID route.

1. `trustedTarget` resolves the browser, checks Accessibility with `AXIsProcessTrusted()` (which does not prompt), and gets the target pid, CGWindowID, and frame from `procs()` / `ids()`. With `raise:true`, `focus` pins the window by id before raising it, since `windows[i]` is positional.
2. `backgroundBegin` binds SkyLight functions in JXA, saves the front process's PSN, resolves the browser PSN, and posts the 0xf8-byte AppKit focus records. `backgroundEnd` restores the prior process/window even if the press or typing fails. A failed focus or restore operation is surfaced as an error.
3. `aim` selects the target tab without raising the app. A hidden tab's `screenX` and `outerWidth` are stale, so `trusted_probe` retries until visible, scrolls the element into view, estimates the screen point, and arms event recorders. The foreground HID path calibrates the point from a posted mouse move and returns a `calibration` trace. Background input uses directed SkyLight events; it never posts an HID move.
4. Background mouse events use `SLEventPostToPid` with target pid/window routing fields and `CGEventSetWindowLocation` set to the **window-local** point. The sequence includes a move primer and an off-screen click pair before the target pair. Passing a screen point to `CGEventSetWindowLocation` shifted the live Chrome click by the window's y-origin; the local point landed at the exact element center. Background keystrokes go to the target pid. The `raise:true` path uses `CGEventPost(kCGHIDEventTap)` for the click and the session tap for typing, then restores the cursor. `trusted_check` reports `hit` and, for fill, whether the text landed.

The earlier bare `CGEventPostToPid` / `SLEventPostToPid` delivery probes did not reach Chrome's page. The routed SkyLight sequence is a separate path. `skyClick` and `mouse` both reject a target point outside the window frame.

Typing creates keyboard events with virtual key 0 and text attached via `CGEventKeyboardSetUnicodeString`. The background route posts each event to the target pid; the foreground route posts at the session tap. Chunks are split in Node (`chunkUtf16`: at most 20 UTF-16 units, never splitting a surrogate pair). Two traps, both of which make Chrome type "a" (key 0) instead of the text:
- the encoding is `NSUTF16LittleEndianStringEncoding` = `0x94000100`, not `0x14000100` (which yields nil data);
- the stock JXA signature of `CGEventKeyboardSetUnicodeString` rejects NSData bytes as `UniChar*`, so it is rebound with `void *` parameters.

Mouse event fields use raw indices, because `$.kCG*` constants aren't reliably bridged: 1 = click state, 11 = pressure (double).

`scripts/skylight-probe.js` proves `SLPSPostEventRecordTo` binds from pure JXA. `ObjC.bindFunction` registers the function on `$` (call `$.SLEventPostToPid(...)`) rather than returning it. The production route uses `NSMutableData` to build focus records without pointer arithmetic or a compiled helper.

## Browser support

| Browser | JS eval | Navigation | New/activate tab | Notes |
|---|---|---|---|---|
| Google Chrome (+Beta/Canary) | yes | yes | yes | Reference target. |
| Brave / Edge / Vivaldi | yes | yes | yes | Same dictionary as Chrome. |
| Arc | active tab only | yes | yes | See Arc quirks. |
| Safari | current tab only | yes | tab create sometimes flaky | Falls back to System Events Cmd+T. |

## Permissions

1. **Browser:** Allow JavaScript from Apple Events. Chromium family: View > Developer (per profile). Safari: Develop menu.
2. **macOS Automation** for the controlling app (Claude Code, Terminal, iTerm) to each browser. Prompted on first call.
3. **macOS Accessibility**, only for trusted input.

Each blocked layer returns an actionable error.

## Rules for changes

- **Single-file server, one runtime dependency.** Only `@modelcontextprotocol/sdk` plus Node built-ins at runtime, with no build step. `happy-dom` is a devDependency for tests only.
- **No user values in code.** JXA goes to `osascript` as one argument or one REPL line; runtime arguments are JSON. Page scripts read arguments only from `A`. User JS for `eval_js` is embedded through the wrappers.
- **The runtime stays self-contained ES2019.** It must not reference Node scope; `test/runtime.test.mjs` runs it under `node:vm` and compiles it with real osascript.
- **Tools earn their slot.** Solve a real workflow; don't mirror CDP. Check both consumers (avis, trabAGItos) before changing the surface. Keep `tools/list` under `SCHEMA_BUDGET`, with shared guidance in `INSTRUCTIONS`.
- **Background-friendly by default.** Only `activate_tab`, `screenshot {raise}` and trusted input with `raise` take focus. Background trusted input must restore the prior AppKit focus and leave the cursor alone.
- **TDD.** Write the failing test first. Then run `npm test` (unit, no browser) and `npm run smoke` (live) after any change, and `node scripts/bench.mjs --compare bench/before.json` for anything performance related.
- **Live focus checks.** `scripts/trusted-live.mjs --background` needs a browser behind another app. If the browser is frontmost, defer that live check; never activate another app just to create the condition. Preserve the user's foreground while testing.

## Ceiling: what AppleScript can't do

- **Network interception** (request/response capture, header injection): CDP or an extension only.
- **Pre-load instrumentation** (`document_start`): both bridges run after navigation.
- **Safari background-tab JS:** `doJavaScript` needs the tab to be current, so call `activate_tab` first.
- **Off-screen capture** of minimized windows or windows on another Space: the rect fallback needs the window on top.
- **Background trusted input:** live-verified on Chrome Canary on this macOS version. SkyLight is a private macOS API and can change between OS releases. The explicit `raise:true` HID route remains available.
