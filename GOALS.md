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
- perch loads only absolute http(s) URLs and about:blank; local files reach a
  page only through file_upload.

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

## Principles
How the goals show up in every tool.
- **Fail closed.** When perch can't prove an action lands where it should (the
  target's own dialog, a click point inside the page, a frame it can place),
  it refuses (goals 1 and 2).
- **Believe the site.** Report what the page kept, not what perch sent: the
  option the control picked, the text a field still holds, the file an input
  still has (goal 2).
- **Never activate to tidy up.** Undoing a side effect by taking focus is
  still taking focus; warn instead (goal 1).
- **Fold before adding.** A param on an existing tool beats a new tool
  (goals 3 and 4).

## A new tool or param earns its slot if
- a consumer workflow needs it today, not a CDP feature by analogy;
- it removes agent turns or makes a result verifiable;
- it fits `SCHEMA_BUDGET`, or something else leaves to make room;
- it keeps goal 1 by default.

## Non-goals
- **Playwright-style primitives.** Tools are shaped around tasks an agent
  finishes and verifies in one call (`fill {fields}`, `click {readback}`), not
  low-level steps it has to chain; no locator chaining or page objects.
  `eval_js` covers the rest.
- **Stealth.** No motion humanizing, jitter, timing randomization or anything
  captcha-specific. Sign-in and challenge frames go to the user.
- **Driving several browsers at once in one call.**

What AppleScript can't reach at all (network interception, pre-load
instrumentation) is in AGENTS.md "Ceiling". How each goal is met, and the
designs rejected on the way, are in AGENTS.md too.
