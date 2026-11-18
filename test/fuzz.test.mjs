// Seeded fuzz of every tool's arguments on the fake world: whatever a client
// sends, handleCall answers with content (never a throw past it), an error is
// text that starts "error: " (eval_js: its script's own error shape) and is
// never a raw AppleScript or JS failure, and a call
// refused as bad_args sent no Apple Event. Values mix the schema's own types
// with wrong ones; numbers stay small so waits end at once. PERCH_FUZZ_SEED and
// PERCH_FUZZ_N rerun a case. notify is left out: it posts through the real
// notification center, which the fake world doesn't model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, TOOLS, deps } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const HTML = `<form><label>Email <input name=email required></label><select name=c><option value="">Pick</option><option>AR</option></select>
<label><input type=checkbox name=ok> Agree</label><button type=button>Send</button></form><a href=/x>Link</a><input type=file id=f>`;
function install() {
  const dom = page(HTML, { url: "https://a.test/p" });
  const world = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 7, active: 0, tabs: [{ url: "https://a.test/p", id: "x", dom }, { url: "https://b.test/", id: "y" }] }] }], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = DAEMONS.slow = DAEMONS.long = world.daemon;
  world.reset();
  return world;
}
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); }
const STR = ["", "x", "#nope", "button", "^Send$", "email", "a@b.co", "(", "https://a.test/q", "about:blank", "chrome:x", "chrome:y", "safari:1.0.z", "room:r:t", "1", "Enter", "AR", "/nonexistent/f.txt"];
const NUM = [-1, 0, 1, 2.5, 30];
function value(r, spec, depth = 0) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  if (r() < 0.15) return pick([null, true, 7, "s", [], {}]);
  const t = spec && (spec.type || (spec.enum ? "enum" : spec.oneOf || spec.anyOf ? "any" : null));
  if (t === "enum") return pick(spec.enum);
  if (t === "string") return pick(STR);
  if (t === "number" || t === "integer") return pick(NUM);
  if (t === "boolean") return r() < 0.5;
  if (t === "array") return depth > 2 ? [] : Array.from({ length: Math.floor(r() * 3) }, () => value(r, spec.items || {}, depth + 1));
  if (t === "object" || spec?.properties) return object(r, spec, depth + 1);
  if (Array.isArray(t)) return value(r, { ...spec, type: pick(t) }, depth);
  if (t === "any") return value(r, pick(spec.oneOf || spec.anyOf), depth);
  return pick([...STR, ...NUM, true]);
}
function object(r, spec, depth = 0) {
  const o = {};
  for (const [k, p] of Object.entries(spec?.properties || {})) if (r() < 0.45) o[k] = k === "target" && r() < 0.7 ? { tabId: STR[9 + Math.floor(r() * 4)] } : value(r, p, depth);
  return o;
}
// The same codes and prefixes the server makes: a coded error, a tool's own
// "name: ..." refusal, or the plain-English errors that predate the codes.
const RAW = /\(-\d+\)$|Error: Error|execution error|osascript|SyntaxError: Unexpected|undefined is not|Cannot read propert|is not a function/;

test("seeded fuzz: every tool answers with content, errors are text, bad_args sends no Apple Event", async () => {
  const seed = Number(process.env.PERCH_FUZZ_SEED) || 20261118, n = Number(process.env.PERCH_FUZZ_N) || 600;
  const r = rng(seed);
  deps.notify = async () => ({ ok: true });
  const odd = [];
  for (let i = 0; i < n; i++) {
    const world = install();
    const tools = TOOLS.filter((t) => t.name !== "notify"), tool = tools[Math.floor(r() * tools.length)];
    const args = object(r, tool.inputSchema);
    let res;
    try { res = await handleCall(tool.name, args); }
    catch (e) { odd.push(`${i} ${tool.name} ${JSON.stringify(args)} threw ${e.message}`); continue; }
    if (!res || !Array.isArray(res.content) || !res.content.length) { odd.push(`${i} ${tool.name} ${JSON.stringify(args)} no content`); continue; }
    if (!res.isError) continue;
    const t = res.content[0].text || "";
    // eval_js keeps the caller's own script error as its JSON shape (SKILL.md).
    if (tool.name === "eval_js" && /^\{"__perch_error":/.test(t)) continue;
    if (!t.startsWith("error: ")) odd.push(`${i} ${tool.name} ${JSON.stringify(args)} error without prefix: ${t.slice(0, 120)}`);
    if (RAW.test(t) && !t.startsWith("error: bad_args")) odd.push(`${i} ${tool.name} ${JSON.stringify(args)} raw failure: ${t.slice(0, 160)}`);
    if (t.startsWith("error: bad_args") && world.aeLog.length) odd.push(`${i} ${tool.name} ${JSON.stringify(args)} bad_args after ${world.aeLog.length} Apple Events`);
  }
  assert.deepEqual(odd, [], `seed ${seed}`);
});

test("cases the fuzz found: a non-string script or path is bad_args, before any Apple Event", async () => {
  for (const [name, args] of [["eval_js", { script: true }], ["eval_js", { script: "1", script_path: [] }], ["file_upload", { path: {}, label_pattern: "AR" }], ["fill", { selector: "#x", text_path: 3 }]]) {
    const world = install();
    const r = await handleCall(name, { target: { tabId: "chrome:x" }, ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, /^error: bad_args: /, JSON.stringify(args));
    assert.deepEqual(world.aeLog, [], JSON.stringify(args));
  }
});
