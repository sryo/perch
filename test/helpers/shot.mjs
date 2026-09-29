// Fakes for Node's screencapture/sips fallback, and a TMPDIR of the test's own
// so whatever the fallback leaves behind is visible.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tempDir } from "../../scripts/temp.mjs";

export const SHOT_NO_IMAGE = "timeout: screenshot: the window capture gave no image within 3s; nothing was captured";
export const BOUND = { timeout: 3000, killSignal: "SIGKILL" };
export const RAW = "Command failed: screencapture -l 77 -x -o -t png /var/folders/xy/T/perch-1-abc.png";

export function ownTmp(t) {
  const dir = tempDir("perch-shot-", t);
  const was = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(() => { if (was == null) delete process.env.TMPDIR; else process.env.TMPDIR = was; });
  return dir;
}

export function clean(text) {
  for (const k of ["Command failed", "ENOENT", "/var/folders", "perch-"]) assert.ok(!text.includes(k), text);
}

// A child that hangs: without a timeout option it never settles; with one it
// writes a partial file and is killed, as execFile reports a timeout. Any other
// command goes to `rest`.
export function hung(which, seen, rest) {
  return (cmd, a, opts) => {
    if (cmd !== which || (which === "sips" && a[0] !== "--cropToHeightWidth")) return rest(cmd, a, opts);
    seen.push([cmd, opts]);
    if (!opts || !opts.timeout) return new Promise(() => {});
    return writeFile(a[a.length - 1], "partial").then(() => {
      throw Object.assign(new Error(RAW), { killed: true, signal: opts.killSignal, code: null });
    });
  };
}
