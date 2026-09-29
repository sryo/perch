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

test("AGENTS.md's Per-tab serialization bullet names every tool tabLockKey locks", async () => {
  const agents = await read("AGENTS.md");
  const source = await read("server.js");
  const line = agents.split("\n").find((l) => l.startsWith("- **Per-tab serialization:**"));
  assert.ok(line, "AGENTS.md lost its Per-tab serialization bullet");
  const set = /const LOCKED_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(source);
  const key = /const tabLockKey = [\s\S]*?\n\n/.exec(source);
  assert.ok(set && key, "LOCKED_TOOLS or tabLockKey not found in server.js");
  const names = [...set[1].matchAll(/"([a-z_]+)"/g), ...key[0].matchAll(/name === "([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 7, `parsed only ${names}`);
  for (const n of names) assert.ok(line.includes("`" + n), `Per-tab serialization bullet misses ${n}`);
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

test("docs say a natively disabled control refuses the click, trusted too, and aria-disabled still clicks", async () => {
  const skill = await read("SKILL.md");
  const agents = await read("AGENTS.md");
  const row = skill.split("\n").find((l) => l.startsWith("| `click` |"));
  assert.ok(row && /disabled/.test(row) && /aria-disabled/.test(row), "SKILL.md's click row misses disabled");
  const bullet = agents.split("\n").find((l) => l.startsWith("- **Click by name:**"));
  assert.ok(bullet.includes("is disabled; nothing was clicked"), "AGENTS.md's click bullet misses the disabled refusal");
  assert.ok(/fieldset/.test(bullet) && /legend/.test(bullet) && /trusted/.test(bullet) && /aria-disabled/.test(bullet), "AGENTS.md's click bullet misses fieldset, legend, trusted or aria-disabled");
});

test("docs say eval_js's ref binds el", async () => {
  const skill = await read("SKILL.md");
  const agents = await read("AGENTS.md");
  const row = skill.split("\n").find((l) => l.startsWith("| `eval_js` |"));
  assert.ok(row && /`ref`/.test(row) && /`el`/.test(row), "SKILL.md's eval_js row misses ref binding el");
  const bullet = agents.split("\n").find((l) => l.startsWith("- **eval_js ref:**"));
  assert.ok(bullet && /__perch_ref_miss/.test(bullet) && /compile cache/.test(bullet), "AGENTS.md misses the eval_js ref bullet");
});
