// The arithmetic of scripts/versions.mjs: per-call stats over reps, and the
// flags a run raises against a baseline.
import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const pick = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
const median = (sorted) => {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
};

// reps: [{ms, bytes, ok, error?}]. error is the first failure's text.
export function stats(reps) {
  const ms = reps.map((r) => r.ms).sort((a, b) => a - b);
  const bytes = reps.map((r) => r.bytes).sort((a, b) => a - b);
  const bad = reps.filter((r) => !r.ok);
  return {
    n: reps.length, p50: Math.round(median(ms)), p90: Math.round(pick(ms, 0.9)), bytes: Math.round(median(bytes)),
    ok: reps.length - bad.length, err: bad.length, error: bad.length ? bad[0].error : null,
  };
}

// Live timings move about 5% between runs of unchanged code, more under load, so
// a call is slower only when its median grew by 25% and 15ms both.
const SLOWER_RATIO = 1.25, SLOWER_MS = 15;

// base, run: {call: stats}. A call is flagged slower, bigger (median result
// bytes grew), bigger image (a screenshot's pixel area grew), fails (a rep
// failed where the baseline's never did) or missing
// (in the baseline, not run). A call new in this run, or one the baseline
// already failed, raises nothing.
export function compareRuns(base, run) {
  const flags = [];
  for (const [call, b] of Object.entries(base)) {
    const r = run[call];
    if (!r) { flags.push({ call, kind: "missing", detail: "in the baseline, not in this run" }); continue; }
    if (b.err === 0 && r.err > 0) flags.push({ call, kind: "fails", detail: `${r.err}/${r.n ?? r.ok + r.err} reps failed: ${r.error ?? ""}`.trim() });
    if (b.err > 0) continue;
    if (r.p50 > b.p50 * SLOWER_RATIO && r.p50 - b.p50 >= SLOWER_MS) flags.push({ call, kind: "slower", detail: `p50 ${b.p50} -> ${r.p50}ms` });
    if (r.bytes > b.bytes && !r.image) flags.push({ call, kind: "bigger", detail: `${b.bytes} -> ${r.bytes} B` });
    const area = (i) => (i ? i.w * i.h : 0);
    if (area(r.image) > area(b.image) && b.image) flags.push({ call, kind: "bigger image", detail: `${b.image.w}x${b.image.h} -> ${r.image.w}x${r.image.h}` });
  }
  return flags;
}

// A behaviour-lock golden (test/lock/golden.json) recorded with one version's
// server.js, as {"<scenario> #<i> <tool>": {tool, ev, bytes, err}}: the fake
// world's Apple Events, the result text's length, and whether it failed
// (isError, or a JSON result with ok:false).
export function lockSteps(golden) {
  const out = {};
  for (const [scenario, steps] of Object.entries(golden)) {
    steps.forEach((s, i) => {
      const text = (s.content || []).map((c) => c.text || "").join("");
      out[`${scenario} #${i} ${s.call[0]}`] = { tool: s.call[0], ev: s.events, bytes: text.length, err: !!s.isError || /"ok":false/.test(text) };
    });
  }
  return out;
}

export function lockTotals(steps) {
  const out = {};
  for (const s of Object.values(steps)) {
    const t = (out[s.tool] = out[s.tool] || { ev: 0, bytes: 0, err: 0, n: 0 });
    t.ev += s.ev; t.bytes += s.bytes; t.err += s.err ? 1 : 0; t.n++;
  }
  return out;
}

// Steps of `after` that cost more Apple Events than in `before`, or fail where they didn't.
export function lockDiff(before, after) {
  const out = [];
  for (const [step, b] of Object.entries(before)) {
    const a = after[step];
    if (!a) continue;
    if (a.ev > b.ev) out.push({ kind: "more events", step, detail: `${b.ev} -> ${a.ev}` });
    if (a.err && !b.err) out.push({ kind: "fails", step, detail: "" });
  }
  return out;
}

// Records the behaviour lock for `serverJs` (a server.js source) with `root`'s lock
// harness and fake world, in scratch directory `dir`, and returns its lockSteps.
// What recordLock copies from `root` beside the recorded server.js.
export const LOCK_FILES = ["package.json", "scripts/temp.mjs", "test/lock.test.mjs"];
export const LOCK_DIRS = ["test/lock", "test/fakes", "test/helpers", "test/fixtures"];

export function recordLock(serverJs, root, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "server.js"), serverJs);
  for (const f of LOCK_FILES) writeFileSync(join(dir, f), readFileSync(join(root, f)));
  for (const d of LOCK_DIRS) execFileSync("cp", ["-R", join(root, d), join(dir, d)]);
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  execFileSync("node", ["--import", "./test/helpers/isolate.mjs", "--test", "test/lock.test.mjs"], { cwd: dir, env: { ...process.env, PERCH_LOCK_WRITE: "1" }, stdio: "ignore" });
  const steps = lockSteps(JSON.parse(readFileSync(join(dir, "test/lock/golden.json"), "utf8")));
  rmSync(dir, { recursive: true, force: true });
  return steps;
}
