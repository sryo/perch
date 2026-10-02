# perch

Developer reference for the perch MCP server: architecture, the rules the code can't show, the contracts callers depend on, and where each behaviour is pinned.

perch exposes MCP tools for driving the user's own macOS browsers: tabs, navigation, JS evaluation, waits, screenshots, page text, accessibility snapshots, console capture, form input, file upload, notifications. It runs `osascript -l JavaScript` against each browser's AppleScript dictionary. No extension, no debug port. The tool surface is `TOOLS` in `server.js`; `SKILL.md` adds to it for skill authors rather than repeating the tool descriptions or `INSTRUCTIONS`, and `test/docs.test.mjs` keeps the two in sync. Read `GOALS.md` before adding a tool.

**How to use this file.** It states rules and contracts, not per-case behaviour. The per-case detail lives in the tests (each test file opens with a comment saying what it pins) and in the commit messages of the change that made it. Before changing a behaviour, grep `test/` for it; before adding prose here, prefer a test. `test/docs.test.mjs` caps this file's size.

## Layout

```
.
├── server.js        # the whole MCP server (single file)
├── test/            # node:test unit tests (npm test), no browser needed
│   ├── fakes/       # fake osascript REPL, fake JXA world (browsers, tabs, CGWindowList, AX, frame clock)
│   ├── fixtures/    # widget pages servable as is for live checks; large-DOM page and its golden outputs
│   └── helpers/     # happy-dom page runner for page scripts; dom-bench.mjs times them on the large page
├── scripts/
│   ├── smoke.mjs    # live stdio smoke test (npm run smoke)
│   ├── trusted-live.mjs  # live trusted click/fill/press/select and new-tab checks (--yes; --background...)
│   ├── dialog-live.mjs   # live alert/confirm/prompt check (--yes)
│   ├── navigate-live.mjs # live Arc background-tab navigate check (--yes --arc; --background)
│   ├── bench.mjs    # live latency/payload bench, compared against bench/baseline.json
│   ├── compare.mjs  # perch side of the perch vs Claude in Chrome suite
│   ├── mcp-client.mjs  # tiny MCP stdio client shared by the live scripts
│   ├── temp.mjs     # the only way tests and scripts make temp dirs; removed on test end or process exit
│   └── skylight-probe.js  # proof that SkyLight event routing binds from pure JXA
├── bench/           # baseline.json (the number to beat), fixture.html (the benched page), compare/ (fixture + history); runs/ is gitignored
├── install.sh       # macOS installer: clone, npm install, `claude mcp add`
├── GOALS.md         # goals, principles, admission test, non-goals. Read before adding a tool.
├── SKILL.md         # usage reference for agents (capped at 6800 bytes)
└── AGENTS.md        # this file (CLAUDE.md points here)
```

## Architecture

```
MCP client <--stdio--> server.js <--osascript REPL--> jxaRuntime --Apple Events--> Chrome / Arc / Safari / ...
                                                          \--tab.execute / doJavaScript--> page scripts
```

`server.js` has four layers, top to bottom:

1. **Transport.** `OsaDaemon` keeps one `osascript -l JavaScript` process per lane, running `DAEMON_LOOP`, which reads stdin lines itself (an interactive osascript over a pipe evaluates nothing until EOF on macOS 27.2). `jxa(script, {lane})` runs a script there, falling back to one-shot `execFile` only when the script never reached stdin.
2. **JXA runtime.** `jxaRuntime()` is a real function whose source is sent once per daemon as the prelude. It defines `globalThis.__perch` with the per-call entry points. Node calls `rt(fn, args)`, which sends one short line, `__perch.fn(<json>)`. The runtime's side channel (`takeNote`) rides ahead of the result between `NOTE` markers and carries tab stamps, moved handles, Safari tab counts and the late-revert answer; `rt` strips it.
3. **Page scripts.** `PAGE_PRELUDE` plus `PAGE_SCRIPTS[name]` are plain strings that run inside the tab. `pageScript(name, A)` ships their `lean` forms (comment lines and indentation dropped at load), prepends `const A = <json>`, and `buildEvalWrapper` wraps the result. Helpers only some scripts call are split into libs (`CLICK_LIB`, `SELECT_LIB`, `TYPEAHEAD_LIB`, `CENSUS_LIB`, ...) and ship only with those scripts.
4. **Tools.** Thin Node handlers (`HANDLERS`) validate arguments, call `rt` or `evalJs`, and shape results. `formatResult` maps them to MCP content.

### osascript daemon

A warm REPL runs a realistic script in about 25ms against about 90ms cold; the saving is JXA bridge startup. Pinned by `test/daemon.test.mjs` and `test/osa.test.mjs`.
- **Lanes:** `fast` and `slow`, so a polling `wait`, `select`, `navigate` or `awaitPromise` never blocks quick calls. An `awaitPromise` whose `timeout` passes the 30s default (up to `AWAIT_MAX_MS`, 5 min) runs on a third, `long`, spawned on first use and never warmed, so it holds up neither; awaits poll every 50ms for 3s, then back off to at most 1s (`awaitEvery`). Pinned by `test/await-long.test.mjs`.
- **Per-tab serialization:** `fill`, `select`, `file_upload`, `click {readback}`, `click {trusted}`, `press {trusted}`, `wait {quiet}` and `screenshot {ref|selector}` keep state on window globals between page calls, so `handleCall` runs them one at a time per `target.tabId` (`withTabLock`, keyed by `tabLockKey`; untargeted calls share one key). Other tools and other tabs never wait. The lock is per process, so calls from two perch servers are told apart by owner tokens instead (see Rules). Pinned by `test/tab-lock.test.mjs`.
- **Framing:** each script is URI-encoded onto one line and evaluated inside an IIFE that prints a `<<P:<id>:O|E:...>>` marker; `encodeURIComponent` escapes `<`, `>` and `:`, so markers can't collide with the payload.
- **Start-up:** the prelude round-trip is the ready handshake. The server calls `warm()` on the fast and slow lanes once connected, so no tool call pays the cold start. `warm()` never throws; a failed spawn is retried by the next call. Each handshake also imports AppKit and sets the prohibited activation policy, so the lanes never get a Dock icon.
- **Failure policy:** a timeout, a mid-call exit or `abort(err, token)` (the dialog watchdog) kills the REPL and the next call respawns it. None is retried, because the script may already have opened a tab or posted a click. Only a script that never reached stdin (`notSent`) falls back to one-shot.
- **Off switch:** `PERCH_DAEMON=0` runs every call one-shot.

