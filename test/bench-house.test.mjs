// scripts/bench.mjs --house: the run format `fium price compare` judges (fium
// RULES.md K2). Live rows give a time metric (their samples) and a bytes metric;
// tools/list gives schema chars, capped by SCHEMA_BUDGET as a limit; the
// behaviour lock's fake world gives Apple Events and result bytes per tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { houseRun, houseFromBaseline } from "../scripts/bench.mjs";
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
