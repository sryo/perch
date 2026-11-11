# perch

Developer reference for the perch MCP server: architecture, the rules the code can't show, the contracts callers depend on, and where each behaviour is pinned.

perch exposes MCP tools for driving the user's own macOS browsers: tabs, navigation, JS evaluation, waits, screenshots, page text, accessibility snapshots, console capture, form input, file upload, notifications. It runs `osascript -l JavaScript` against each browser's AppleScript dictionary. No extension, no debug port. The tool surface is `TOOLS` in `server.js`; `SKILL.md` adds to it rather than repeating the tool descriptions or `INSTRUCTIONS`, and `test/docs.test.mjs` keeps the two in sync. Read `GOALS.md` before adding a tool.

**How to use this file.** It states rules, not per-case behaviour; each tool's contract is in `docs/contracts/` (see Tool contracts and subsystems). The per-case detail lives in the tests (each test file opens with a comment saying what it pins) and in the commit messages of the change that made it. Before changing a behaviour, grep `test/` for it; before adding prose here, prefer a test. `test/docs.test.mjs` caps this file's size and the contracts'.

## Layout

```
.
├── server.js        # the whole MCP server (single file)
├── test/            # node:test unit tests (npm test), no browser needed
│   ├── fakes/       # fake osascript REPL, fake JXA world (browsers, tabs, CGWindowList, AX, frame clock)
│   ├── fixtures/    # widget pages for live checks; the large-DOM page and its goldens
│   └── helpers/     # happy-dom page runner for page scripts; dom-bench.mjs times them on the large page
├── scripts/
│   ├── smoke.mjs    # live stdio smoke test (npm run smoke)
│   ├── trusted-live.mjs  # live trusted click/fill/press/select and new-tab checks (--yes; --background...)
│   ├── dialog-live.mjs   # live alert/confirm/prompt check (--yes)
│   ├── navigate-live.mjs # live Arc background-tab navigate check (--yes --arc; --background)
│   ├── bench.mjs    # live latency/payload bench vs bench/baseline.json
│   ├── versions.mjs # A/B of perch versions, live or --offline
│   ├── compare.mjs  # perch side of the perch vs Claude in Chrome suite
│   ├── mcp-client.mjs  # tiny MCP stdio client shared by the live scripts
│   ├── temp-dirs.mjs # the only maker of temp dirs; removed at test end or exit
│   └── skylight-probe.js  # proof that SkyLight event routing binds from pure JXA
├── bench/           # baseline.json (the number to beat), fixture.html (the benched page), compare/ (fixture + history); runs/ is gitignored
├── docs/logo/       # suite.py: makes suite logos
├── docs/contracts/   # tool contracts, one file per area (indexed under Tool contracts below)
├── install.sh       # macOS installer: clone, npm install, register in claude, codex, copilot
├── GOALS.md         # goals, principles, admission test, non-goals. Read before adding a tool.
├── SKILL.md         # usage reference for agents (capped at 8800 bytes)
└── AGENTS.md        # this file (CLAUDE.md points here)
```

## Architecture

```
MCP client <--stdio--> server.js <--osascript REPL--> jxaRuntime --Apple Events--> Chrome / Arc / Safari / ...
                                                          \--tab.execute / doJavaScript--> page scripts
```

`server.js` has four layers, top to bottom:

