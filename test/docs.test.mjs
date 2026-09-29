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

test("SKILL.md adds to the schema and server instructions rather than repeating them", async () => {
  const skill = await read("SKILL.md");
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ");
  const sources = [INSTRUCTIONS, ...TOOLS.flatMap((t) => [t.description, ...Object.values(t.inputSchema.properties).map((p) => p.description || "")])];
  const shingles = new Set();
  for (const s of sources.map(norm)) for (let i = 0; i + 40 <= s.length; i++) shingles.add(s.slice(i, i + 40));
  const body = norm(skill);
  const repeated = new Set();
  for (let i = 0; i + 40 <= body.length; i++) if (shingles.has(body.slice(i, i + 40))) repeated.add(body.slice(i, i + 40));
  assert.ok(repeated.size <= 3, `SKILL.md repeats ${repeated.size} 40-char runs of the schema, e.g. ${JSON.stringify([...repeated][0])}`);
});

test("docs don't mention removed tools, params or shapes", async () => {
  const stale = ["get_html", "page_state", "include_bounds", "clickCount", "`clear`", "bare array", "wait: false", "targetClause", "FRONTMOST", "{level, ts, args"];
  for (const f of ["SKILL.md", "AGENTS.md", "README.md", "GOALS.md"]) {
    const s = await read(f);
    for (const w of stale) assert.ok(!s.includes(w), `${f} still mentions ${w}`);
  }
});

test("AGENTS.md's Errors bullet names every coded error and no retired mechanism", async () => {
  const agents = await read("AGENTS.md");
  const source = await read("server.js");
  const errors = agents.split("\n").find((l) => l.startsWith("- **Errors:**"));
  assert.ok(errors, "AGENTS.md lost its Errors bullet");
  const coded = /const CODED = \/\^\(([a-z_|]+)\)/.exec(source);
  assert.ok(coded, "CODED regex not found in server.js");
  for (const c of [...coded[1].split("|"), "window_ambiguous", "frames_unreadable"]) {
    assert.ok(errors.includes("`" + c + "`"), `AGENTS.md's Errors bullet misses ${c}`);
  }
  const comments = source.split("\n").filter((l) => /^\s*\/\//.test(l)).join("\n");
  for (const w of ["System Events Cmd+T", "osascript -i -l"]) {
    assert.ok(!agents.includes(w), `AGENTS.md still mentions ${w}`);
    assert.ok(!comments.includes(w), `a server.js comment still mentions ${w}`);
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
