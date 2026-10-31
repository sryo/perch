// scripts/bench.mjs --house: the run format `fium compare` judges (fium
// RULES.md K2). Live rows give a time metric (their samples) and a bytes metric;
// tools/list gives schema chars, capped by SCHEMA_BUDGET as a limit; the
// behaviour lock's fake world gives Apple Events and result bytes per tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { houseRun, houseFromBaseline, noiseFrom, NOISY_BYTES } from "../scripts/bench.mjs";
import { SCHEMA_BUDGET } from "../server.js";

test("houseRun turns rows, schema and lock totals into metrics and limits", () => {
  const run = houseRun({
    results: { "list_tabs": { p50: 66, bytes: 293 }, "screenshot png": { error: "tab not shown" }, schema: { tools: 17, chars: 9600 } },
    samples: { "list_tabs": [65, 66, 67] },
    lock: { click: { ev: 40, bytes: 900, err: 1, n: 12 } },
  });
  assert.deepEqual(run, {
    metrics: {
      "list_tabs ms": { dir: "lower", kind: "time", samples: [65, 66, 67] },
      "list_tabs bytes": { dir: "lower", kind: "bytes", samples: [293] },
      "schema chars": { dir: "lower", kind: "bytes", samples: [9600] },
      "lock events click": { dir: "lower", kind: "count", samples: [40] },
      "lock result bytes click": { dir: "lower", kind: "bytes", samples: [900] },
    },
    limits: { "schema chars": SCHEMA_BUDGET },
  });
});

test("an offline run has no live rows", () => {
  const run = houseRun({ results: { schema: { tools: 17, chars: 9600 } }, samples: {}, lock: {} });
  assert.deepEqual(Object.keys(run.metrics), ["schema chars"]);
});

// The old baseline kept p50s only, so its time metrics carry one sample each:
// house judges those by any move until a live run records a real baseline.
test("houseFromBaseline converts the summary baseline", () => {
  const run = houseFromBaseline({ results: { "get_text 2000": { p50: 16.9, p95: 17.9, min: 14.7, bytes: 674 }, schema: { tools: 17, chars: 8826 } } });
  assert.deepEqual(run.metrics["get_text 2000 ms"], { dir: "lower", kind: "time", samples: [16.9] });
  assert.deepEqual(run.metrics["get_text 2000 bytes"], { dir: "lower", kind: "bytes", samples: [674] });
  assert.equal(run.metrics["schema chars"], undefined, "the offline baseline measures the schema");
});

// A live A/A showed these rows' result bytes move between identical runs (ref ids,
// rendered pixels, the user's open tabs), so they are judged like timings, over
// every rep's bytes.
test("a row whose bytes vary between identical runs is noisy, over every rep", () => {
  const run = houseRun({
    results: { "screenshot png": { p50: 62, bytes: 116685 }, "get_text 2000": { p50: 16, bytes: 674 } },
    samples: { "screenshot png": [62, 63] }, bytes: { "screenshot png": [116633, 116685], "get_text 2000": [674, 674] }, lock: {},
  });
  assert.deepEqual(run.metrics["screenshot png bytes"], { dir: "lower", kind: "bytes", noisy: true, samples: [116633, 116685] });
  assert.deepEqual(run.metrics["get_text 2000 bytes"], { dir: "lower", kind: "bytes", samples: [674] });
  assert.ok(NOISY_BYTES.has("list_tabs") && NOISY_BYTES.has("accessibility_snapshot"));
});

// bench/noise.json from a live A/A's `fium compare --json` rows: per noisy
// metric, the farthest its range strayed from 1, rounded up to a percent, at
// least fium's default 10%.
test("noiseFrom keeps each noisy metric's A/A spread", () => {
  assert.deepEqual(noiseFrom([
    { metric: "screenshot png ms", range: [0.9035, 1.0819], verdict: "same" },
    { metric: "x ms", range: [0.8, 1.01], verdict: "inconclusive" },
    { metric: "get_text 2000 bytes", verdict: "same" },
  ]), { rel: { "screenshot png ms": 0.1, "x ms": 0.2 } });
});

// The bench must never take the user's focus (GOALS.md goal 1): it reads the
// frontmost app before and after every step and stops, naming the step, when it changed.
import { frontGuard } from "../scripts/bench.mjs";
test("frontGuard passes while the front app stays, and names the step that changed it", async () => {
  let front = 10;
  const g = frontGuard(() => front);
  await g.step("list_tabs", async () => {});
  await assert.rejects(g.step("screenshot png", async () => { front = 20; }), /the front app changed during screenshot png \(pid 10 -> 20\)/);
});
