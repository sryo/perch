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
  no separate profile. The one exception is a room (the `rooms` CLI): its own
  Chromium on one persistent profile in a Linux VM, reached over a loopback
  DevTools port behind a token, for work that must go on while the Mac is
  locked or a window is minimized. A call reaches a room only by a `room:`
  handle, and nothing a room does touches the user's screen or browser.
- Single-file server, one runtime dependency, one-command install.

## Goals, in priority order
When two goals conflict, the higher one wins.

1. **Never take the user's foreground.** No app activation, tab selection,
   keyboard redirection or cursor move unless the user allowed it: a call that
   needs focus (`activate_tab`, `raise:true`) runs only under the user's own,
   timed focus grant, and otherwise answers `needs_focus`. The background path or
   a room comes first. A refused action is better than a stolen one.
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
| Goal | Metric | Where | Run |
|---|---|---|---|
| 1 | foreground app, key process, cursor unchanged; focus only under the user's grant | `scripts/trusted-live.mjs --background`, `npm run smoke`, `test/focus-grant.test.mjs` | by hand: `node scripts/trusted-live.mjs --yes --background` and `npm run smoke` post real input to the user's browser |
| 1 | focus only under the user's grant, and the rest of the suite | `test/focus-grant.test.mjs`, `npm test` | `npm test` |
| 2 | `readback_hits`, navigate success rate | `scripts/compare.mjs --fium` (fium compare), `bench/compare/README.md` | `node scripts/compare.mjs --app room:main --fium ~/.fium/runs/perch/done-compare.json >&2 && echo ~/.fium/runs/perch/done-compare.json` |
| 3 | `calls_per_task <op>` (calls per task that succeeds) | `scripts/compare.mjs --fium` (fium compare), `bench/compare/README.md` | `node scripts/compare.mjs --app room:main --fium ~/.fium/runs/perch/done-compare.json >&2 && echo ~/.fium/runs/perch/done-compare.json` |
| 4 | `tools/list` chars under `SCHEMA_BUDGET`; payload sizes | `schema chars`: `test/schema.test.mjs`, `bench/baseline.json` | `node scripts/bench.mjs --offline --fium ~/.fium/runs/perch/done-fium.json && echo ~/.fium/runs/perch/done-fium.json` |
| 5 | p50/p95 per tool; Apple Events per call | `bench/baseline.json`, `test/perf-budget.test.mjs` | costly: `node scripts/bench.mjs --app canary --fium ~/.fium/runs/perch/done-live.json && echo ~/.fium/runs/perch/done-live.json` |
| 5 | Apple Events per call (`lock events <tool>`) | `test/perf-budget.test.mjs`, behaviour lock | `node scripts/bench.mjs --offline --fium ~/.fium/runs/perch/done-fium.json && echo ~/.fium/runs/perch/done-fium.json` |
| 6 | no browser names in descriptions | `test/runtime.test.mjs` | `npm test` |

Caps: `q3 k2 n2 b1 t1` (how firm each kind of number is: 3 hard, must end the same or better; 2 semi-hard, past its margin you choose; 1 semi-hard with a 10% margin; 0 soft, no limit; fium RULES.md K6)

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
