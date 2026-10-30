// Lists what the behaviour lock doesn't exercise: every TOOLS parameter no
// scenario passes, and every result key, flag or error code SKILL.md names that
// no recorded result shows. Reads test/lock/golden.json, so regenerate it first
// (PERCH_LOCK_WRITE=1). Run: node test/lock/coverage.mjs. Exits 1 on a leftover
// not listed in JUSTIFIED below; test/lock.test.mjs fails on the same.
import { readFileSync } from "node:fs";
import { TOOLS } from "../../server.js";

// Leftovers the fake world can't reach, or that are words in SKILL.md rather
// than result keys, each with why.
export const JUSTIFIED = {
  // Words SKILL.md backticks that are values, examples or prose, not result keys.
  "given-name": "an autocomplete token example for label_pattern",
  tel: "an autocomplete token example",
  "aria-disabled": "a page attribute click ignores (click: disabled refused clicks one), not a result key",
  input: "prose: the trusted `input` event a trusted fill verifies, not a result key",
};

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));
const steps = Object.values(golden).flat();
const texts = steps.flatMap((s) => s.content.filter((c) => c.type === "text").map((c) => c.text));
const all = texts.join("\n");

// ---- TOOLS parameters ----
const passed = new Set();
const walk = (tool, v, path) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return;
  for (const [k, x] of Object.entries(v)) { passed.add(`${tool}.${path}${k}`); if (k === "target") walk(tool, x, "target."); }
};
for (const s of steps) walk(s.call[0], s.call[1], "");
const missingParams = [];
for (const t of TOOLS) {
  if (!steps.some((s) => s.call[0] === t.name)) missingParams.push(`${t.name} (never called)`);
  for (const p of Object.keys(t.inputSchema.properties || {})) if (!passed.has(`${t.name}.${p}`)) missingParams.push(`${t.name}.${p}`);
}
// fields[] entry keys, from the description's own list.
for (const k of ["ref", "selector", "label_pattern", "text", "checked", "option", "trusted"]) {
  if (!steps.some((s) => s.call[0] === "fill" && (s.call[1].fields || []).some((f) => k in f))) missingParams.push(`fill.fields[].${k}`);
}

// ---- SKILL.md result keys, flags and error codes ----
// Front matter and fenced examples out; the snapshot example's keys are named
// again in the prose that follows it.
const skill = readFileSync(new URL("../../SKILL.md", import.meta.url), "utf8").replace(/^---[\s\S]*?---/, "").replace(/```[\s\S]*?```/g, "");
const words = new Set();
for (const m of skill.matchAll(/`([^`]+)`/g)) {
  const inner = m[1];
  // `{a, b?, c: ...}` shapes and `a:b` pairs name keys; a bare `word` is a key, flag or code.
  for (const w of inner.matchAll(/(?:^|[{,\s])([A-Za-z_][\w.-]*)\??(?=\s*[:,}?]|$)/g)) words.add(w[1].split(".")[0]);
}
const toolNames = new Set(TOOLS.map((t) => t.name));
const params = new Set(TOOLS.flatMap((t) => Object.keys(t.inputSchema.properties || {})));
const shown = (w) => {
  const e = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${e}":|[ #{,]${e}=|"${e}"|^\\S+ .* ${e}( |$)|error: ${e}:|"${e}: `, "m").test(all);
};
// isError is the MCP result's own flag, which every step records.
const isError = (w) => w === "isError" && steps.some((s) => s.isError);
const missingKeys = [...words].filter((w) => !toolNames.has(w) && !params.has(w) && !["true", "false"].includes(w) && !isError(w) && !shown(w));

const leftovers = [...missingParams, ...missingKeys];
const unjustified = leftovers.filter((x) => !JUSTIFIED[x]);
const stale = Object.keys(JUSTIFIED).filter((x) => !leftovers.includes(x));
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const x of leftovers) console.log(JUSTIFIED[x] ? `justified  ${x}: ${JUSTIFIED[x]}` : `UNCOVERED  ${x}`);
  for (const x of stale) console.log(`stale      ${x}: now covered; drop it from JUSTIFIED`);
  console.log(`${leftovers.length} leftover, ${unjustified.length} unjustified, ${stale.length} stale justification`);
  process.exitCode = unjustified.length || stale.length ? 1 : 0;
}
export { leftovers, unjustified, stale };
