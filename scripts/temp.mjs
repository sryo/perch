// Temp dirs for tests and scripts. Each is removed when the test context given
// ends, and in any case when the process exits, throws or is signalled.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = new Set();

function remove(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  made.delete(dir);
}

export function removeTempDirs() {
  for (const dir of made) remove(dir);
}

export function tempDir(prefix = "perch-", t) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  t?.after(() => remove(dir));
  return dir;
}

process.on("exit", removeTempDirs);
// A listener replaces the default action, so after cleaning up, the signal is
// raised again with the listener gone and ends the process as it would have.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(sig, () => {
    removeTempDirs();
    process.kill(process.pid, sig);
  });
}