### Targeting (`resolve`)

`procs()` does one `CGWindowListCopyWindowInfo` read (about 4ms): on-screen z-order of browsers, the frontmost app, pids and CGWindowIDs. No System Events.
- **Search order:** on-screen browsers topmost first, then the rest of `BROWSERS` in declared order, checked with `running()`; the walk stops at the first match.
- **Default target:** with no target, the active tab of the topmost window of the first candidate. A window showing no tab (a fresh Arc window) is skipped. The default target and `tabIndex` never stamp pages.
- **Tab handles:** clients never branch on browser. `tabId` is an opaque `<key>:<raw>` handle (`key` from `BROWSERS`), so `{tabId}` alone targets a tab in any browser; the key matters because Chromium tab ids collide across Chromium apps. Chrome and Arc targets are pinned by id even when given by position, since `tabs[i]` is re-evaluated on every use. `tabIndex` and `windowId` are still accepted in `target` but not listed; rows carry only the handle, except a row whose tab id can't be read.
- **Safari handles:** Safari tabs have no id, so a handle is `safari:<windowId>.<index>.<url hash>`, re-found by URL within its recorded window, and a navigation makes it stale (which is why `navigate` returns the tab's current handle). Which same-URL tab is the handle's is settled by a stamp the handle writes to `window.__perch_h` on its first page JS (`stampGuard`, inside the same execute, so no extra event), plus the window's tab counts at the last read (`stampCounts`). The rule: **a Safari handle never runs on a tab it can't prove is its own; when unsure it is `stale_tab`**, since the other tab at that URL is likely the user's. Every tracking map is capped and eviction fails closed. A tab found off its recorded index answers `moved: true` with its refreshed `tabId` (`eval_js`: in a second text item). Pinned by `test/safari-handle.test.mjs` and `test/perf-budget.test.mjs`.
- **close_tab is strict:** only an explicit `tabId`, only the recorded window, only the tab at the recorded index still showing the URL; a moved tab is `stale_tab`. It refuses a window's last tab (Arc: the space's last tab) and never selects or activates anything. Pinned by `test/close-tab.test.mjs`.
- **Apple Event budget:** live, each Apple Event to a browser costs about one display frame (~16.7ms), while `procs()` and `running()` cost under 3ms, so latency is the event count. `evalJs` first tries `quickExec` (one event, through the remembered window hint), and falls back to `resolve` only when the script cannot have run. Every page call and tab read goes through `onTab`; a tab found nowhere is `stale_tab`, and polls end on it at once. `list_tabs` reads each app's windows in bulk and interleaves browsers one event at a time, so several browsers take about as long as the slowest. Never touch a quit app's windows (`alive`): JXA relaunches it. Pinned by `test/perf-budget.test.mjs`, `test/call-events.test.mjs` and `test/list-tabs.test.mjs`.
- **Browser names:** `matchApp` matches `app` loosely: case-insensitive name, key, or a unique substring.
- **Errors:** thrown errors start with a browser-neutral code that clients branch on: `tab_not_visible` (needs the tab its window shows), `stale_tab` (re-run `list_tabs`), `window_offscreen` (minimized, another Space, or no CG entry), `no_browser`, `timeout`, `dialog_open`, `tab_not_scriptable` (a browser-internal page page JS can't run on), `bad_url` (a `navigate` or `new_tab` url that is not absolute http(s), `file://` or `about:blank`; `file://` stays loadable by decision), `bad_args` (an argument out of range, refused before any Apple Event), all of them in `CODED`, plus two outside `CODED` that trusted input and the frame walk throw: `window_ambiguous` (another window of the browser has the same frame, or two instances have windows on screen) and `frames_unreadable` (Accessibility could not read the page's frames). Tool descriptions and `INSTRUCTIONS` never name a browser (`test/runtime.test.mjs`); permission messages are the exception. `tab_not_visible` never activates the tab for the caller; that is `activate_tab`'s opt-in. Pinned by `test/errors.test.mjs` and `test/coded-errors.test.mjs`.
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

## Rules the code can't show

