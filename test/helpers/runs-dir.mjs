// Where fium keeps this repo's bench runs (fium RULES.md K2), resolved
// independently of scripts/mcp-client.mjs so the tests pin the convention.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export function expectedRunsDir() {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: new URL("../..", import.meta.url), encoding: "utf8" }).trim();
  return join(process.env.FIUM_HOME || join(homedir(), ".fium"), "runs", basename(dirname(common)));
}
