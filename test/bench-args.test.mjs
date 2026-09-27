// scripts/bench.mjs argument parsing. npm run bench passes --app canary before
// the user's own args, so a later flag has to win for `npm run bench -- --app X`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../scripts/bench.mjs";

test("bench defaults", () => {
  assert.deepEqual(parseArgs([]), {
    runs: 20, out: "bench/runs/bench.json", compare: "bench/baseline.json", app: undefined, navigate: false,
  });
});

test("npm run bench keeps the Canary default", () => {
  assert.equal(parseArgs(["--app", "canary"]).app, "canary");
});

test("a later flag overrides the npm script's default", () => {
  const args = parseArgs(["--app", "canary", "--app", "arc", "--runs", "5", "--runs", "3", "--navigate"]);
  assert.equal(args.app, "arc");
  assert.equal(args.runs, 3);
  assert.equal(args.navigate, true);
});