1. **Transport.** `OsaDaemon` keeps one `osascript -l JavaScript` process per lane, running `DAEMON_LOOP`, which reads stdin lines itself (an interactive osascript over a pipe evaluates nothing until EOF on macOS 27.2). `jxa(script, {lane})` runs a script there, falling back to one-shot `execFile` only when the script never reached stdin.
2. **JXA runtime.** `jxaRuntime()` is a real function whose source is sent once per daemon as the prelude. It defines `globalThis.__perch` with the per-call entry points. Node calls `rt(fn, args)`, which sends one short line, `__perch.fn(<json>)`. A `room:` target goes to `roomRt` instead. The runtime's side channel (`takeNote`) rides ahead of the result between `NOTE` markers and carries tab stamps, moved handles, Safari tab counts and the late-revert answer; `rt` strips it.
3. **Page scripts.** `PAGE_PRELUDE` plus `PAGE_SCRIPTS[name]` are plain strings that run inside the tab. `pageScript(name, A)` ships their `lean` forms (comment lines and indentation dropped at load), prepends `const A = <json>`, and `buildEvalWrapper` wraps the result. Helpers only some scripts call are split into libs (`CLICK_LIB`, `SELECT_LIB`, `TYPEAHEAD_LIB`, `CENSUS_LIB`, ...) and ship only with those scripts.
4. **Tools.** Thin Node handlers (`HANDLERS`) validate arguments, call `rt` or `evalJs`, and shape results. `formatResult` maps them to MCP content.

### osascript daemon

A warm REPL runs a realistic script in about 25ms against about 90ms cold; the saving is JXA bridge startup. Pinned by `test/daemon.test.mjs` and `test/osa.test.mjs`.
- **Lanes:** `fast` and `slow`, so a polling `wait`, `select`, `navigate` or `awaitPromise` never blocks quick calls. An `awaitPromise` whose `timeout` passes the 30s default (up to `AWAIT_MAX_MS`, 5 min) runs on a `long` lane, spawned on first use and never warmed, so it holds up neither; concurrent ones each take their own (`long2`.., `LONG_LANES`); awaits poll every 50ms for 3s, then back off to at most 1s (`awaitEvery`). Pinned by `test/await-long.test.mjs`.
- **Per-tab serialization:** `fill`, `select`, `file_upload`, `click {readback}`, `click {trusted}`, `press {trusted}`, `wait {quiet}` and `screenshot {ref|selector}` keep state on window globals between page calls, so `handleCall` runs them one at a time per `target.tabId` (`withTabLock`, keyed by `tabLockKey`; untargeted calls share one key). Other tools and other tabs never wait. The lock is per process, so calls from two perch servers are told apart by owner tokens instead (see Rules). Pinned by `test/tab-lock.test.mjs`.
- **Framing:** each script is URI-encoded onto one line and evaluated inside an IIFE that prints a `<<P:<id>:O|E:...>>` marker; `encodeURIComponent` escapes `<`, `>` and `:`, so markers can't collide with the payload.
- **Start-up:** the prelude round-trip is the ready handshake. The server calls `warm()` on the fast and slow lanes once connected, so no tool call pays the cold start. `warm()` never throws; a failed spawn is retried by the next call. Each handshake also imports AppKit and sets the prohibited activation policy, so the lanes never get a Dock icon.
- **Failure policy:** a timeout, a mid-call exit or `abort(err, token)` (the dialog watchdog) kills the REPL and the next call respawns it. None is retried, because the script may already have opened a tab or posted a click. Only a script that never reached stdin (`notSent`) falls back to one-shot.
- **Cancellation:** the SDK fires the request's signal on a client's `notifications/cancelled`; `handleCall` passes it on (`createServer`). A `wait` or an `eval_js` await or main-world read (`CANCELLABLE`) is then aborted as a timeout would be, which frees its tab lock and lane, and answers `cancelled:`. Every other call finishes, since it may have acted. Pinned by `test/cancel.test.mjs`.
- **Call budget:** `PERCH_CALL_MAX_MS` (unset: none) caps one call for clients that cut calls short. An `eval_js` await past it answers `{ok:true, pending:true, job}` once the budget less 2s is spent; `wait {job}` resumes the page read (`kicked`, `evalKicked` `resume`), with the page keeping the job's deadline, until the value or the original timeout. Pinned by `test/await-job.test.mjs`.
- **Resources:** `createServer` serves SKILL.md as `perch://skill` for clients that read MCP resources but load no skills (Codex); it costs nothing in `tools/list`. Pinned by `test/resources.test.mjs`.
- **Off switch:** `PERCH_DAEMON=0` runs every call one-shot.
- **Display awake:** macOS locks the screen once the display sleeps, and a locked screen refuses trusted input. Each call (`handleCall`) holds one `caffeinate -d -i -w <pid>` child for `awake.ms` (10 min, `PERCH_AWAKE_MS`) after it, refreshed by later calls; the idle timer, shutdown or this process's death (`-w`) ends it. Only the entry point turns it on; `PERCH_AWAKE=0` turns it off. Pinned by `test/awake.test.mjs`.

