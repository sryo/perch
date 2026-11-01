// scripts/bench.mjs argument parsing. npm run bench passes --app canary before
// the user's own args, so a later flag has to win for `npm run bench -- --app X`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseArgs } from "../scripts/bench.mjs";
import { expectedRunsDir } from "./helpers/runs-dir.mjs";

test("bench defaults", () => {
  assert.deepEqual(parseArgs([]), {
    runs: 20, out: join(expectedRunsDir(), "bench.json"), compare: "bench/baseline.json", app: undefined, tab: undefined, navigate: false, house: undefined, noise: undefined, offline: false,
  });
});

test("the default out honours FIUM_HOME and names the main checkout", () => {
  const prev = process.env.FIUM_HOME;
  process.env.FIUM_HOME = "/tmp/fium-home-test";
  try {
    assert.equal(parseArgs([]).out, join("/tmp/fium-home-test/runs", expectedRunsDir().split("/").pop(), "bench.json"));
    assert.equal(expectedRunsDir().split("/").pop(), "perch");
  } finally {
    if (prev === undefined) delete process.env.FIUM_HOME; else process.env.FIUM_HOME = prev;
  }
});

test("an explicit --out is kept as given", () => {
  assert.equal(parseArgs(["--out", "x.json"]).out, "x.json");
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
