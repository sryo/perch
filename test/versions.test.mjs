// The version comparison's arithmetic: per-call stats over reps and the flags a
// run raises against a baseline (slower, bigger, newly failing, lost condition).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stats, compareRuns } from "../scripts/versions-lib.mjs";

test("stats: median and p90 over reps, bytes as the median, ok only when every rep was", () => {
  const s = stats([{ ms: 30, bytes: 10, ok: true }, { ms: 10, bytes: 12, ok: true }, { ms: 20, bytes: 10, ok: true }, { ms: 100, bytes: 10, ok: true }]);
  assert.deepEqual(s, { n: 4, p50: 25, p90: 100, bytes: 10, ok: 4, err: 0, error: null });
  const f = stats([{ ms: 5, bytes: 3, ok: false, error: "error: timeout: x" }, { ms: 7, bytes: 3, ok: true }]);
  assert.equal(f.ok, 1);
  assert.equal(f.err, 1);
  assert.equal(f.error, "error: timeout: x");
});

test("compareRuns flags a call that got slower past noise, bigger, newly failing, or missing", () => {
  const base = { "eval_js": { p50: 20, p90: 25, bytes: 10, ok: 10, err: 0 }, "snap": { p50: 20, p90: 22, bytes: 800, ok: 10, err: 0 },
    "shot": { p50: 80, p90: 90, bytes: 300000, ok: 10, err: 0 }, "gone": { p50: 10, p90: 10, bytes: 5, ok: 10, err: 0 }, "flaky": { p50: 10, p90: 10, bytes: 5, ok: 10, err: 0 } };
  const run = { "eval_js": { p50: 23, p90: 30, bytes: 10, ok: 10, err: 0 }, "snap": { p50: 60, p90: 70, bytes: 900, ok: 10, err: 0 },
    "shot": { p50: 70, p90: 80, bytes: 200000, ok: 10, err: 0 }, "flaky": { p50: 10, p90: 10, bytes: 5, ok: 7, err: 3 }, "new": { p50: 1, p90: 1, bytes: 1, ok: 10, err: 0 } };
  const flags = compareRuns(base, run);
  assert.deepEqual(flags.map((f) => [f.call, f.kind]).sort(), [["flaky", "fails"], ["gone", "missing"], ["snap", "bigger"], ["snap", "slower"]]);
  assert.match(flags.find((f) => f.kind === "slower").detail, /20 -> 60ms/);
});

test("compareRuns: a call that failed in the baseline and passes now is not flagged; slower needs 25% and 15ms both", () => {
  const flags = compareRuns({ a: { p50: 100, p90: 100, bytes: 1, ok: 0, err: 10 }, b: { p50: 10, p90: 10, bytes: 1, ok: 10, err: 0 } },
    { a: { p50: 100, p90: 100, bytes: 1, ok: 10, err: 0 }, b: { p50: 20, p90: 20, bytes: 1, ok: 10, err: 0 } });
  assert.deepEqual(flags, []);
});

import { lockSteps, lockTotals, lockDiff } from "../scripts/versions-lib.mjs";

const golden = (ev, text, isError = false) => ({ "nav: ok": [{ call: ["navigate", {}], content: [{ type: "text", text }], isError, events: ev }],
  "eval: one": [{ call: ["eval_js", {}], content: [{ type: "text", text: "1" }], isError: false, events: 1 }, { call: ["eval_js", {}], content: [{ type: "text", text: "{\"ok\":false}" }], isError: false, events: 1 }] });

test("lockTotals sums a behaviour-lock golden's events, result bytes and failed steps per tool", () => {
  assert.deepEqual(lockTotals(lockSteps(golden(7, "{\"ok\":true}"))), {
    navigate: { ev: 7, bytes: 11, err: 0, n: 1 }, eval_js: { ev: 2, bytes: 13, err: 1, n: 2 },
  });
});

test("lockDiff names the steps that cost more events or newly fail", () => {
  const d = lockDiff(lockSteps(golden(7, "{\"ok\":true}")), lockSteps(golden(9, "error: timeout: x", true)));
  assert.deepEqual(d.map((x) => [x.kind, x.step]), [["more events", "nav: ok #0 navigate"], ["fails", "nav: ok #0 navigate"]]);
  assert.deepEqual(lockDiff(lockSteps(golden(9, "x", true)), lockSteps(golden(7, "{\"ok\":true}"))), []);
});

test("compareRuns flags a screenshot whose pixel area grew, which is what an image costs in tokens", () => {
  const base = { shot: { p50: 80, p90: 90, bytes: 1000, ok: 5, err: 0, image: { w: 784, h: 1568 } } };
  assert.deepEqual(compareRuns(base, { shot: { p50: 80, p90: 90, bytes: 900, ok: 5, err: 0, image: { w: 1568, h: 1568 } } }).map((f) => f.kind), ["bigger image"]);
  assert.deepEqual(compareRuns(base, { shot: { p50: 80, p90: 90, bytes: 1000, ok: 5, err: 0, image: { w: 784, h: 1568 } } }), []);
});
