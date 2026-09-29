// Every temp dir a test or script makes comes from scripts/temp.mjs, which
// removes it when the test ends or the process exits, however it exits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../scripts/temp.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMP = join(ROOT, "scripts", "temp.mjs");
const perchEntries = (dir) => readdirSync(dir).filter((n) => n.startsWith("perch"));
const env = (tmp) => {
  const e = { ...process.env, TMPDIR: tmp + "/", PERCH_LIVE: "0" };
  delete e.NODE_TEST_CONTEXT;
  return e;
};

test("no test or script makes a temp dir except through scripts/temp.mjs", () => {
  const offenders = [];
  for (const sub of ["test", "scripts", "bench"]) {
    const dir = join(ROOT, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir, { recursive: true })) {
      if (!/\.(mjs|js|cjs)$/.test(f)) continue;
      const p = join(dir, f);
      if (p === TEMP || p === fileURLToPath(import.meta.url)) continue;
      if (/\bmkdtemp(Sync)?\b/.test(readFileSync(p, "utf8"))) offenders.push(join(sub, f));
    }
  }
  assert.deepEqual(offenders, []);
});

for (const [how, body, code] of [
  ["exits normally", "", 0],
  ["calls process.exit", "process.exit(3);", 3],
  ["throws", "throw new Error('boom');", 1],
  ["rejects", "await Promise.reject(new Error('boom'));", 1],
]) {
  test(`a temp dir is removed when its process ${how}`, (t) => {
    const tmp = tempDir("perch-cleanup-", t);
    const src = `import { tempDir } from ${JSON.stringify(TEMP)}; import { writeFileSync } from "node:fs";` +
      `const d = tempDir("perch-x-"); writeFileSync(d + "/f", "x"); console.log(d); ${body}`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { env: env(tmp), encoding: "utf8" });
    assert.equal(r.status, code, r.stderr);
    assert.ok(r.stdout.trim().startsWith(tmp), r.stdout);
    assert.deepEqual(perchEntries(tmp), []);
  });
}

test("a temp dir is removed when its process is signalled, and the signal still ends it", (t) => {
  const tmp = tempDir("perch-cleanup-", t);
  const src = `import { tempDir } from ${JSON.stringify(TEMP)};` +
    `tempDir("perch-x-"); process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 5000);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { env: env(tmp), encoding: "utf8" });
  assert.equal(r.signal, "SIGTERM", r.stderr);
  assert.deepEqual(perchEntries(tmp), []);
});

test("tempDir with a test context removes the dir when that test ends", async (t) => {
  let dir;
  await t.test("inner", (tt) => { dir = tempDir("perch-inner-", tt); });
  assert.equal(existsSync(dir), false);
});

// The files that make temp dirs or files (fields_path, text files, uploads, the
// screencapture fallback's PNGs), run for real against an empty TMPDIR.
test("the test files that write temp files leave nothing in TMPDIR", (t) => {
  const tmp = tempDir("perch-cleanup-", t);
  const files = ["fill-fields", "perf-budget", "schema", "upload", "page-fault", "screenshot", "contract"].map((f) => join("test", `${f}.test.mjs`));
  const r = spawnSync(process.execPath, ["--import", "./test/helpers/isolate.mjs", "--test", ...files], { cwd: ROOT, env: env(tmp), encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr);
  assert.deepEqual(perchEntries(tmp), []);
});
