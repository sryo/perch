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
│   ├── trusted-live.mjs  # live trusted click/fill check (--yes; --background)
│   ├── bench.mjs    # live latency/payload bench, compared against bench/baseline.json
│   ├── compare.mjs  # perch side of the perch vs Claude in Chrome suite
│   ├── mcp-client.mjs  # tiny MCP stdio client shared by the live scripts
│   └── skylight-probe.js  # proof that SkyLight event routing binds from pure JXA
├── bench/           # baseline.json (the number to beat), compare/ (fixture + history); runs/ is gitignored
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

1. **Transport.** `OsaDaemon` keeps one `osascript -l JavaScript` process per lane, running `DAEMON_LOOP`, which reads stdin lines itself (`osascript -i` over a pipe evaluates nothing until EOF on macOS 27.2). `jxa(script, {lane})` runs a script there, falling back to one-shot `execFile` only when the script never reached stdin.
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
- **Default target:** with no target, the active tab of the first window. A window showing no tab (a fresh Arc window) is skipped.
- **Tab handles:** clients never branch on browser. `tabId` is an opaque handle `<key>:<raw>` (`key` from `BROWSERS`, e.g. `arc:<uuid>`, `canary:<id>`), so `{tabId}` alone targets a tab in any browser. The key matters: Chromium tab ids are per-process counters and collide across Chromium apps. Safari tabs have no id, so theirs is `safari:<windowId>.<index>.<url hash>`: `resolveSafari` re-finds it by URL (nearest index wins), and a navigation makes it stale, which is why `navigate` returns the tab's current handle. A bare id from before handles is still searched across browsers.
- **Tab ids:** a handle resolves with one bulk `win.tabs.id()` read per window, then `tabs.byId`. Chrome and Arc targets are pinned by id even when given by position, because `tabs[i]` is re-evaluated on every use and a long poll could drift to another tab. Chrome has no tab `select` verb, so selection re-reads the position from the id.
- **Apple Event budget:** live, each Apple Event to a browser costs about one display frame (~16.7ms), while `procs()` and `running()` cost under 3ms, so latency is the event count; `test/perf-budget.test.mjs` pins it. `evalJs` first tries `quickExec`, one event: a Chromium handle through its remembered window (`hints`, filled by list_tabs, new_tab and resolve; `windows[w].tabs.byId(id)` can only miss, never hit another tab), a Safari handle through `windows.byId(win).tabs[i]` with the page checking its own URL hash first, or the default target's active tab. It falls back to `resolve` only when the script cannot have run (errAENoSuchObject, or the hash sentinel). `list_tabs` reads all of an app's windows at once (`windows.tabs.url()` and friends). Never touch a quit app's windows (`alive`): JXA relaunches it.
- **Browser names:** `matchApp` (Node, in `handleCall`) matches `app` loosely: case-insensitive name, key, or a unique substring.
- **Errors:** thrown errors start with a browser-neutral code (`tab_not_visible`, `stale_tab`, `window_offscreen`, `no_browser`, `timeout`) that clients branch on. Tool descriptions and `INSTRUCTIONS` never name a browser; `test/runtime.test.mjs` enforces it. Permission messages are the exception, since the user needs the exact per-browser toggle.

**JXA access patterns.** Read collections lazily (`app.windows[i]`, `win.tabs[i]`), never with the called form (`app.windows()`). The called form loses the bridge context on Arc, and later property chains throw "Can't convert types". Multi-tab reads use bulk property access (`win.tabs.url()`), about 30x faster than per-tab loops. That's the difference between working and timing out on Arc windows with hundreds of tabs.

