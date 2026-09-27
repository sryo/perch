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
Each entry: what was chosen, the goal it served, what was rejected. Mechanism
lives in AGENTS.md.

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
- **Surface diet (2026-09): 17 tools to 15, schema about halved.** `get_html`
  folded into `get_text {html}`, page state into the snapshot header,
  snapshot as a line format (goal 4). Enforced by `SCHEMA_BUDGET`.
- **One JXA runtime (2026-09).** A real function shipped as the daemon
  prelude, so it is parse-checked and unit-tested. Rejected: splitting
  `server.js` into modules (constraint: single file).
- **Browser-neutral handles (2026-09).** `tabId` encodes the browser, so
  `{tabId}` alone works everywhere (goal 6) and Chromium id collisions across
  apps are gone. Rejected: auto-activating a tab on `tab_not_visible` (goal 1).
- **One-call workflows (2026-09).** `fill {fields}` and `click {readback}` do
  in one call what took five and two (goals 2 and 3).
- **Reach and keys (2026-09): 15 tools to 17, budget 9000 to 9400.** New
  `close_tab {tabId}` (a required handle, so omission can never close the
  user's tab; never the window's last tab) and `press {key}` (synthetic keys
  with Enter/Space/Tab defaults emulated, background-friendly). Folded in
  rather than added: `click {hover}`, `console_capture` mode `network`
  (Resource Timing, reading only), and open shadow roots plus a `query` regex
  in `accessibility_snapshot`, perch's answer to a `find` tool (goals 3 and 4).
  Deferred: fetch/XHR patching (close to interception), trusted press and
  hover, drag, resize, dialogs and cross-origin iframes (each waits for a lab
  result), GIF recording (no encoder without a dependency), scroll (`eval_js`
  covers it) and same-origin iframe descent (next use of the shadow walker).
- **Dialogs and trusted keys (2026-09): budget 9400 to 9600, SKILL cap 6600
  to 6800.** `press {trusted}` posts real key events through SkyLight to the
  tab its window shows (named keys, shift only). `press {dialog}` answers a
  native alert/confirm/prompt through Accessibility without raising the
  window. Page JS stuck behind a dialog fails in about 2s with `dialog_open`
  instead of a 30s timeout. `new_tab` puts back the tab its window was
  showing. Rejected: `click {dialog}` (over the per-tool cap), a dialog tool,
  auto-dismissing dialogs (goal 2), trusted cmd/ctrl/alt chords (they can fire
  browser menu shortcuts such as closing the tab), and re-activating the
  user's previous app after `new_tab` (that is itself an activation, goal 1).
  After the live run, a trusted Tab past the page's last focusable element is
  refused: it moved focus into the toolbar, where the next Enter reloaded the
  tab (goal 2). Dialogs are found only outside browser windows, because a
  page's own `role=dialog` looks the same to Accessibility.
- **Dialog scope (2026-09).** `press {dialog}` answers, and the watchdog
  reports `dialog_open` for, only the target tab's own JS alert/confirm/prompt:
  a child window directly above the target's window, on the tab that window
  shows, in one of the recorded shapes, and for answers, with the tab's host in
  its origin line. Anything perch cannot tie to the target fails closed (goals 1
  and 2). Rejected: answering the browser's other dialogs, HTTP sign-in sheets
  (credentials), leave-page and permission prompts (the user's call), and
  scoping by browser only (it aborted calls and answered dialogs in the user's
  other tabs).
  Round 4 adds positive proof (goals 1 and 2): `press {dialog}` needs
  `target.tabId`; any control but buttons, a plain field, texts, headings and
  groups makes a dialog `other`; the watchdog also needs the host in the
  heading; and both need the page's JS paused, shown by a 1s bounded no-op
  execute getting no reply. Permission, multiple-downloads, FedCM and passkey
  prompts can pass the shape and host tests but leave the page running.
  Browsers without a bounded execute (Safari, Arc) fail closed. Rejected:
  answering on a shape and host match alone, and a default target for
  `press {dialog}`.
- **Round 3 (2026-09): room back, Safari background tabs.** `target` lists
  only `tabId` and `app` (`windowId` and `tabIndex` still work) and
  descriptions and SKILL.md were tightened: `tools/list` 9511 to 8385 chars,
  budgets unchanged (goal 4). Safari runs page JS in, and `navigate` loads, a
  tab its window isn't showing (live, Safari on macOS 27.2), so `navigate` no
  longer selects the tab (goal 1). Rejected: dropping `windowId`/`tabIndex`
  (list rows without a handle still use them) and raising any budget.
  Deferred: dialog attribution live (no live dialog tests while the user may
  type), Safari and Arc dialog trees, cross-origin iframes through
  Accessibility (captcha, payment and login frames need their own design),
  and screenshots of minimized or other-Space windows (no consumer needs them).
- **Frames (2026-09): iframe controls through Accessibility.** Opt-in
  `accessibility_snapshot {frames:true}` lists controls inside iframes,
  cross-origin ones too, as `fN` rows, and `click {ref:"fN", trusted:true}`
  clicks one after walking the frames again (goals 2 and 3: one snapshot and
  one click instead of a hand-off). No new tool, budgets unchanged. Click only:
  frame refs refuse fill, press, select, get_text and file_upload, so card and
  password fields are never typed into, and rows never carry a field's value.
  Rejected: stealth of any kind (motion humanizing, jitter, timing
  randomization) and anything captcha-specific; challenge frames are the
  user's. Deferred again: screenshots of minimized windows, because in the lab
  `screencapture -l` returned the pixels from before minimizing, and a stale
  image is the false `ok` goal 2 rejects.
- **Round 4 (2026-09): dialog proof, frames live.** Dialogs are answered and
  reported only with proof (above), and frame clicks ran live on Chrome Canary
  behind another app with the foreground unchanged. `tools/list` 8385 to 8544
  chars, SKILL.md 6704 bytes, budgets unchanged (goal 4). A frame click's
  `after` waits up to 0.5s for Accessibility to catch up, and a checkbox state
  Chrome doesn't expose reads null, not false (goal 2). Found live: `navigate`
  from `about:blank` to a local page raised Canary although perch never
  activates (goal 1). Deferred: why, and a fix; the dialog proof and the
  whitelist against the real dialog tree (no live dialog tests while the user
  may type); frame links, `raise:true` frame clicks, Safari and Arc frames.
- **Frame hand-off (2026-09): sign-in and challenge frames refuse clicks.**
  Frame rows from a short fixed list of sign-in and challenge hosts (Google,
  Apple and Microsoft sign-in, reCAPTCHA, hCaptcha, Turnstile, Arkose) are
  flagged `handoff`, and a trusted click on a `handoff` or `secure` row
  returns `{ok:false}` with a hand-to-user message before anything is raised
  or posted (safety; goal 3: the snapshot shows it before the agent tries).
  Rejected: leaving it to SKILL.md, a configurable list, and guessing
  challenges from control names. Unverified live.
