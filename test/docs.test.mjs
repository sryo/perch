import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TOOLS } from "../server.js";

const read = (f) => readFile(new URL("../" + f, import.meta.url), "utf8");

test("SKILL.md covers every tool and stays short", async () => {
  const skill = await read("SKILL.md");
  for (const t of TOOLS) assert.ok(skill.includes("`" + t.name + "`"), `SKILL.md misses ${t.name}`);
  assert.ok(skill.length < 6600, `SKILL.md is ${skill.length} bytes`);
});

test("docs don't mention removed tools, params or shapes", async () => {
  const stale = ["get_html", "page_state", "include_bounds", "clickCount", "`clear`", "bare array", "wait: false", "targetClause", "FRONTMOST", "{level, ts, args"];
  // GOALS.md is a decision log and names removed tools on purpose.
  for (const f of ["SKILL.md", "AGENTS.md", "README.md"]) {
    const s = await read(f);
    for (const w of stale) assert.ok(!s.includes(w), `${f} still mentions ${w}`);
  }
});