**Arc quirks.**
- **Double encoding:** Arc's `execute` JSON-stringifies whatever the page function returns, so `exec` unwraps one layer.
- **Reading the active tab:** `win.activeTabIndex()` and `win.currentTab` both throw. `win.activeTab.id()` works; it throws on a window showing no tab.
- **Tab order:** `win.tabs` order is unrelated to the sidebar (effectively random) and includes Favorites (`location` `topApp`). `win.activeSpace.tabs` is in sidebar order. `arcOrder` builds the display order (Favorites, then the active space's sidebar), and Arc's `tabIndex` means a row in it.
- **Shared windows:** windows on the same space share the same tab set (same UUIDs), and one tab can be active in several windows. `execute` works only through a window where the tab is active and hangs through any other, so `resolveById` prefers such a window. `select` changes only the window it's called through. `list_tabs` lists each Arc tab once, under the frontmost window showing it, and reuses url/title reads across windows with identical tab sets.
- **Switching tabs:** writing `activeTab`/`currentTab` is forbidden, but `tab.select()` switches without raising.
- **Background tabs:** `execute` hangs until timeout on a background tab, so `arcGuard` refuses first.
- **Geometry:** Arc has no window geometry verbs, so its frame comes from its own CGWindowList entry, matched by window title (`byTitle`). AppleScript windows and CG entries both run front to back, so same-titled windows pair up in order.

**Eval runs in an isolated world (Chrome family).** Chrome runs Apple Events JS in an isolated world. The DOM and `location` are shared with the page; JS globals are not.
- **Persistence:** globals set by one eval persist for later evals; `window.__perch_refs` and `window.__perch_console` rely on this.
- **Page globals:** the page's own globals are invisible, so probe page state through the DOM.
- **Events:** a plain `click` still fires main-world handlers, because DOM events cross worlds.
- **Console:** `console_capture` injects a `<script>` that patches the main world's console and relays entries as `perch:console` events. A ping/pong tells whether it ran; under a CSP that blocks inline scripts it patches the isolated console instead, which sees only perch's own evals.
- **Timers:** page timers are throttled to about 1/s in background tabs. Anything that must wait polls from JXA (`poll` in the runtime) instead of `setTimeout` in the page. `select` is start/pick/readback steps polled that way, and so is `click {readback}`: the click stores the readback element's text and the url on `window.__perch_rb`, then JXA polls `readback_read` for up to 2s until either changes (a missing `__perch_rb` means a new document). Trusted clicks arm it with `readback_arm` just before posting and poll after restoring the cursor.

**Page scripts.** One prelude defines `vis`, `labelText`/`hintText`/`accName` (accessible-name precedence), `role`, `ident` (`role "name"`), `setNativeValue` (the prototype setter, which reaches React-controlled fields), `fire` and `resolveEl`.
- **Arguments:** every tool body reads its arguments from `A`; no user value is spliced into code.
- **Refs:** `resolveEl` treats a missing or detached ref as `{__perch_ref_miss}`, which `formatResult` turns into an error with a re-snapshot hint.
- **Snapshot:** `accessibility_snapshot` stores elements on `window.__perch_refs` (a plain object, since a Map breaks the JSON round trip). It emits a line format: a `# {header}` line, then `ref role "name" key=json... flags`.

**Tab indices are positional.** `tabIndex` is the tab's current position; opening or closing tabs shifts it. It is still accepted in `target` but no longer listed; rows carry only the handle.

**Tab creation.** `new_tab` defaults to the browser in use (`defaultBrowser`: topmost on screen, else the system default browser if it runs, else any running one) and requires a running browser with an existing window. It no longer calls `activate()` or selects the new tab, but the browser may still focus its window during creation. Chrome can evaluate JS in that background tab; trusted input and screenshots need a tab already active in its window. Do not create tabs while preserving the user's foreground.

**Screenshots.**
- **Capture:** `screencapture -l <CGWindowID> -t png|jpg` reads a window's own pixels regardless of z-order.
- **Downscaling:** `sips` runs only when the image is wider than `maxWidth`. Dimensions come from the PNG/JPEG header (`imageDims`).
- **Missing CGWindowID:** minimized windows and windows on another Space cannot be captured; perch refuses instead of returning another app's pixels.
- **Tab targeting:** only the active tab of a window is rendered. A background screenshot refuses an inactive `tabId` or `tabIndex`; `raise:true` is required to select it.

**Trusted input.** `click {trusted:true}` and `fill {trusted:true}` default to background routes that do not explicitly activate the browser or move the cursor. Background fill directly uses Chrome's editing command in the targeted tab; the live scratch-page test verified a trusted input event and exact Unicode value in an inactive tab while its window was minimized, with no Canary key focus during continuous monitoring. Background SkyLight click needs an on-screen window and its active tab; its event did not reach a minimized window in the live probe. `raise:true` keeps the foreground HID route.

1. For clicks and raised input, `trustedTarget` resolves the browser, checks Accessibility with `AXIsProcessTrusted()` (which does not prompt), and gets the target pid, CGWindowID, and frame from `procs()` / `ids()`. With `raise:true`, `focus` pins the window by id before raising it, since `windows[i]` is positional. Default trusted fill uses page JS and needs no CGWindowID or Accessibility grant.
2. `skyInit` binds SkyLight event functions in JXA. The background route never posts `SLPSPostEventRecordTo` AppKit focus records: they made input reach Chrome but redirected the user's keyboard until the restore.
3. Background trusted clicks require the target tab to already be active in an on-screen browser window; they never switch tabs. With `raise:true`, `aim` selects the target tab. A hidden tab's `screenX` and `outerWidth` are stale, so `trusted_probe` retries until visible, scrolls the element into view, estimates the screen point, and arms event recorders. The estimate puts all horizontal chrome left of the page and ignores zoom, so `aim` corrects it: background clicks read the page's web area from the Accessibility tree (`axPageArea`: the `AXWebArea` whose shape matches the viewport, since a side panel is a web area too; its width over `innerWidth` is the zoom), because directed SkyLight moves never reached a background page live. The foreground HID path calibrates from a posted mouse move and falls back to the Accessibility tree. Results carry `aim` (`ax`, `mouse` or `estimate`) and a `calibration` trace; an `estimate` aim adds a `warning`.
4. Background mouse events use `SLEventPostToPid` with target pid/window routing fields and `CGEventSetWindowLocation` set to the **window-local** point. The sequence includes a move primer and an off-screen click pair before the target pair. A Command flag on the down event lets WindowServer deliver to the background window; the up event has no Command flag, and Chrome receives an ordinary trusted click with `metaKey: false`. Passing a screen point to `CGEventSetWindowLocation` shifted the live Chrome click by the window's y-origin; the local point landed at the exact element center. Background fill instead uses `document.execCommand('insertText')` directly on the requested tab's field, including inactive or minimized Chrome tabs. It verifies the trusted event and exact value. The `raise:true` path uses `CGEventPost(kCGHIDEventTap)` for the click and the session tap for typing, then restores the cursor. `trusted_check` reports `hit` for routed clicks.

The earlier bare `CGEventPostToPid` / `SLEventPostToPid` delivery probes did not reach Chrome's page. The routed SkyLight sequence is a separate path. `skyClick` and `mouse` both reject a target point outside the window frame.
The background `mousedown` carries `metaKey: true` because of the WindowServer routing flag, while the resulting Chrome `click` carries `metaKey: false`. Pages that inspect modifiers on `mousedown` may behave differently; verify the resulting page state after critical actions.

Foreground typing creates keyboard events with virtual key 0 and text attached via `CGEventKeyboardSetUnicodeString`, then posts at the session tap. Chunks are split in Node (`chunkUtf16`: at most 20 UTF-16 units, never splitting a surrogate pair). Two traps, both of which make Chrome type "a" (key 0) instead of the text:
- the encoding is `NSUTF16LittleEndianStringEncoding` = `0x94000100`, not `0x14000100` (which yields nil data);
- the stock JXA signature of `CGEventKeyboardSetUnicodeString` rejects NSData bytes as `UniChar*`, so it is rebound with `void *` parameters.

Mouse event fields use raw indices, because `$.kCG*` constants aren't reliably bridged: 1 = click state, 11 = pressure (double).

`scripts/skylight-probe.js` proves SkyLight functions bind from pure JXA. `ObjC.bindFunction` registers the function on `$` (call `$.SLEventPostToPid(...)`) rather than returning it.

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
3. **macOS Accessibility**, for SkyLight/HID input (trusted clicks and raised input).

Each blocked layer returns an actionable error.

## Rules for changes

- **Single-file server, one runtime dependency.** Only `@modelcontextprotocol/sdk` plus Node built-ins at runtime, with no build step. `happy-dom` is a devDependency for tests only.
- **No user values in code.** JXA goes to `osascript` as one argument or one REPL line; runtime arguments are JSON. Page scripts read arguments only from `A`. User JS for `eval_js` is embedded through the wrappers.
- **The runtime stays self-contained ES2019.** It must not reference Node scope; `test/runtime.test.mjs` runs it under `node:vm` and compiles it with real osascript.
- **Tools earn their slot.** Solve a real workflow; don't mirror CDP. Check both consumers (avis, trabAGItos) before changing the surface. Keep `tools/list` under `SCHEMA_BUDGET`, with shared guidance in `INSTRUCTIONS`.
- **Background-friendly by default.** Only `activate_tab`, `screenshot {raise}` and trusted input with `raise` take focus. Background trusted input must never change the user's AppKit key process or shared cursor.
- **Every improvement is measured.** Before committing a change to perch:
  1. Write the failing test first, then make it pass. `npm test` (unit, no browser) must be green.
  2. `npm run smoke` (live) must pass.
  3. `npm run bench` (live, Canary's shown tab) compares against `bench/baseline.json`. Say the before/after in the commit message. A regression needs a reason or a fix. Unchanged code moves about ±5% between runs, so smaller differences are noise.
  4. If the change made perch faster, replace `bench/baseline.json` with the new run (`bench/runs/bench.json`) in the same commit. For a change a user would notice in an agent's session (fewer calls, a flow that works now), rerun `scripts/compare.mjs` and add a row to `bench/compare/README.md`.

  Live steps need a browser the user isn't using; if none is free, say so and leave them for later rather than skipping silently. Runs land in `bench/runs/` (gitignored).
- **Live focus checks.** `npm run smoke` reuses an existing scratch tab and skips tab creation; `--with-tab-creation` opts into checks that may focus the browser. `scripts/trusted-live.mjs --background` needs an active scratch tab behind another app for SkyLight click; `--background-fill` tests an inactive scratch tab even while minimized. If the preconditions are absent, defer; never create/select tabs or activate another app to create them. Preserve the user's foreground while testing.

## Ceiling: what AppleScript can't do

- **Network interception** (request/response capture, header injection): CDP or an extension only.
- **Pre-load instrumentation** (`document_start`): both bridges run after navigation.
- **Safari background-tab JS:** `doJavaScript` needs the tab to be current, so call `activate_tab` first.
- **Off-screen capture** of minimized windows or windows on another Space: the rect fallback needs the window on top.
- **Background trusted input:** live-verified on Chrome Canary on this macOS version. SkyLight is a private macOS API and can change between OS releases. The explicit `raise:true` HID route remains available.
