# perch vs Claude in Chrome

The same 8-op suite (O1 to O8, plus the one-call variants O6b and O7b) runs against
`fixture.html`, served on `127.0.0.1:8787`, in Chrome Canary.

```
node scripts/compare.mjs --app canary --reps 10 --activate
```

Runs land in `bench/runs/compare.json`, which is gitignored. Add a row to the history
below when a run is worth keeping.

## How to read the numbers

Tool calls matter most. Each call costs the model a turn, about 6 seconds, which dwarfs
every per-op time.

perch is timed end to end through its MCP stdio server. The extension was timed with
page-side `Date.now()` stamps inside one `browser_batch`, which leaves out its MCP hop.
Treat its times as a floor, not a head-to-head.

## History

All runs: macOS 27.2, Chrome Canary. Times are median ms.

| Date | Tool | Rev | Fill 5 fields | Click + verify | Navigate | Read text | Snapshot | Eval | Screenshot | Navigate ok |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-27 | perch | 3ba7188 | 5 calls, 245 | 2 calls, 99 | 196 | 50 | 50 | 50 | 189 | 70% |
| 2026-09-27 | perch | 5996fd3 | 1 call, 14 | 1 call, 51 | 135 | 17 | 17 | 17 | 165 | 100% |
| 2026-09-27 | perch | 39bf181 | 1 call, 15 | 1 call, 51 | 151 | 17 | 17 | 17 | 151 | 100% |
| 2026-09-28 | perch | a33de49 | 1 call, 12 | 1 call, 31 | 135 | | | | 83 | 100% |
| 2026-09-28 | perch | 62625a5 | | | | | | | | |
| 2026-09-27 | Claude in Chrome | | 6 calls, 73 | 3 calls, 164 | 89 | 59 | 66 | 2 | 143 | 100% |

- **5996fd3:** navigate no longer hangs, and `fill {fields}` and `click {readback}` do
  in one call what took 5 and 2. Most calls went from 3 to 5 Apple Events down to 1.
- **39bf181:** trusted clicks aim from the Accessibility tree. With the call
  `click {selector: "#submit", trusted: true, readback: "#status"}` and Canary as the
  active tab, 10 of 10 aimed by `ax`, hit, and read back the right status. The median
  was 311ms for the whole call.
- **a33de49:** screenshots are captured and encoded in the osascript runtime instead of
  spawning screencapture and sips. A click readback, a custom select's miss and a
  typeahead's miss end once the page holds still instead of waiting out their caps. Only
  the numbers that moved are filled in. This run was without `--activate`, so the
  Screenshot cell is the `bench` p50 on Canary's shown tab (149 before).
- **62625a5:** no compare-suite op moved. On the 2720-node page from
  `test/fixtures/large-dom.mjs`, served on 127.0.0.1 in Canary's shown tab, a fill whose
  `label_pattern` matches nothing went from 29.5 to 22.0 and from 44.5 to 23.8 in two
  runs against b986dd6 (medians of 10). Snapshots, a fill that matches, a select miss and
  a typeahead fill stayed within noise, with identical outputs. The bench baseline now
  records `bench/fixture.html`'s sha256, so its byte counts compare like-for-like.

## Payload size

These are the characters each op puts into context:
- **Read text:** perch 14.4k, the whole body. The extension 13.2k, the `<article>` only.
- **Snapshot:** perch 7.5k, with every field labelled and all 150 links.
- **Extension `read_page`:** 0.3k with the interactive filter, but its fields are
  unnamed and it only covers the viewport. 14k with the default filter.

## Extension quirks seen

- A click on a freshly loaded background tab reported success but did nothing, until
  the agent took a screenshot.
- Fields inside a `<label>` had no name in the interactive snapshot.
