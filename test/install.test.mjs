// install.sh's merge_json: the config edit used for Copilot and opencode. It
// keeps the user's other servers, refuses a file it can't parse instead of
// replacing it, and leaves an unchanged file alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../scripts/temp-dirs.mjs";

const INSTALL = new URL("../install.sh", import.meta.url).pathname;

function merge(file, key, entry) {
  try {
    execFileSync("bash", ["-c", `PERCH_INSTALL_LIB=1 source "$0"; merge_json "$1" "$2" perch "$3"`,
      INSTALL, file, key, JSON.stringify(entry)], { stdio: "pipe" });
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr) };
  }
}

test("merge_json adds perch and keeps other servers", (t) => {
  const f = join(tempDir("perch-install-", t), "mcp-config.json");
  writeFileSync(f, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
  assert.equal(merge(f, "mcpServers", { command: "node" }).ok, true);
  const cfg = JSON.parse(readFileSync(f, "utf8"));
  assert.deepEqual(cfg.mcpServers, { other: { command: "x" }, perch: { command: "node" } });
  assert.equal(cfg.theme, "dark");
});

test("merge_json creates a missing file and its folder", (t) => {
  const f = join(tempDir("perch-install-", t), "opencode", "opencode.json");
  assert.equal(merge(f, "mcp", { type: "local" }).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { mcp: { perch: { type: "local" } } });
});

for (const [name, text] of [["malformed JSON", "{ \"mcpServers\": { // jsonc\n } }"],
  ["a non-object root", "[1, 2]"], ["a non-object key", "{\"mcpServers\": []}"]]) {
  test(`merge_json refuses ${name} and leaves the file as it was`, (t) => {
    const dir = tempDir("perch-install-", t), f = join(dir, "mcp-config.json");
    writeFileSync(f, text);
    const r = merge(f, "mcpServers", { command: "node" });
    assert.equal(r.ok, false);
    assert.match(r.stderr, /left it alone/);
    assert.equal(readFileSync(f, "utf8"), text);
    assert.deepEqual(readdirSync(dir), ["mcp-config.json"]);
  });
}

test("merge_json does not rewrite a file that already has the entry", (t) => {
  const f = join(tempDir("perch-install-", t), "mcp-config.json");
  assert.equal(merge(f, "mcpServers", { command: "node" }).ok, true);
  const before = statSync(f).mtimeMs;
  execFileSync("sleep", ["0.05"]);
  assert.equal(merge(f, "mcpServers", { command: "node" }).ok, true);
  assert.equal(statSync(f).mtimeMs, before);
});
