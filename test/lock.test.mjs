// Behaviour lock: replays every scenario in test/lock/scenarios.mjs and compares
// it with test/lock/golden.json. A rewrite of server.js must keep each call's
// result text and isError exactly, and may send fewer Apple Events, page scripts
// and page script bytes, never more. PERCH_LOCK_WRITE=1 rewrites the golden
// (all of it, or the scenarios a --test-name-pattern picks); review its diff.
// What gets normalized, and why, is documented in test/lock/harness.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SCENARIOS } from "./lock/scenarios.mjs";
import { runScenario } from "./lock/harness.mjs";

const GOLDEN = new URL("./lock/golden.json", import.meta.url);
const WRITE = process.env.PERCH_LOCK_WRITE === "1";
const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) : {};
const HOW = "if the change is intended, rerun with PERCH_LOCK_WRITE=1 and review the golden diff";

const fresh = {};
if (WRITE) {
  after(() => {
    const out = {};
    for (const name of Object.keys(SCENARIOS)) if (fresh[name] || golden[name]) out[name] = fresh[name] || golden[name];
    writeFileSync(GOLDEN, JSON.stringify(out, null, 1) + "\n");
  });
}

const counts = (s) => `${s.events} events ${JSON.stringify(s.ae)}, ${s.pageScripts} page scripts, ${s.pageBytes} bytes`;

for (const [name, fn] of Object.entries(SCENARIOS)) {
  test(`lock: ${name}`, async (t) => {
    const steps = await runScenario(name, fn, t);
    if (WRITE) { fresh[name] = steps; return; }
    const want = golden[name];
    assert.ok(want, `no golden for this scenario; ${HOW}`);
    assert.deepEqual(steps.map((s) => s.call), want.map((s) => s.call), "the scenario's calls changed");
    steps.forEach((got, i) => {
      const exp = want[i], at = `step ${i} ${JSON.stringify(got.call).slice(0, 160)}`;
      assert.deepEqual(got.content, exp.content, `${at}: result changed; ${HOW}`);
      assert.equal(got.isError, exp.isError, `${at}: isError changed`);
      assert.deepEqual(got.execs, exp.execs, `${at}: commands run changed`);
      if (exp.events == null) return;
      const more = `${at}: now ${counts(got)}; golden ${counts(exp)}; ${HOW}`;
      assert.ok(got.events <= exp.events, `more Apple Events. ${more}`);
      for (const [app, keys] of Object.entries(got.ae)) assert.ok(keys.length <= (exp.ae[app] || []).length, `more Apple Events to ${app}. ${more}`);
      assert.ok(got.pageScripts <= exp.pageScripts, `more page scripts. ${more}`);
      assert.ok(got.pageBytes <= exp.pageBytes, `more page script bytes. ${more}`);
    });
  });
}

test("lock: every golden scenario is still in the corpus", { skip: WRITE }, () => {
  assert.deepEqual(Object.keys(golden).filter((k) => !SCENARIOS[k]), [], "a scenario was dropped or renamed; restore it, or rerun with PERCH_LOCK_WRITE=1 to retire it on purpose");
});

test("lock: every tool parameter and SKILL.md result key is exercised, or justified", { skip: WRITE }, async () => {
  const { unjustified, stale } = await import("./lock/coverage.mjs");
  assert.deepEqual(unjustified, [], "add a scenario for these (node test/lock/coverage.mjs lists them)");
  assert.deepEqual(stale, [], "these are covered now; drop them from JUSTIFIED in test/lock/coverage.mjs");
});

// The rooms words SKILL.md leaves to the user must still be rooms commands. rooms dropped its
// teleport alias for signin --from; this reads rooms' own help when its checkout sits beside perch.
test("every rooms command SKILL.md names is one rooms still has", async (t) => {
  const cli = new URL("../../rooms/rooms.mjs", import.meta.url).pathname;
  if (!existsSync(cli)) return t.skip("no rooms checkout beside perch");
  const { execFileSync } = await import("node:child_process");
  let help;
  try { help = execFileSync(process.execPath, [cli, "help"], { encoding: "utf8" }); } catch (e) { help = e.stdout; }
  const { JUSTIFIED } = await import("./lock/coverage.mjs");
  const gone = Object.keys(JUSTIFIED).filter((w) => JUSTIFIED[w] === "a rooms CLI command" && !new RegExp(`\\b${w}\\b`).test(help));
  assert.deepEqual(gone, []);
});
