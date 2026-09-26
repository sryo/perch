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

**Trusted input.** `click {trusted:true}` and `fill {trusted:true}` produce `isTrusted: true` events for WAF gates and validators that reject synthetic input. Verified live (Chrome Canary, macOS 27) with `node scripts/trusted-live.mjs --yes`, which raises the browser only with that consent flag and restores focus afterwards. `--delivery` compares posting paths.

1. `trustedTarget`: Accessibility check (`AXIsProcessTrustedWithOptions`, prompt suppressed, so a missing grant is a loud error rather than a silent drop), then the target must be frontmost unless `raise: true` (`focus` pins the window by id before raising, since `windows[i]` is positional). The pid and window frame come from `procs()`, and the current cursor position is saved.
2. `aim`: `selectTab` shows the target tab first. A background tab's `screenX` and `outerWidth` are stale (verified: a hidden tab reported the window's old frame). `trusted_probe` retries until the page is visible, scrolls the element into view, estimates the point (screen origin + `outer - inner` chrome + element center), and arms mousemove/mousedown recorders.
3. Calibration: a mouse move is posted at the estimate. Only the recorded move whose `screenX/Y` equals the posted point counts, because late events and the user's own mouse reach the page too. The point is corrected by `center - client` (at most three rounds; the `calibration` trace is returned). With no matching move, the estimate is used.
4. The press, then `trusted_check` reports `hit` (did the mousedown land on the element) and, for fill, whether the typed text landed. The cursor is warped back to where it was.

Delivery is the HID event tap (`CGEventPost(kCGHIDEventTap)`), like real hardware, which is why the cursor moves and is restored. `CGEventPostToPid`, with or without the window-routing fields, and SkyLight's `SLEventPostToPid` never reached Chrome's page. Because the HID tap clicks whatever is at that point, `mouse` refuses any point outside the target window's frame.

Typing posts keyboard events at the session tap, virtual key 0, with the text attached via `CGEventKeyboardSetUnicodeString`. Chunks are split in Node (`chunkUtf16`: at most 20 UTF-16 units, never splitting a surrogate pair). Two traps, both of which make Chrome type "a" (key 0) instead of the text:
- the encoding is `NSUTF16LittleEndianStringEncoding` = `0x94000100`, not `0x14000100` (which yields nil data);
- the stock JXA signature of `CGEventKeyboardSetUnicodeString` rejects NSData bytes as `UniChar*`, so it is rebound with `void *` parameters.

Mouse event fields use raw indices, because `$.kCG*` constants aren't reliably bridged: 1 = click state, 11 = pressure (double).

Background trusted input (clicking an unfocused window without raising it) is unbuilt. `scripts/skylight-probe.js` shows SkyLight's `SLPSPostEventRecordTo` binds from pure JXA; note that `ObjC.bindFunction` registers the function on `$` (call `$.SLEventPostToPid(...)`) rather than returning it.

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
- **Background-friendly by default.** Only `activate_tab`, `screenshot {raise}` and trusted input with `raise` take focus. Trusted input fails loudly when the target isn't in front.
- **TDD.** Write the failing test first. Then run `npm test` (unit, no browser) and `npm run smoke` (live) after any change, and `node scripts/bench.mjs --compare bench/before.json` for anything performance related.

## Ceiling: what AppleScript can't do

- **Network interception** (request/response capture, header injection): CDP or an extension only.
- **Pre-load instrumentation** (`document_start`): both bridges run after navigation.
- **Safari background-tab JS:** `doJavaScript` needs the tab to be current, so call `activate_tab` first.
- **Off-screen capture** of minimized windows or windows on another Space: the rect fallback needs the window on top.
- **Background trusted input:** unbuilt (see Trusted input).