- **Never take the user's foreground.** Only `activate_tab` and calls passed `raise:true` (`screenshot`, `navigate`, trusted input) take focus, as `INSTRUCTIONS` says; `new_tab` may focus the browser and its description says to defer it while the user works. Background paths must never change the frontmost app, the key process or the shared cursor, and never select a tab. Undoing a side effect by taking focus is still taking focus: warn instead (`new_tab`'s `warning`, `navigate`'s fallback `warning`).
- **Fail closed.** When perch can't prove an action lands where it should (the target's own dialog, a click point on the page itself, a frame it can place, a tab it can prove is the handle's), it refuses. `{ok:false}` beats a false `ok`, and a refusal beats a stolen foreground.
- **Believe the site.** Report what the page kept (readback, value checks, `trusted`/`hit`), never what perch sent, and never judge success from the site's words: perch reports structure (`form`, `page`, `invalid`).
- **Compile cache.** Chrome caches compiled page scripts by source, so a repeated identical call must send byte-identical source. Page script source varies only with `A`, and nothing per call (nonce, token, timestamp) is spliced in; owner tokens are made in the page (`TOK_LIB`'s `rbTok`: a per-document counter plus a random suffix) and `fill_fields` keys its record by `fp`, a hash of the batch computed in the page. Documented exceptions, each paying a fresh compile only on the call that needs it: `fill_late` (the pending late tokens in `A`, on the call after a plain `fill` or native `select`), `fill_reread` (the write's token swapped for `FR_TOK`), and `eval_js {ref}` (the ref and its `rid` as JSON literals; with no ref the wrapper is byte-identical). Measure before adding another.
- **Owner tokens.** Several perch servers (one per Claude session) can drive the same tab, and `withTabLock` is per process. Every multi-step page state (`__perch_rb` readback, `__perch_quiet`, `__perch_select`, `__perch_ta`, `__perch_blank`, `__perch_up`, `__perch_shot`, `__perch_fr` late records) carries its call's key and a page-made owner token. A phase that finds another call's state answers `{lost, tok}` before pressing, typing or restoring anything, and the runtime ends the call with an `ok:false` "another perch call on this tab took over ..." (or, when the other state is fresh, refuses up front with "... is mid-<action>; nothing was set, retry"). Another server can only lengthen a `wait {quiet}`, never shorten it. Pinned by `test/cross-server-state.test.mjs`.
- **No user values in code.** JXA goes to `osascript` as one argument or one REPL line; runtime arguments are JSON; page scripts read arguments only from `A`; user JS for `eval_js` is embedded through the wrappers.
- **Background tabs throttle timers** to about 1/s. Anything that must wait polls from JXA (`poll` in the runtime), never `setTimeout` in the page. A hidden tab's `blur()` and `focus()` fire no events, so perch dispatches them itself where widgets depend on them.
- **Dropped replies.** Chrome never replies to an `execute` that lands while a navigation replaces the document, and JXA commands take no timeout, so page JS on a pinned Chromium tab goes through bounded NSAppleScript handlers (`execWithin`, `pollExec`, `stepExec`, compiled once per tab and cached in `asScript`; the error Ref is never read, since it can hold a freed dictionary). A read-only poll counts a dropped reply as "not yet"; **a step with side effects (a click, a pick, a kick) is never sent twice**, and its dropped reply is a `timeout` saying it may have run. Reads after a step never say "retry"; they say the step ran and to check the page. Arc, Safari and a browser with a second instance take the plain execute, unbounded. Pinned by `test/nav-poll.test.mjs` and `test/wait-deadline.test.mjs`.
- **Deadlines count from the call's start.** `poll` takes the caller's `start` and caps each run at the time left, so a timed-out `wait`, `wait {quiet}` or `awaitPromise` ends within about one interval plus one bounded execute past its timeout.
- **Page faults are neutral.** A perch page script that throws becomes `{ok:false, error:'<tool>: the page script failed on this page (<Name>); nothing verified'}` (no `isError`), keeping `delivery`/`point` when trusted input already went out. Only `eval_js`, whose script is the caller's, keeps the raw `{__perch_error, __perch_error_name, __perch_error_stack_head}` shape. A lost page state (a pick that reloaded the page) is `ok:false` "the page changed ...; not verified", never a pick. Pinned by `test/page-fault.test.mjs` and `test/page-state-lost.test.mjs`.
- **`file:` URLs stay allowed.** avis opens local prototype files; never block `file://` in `navigate`, `new_tab` or `checkUrl`. `test/url-policy.test.mjs` pins every place the runtime hands a browser a url.
- **No stealth, no circumvention.** No motion humanizing, jitter or anything captcha-specific. Sign-in and challenge frames (`handoff`) and password fields (`secure`) go to the user and are never clicked; credentials are never read. HTTP sign-in sheets, FedCM, passkey and permission prompts are never answered.
- **Never answer the user's dialog.** perch aborts a call or answers a dialog only when it can tie a JS alert/confirm/prompt to the target tab (see Dialogs).

## Page scripts

One prelude defines `vis`, `labelText`/`hintText`/`accName` (accessible-name precedence), `role`, `ident` (`role "name"`), `setNativeValue` (the prototype setter, which reaches React-controlled fields), `fire`, `resolveEl` and `deepAll` (open shadow roots in document order). `test/page.test.mjs` runs them under happy-dom; `test/dom-cost.test.mjs` pins their output on a large page byte for byte (`PERCH_GOLDEN_WRITE=1` rewrites the goldens). `test/perf-budget.test.mjs` pins that lean scripts carry no backtick, block comment or line continuation, that every script defines each split-out helper it calls, and the page-script size budgets.

- **Refs:** a ref is valid only against the map this server's last snapshot of that tab built (keyed as `tabLockKey` keys the tab, so a ref from an untargeted snapshot needs an untargeted call). Each snapshot names its map with a page-made `window.__perch_refsId` (`rid`), which `pageScript` puts beside every `ref` in `A`. A ref from another snapshot, tab, document or server is `{__perch_ref_miss}`, which `formatResult` turns into an error with a re-snapshot hint. `issueRefs` renumbers so a ref names one row of one snapshot. Pinned by `test/snapshot-refs.test.mjs`.
- **eval_js ref:** `eval_js {ref}` binds the snapshot row's element as `el` inside the same page call (no extra Apple Event). `composeEvalScript` returns `{__perch_ref_miss}` before the user script runs when the element is gone or its document is no longer live (`liveDoc`, inlined as `EVAL_LIVE_DOC`), and otherwise calls the body as `function (el)` (`async` under `awaitPromise`) with `this` kept. With no ref the wrapper is byte-identical, so repeated calls keep Chrome's compile cache. `el` is a parameter, so a script declaring `let el` throws. Frame refs (`fN`) are refused by `guardFrameRefs` before any Apple Event. Pinned by `test/eval-ref.test.mjs`.
- **Names:** `labelWords` skips hidden descendants and popups inside a label. A field with no label is named, before its placeholder, by `nearText` (the text laid out just before it, never past a list item, fieldset or form, never text beside another control). These flow into `ident()` for every tool.
- **Click by name:** `click {label_pattern}` resolves through `clickableByLabel`, ranking enabled buttons, links and clickable roles by accessible name, visible first: whole name, then word boundaries, then any match. A tie at the best tier refuses with `candidates`; no match lists up to 8 visible names; open shadow roots are searched only when the light DOM has no enabled match. A resolved target (by `ref`, `selector` or name; `trusted` too, before any mouse event) that is natively disabled, itself or inside a `fieldset[disabled]` outside that fieldset's first `<legend>`, is refused as `{ok:false, el}` with `... is disabled; nothing was clicked`, since the browser drops the click; `aria-disabled=true` still clicks, as such forms show their errors on click. Pinned by `test/click-label.test.mjs`.
- **Shadow DOM and frames:** open shadow roots are walked by the snapshot, fill's label search and the selector fallback; select and typeahead fills resolve a control's `aria-controls` in its own shadow root, then its hosts' roots, and read options and the shown choice through slots (`flatAll`, `flatText`); closed roots and cross-origin iframes are out of page JS's reach (see Frames). Same-origin iframes are walked by the snapshot (see Snapshot). Helpers take the element's own document and window (`viewOf`), so ref-based input works inside a walked frame. Pinned by `test/shadow.test.mjs`.
- **Keys and hover:** `press` and `click {hover}` dispatch untrusted events, so they reach background tabs but get no browser defaults (no text inserted, CSS `:hover` never matches). `press` emulates what pages rely on unless keydown or keypress was prevented: Enter clicks a button or link or submits the field's form (`requestSubmit`), Space clicks buttons, checkboxes and radios, Tab moves focus through visible tabbables. Result `{ok, el, prevented, focus}`. Pinned by `test/press.test.mjs`.

