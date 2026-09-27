# perch vs Claude in Chrome

The same 8-op suite, run against `fixture.html` served on `127.0.0.1:8787`, in the
same Chrome Canary on macOS 27.2.

- `perch.json`: perch before the improvement loops
- `perch-after.json`: perch after them (`node scripts/compare.mjs --app canary --reps 10 --activate`)
- `extension.json`: Claude in Chrome, measured by an agent through `browser_batch`

## How to read the numbers

Tool calls are what matter most. Each call costs the model a turn, measured at about
6 seconds, which dwarfs every per-op time below.

The two sides are timed differently:
- **perch:** end to end through the MCP stdio server.
- **Extension:** page-side `Date.now()` stamps inside one `browser_batch`. This leaves
  out the MCP hop, so treat those times as a floor, not a head-to-head.

## Results

Calls and median ms are shown as perch before / perch after / extension. The ok
column is perch before / after; the extension completed every op.

| Op | Calls | Median ms | ok |
|---|---|---|---|
| O1 list tabs | 1 / 1 / 1 | 100 / 83 / 2 | 100% / 100% |
| O2 navigate | 1 / 1 / 1 | 196 / 135 / 89 | **70%** / 100% |
| O3 read text | 1 / 1 / 1 | 50 / 17 / 59 | 100% / 100% |
| O4 snapshot | 1 / 1 / 1 | 50 / 17 / 66 | 100% / 100% |
| O5 eval | 1 / 1 / 1 | 50 / 17 / 2 | 100% / 100% |
| O6 fill 5 fields | 5 / **1** (`fill {fields}`) / 6 | 245 / 14 / 73 | 70% / 100% |
| O7 click and verify | 2 / **1** (`click {readback}`) / 3 | 99 / 51 / 164 | 100% / 100% |
| O8 screenshot | 1 / 1 / 1 | 189 / 165 / 143 | 100% / 100% |

## Payload size

These are the characters that land in context for each op.

- **Read text:** perch 14.4k (the whole body); the extension 13.2k (the `<article>` only).
- **Snapshot:** perch 7.5k (every field labelled, all 150 links).
- **Extension `read_page`, interactive filter:** 0.3k, but the fields are unnamed and it
  only covers what is in the viewport.
- **Extension `read_page`, default filter:** 14k.

## Extension quirks seen

- A click on a freshly loaded background tab reported success but did nothing. It
  only worked after the agent took a screenshot.
- Fields inside a `<label>` showed up with no name in the interactive snapshot.

## What changed in perch

- **navigate:** it no longer hangs. Chrome drops the reply to an `execute` sent while a
  navigation is replacing the page. navigate now waits for `loading` to go false and
  caps each check with an AppleScript timeout.
- **fill {fields}:** one call fills a whole form. `checked` sets a checkbox's state
  idempotently.
- **click {readback}:** returns the selector's text once it changes, capped at 2 seconds.
- **Apple Events per call:** most calls went from 3 to 5 events down to 1, because
  handles now remember their window. At about 16.6ms per event, that is the latency
  floor.

## After the trusted-click calibration fix (39bf181)

`perch-after2.json` reruns the suite on top of the Accessibility-tree aiming. It matches
`perch-after.json` within noise (eval 17ms, fill with `fields` 15ms, click with readback
51ms, 100% ok), because the suite only uses plain DOM clicks.

The trusted path was measured separately on the same fixture, with Canary as the
active tab. The call was `click {selector: "#submit", trusted: true, readback: "#status"}`,
10 reps:

- **Aim:** `ax` on 10 of 10. No reps fell back to the estimate.
- **Result:** `hit: true` and the correct status read back on 10 of 10.
- **Time:** median 311ms, range 295 to 349. That covers the whole call: probe, AX aim,
  SkyLight click and readback.
