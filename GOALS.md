# perch: goals

## What perch is for
Agents doing real tasks in the macOS browser the user already has open,
while the user keeps working. The known consumers:
- [avis](https://github.com/sryo/avis): review and annotate a live page with
  the user.
- Unattended agents that fill long forms across many background tabs, often
  for hours, with the user at the same machine.

The benchmark to beat is Claude in Chrome (`bench/compare/`), not Playwright.

## Constraints (never traded)
- The user's own browser, as it is: no extension, no debug port, no relaunch,
  no separate profile.
- Single-file server, one runtime dependency, one-command install.

## Goals, in priority order
When two goals conflict, the higher one wins.

1. **Never take the user's foreground.** No app activation, tab selection,
   keyboard redirection or cursor move unless the call opts in
   (`activate_tab`, `raise:true`). A refused action is better than a stolen one.
2. **Correct outcomes, verified.** Report what actually happened on the page
   (readback, value checks, `trusted`/`hit`). `{ok:false}` beats a false `ok`.
3. **As few agent turns as success needs.** Each call costs the model a turn,
   about 6 seconds, so a common workflow shouldn't take five calls when one
   will do. But a call that lets the agent see and recover is worth its turn;
   saving turns never comes at the cost of goal 2.
4. **Small context footprint.** Short tool schemas, compact results, and large
   payloads (files, long text) read from disk instead of passed as arguments.
5. **Fast per call.** Latency is Apple Events per call; spend as few as possible.
6. **Any macOS browser, one API.** Chrome family, Arc, Safari. Clients never
   branch on browser; real gaps surface as neutral error codes.

## How we know
| Goal | Metric | Where |
|---|---|---|
| 1 | foreground app, key process, cursor unchanged | `scripts/trusted-live.mjs --background`, `npm run smoke` |
| 2 | readback hits, navigate success rate | `bench/compare/README.md` |
| 3 | calls per task that succeeds | `bench/compare/README.md` |
| 4 | `tools/list` chars under `SCHEMA_BUDGET`; payload sizes | `test/schema.test.mjs`, `bench/baseline.json` |
| 5 | p50/p95 per tool; Apple Events per call | `bench/baseline.json`, `test/perf-budget.test.mjs` |
| 6 | no browser names in descriptions | `test/runtime.test.mjs` |

## A new tool or param earns its slot if
- a consumer workflow needs it today, not a CDP feature by analogy;
- it removes agent turns or makes a result verifiable;
- it fits `SCHEMA_BUDGET`, or something else leaves to make room;
- it keeps goal 1 by default.

## Non-goals
- Network interception, pre-load instrumentation, console subscription: out of
  reach for AppleScript (see AGENTS.md "Ceiling").
- A general scripting API. perch offers task-shaped tools (`fill {fields}`,
  `click {readback}`) and `eval_js` as the escape hatch, not a selector
  language or a page object model.
- Driving several browsers at once in one call.

## Decisions
One entry per decision, not per round: what was chosen, the goal it served,
what was rejected. No metrics, status or backlog: measurements live in
`bench/`, mechanism in AGENTS.md, open work under Open questions.

- **File uploads (2026-05): server-side base64 + DataTransfer.** perch reads
  the file and ships it in one `eval_js` (goal 4 for the agent, about 80 KB
  across the bridge). Rejected: the OS file dialog (goal 1), a localhost server
  the page fetches from (Chrome's local-network prompt breaks goal 1).
- **Trusted input (2026-09): background SkyLight route.** Window-routed click
  events and Chrome's editing command for fill, both without touching the
  user's key process. Rejected: AppKit focus records (redirected the user's
  keyboard, goal 1); trusted clicks on inactive tabs or minimized windows (no
  delivery, and selecting the tab breaks goal 1). `raise:true` keeps the HID
  route for callers who opt in.
- **Accessibility has the last word on a trusted click (2026-09).** Every
  trusted click hit-tests its final screen point and posts only when it lands
  in the target page's own web area; anything else refuses with nothing posted
  (goal 2, failing closed). Accepted: refusals where Accessibility finds no
  page area or another window covers the point.
- **Trusted keys (2026-09).** `press {trusted}` posts named keys, shift only,
  and only while Accessibility shows focus inside the target page. Rejected:
  Cmd/Ctrl/Alt chords (they fire browser shortcuts such as closing the tab),
  keys with focus in the address bar or a frame, and Tab past the page's last
  control (it moved focus to the toolbar, where Enter reloaded the tab); all
  goal 2. A window whose frame another window shares is `window_ambiguous`
  (goal 1 over reach).
- **Surface diet (2026-09).** `get_html` folded into `get_text {html}`, page
  state into the snapshot header, snapshot as a line format, `target` lists
  only `tabId` and `app` (goal 4). Enforced by `SCHEMA_BUDGET`. Rejected:
  splitting `server.js` into modules (constraint: single file) and dropping
  `windowId`/`tabIndex`, which rows without a handle still use.
- **Fold before adding (2026-09).** New tools only where nothing fits:
  `close_tab` (needs an explicit `tabId`, never closes a window's last tab)
  and `press`. Folded instead: `click {hover}`, a passive network log in
  `console_capture` (Resource Timing, reading completed requests only),
  open shadow roots and a `query` filter in `accessibility_snapshot` in place
  of a `find` tool (goals 3 and 4). Rejected: fetch/XHR patching (close to
  interception), a scroll tool (`eval_js` covers it), GIF recording (needs a
  dependency).
- **Browser-neutral handles (2026-09).** `tabId` encodes the browser, so
  `{tabId}` alone works everywhere (goal 6) and Chromium id collisions across
  apps are gone. Rejected: auto-activating a tab on `tab_not_visible` (goal 1).
- **Never activate to tidy up (2026-09).** `new_tab` puts back the tab its
  window was showing; `navigate` starts loads from page JS (`location.assign`)
  because AppleScript's `set URL` raised Chrome, and no longer selects Safari
  tabs (goal 1). Rejected: re-activating the user's previous app after
  `new_tab` (itself an activation). Accepted: a page-started load keeps the
  old page as referrer and may run `beforeunload`.
- **One-call workflows (2026-09).** `fill {fields}` and `click {readback}` do
  in one call what took five and two (goals 2 and 3).
- **Believe the site (2026-09).** Form tools report what the page kept, not
  what perch typed: `select` picks only from the target control's own options
  and returns `candidates` on a miss; `fill` on a typeahead picks the widget's
  own suggestion, keeps free text only where the field keeps it, and withdraws
  it otherwise; `file_upload` reports an input the site swapped or emptied;
  `navigate` reports `waited` only when the URL moved (goal 2). Accepted: a
  typeahead that filters to nothing is indistinguishable from free text.
- **Dialogs (2026-09): answer only what is provably the target's.**
  `press {dialog}` needs a `tabId` and answers only that tab's own JS
  alert/confirm/prompt, proven by shape, host and the page's JS being paused;
  page JS stuck behind a dialog fails fast with `dialog_open` (goals 1 and 2).
  Browsers that can't prove it fail closed. Rejected: auto-dismissing (goal
  2), a dialog tool or `click {dialog}` (budget), answering sign-in sheets,
  permission and leave-page prompts (the user's call), and matching by browser
  alone (it answered dialogs in the user's other tabs).
- **Frames stay the user's where it matters (2026-09).** Opt-in
  `accessibility_snapshot {frames:true}` lists iframe controls, cross-origin
  too, and they take only a trusted click (goals 2 and 3), never typing, so
  card and password fields are never filled. Sign-in and challenge frames, and
  frames perch can't place, are `handoff` and refuse clicks. Rejected: stealth
  of any kind (motion humanizing, jitter, timing randomization), anything
  captcha-specific, and a configurable host list.
- **No stale screenshots (2026-09).** Minimized and other-Space windows are
  refused: `screencapture -l` returned pixels from before minimizing, and a
  stale image is the false `ok` goal 2 rejects.

## Open questions
- `navigate` from page JS with the browser behind another app; Arc and Safari.
- Dialog proof against real dialog trees, and on Safari and Arc.
- Frames on Safari and Arc; frame links and `raise:true` frame clicks.
- The hit test against a real challenge widget in a closed shadow root.
- Typeaheads whose suggestion list is portaled with no `aria-controls`;
  real sites' async uploads.
- Drag, resize and same-origin iframe descent, each waiting for a consumer.