### Targeting (`resolve`)

`procs()` does one `CGWindowListCopyWindowInfo` read (about 4ms): on-screen z-order of browsers, the frontmost app, pids and CGWindowIDs. No System Events.
- **Search order:** on-screen browsers topmost first, then the rest of `BROWSERS` in declared order, checked with `running()`; the walk stops at the first match.
- **Default target:** with no target, the active tab of the topmost window of the first candidate. A window showing no tab (a fresh Arc window) is skipped. The default target and `tabIndex` never stamp pages.
- **Tab handles:** clients never branch on browser. `tabId` is an opaque `<key>:<raw>` handle (`key` from `BROWSERS`), so `{tabId}` alone targets a tab in any browser; the key matters because Chromium tab ids collide across Chromium apps. Chrome and Arc targets are pinned by id even when given by position, since `tabs[i]` is re-evaluated on every use. `tabIndex` and `windowId` are still accepted in `target` but not listed; rows carry only the handle, except a row whose tab id can't be read.
- **Safari handles:** Safari tabs have no id, so a handle is `safari:<windowId>.<index>.<url hash>`, re-found by URL within its recorded window, and a navigation makes it stale (so `navigate` returns the current handle). Which same-URL tab is the handle's is settled by a stamp the handle writes to `window.__perch_h` on its first page JS (`stampGuard`, in the same execute), plus the window's tab counts at the last read (`stampCounts`). The rule: **a Safari handle never runs on a tab it can't prove is its own; when unsure it is `stale_tab`**, since the other tab at that URL is likely the user's. Every tracking map is capped and eviction fails closed. A tab found off its recorded index answers `moved: true` with its refreshed `tabId`. Pinned by `test/safari-handle.test.mjs` and `test/perf-budget.test.mjs`.
- **close_tab is strict:** only an explicit `tabId` (or `target.tabId`), only the recorded window, only the tab at the recorded index still showing the URL; a moved tab is `stale_tab`. It refuses a window's last tab (Arc: the space's last tab) and never selects or activates anything. Pinned by `test/close-tab.test.mjs`.
- **Apple Event budget:** live, each Apple Event to a browser costs about one display frame (~16.7ms), while `procs()` and `running()` cost under 3ms, so latency is the event count. `evalJs` first tries `quickExec` (one event, through the remembered window hint), and falls back to `resolve` only when the script cannot have run. Every page call and tab read goes through `onTab`; a tab found nowhere is `stale_tab`, which ends polls at once. `list_tabs` reads each app's windows in bulk and interleaves browsers, so several take about as long as the slowest. Never touch a quit app's windows (`alive`): JXA relaunches it. Pinned by `test/perf-budget.test.mjs`, `test/call-events.test.mjs` and `test/list-tabs.test.mjs`.
- **Browser names:** `matchApp` matches `app` loosely: case-insensitive name, key, or a unique substring.
- **Errors:** thrown errors start with a browser-neutral code that clients branch on: `tab_not_visible` (needs the tab its window shows), `stale_tab` (re-run `list_tabs`), `window_offscreen` (minimized, another Space, or no CG entry), `no_browser`, `timeout`, `dialog_open`, `tab_not_scriptable` (a browser-internal page), `bad_url` (a `navigate` or `new_tab` url not absolute http(s), `file://` or `about:blank`), `bad_args` (refused before any Apple Event), all of them in `CODED`, plus two outside it, from trusted input and the frame walk: `window_ambiguous` (another window shares the frame, or two instances are on screen) and `frames_unreadable` (Accessibility could not read the page's frames). Tool descriptions and `INSTRUCTIONS` never name a browser (`test/runtime.test.mjs`); permission messages are the exception. `needs_focus`: a call that would move the user's focus (`raise:true`, `activate_tab`, `new_tab` outside Safari) without the user's grant; nothing was sent.
- **Focus grant:** focus moves only once the user allowed it, or while they're away (`userAway`: 5 min idle or locked). `handleCallCore` checks before the handler (`movesFocus`): the first call that would move focus asks through the client (MCP elicitation; no answer in 60s: no), and a yes sets `focus.granted` for the server's life; a client that can't be asked gets `needs_focus`. `new_tab` outside Safari counts (live: Chromium raises itself on any new tab); `loft` and room tabs never ask. A bare `new_tab` is routed instead (`routedTab`, `test/new-tab-route.test.mjs`). Live scripts: `connect({allowFocus})` answers the ask. Rejected: a timed grant file with its own CLI. Pinned by `test/focus-grant.test.mjs`, `test/errors.test.mjs` and `test/coded-errors.test.mjs`.
- **Raw AppleScript failures:** never reach a caller bare. `codeOsaError` maps Apple Event numbers to codes (the browser quit or unreachable: `no_browser`; -1712: `timeout`; an object gone: `stale_tab`; -1743 and the JS-from-Apple-Events wording: the permission messages; a lane that died: `timeout` saying the call may have run) and keeps the number as a `(AppleScript -600)` suffix. A browser busy or behind a dialog is a transient `timeout` naming it. `list_tabs` never answers `stale_tab`; a browser it couldn't read is a `warning` beside the others' tabs, or the error when nothing else listed, so an empty list always means no tabs. Pinned by `test/coded-errors.test.mjs`.

### JXA access patterns

Read collections lazily (`app.windows[i]`, `win.tabs[i]`), never with the called form (`app.windows()`): the called form loses the bridge context on Arc, and later property chains throw "Can't convert types". Multi-tab reads use bulk property access (`win.tabs.url()`), about 30x faster than per-tab loops; on Arc windows with hundreds of tabs that is the difference between working and timing out.

### Arc quirks

- **Double encoding:** `execute` JSON-stringifies whatever the page returns, so `exec` unwraps one layer.
- **Active tab:** `win.activeTabIndex()` and `win.currentTab` throw; `win.activeTab.id()` works (and throws on a window showing no tab).
- **Tab order:** `win.tabs` order is unrelated to the sidebar and includes Favorites; `arcOrder` builds the display order (Favorites, then the active space's sidebar), and Arc's `tabIndex` is a row in it.
- **Shared windows:** windows on one space share a tab set, and one tab can be active in several windows. `execute` works only through a window where the tab is active and hangs through any other; `list_tabs` lists each Arc tab once, under the frontmost window showing it.
- **Switching tabs:** writing `activeTab` is forbidden, but `tab.select()` switches without raising.
- **Background tabs:** `execute` hangs on a background tab and on `arc:` pages, so `visibleGuard` refuses first (`tab_not_visible`); trusted input refuses `arc:` pages.
- **Geometry:** Arc has no geometry verbs, so its frame comes from its CGWindowList entry, matched by title; ambiguous pairing is `window_offscreen`. Pinned by `test/window-match.test.mjs`.

### Chrome's isolated world

Chrome runs Apple Events JS in an isolated world: the DOM and `location` are shared with the page, JS globals are not.
- Globals set by one eval persist for later evals (`window.__perch_refs`, `window.__perch_console` rely on this).
- The page's own globals, listeners, timers and promises are invisible: probe page state through the DOM.
- A plain `click` still fires main-world handlers, because DOM events cross worlds. Event fields like `keyCode` must go in the event init: a property defined on the event in the isolated world reads 0 to page handlers.
- `window.open` wrapping only sees Safari's page handlers; Chromium's call the main world's.
- `eval_js {world:"main"}` reaches page globals through an injected `<script>` and reads its result off that element in bounded parts; a CSP that blocks inline scripts, Trusted Types and a non-HTML document are `tab_not_scriptable` naming which, never an isolated-world fallback. The page can rewrite that element, so the verdict lives in perch's world and Node takes only `{value}` or a `{__perch_error, __perch_error_name}` error from it (else `tab_not_scriptable`, the page altered it); a value shaped like an image or error block comes back as text. Pinned by `test/eval-main.test.mjs`.

### Second instances

Another tool may run its own copy of the user's browser (headless, own profile). AppleScript's `tell application "Name"` can reach that copy while JXA's `Application(name)` reaches the user's, so the bounded NSAppleScript path runs only when `soleInstance` sees one instance (one ObjC read, no Apple Event); otherwise page JS takes the plain execute. CG lookups skip windows of non-regular-app pids, and two regular instances mark `dupe`, which trusted input refuses as `window_ambiguous`. Pinned by `test/twin-instance.test.mjs`.

### Rooms

`room:<name>:<targetId>` tabs go over the room's CDP endpoint (`ROOM_FNS`), not Apple Events. Servers share one by its lease file in `$ROOMS_HOME/run/leases` (perch's own). `ROOM_LEASE_TOOLS` take it; it holds while its pid lives and is mid-call or under `ROOM_LEASE_IDLE_MS` idle. A tab rooms' viewer marks in `control/<name>/viewing/<targetId>.json` (`roomViewing`, while its pid lives) is the user's: `tab_held`, and `holder: "user"`. A claim in `run/claims` keeps a `new_tab` tab its server's and its client's other perch processes' (a helper the agent runs: `roomKin`), or with `label` only its label handle's, until `close_tab`, its pid's exit or `ROOM_CLAIM_IDLE_MS`; `roomReap` clears dead ones. Pinned by `test/room.test.mjs`.

### Loft

`new_tab {loft}`: a window on a loft: `true` (`$LOFT_HOME/holder.json`), an id (`lofts/<id>.json`) or `WxH` (perch makes it, `--owner` its pid, and downs it with its last window). Without the grant, Chromium is used only while the user is away (the app they left gets the front back); otherwise, and for Arc, Safari takes it (`open -g` if needed; `note`). Node checks the pid, the runtime the display (`0x6c66`/`0x7466`). **perch makes and closes only its own loft windows** and lofts; `loftArm` hides them from untargeted calls. Pinned by `test/loft.test.mjs`.

## Rules the code can't show

- **Never take the user's foreground** while they're here. Only `activate_tab` and calls passed `raise:true` (`screenshot`, `navigate`, trusted input) take focus, as does `new_tab` outside Safari (see Focus grant). Background paths must never change the frontmost app, the key process or the shared cursor, and never select a tab. Undoing a side effect by taking focus is still taking focus: warn instead (`new_tab`'s `warning`, `navigate`'s fallback `warning`, a background trusted click's `warning`).
- **Fail closed.** When perch can't prove an action lands where it should (the target's own dialog, a click point on the page itself, a frame it can place, a tab it can prove is the handle's), it refuses. `{ok:false}` beats a false `ok`, and a refusal beats a stolen foreground.
- **Believe the site.** Report what the page kept (readback, value checks, `trusted`/`hit`), never what perch sent, and never judge success from the site's words: perch reports structure (`form`, `page`, `invalid`).
- **Compile cache.** Chrome caches compiled page scripts by source, so a repeated identical call must send byte-identical source. Page script source varies only with `A`, and nothing per call (nonce, token, timestamp) is spliced in; owner tokens are made in the page (`TOK_LIB`'s `rbTok`: a per-document counter plus a random suffix) and `fill_fields` keys its record by `fp`, a hash of the batch computed in the page. Documented exceptions, each compiling afresh only on the call that needs it: `fill_late` (the pending late tokens in `A`, on the call after a plain `fill` or native `select`), `fill_reread` (the write's token swapped for `FR_TOK`), `eval_js {ref}` (the ref and its `rid`; with no ref the wrapper is byte-identical), and `snapshot {diff}` (`since`). Measure before adding another.
- **Owner tokens.** Several perch servers (one per session) can drive the same tab, and `withTabLock` is per process. Every multi-step page state (`__perch_rb`, `__perch_quiet`, `__perch_select`, `__perch_ta`, `__perch_blank`, `__perch_up`, `__perch_shot`, `__perch_fr` late records) carries its call's key and a page-made owner token. A phase that finds another call's state answers `{lost, tok}` before acting, and the runtime ends the call with an `ok:false` "another perch call on this tab took over ..." (or, when the other state is fresh, refuses up front with "... is mid-<action>; nothing was set, retry"). Another server can only lengthen a `wait {quiet}`, never shorten it. Pinned by `test/cross-server-state.test.mjs`.
- **No user values in code.** JXA goes to `osascript` as one argument or one REPL line; runtime arguments are JSON; page scripts read arguments only from `A`; user JS for `eval_js` is embedded through the wrappers.
- **Background tabs throttle timers** to about 1/s. Anything that must wait polls from JXA (`poll`), never `setTimeout` in the page. A hidden tab's `blur()` and `focus()` fire no events, so perch dispatches them itself where widgets depend on them.
- **Dropped replies.** Chrome never replies to an `execute` that lands while a navigation replaces the document, and JXA commands take no timeout, so page JS on a pinned Chromium tab goes through bounded NSAppleScript handlers (`execWithin`, `pollExec`, `stepExec`, compiled once per tab in `asScript`; the error Ref, which can hold a freed dictionary, is never read). A read-only poll counts a dropped reply as "not yet"; **a step with side effects (a click, a pick, a kick) is never sent twice**, and its dropped reply is a `timeout` saying it may have run. Reads after a step never say "retry", but that the step ran and to check the page. Arc, Safari and a browser with a second instance take the plain, unbounded execute. Pinned by `test/nav-poll.test.mjs` and `test/wait-deadline.test.mjs`.
- **Deadlines count from the call's start.** `poll` takes the caller's `start` and caps each run at the time left, so a timed-out `wait`, `wait {quiet}` or `awaitPromise` ends within about one interval plus one bounded execute past its timeout.
- **Page faults are neutral.** A perch page script that throws becomes `{ok:false, error:'<tool>: the page script failed on this page (<Name>); nothing verified'}` (no `isError`), keeping `delivery`/`point` when trusted input already went out. Only `eval_js`, whose script is the caller's, keeps the raw `{__perch_error, __perch_error_name, __perch_error_stack_head}` shape. A lost page state (a pick that reloaded the page) is `ok:false` "the page changed ...; not verified", never a pick. Pinned by `test/page-fault.test.mjs` and `test/page-state-lost.test.mjs`.
- **`file:` URLs stay allowed.** avis opens local prototype files; never block `file://` in `navigate`, `new_tab` or `checkUrl`. `test/url-policy.test.mjs` pins every place the runtime hands a browser a url.
- **No stealth, no circumvention.** No motion humanizing, jitter or anything captcha-specific. Sign-in and challenge frames (`handoff`) and password fields (`secure`) go to the user and are never clicked; credentials are never read. HTTP sign-in sheets, FedCM, passkey and permission prompts are never answered.
- **Never answer the user's dialog.** perch aborts a call or answers a dialog only when it can tie a JS alert/confirm/prompt or a leave-page sheet to the target tab (see Dialogs).

## Tool contracts and subsystems

Result shapes callers depend on are pinned by `test/contract.test.mjs` (each test names its consumer); `SKILL.md` documents them for agents. Every result key in them is caller-facing: rename or drop one only with its consumers.

The contracts live in `docs/contracts/`, one file per area, so a session loads only what it touches. **Read the file for an area before changing its behaviour**, and edit it in the same change. `test/docs.test.mjs` caps their total size and checks this table lists every file.

| File | Covers |
|---|---|
| `docs/contracts/page-scripts.md` | the prelude helpers, refs, `eval_js {ref}`, names, click by name, shadow DOM and frames, keys and hover |
| `docs/contracts/snapshot.md` | `accessibility_snapshot`: format, header, flags, frames |
| `docs/contracts/click-readback.md` | `click {readback}`: what it records and its result keys |
| `docs/contracts/wait.md` | `wait`, `wait {quiet}` |
| `docs/contracts/fill.md` | `fill`, `fill {fields}`: verification, labels, typeaheads, census, late reverts |
| `docs/contracts/select.md` | `select`: own list, matching, verification, side effects, trusted |
| `docs/contracts/tabs.md` | `list_tabs`, `new_tab`, `activate_tab` |
| `docs/contracts/click-new-tab.md` | a `click` that opens a tab: `opened`, `unconfirmed`, `blocked` |
| `docs/contracts/navigation.md` | `navigate`: how the load starts, refusals, outcomes |
| `docs/contracts/screenshots.md` | `screenshot`: capture helper, refusals, element crop |
| `docs/contracts/upload.md` | `file_upload`, the file dialog, drop zones |
| `docs/contracts/console.md` | `console_capture` |
| `docs/contracts/trusted-input.md` | `trusted:true` on click, fill, press and select; `raise:true` |
| `docs/contracts/frames.md` | `frames:true` rows and `fN` refs |
| `docs/contracts/dialogs.md` | `dialog_open`, `press {dialog}`, leave-page sheets |

## Browser support

| Browser | JS eval | Navigation | New/activate tab | Notes |
|---|---|---|---|---|
| Google Chrome (+Beta/Canary) | yes | yes | yes | Reference target. |
| Brave / Edge / Vivaldi | yes | yes | yes | Same dictionary as Chrome. |
| Arc | active tab only | yes | yes | See Arc quirks. No `loft` window. |
| Safari | any tab | yes | yes | `new_tab` pushes `Tab({url})` into the front window; if that throws it is `no_browser`, with no keystroke fallback. No bounded page call, so no dialog proof and no in-call `fill {fields}` re-read. |

Live verification is Chrome Canary first; Arc and Safari paths not run live have only the fake world. When a behaviour is unverified live, say so in the commit message rather than here.

## Permissions

1. **Browser:** Allow JavaScript from Apple Events. Chromium family: View > Developer (per profile). Safari: Develop menu.
2. **macOS Automation** for the controlling app (Claude Code, Terminal, iTerm) to each browser. Prompted on first call.
3. **macOS Accessibility**, for trusted clicks and presses, raised input, element screenshots, the frame walk and dialogs.
4. **Screen Recording**, for screenshots.

Each blocked layer returns an actionable error naming the exact toggle (`ERR.jsOff`, `ERR.automation`; `test/docs.test.mjs` pins the paths). perch never prompts for Accessibility or Screen Recording.

## Test

- **`npm test`** (unit, no browser) must be green before every commit. Tests run against the fake osascript REPL and fake JXA world in `test/fakes/` and happy-dom for page scripts; `test/runtime.test.mjs` also compiles the runtime with real osascript. Write the failing test first.
- **`test/perf-budget.test.mjs`** pins Apple Events per call and page script sizes; `test/call-events.test.mjs` pins per-call event trims; `test/schema.test.mjs` keeps `tools/list` under its limit; `test/docs.test.mjs` keeps SKILL.md and this file honest and capped.
- **`npm run smoke`** (live) must pass.
- **`npm run bench`** (live, Canary) compares against `bench/baseline.json`. It serves `bench/fixture.html` on 127.0.0.1, drives an existing about:blank scratch tab there and back, and compares bytes only when the fixture's sha256 matches.
- **fium's offline bench:** `node scripts/bench.mjs --offline --fium ~/.fium/runs/perch/fium.json` (no browser, about 12s) writes schema chars (limit in `bench/fium-baseline.json`) and, per tool, the behaviour lock's Apple Events and result bytes; `fium compare bench/fium-baseline.json ~/.fium/runs/perch/fium.json` judges them (fium RULES.md K). A live `--fium` run adds each row's timings and bytes, judged against `bench/fium-live-baseline.json` with `--noise bench/noise.json`. `scripts/versions-lib.mjs` keeps its own thresholds.
- **Every change is measured, and done when `fium done` says so:** it runs every GOALS.md How we know row at the change's start and now; add `--costly` for the live Canary bench and the room compare, which drive tabs. fium's unattended loop (fium loop.md) never changes `bench/judge`; `bench/affects.json` maps files to rows. Perf work must improve its numbers, other work must stay within their caps; unchanged numbers are no gain. If the change made perch faster, replace `bench/baseline.json` with the new run (`~/.fium/runs/perch/bench.json`) in the same commit. For a change a user would notice in a session (fewer calls, a flow that works now), rerun `scripts/compare.mjs` and add a row to `bench/compare/README.md`. Runs land in `~/.fium/runs/perch/`, never in the repo.

## Live checks

- **Never disturb the user.** Live steps need a browser tab the user isn't using. Reuse an existing scratch tab (`about:blank`, or `about:blank#perch-<ts>` from `--with-tab-creation`); never create or select tabs or activate another app to set one up. If the preconditions are absent, don't wait on the user: poll for them and start once they hold, or say what is left and defer it. Never skip silently.
- **Never submit a real form**, sign in, solve a challenge or answer the user's dialogs. Live checks run on 127.0.0.1 fixtures (`test/fixtures/`, `bench/fixture.html`).
- **Record foreground state** (frontmost app, key process, cursor) around each background step; a change is a failure of goal 1.
- **Run the adverse cases too:** a covered window, a minimized one, a slow or loaded page, two perch servers on one tab, a hostile page.
- **Scripts and their preconditions:**
  - `npm run smoke` reuses an existing scratch tab; `--with-tab-creation` opts into checks that may focus the browser.
  - `scripts/trusted-live.mjs --yes`: `--background` (and `--background-press`, `--background-select` on `test/fixtures/trusted-select.html`) need an active scratch tab in a window behind another app; `--background-fill` tests an inactive scratch tab, minimized too; `--new-tab` needs an about:blank scratch tab (shown in its window with `--background`) and closes the tabs it opened.
  - `scripts/dialog-live.mjs --yes` needs an about:blank tab active in its window.
  - `scripts/navigate-live.mjs --yes --arc` needs an about:blank tab in Arc's front window that the window doesn't show, with Arc in front (another app in front for `--background`).

## Rules for changes

- **Single-file server, one runtime dependency.** Only `@modelcontextprotocol/sdk` plus Node built-ins at runtime, no build step. `happy-dom` is a devDependency for tests only. Splitting `server.js` into modules was turned down.
- **The runtime stays self-contained ES2019.** It must not reference Node scope; `test/runtime.test.mjs` runs it under `node:vm` and compiles it with real osascript.
- **Tools earn their slot.** Solve a real workflow; don't mirror CDP. Check the known consumers (GOALS.md) and `test/contract.test.mjs` before changing the surface; GOALS.md has the admission test. Keep `tools/list` under its limit, with shared guidance in `INSTRUCTIONS`. Turned down so far: a `find` tool (`accessibility_snapshot {query}` does it), a scroll tool (`eval_js` covers it), GIF recording (needs a dependency), a dialog tool.
- **Docs stay lean.** SKILL.md adds to the schema rather than repeating it and stays under its cap. This file holds rules, contracts and pointers; per-case behaviour goes in a test, history in commit messages. Don't append a paragraph per round.
- **Commits** are atomic, carry measured before/after, and have no attribution trailers.

## Ceiling: what AppleScript can't do

- **Network interception** (request/response capture, header injection): CDP or an extension only.
- **Pre-load instrumentation** (`document_start`): both bridges run after navigation.
- **Background trusted input:** live-verified on Chrome Canary on this macOS version. SkyLight is a private macOS API and can change between OS releases. The explicit `raise:true` HID route remains available.
