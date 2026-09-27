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