## Tool contracts and subsystems

Result shapes callers depend on are pinned by `test/contract.test.mjs` (each test names its consumer); `SKILL.md` documents them for agents. Every result key below is caller-facing: rename or drop one only with its consumers.

### Snapshot (`accessibility_snapshot`)

- **Format:** a `# {header}` line, then `ref role "name" key=json... flags`. Header keys: `url`, `title`, `ready`, `count`, `focus`, `dialogs`, `matched` (with `query`), `form`, `iframes`. `query` tests each line without its ref; `max` caps rows, not ref values. Refs continue a per-document counter.
- **Visibility:** `vis()` plus `snapVis` (a styled radio, checkbox or combobox input counts as shown when its label or box is).
- **Values:** a select's `value` is its chosen option's text; a placeholder choice (`nothingChosen`) has none and counts as required-empty. A combobox's `value` falls back to its box's single value or chips.
- **`form` header** (the biggest visible form, across walked frames): `fields`, `requiredEmpty`, `invalid?`, `unpicked?`, `step?`. The census (`CENSUS_LIB`'s `census`, shared with `fill {fields}`) counts required-empty text fields, placeholder selects and comboboxes, unticked required checkboxes, unchecked required radio groups and required file inputs, and drops disabled fields.
- **Flags:** `invalid` plus `error="..."` (from `aria-invalid` or a native constraint failure; an empty required field stays in `requiredEmpty` instead), `unpicked` (a typeahead holding typed text whose pick input is empty), `hidden` (a required-empty field `snapVis` drops gets a row after the ordinary rows; fill it by `ref`), with `reveal=<ref>` naming the button that likely shows it. Bot traps never get rows, nor do stand-ins (`standIn`: a text field aria-hidden and out of the tab order, such as react-select's required input or an address block's autofill catchers), which the census skips too.
- **Embedded frames:** `iframes: [{src, w, h, same, in?}]` lists visible iframes of at least 200x150 CSS px, largest first, at most 5 (`src` is origin and path only). A listed same-origin frame is walked after the page's rows, each row ending ` frame=<index>`. A cross-origin frame is only named, never read.
- **`frames:true`** adds cross-origin frame controls from Accessibility as `fN` rows (see Frames). A default snapshot does no Accessibility work.
- Pinned by `test/snapshot-form.test.mjs`, `test/snapshot-widgets.test.mjs`, `test/snapshot-refs.test.mjs`, `test/snapshot-frames.test.mjs`.

### Click readback (`click {readback}`)

- The click arms a record on `window.__perch_rb` (the readback element's text, a state signature of it and its first 50 descendants' ARIA and checked/value state, the url, the invalid fields, the form scope, step and alerts) and JXA polls `readback_read` for up to 2s until something changes or the page has been quiet for 10 polls (no DOM mutation, no fetch/XHR completing). In a hidden tab the quiet stretch must also last 1200ms of page time, so a throttled validation timer still lands inside it. `class` is not in the signature.
- **Result keys:** `changed`, `navigated`, `readback`; `invalid: ["Label: message", ...]` (fields that turned invalid or changed message, at most 5, `invalidCount` past that); `form: {gone?, step?, alert?}` when the clicked element's form scope moved; `page: {heading?, alert?}` after a new document.
- **Submitting controls:** a submit button whose own text or disabled state is the only change is mid-flight, so the poll keeps going; a form that only disables itself reads `changed:false`. Any other button's change reads `changed:true` at once, so an agent never re-clicks a toggle.
- Pinned by `test/click-readback.test.mjs` and `test/cross-server-state.test.mjs`.

### Wait (`wait`)

- Polls every 50ms from JXA. `wait {quiet: ms}` reuses readback's activity check (`QUIET_LIB`) and times the window in the runtime; polls write nothing (`{act, tok}`), so readers are independent. Returns `{ok, waited, quietFor}` or `timeout: wait timed out`. `quiet` takes no `selector` or `expression` and must be shorter than `timeout`; it does not stretch in a hidden tab. A fetch in flight is invisible until it completes.
- A `wait` fault names only a selector the page can't parse (`wait: bad selector: <selector>`).
- Pinned by `test/wait-quiet.test.mjs`, `test/wait-deadline.test.mjs`, `test/nav-poll.test.mjs`.

### Fill

`fill` returns `{ok, kind: "plain"|"rich"|"typeahead"|"radio", el, len, ambiguous?, kept?, reveal?, hidden?, warning?, note?}`. `ok:true` is proof the value holds.

- **Verification:** text-like fields pass when the value holds the text after trimming and collapsing whitespace, or on a tolerant check (most of the text, or a phone mask's digits). Sanitized inputs (`date`, `time`, `number`, `range`, `color`, ...) pass only on the exact value read back; a miss is `{ok:false, el, kept, error}` naming the accepted format, with the prior value not restored. A value the page put straight back is `ok:false`. An empty `text` clears any field and must read back empty. Pinned by `test/page.test.mjs` and `test/trusted-fill-exact.test.mjs`.
- **Label fallback:** `fill {label_pattern}` ranks by own label or whole autocomplete token (`acToken`, a fixed WHATWG list without `cc-*` or credentials) first, then hint, then ancestor text (which claims a field only as its section label, confirmed by `nearText` when the section holds other fields). Only visible fields are filled (`fieldVis`); bot traps (`trapLike`: honeypots, untabbable with autofill off, "leave blank" names) lose to a normal match and draw a `warning` when filled; a required field with a visible label is never a trap (`wanted`). A disabled winner (itself or by `fieldset[disabled]`) is refused, since the form won't submit it. `ref`/`selector` fills still write hidden fields and add `hidden: true`. Pinned by `test/page.test.mjs` and `test/fill-fields.test.mjs`.
- **Misses:** `candidates` (passed-over fields named by their own label), `reveal: ['button "Enter manually"']` (up to 2 buttons in the field's own section that likely show it; nothing is clicked; never a submit-like button), or a pointer to the largest listed frame (`label_pattern` never searches frames).
- **Typeaheads:** a plain fill on a typeahead (`role=combobox`, `aria-autocomplete`, or a widget box with a hidden companion and a dropdown; never a search box or `tel`) types, then Node runs the runtime `select` loop over the widget's own options only, pressing the best match by `taMatch` (accent-folded tiers: exact, comma parts, comma parts as places, prefix, word prefix, all words in order; a comma tie keeps the hits that start with the typed first part). A tie presses nothing (`ambiguous:true`, `candidates`). The pick passes only when something moved (the field's value, the companion's, or the list closing), never on the typed text alone. A miss on a widget that expects a pick restores the prior text and returns `ok:false`; any other combobox keeps the text as `{ok:true, kind:"plain", note}`. An empty lookup retries once with a shorter query (`query` in the result); a `trusted` fill never retries. A verified pick carries `selected`, and `value` only when it differs. Pinned by `test/fill-typeahead.test.mjs`.
- **Radio groups and checkboxes:** `option` also answers a radio group by its question (`kind:"radio"`, `selected`); `checked` clicks a box only on a change. Ties refuse (`ambiguous:true, candidates`), traps and hidden-only boxes are never clicked, a disabled box is refused even when already in the wanted state. Pinned by `test/check.test.mjs` and `test/fill-fields.test.mjs`.
- **`fill {fields}`** returns `{ok, results:[...], form?, unverified?, warning?, skipped?}`, `ok` if every field landed. Passes defer custom comboboxes and typeaheads to `select` and resume after; `fill_fields` records what it landed on `window.__perch_ff` keyed by `fp`.
  - A later field that clears, changes or removes an earlier one turns that result `ok:false`, naming the later field when it can be told (`fields[k] (<ident>) may have changed it`). A re-rendered node is looked up again (`twin`) before it is called removed.
  - A pass that finds another document (the pick navigated) writes nothing more: remaining fields fail with `the page changed after fields[k]; not filled`, earlier ones are flagged `unverified:true` with a `warning`. A final re-read that did not run flags earlier fields the same way.
  - `only_empty:true` skips (never fails) absent, trap-only, ambiguous, disabled and already-set fields, listed in `skipped` with the reason.
  - `option` may be an ordered preference list (at most 10); a pick past the first adds `pref: i`, all missing adds `tried`.
  - `fields_path` reads the `fields` array from a local JSON file (at most 256KB) with the same Apple Events as inline `fields`; errors are `fill: fields_path: ...`.
  - An entry may take `trusted:true` (never `raise`); it takes the background trusted route with every check an untrusted entry gets.
  - Pinned by `test/fill-fields.test.mjs`.
- **Form census:** the call's last pass adds `form: {requiredEmpty, unpicked?, left?:[{name, label}]}` for the form the first landed field sits in (`left`: at most 10, in document order), counted exactly as the snapshot header counts it. No extra Apple Event. Absent for fields outside any `<form>`, a batch that returned `gone` or halted. `ok` still follows the results; the census is information.
- **Late reverts (`late`):** a page can undo a write a task after the page script returned. A plain `fill`, a native `select` and a `fill {fields}` write pass record what landed on `window.__perch_fr` under an owner token (`FR_LIB`); `frJudge` later judges each record: back at its prior value or emptied is a revert (`reverted:true`), a select or radio on another option is a miss, and a text reformat is only a `note`.
  - Single `fill` and native `select` answer from the write alone. Node keeps the token (`lateToks`, server-wide, at most 20), and **the next call that runs page JS, on any target, carries the check inside its own first execute** (`lateTemplate`/`lateWrap`), so it costs no Apple Event on any browser. The call's result gets `late: [{el, error}]` (an object key, or one more text item for text, images, `eval_js` values and errors). Tokens are dropped once their record answered, or after 20 checks or 60s.
  - A `click` or `press` held by a non-empty list does nothing and answers `{ok:false, error: "nothing clicked: a field filled earlier no longer holds its value (late); ...", late}`, so a submit never goes out with a field the page emptied. It holds once, then the next click runs.
  - `fill {fields}` re-reads its own records in one bounded page call right after the batch (`fill_reread`), replacing results with `recheck` entries. A batch that put text in a field no one sees (an autofill catcher the page empties on a timer) reads once more after a watch, 600ms of page time or 1500ms in a hidden tab; other batches pay nothing. Where no bounded call exists (Arc, Safari, a second instance) or the reply dropped, the token goes to the next call's `late` check instead.
  - Pinned by `test/late.test.mjs` and `test/fill-fields.test.mjs`.
- **Trusted fill:** see Trusted input.

### Select

`select` returns `{ok, selected, el, value?, note?, candidates?, ambiguous?, pressed?, open?, dialogClosed?, trusted?}`.

- **Own list only:** options come only from the target control's own list: its `aria-controls`/`aria-owns` targets, else a list in a wrapper holding no other control, else options that appeared after select opened it. The control's box (`ctlBox`, `SELECT_OWN_LIB`) is never the page, a form or body. A search box is typed into only when it is the popup's own and empty. Pinned by `test/select-scope.test.mjs` and `test/select-pickers.test.mjs`.
- **Matching:** exact, whole word, word prefix, all typed words in order, then comma parts as places, never mid-word, accents folded. **Places:** a comma part naming a US state, Canadian province or common country equals its other names (`PLACES`); `pageScript` ships only the groups the call's text or option names, and a tie as places yields to any later literal tier. A native `<select>` tie at the winning tier short of exact sets nothing (`ambiguous:true, candidates`); a custom list's tie goes to the shortest. Disabled options never win or join a tie; a disabled `<select>` is refused. A filter is typed only when the unfiltered list finds nothing; a miss clears it and returns up to 30 `candidates` (`text:""` lists them).
- **Verification:** a native pick is read back after `change` (and late, see Late reverts). A custom pick is verified only when the control shows it (whole value, one element's text, or its own format once the display moved); **a control showing only the filter select typed proves nothing** and is `ok:false` "pressed ... but the control shows only the text select typed" unless the list closed, the companion changed, or the option became selected. A pick the control doesn't show is `{ok:false, pressed, value}`, never `ok:true`. An option already chosen is not pressed again (cmdk toggles) and adds a `note`.
- **Side effects:** a refusal changes nothing beyond undoing select's own typing (`untype`) and closing its own popup. Escape goes only to a popup select opened, never to a closed control. Inside an open modal select never sends an Escape the dialog could hear, and reports `dialogClosed: true` if the dialog closed anyway. A popup that ignores Escape is left open and the refusal says so (`open: true`) rather than synthesize an outside click. Nothing is blurred. A control out of view is centered to press it, and every offset select's own scroll moved is put back when the call answers (`SCROLL_HOME_LIB`); the page's own scrolls stay. Pinned by `test/select.test.mjs`.
- **Settling:** a custom list's miss ends once the own list holds still for a few polls; an emptied list after a typed filter waits while a loading signal shows. Typeahead fills keep waiting on an emptied list. A control with no text box still saying `aria-expanded="false"` after the press, with no option shown anywhere (open shadow roots too) and nothing loading, misses after about 0.6s; one without `aria-expanded` keeps the bound.
- **Synthetic open:** a press with focus; a role=combobox the press left shut and empty then gets one ArrowDown (before any typed filter), and a Downshift toggle naming its list a press.
- **Trusted select:** for menus that open only on a real press. `select {trusted:true}` opens synthetically first; only if that shows nothing does it click the control through the trusted click path, then the option if the pick doesn't show. A control or option another element covers at the aim point (not its shadow host or own label) is refused with `covered: true`, nothing posted. `trusted` lists what got a trusted click (`control`, `option`, `typed`). In a tab its window doesn't show, or a menu the trusted click leaves shut, it types a filter into the control's own empty text box with the editing command (`select_type`); no such box is `tab_not_visible`, nothing typed. Pinned by `test/select-trusted.test.mjs`; fixture `test/fixtures/trusted-select.html`.

### Tabs

- **`list_tabs`** returns `{tabs, total, warning?}`; rows carry the full app name and a `tabId`.
- **`new_tab`** returns `{app, tabId}`, defaults to the browser in use (`defaultBrowser`), needs a running browser with a window, never calls `activate()`, and puts back the tab a window showed if the browser switched to the new one. When the browser came to the front anyway, the result carries `warning: "creating the tab brought the browser to the front"`. Pinned by `test/new-tab-restore.test.mjs`.
- **`activate_tab`** is the only tool that selects a tab and raises its window.

### Clicks that open a tab

A popup blocker drops a synthetic click's new tab silently, so `click` reports both outcomes. The first pass stops before clicking a `_blank` link or submit (`blankHref`), keeps a closure on `window.__perch_blank` under an owner token, and the runtime reads every window's tabs, clicks through the kept closure and diffs the tabs for up to 500ms.
- `opened: {tabId, url}`: the click's tab (at the link's URL, still blank, or on its origin); perch never selects it, and `note: "the browser showed the new tab"` when the browser did.
- `unconfirmed: true, href, note` with `ok:true`: no tab seen (blocked or still opening); check `list_tabs urlContains href` before clicking again. New tabs that aren't the click's are never `opened`.
- `blocked`: only when the page saw `window.open` return null.
- Ordinary clicks cost what they did. Pinned by `test/click-new-tab.test.mjs`; live: `scripts/trusted-live.mjs --yes --new-tab`.

### Navigation

- `navigate` returns `{ok, url, tabId, waited, requested?, warning?}`: `url` is the committed document's URL (`requested` when it differs), and the tab's current `tabId`.
- **Load from page JS.** Chrome's AppleScript `set URL` raises the browser (it is treated as a typed navigation), so `navigate` starts the load with `location.assign(url)` inside the stamp call whenever page JS runs. Setting `url` is the fallback, and on Chromium and Arc it runs only with `raise:true` or when the browser and the tab's window are already in front (with a `warning`); otherwise `navigate` refuses before anything loads, naming `raise:true` and `activate_tab`. Safari's `url` set did not raise, so its fallback is unchanged.
- **Refusals before any Apple Event:** a url that is not absolute http(s), `file://` or `about:blank` is `bad_url` (`checkUrl` in Node, `loadable` in the runtime). A Chromium internal page (`chrome:` and the like) is `tab_not_scriptable`; Arc background tabs and `arc:` pages are `tab_not_visible`.
- **Outcomes:** a load the tab never made (a download, 204, a cancelled navigation, a `beforeunload` stay) is `load_failed: the tab stayed on <url>`; an error page is `load_failed: <url> did not load`; a load not committed by the deadline is `timeout: <url> had not committed after 15000ms ...; it may still load, check before retrying`. `waited:false` means committed but not confirmed complete. The stamp keeps its answer on the page (`window.__perch_navr`), so a retry after a lost reply never loads twice.
- Pinned by `test/navigate.test.mjs` and `test/url-policy.test.mjs`; live Arc: `scripts/navigate-live.mjs`.

### Screenshots

- **Capture:** the runtime reads a window's own pixels regardless of z-order. Without the Screen Recording grant (`CGPreflightScreenCaptureAccess`, which never prompts) every screenshot is refused before anything is spawned. With it, the **capture helper** (a second `osascript` capturing in process with `CGWindowListCreateImage`) takes the shot, else `/usr/sbin/screencapture`, else a Node-spawned `screencapture` fallback. Every capture is bounded at 3s and every temp file is removed; no execFile or fs message or temp path reaches the caller.
- **Why a helper:** `CGWindowListCreateImage` is proxied through `replayd`, which serves one live process per executable, so a daemon that captured in process would stall other tools' captures and be stalled by them. The helper holds an `flock` on `$TMPDIR/perch-capture.lock`, exits when idle or when its daemon is gone, and a stalled helper is killed and left off for a while. `PERCH_CAPTURE_HELPER=0` turns it off. Pinned by `test/screenshot-helper.test.mjs`.
- **Refusals:** minimized windows and windows on another Space have no CGWindowID (`window_offscreen`); only a window's active tab renders, so an inactive tab needs `raise:true`.
- **Element crop (`ref`/`selector`):** needs Accessibility (only the AX page area places the viewport in the window). `shot_clip` scrolls the element into view and records every scroll offset under an owner token; the crop is the element plus 8 CSS px, and the scroll is always put back. It refuses an element larger than the viewport, one clipped by a scrolling container, a window that isn't painting (covered or hidden, after a scroll), and another call mid-screenshot. `meta.clip` is the rect, `clipped:true` when the element was cut; a restore that got no answer becomes a `warning`. Pinned by `test/screenshot-element.test.mjs` and `test/screenshot.test.mjs`.

### File upload and drop zones

- `file_upload` reads the file in Node and ships it base64 in one page call, where a `DataTransfer` sets the input's `files`. It refuses a file over 25MB, or over 700KB without the daemon (one-shot osascript's argument limit). Rejected: the OS file dialog (takes the foreground) and a localhost server the page fetches from (local-network prompt).
- A target that is not a file input is a drop zone: its own file input comes first; with none, the page dispatches `dragenter`/`dragover`/`drop` with the file. An unwired hidden input (no request, no mutation within 1s) falls back to a drop. A drop is `{dropped:true, el}` and counts only when a file input holds the file or the name appears; otherwise `{ok:false, dropped:true, error}`. Result `shown` says whether the file name showed.
- Pinned by `test/upload.test.mjs`.

### Console and network (`console_capture`)

- `console_capture` injects a `<script>` that patches the main world's console and relays `perch:console` events; under a CSP that blocks inline scripts it patches the isolated console instead (perch's own evals only). Besides `level: text` entries it records `Uncaught ...`, `Unhandled rejection: ...` and `Assertion failed: ...` errors. Servers share one capture per document: only the last `stop` unhooks (earlier ones answer `stillCapturing`), and a read after another server's drain adds `partial:true`.
- `{mode:"network"}` reads Resource Timing, so it needs no start and intercepts nothing (Safari has no status: `-`). Patching `fetch`/XHR was rejected as close to interception.
- Pinned by `test/network.test.mjs` and `test/cross-server-state.test.mjs`.

### Trusted input

`click {trusted:true}`, `fill {trusted:true}`, `press {trusted:true}` and `select {trusted:true}` are for widgets that check `isTrusted`. Background is the default: no activation, no cursor move, no key-process change.

- **Background fill** uses the browser's editing command (`insertText`, `EDIT_LIB`'s `editType`) in the target tab through page JS, so it works in inactive and minimized tabs and needs no Accessibility; it verifies a trusted `input` event and the exact value. Result `{ok, trusted, value, el}`; callers require both `ok` and `trusted`. A typeahead then takes the usual pick with `trusted:true`.
- **By label,** every trusted fill route takes plain fill's ranking (`fillOne`, holding the field as a `fill {fields}` pass does). The tie `only_empty` skips refuses (`ambiguous:true, candidates`) with nothing typed, since typing can't be taken back. Pinned by `test/trusted-fill-label.test.mjs`.
- **Background click** needs Accessibility, an on-screen window and the tab its window already shows (never switches tabs; else `tab_not_visible`). `trustedTarget` resolves pid, CGWindowID and frame; `aim` places the point from the AX page area (`axPageArea`), never from the page's own estimate alone; SkyLight posts to the pid with window-local coordinates (`SLEventPostToPid`, a move primer and an off-screen pair first; the down event carries Command for routing, so a page reading `mousedown`'s `metaKey` sees `true` while the `click` sees `false`). It never posts `SLPSPostEventRecordTo` focus records, which redirected the user's keyboard. Results carry `aim` (`ax` or `mouse`), a `calibration` trace, `delivery`, `point` and `hit` (did the trusted mousedown land on the element).
- **Hit test before every post:** `trusted_probe` refuses an element inside an IFRAME, FRAME, OBJECT or EMBED; `offPage` hit-tests the final point with Accessibility and requires the first `AXWebArea` up from the hit to be the page's own. Another web area (an embedded frame), browser UI, a JS dialog or a failed hit test refuse with nothing posted. Another window of the same browser over the point refuses; another app's window doesn't matter. AX reads only, no Apple Events. Pinned by `test/ax-hit-test.test.mjs` and `test/perf-budget.test.mjs`.
- **`raise:true`** is the foreground HID route (`CGEventPost` at the HID tap for clicks, the session tap for typing, cursor restored). Raised fill passes only on the exact text (whitespace-normalised, or a phone mask's digits) and a miss reports what the field holds, never the text sent. Refusals after `trustedTarget` come after the raise, and a refused raised fill can leave its field cleared.
- **Trusted press** posts a named key (no cmd/ctrl/alt chords; shift only) to the browser pid with `SLEventPostToPid`. The key goes to the browser's key window and focused element, so `keyFocusMiss` first requires, with Accessibility alone, that the target window is key and focus is inside the page's own web area; otherwise `tab_not_visible` with a hint (a background trusted click moves focus back). It refuses keys into frames and a Tab out of the page. `hit` is true, false or null (none arrived). Pinned by `test/trusted-press.test.mjs`.
- **Foreground typing traps** (both make Chrome type "a"): the UTF-16 encoding constant is `0x94000100`, and `CGEventKeyboardSetUnicodeString` must be rebound with `void *` parameters. Chunks are at most 20 UTF-16 units, never splitting a surrogate pair. Mouse event fields use raw indices (1 click state, 11 pressure), since `$.kCG*` constants aren't reliably bridged.
- `ObjC.bindFunction` registers on `$` rather than returning the function; `scripts/skylight-probe.js` proves the SkyLight bindings.
- Pinned by `test/trusted.test.mjs`, `test/trusted-fill-exact.test.mjs`, `test/window-match.test.mjs`; live: `scripts/trusted-live.mjs`.

### Frames (Accessibility)

- `accessibility_snapshot {frames:true}` reads cross-origin frame controls from the Accessibility tree in the same runtime call (bounded by 3000 nodes and 150ms) and lists them as `fN role "name" frame="<host>" flags` rows. It never reads a field's value. Rows of a same-origin frame the page walk already listed are dropped.
- **Flags:** `secure` (a password field), `handoff` (sign-in and challenge frames from a fixed host list plus `/recaptcha` paths, any frame without an http(s) URL, and anything nested under one), `offscreen`. `handoff` and `secure` rows are the user's: a click is refused before anything is raised, probed or walked.
- `fN` refs take only `click {ref:"fN", trusted:true}`; every other use throws `frame refs need click {trusted:true}`. The click re-walks, matches the row again (frame URL, role, name, ordinal) and clicks its fresh center, never a stored point; a changed frame or page URL is the stale-ref error. The result is `{ok, ref, frame, point, aim:"ax", delivery, before, after, hit:null}`, with `before`/`after` re-read from Accessibility since no page recorder can confirm delivery.
- Walk failures stay in the header (`frames:{error}`) with the trusted click's codes, else `frames_unreadable`. Pinned by `test/frames.test.mjs`, `test/frame-refusal.test.mjs`, `test/frame-cover.test.mjs`, `test/snapshot-frames.test.mjs`.

### Dialogs

- A page's `alert`/`confirm`/`prompt` blocks its JS, so a call running page JS hangs. `rt()` watches every entry except `DIALOG_BLIND`: after `DIALOG_PROBE_MS` in flight (and every `DIALOG_REPROBE_MS` after) a one-shot osascript scans for a dialog; a hit aborts the call with `dialog_open`. A timeout that may be a hang (`HANG` phrases) is probed once more; a wait that ran out while the page answered is not.
- **Attribution fails closed:** the scan is Accessibility only (no Apple Events while no dialog is open). A dialog counts only when its shape is a plain alert, confirm or prompt (structural, never by localized title; anything else is kind `other`: sign-in sheets, FedCM, passkey, permission bubbles), it is a child window directly above the target's window, the target is its window's shown tab, its heading names the tab's host, and the page is proven paused (a bounded no-op times out). Unproven (Safari, Arc, JS from Apple Events off) is neither reported nor answered.
- **Answering:** `press {dialog}` needs `target.tabId`, presses buttons by position with `AXPress`, sets a prompt's text as `AXValue` and reads it back, never activates or raises, and reports a dialog the page opens right after as `next`.
- Rejected: auto-dismissing dialogs, a separate dialog tool, and matching a dialog by browser alone (it answered dialogs in the user's other tabs). Pinned by `test/dialog.test.mjs`; live: `scripts/dialog-live.mjs`.

## Browser support

| Browser | JS eval | Navigation | New/activate tab | Notes |
|---|---|---|---|---|
| Google Chrome (+Beta/Canary) | yes | yes | yes | Reference target. |
| Brave / Edge / Vivaldi | yes | yes | yes | Same dictionary as Chrome. |
| Arc | active tab only | yes | yes | See Arc quirks. |
| Safari | any tab | yes | yes | `new_tab` pushes `Tab({url})` into the front window; if that throws it is `no_browser`, with no keystroke fallback. No bounded page call, so no dialog proof and no in-call `fill {fields}` re-read. |

Live verification is Chrome Canary first; Arc and Safari paths not yet run live are covered by the fake world only. When a behaviour is unverified live, say so in the commit message rather than here.

## Permissions

1. **Browser:** Allow JavaScript from Apple Events. Chromium family: View > Developer (per profile). Safari: Develop menu.
2. **macOS Automation** for the controlling app (Claude Code, Terminal, iTerm) to each browser. Prompted on first call.
3. **macOS Accessibility**, for trusted clicks and presses, raised input, element screenshots, the frame walk and dialogs.
4. **Screen Recording**, for screenshots.

Each blocked layer returns an actionable error naming the exact toggle (`ERR.jsOff`, `ERR.automation`; `test/docs.test.mjs` pins the paths). perch never prompts for Accessibility or Screen Recording.

## Testing and measuring

- **`npm test`** (unit, no browser) must be green before every commit. Tests run against the fake osascript REPL and fake JXA world in `test/fakes/` and happy-dom for page scripts; `test/runtime.test.mjs` also compiles the runtime with real osascript. Write the failing test first.
- **`test/perf-budget.test.mjs`** pins Apple Events per call and page script sizes; `test/call-events.test.mjs` pins per-call event trims; `test/schema.test.mjs` keeps `tools/list` under `SCHEMA_BUDGET`; `test/docs.test.mjs` keeps SKILL.md and this file honest and capped.
- **`npm run smoke`** (live) must pass.
- **`npm run bench`** (live, Canary) compares against `bench/baseline.json`. It serves `bench/fixture.html` on 127.0.0.1, navigates an existing about:blank scratch tab there and back, and compares byte counts only when the fixture's sha256 matches the baseline's. Unchanged code moves about 5% between runs, so smaller differences are noise.
- **Every change is measured.** Perf work must improve its numbers; other work must not regress them. Put before/after in the commit message, and never report unchanged numbers as a gain. A regression needs a reason or a fix. If the change made perch faster, replace `bench/baseline.json` with the new run (`bench/runs/bench.json`) in the same commit. For a change a user would notice in an agent's session (fewer calls, a flow that works now), rerun `scripts/compare.mjs` and add a row to `bench/compare/README.md`. Runs land in `bench/runs/` (gitignored); no other bench history goes in the repo.
- Temp dirs come only from `scripts/temp.mjs` (`test/tmp-cleanup.test.mjs`).

## Live checks

- **Never disturb the user.** Live steps need a browser tab the user isn't using. Reuse an existing scratch tab (`about:blank`, or `about:blank#perch-<ts>` from `--with-tab-creation`); never create or select tabs or activate another app to set one up. If the preconditions are absent, don't sit waiting on the user: poll for them (a watcher) and start once they hold, or say what is left and defer it. Never skip silently.
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
- **Tools earn their slot.** Solve a real workflow; don't mirror CDP. Check the known consumers (GOALS.md) and `test/contract.test.mjs` before changing the surface; GOALS.md has the admission test. Keep `tools/list` under `SCHEMA_BUDGET`, with shared guidance in `INSTRUCTIONS`. Turned down so far: a `find` tool (`accessibility_snapshot {query}` does it), a scroll tool (`eval_js` covers it), GIF recording (needs a dependency), a dialog tool.
- **Docs stay lean.** SKILL.md adds to the schema rather than repeating it and stays under its cap. This file holds rules, contracts and pointers; per-case behaviour goes in a test, history in commit messages. Don't append a paragraph per round.
- **Commits** are atomic, carry measured before/after, and have no attribution trailers.

## Ceiling: what AppleScript can't do

- **Network interception** (request/response capture, header injection): CDP or an extension only.
- **Pre-load instrumentation** (`document_start`): both bridges run after navigation.
- **Off-screen capture** of minimized windows or windows on another Space: neither capture path has a window image or CGWindowID for them.
- **Background trusted input:** live-verified on Chrome Canary on this macOS version. SkyLight is a private macOS API and can change between OS releases. The explicit `raise:true` HID route remains available.
