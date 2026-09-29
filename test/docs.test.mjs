import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TOOLS, INSTRUCTIONS, SCHEMA_BUDGET, ERR } from "../server.js";

const read = (f) => readFile(new URL("../" + f, import.meta.url), "utf8");

test("SKILL.md covers every tool and stays short", async () => {
  const skill = await read("SKILL.md");
  for (const t of TOOLS) assert.ok(skill.includes("`" + t.name + "`"), `SKILL.md misses ${t.name}`);
  assert.ok(skill.length < 6800, `SKILL.md is ${skill.length} bytes`);
  assert.ok(skill.includes("Refs die on re-snapshot or navigation."), "SKILL.md says when refs die");
});

test("docs don't mention removed tools, params or shapes", async () => {
  const stale = ["get_html", "page_state", "include_bounds", "clickCount", "`clear`", "bare array", "wait: false", "targetClause", "FRONTMOST", "{level, ts, args"];
  for (const f of ["SKILL.md", "AGENTS.md", "README.md", "GOALS.md"]) {
    const s = await read(f);
    for (const w of stale) assert.ok(!s.includes(w), `${f} still mentions ${w}`);
  }
});

const SELF_EXPLANATORY = ["message", "subtitle", "sound", "maxWidth", "mode"];

test("every param, element hint, error code and permission toggle stays documented somewhere", async () => {
  const skill = await read("SKILL.md");
  const source = await read("server.js");
  const room = `schema headroom ${SCHEMA_BUDGET - JSON.stringify(TOOLS).length}, SKILL.md headroom ${6800 - skill.length}`;
  for (const t of TOOLS) {
    for (const [name, p] of Object.entries(t.inputSchema.properties)) {
      if (SELF_EXPLANATORY.includes(name)) continue;
      const where = [p.description || "", t.description, INSTRUCTIONS, skill];
      assert.ok(where.some((s) => s.includes(name)), `${t.name}.${name} is documented nowhere (${room})`);
    }
  }
  assert.match(INSTRUCTIONS, /`ref` \(from accessibility_snapshot\)/, room);
  assert.match(INSTRUCTIONS, /`label_pattern` \([^)]*regex/, room);
  assert.match(INSTRUCTIONS, /CSS `selector`/, room);
  const toolNames = TOOLS.map((t) => t.name);
  const thrown = [...source.matchAll(/["`]([a-z]+_[a-z_]+): /g)].map((m) => m[1]).filter((c) => !toolNames.includes(c));
  const codes = new Set(["tab_not_visible", "stale_tab", "window_offscreen", "window_ambiguous", "no_browser", "timeout", "tab_not_scriptable", "dialog_open", ...thrown]);
  for (const c of codes) assert.ok(INSTRUCTIONS.includes(c) || skill.includes(c), `error code ${c} is documented nowhere (${room})`);
  assert.ok(ERR.jsOff.includes("Allow JavaScript from Apple Events") && ERR.jsOff.includes("Show Develop menu"), "ERR.jsOff lost a toggle path");
  assert.ok(ERR.automation.includes("Privacy & Security"), "ERR.automation lost its settings path");
  assert.match(source, /Accessibility permission required: System Settings > Privacy & Security > Accessibility/);
});
