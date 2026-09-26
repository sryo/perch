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

**Trusted input via CGEventPostToPid.** `click {trusted:true}` and `fill {trusted:true}` produce `isTrusted: true` events for WAF gates and validators that reject synthetic input. `trustedTarget` handles the preconditions:
- **Accessibility:** `AXIsProcessTrustedWithOptions` with the prompt suppressed; a missing grant is a loud error, not a silent drop.
- **Frontmost:** the target must be in front, or pass `raise: true`.
- **Ids:** pid and window number come from `procs()`.

The `trusted_probe` page script finds the element, scrolls it into view and estimates its screen point. The estimate is `screenX/Y` plus browser chrome (`outer - inner`: toolbars on top, Arc's sidebar on the left) plus the element's center, assuming 100% zoom. It also arms a mousedown listener, so the result reports `hit`. Typing is chunked in Node at 20 UTF-16 units (CGEvent's buffer cap) without splitting surrogate pairs.

Mouse event fields use raw indices, because `$.kCG*` constants aren't reliably bridged:

| Field | Raw idx | Value |
|---|---|---|
| `kCGMouseEventClickState` | 1 | 1 |
| `kCGEventTargetUnixProcessID` | 9 | pid |
| `kCGMouseEventPressure` (double) | 11 | 1.0 down, 0.0 up |
| `kCGMouseEventWindowUnderMousePointer` | 27 | windowNumber |
| `kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent` | 28 | windowNumber |
| private (target window) | 51 | windowNumber |
| private (routing flag) | 58 | 1 |

**Status: unverified live.** A 2026-09 check on Chrome Canary saw no mousedown reach the page, for this code or for the pre-redesign code. A plain HID-level `CGEventPost` didn't reach it either, so suspect window placement (Canary was on another Space) or how Accessibility is attributed before suspecting the renderer filter below. Treat `hit: null` as "the event never arrived".

Trusted input is foreground only (Tier 1). Background dispatch in the style of cua ("two cursors") needs no event tap or C callback:
- **Routing:** SkyLight's `SLEventPostToPid` routes the event without moving the shared cursor.
- **Activation:** the yabai `SLPSPostEventRecordTo` recipe makes the target AppKit-active without raising it.
- **Proof:** `scripts/skylight-probe.js` shows both bind and run from pure JXA; what's left is engineering.

If Chrome's renderer ever rejects `CGEventPostToPid` clicks, the fallback is `SLEventPostToPid`. Bind it with `ObjC.bindFunction('SLEventPostToPid', ['int', ['int', 'void *']])`; SkyLight is already loaded in-process. `$.dlopen` and `$.dlsym` are not callable on the bridge.

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
- **Background trusted input:** unbuilt, not impossible (see above).
