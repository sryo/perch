#!/usr/bin/env node
// perch side of the perch vs Claude-in-Chrome comparison. Runs a fixed op suite
// (O1..O8, mirrored on the extension side) through perch's MCP stdio interface
// against bench/compare/fixture.html served at FIXTURE_URL, and writes
// {tool, app, date, node, macos, ops:{O1:{calls, chars, ms, ok_rate, notes}}}.
//   node scripts/compare.mjs --app <browser> [--reps 10] [--out bench/compare/perch.json] [--activate]
// Opens one scratch tab (new_tab may focus the browser) and closes it at the end.
// --activate selects that tab first (takes focus); without it, perch refuses
// screenshots of the unselected tab, and Arc/Safari refuse its page JS too.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, ROOT } from "./mcp-client.mjs";

export const FIXTURE_URL = "http://127.0.0.1:8787/fixture.html";
export const FIXTURE_TITLE = "perch compare fixture";
export const EXPECTED_STATUS = "Submitted: Ada|ada@x.test|hello\nworld|AR|true";

// ---- stats ----

const sorted = (xs) => xs.slice().sort((a, b) => a - b);
export function median(xs) {
  if (!xs.length) return null;
  const s = sorted(xs), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Nearest-rank percentile.
export function p90(xs) {
  if (!xs.length) return null;
  return sorted(xs)[Math.ceil(xs.length * 0.9) - 1];
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
export function summarize(ms) {
  if (!ms.length) return { median: null, p90: null, min: null, max: null };
  return { median: r1(median(ms)), p90: r1(p90(ms)), min: r1(Math.min(...ms)), max: r1(Math.max(...ms)) };
}

// ---- measuring ----

class CallError extends Error {}
const textOf = (res) => (res?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
const json = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

// Wraps `call` so every MCP call is counted. An isError result throws, ending the op.
function counter(call, tally) {
  return async (name, args) => {
    tally.calls++;
    const res = await call(name, args);
    for (const c of res?.content || []) {
      if (c.type === "text") tally.chars += c.text.length;
      if (c.type === "image") tally.image = { b64: c.data.length };
    }
    if (tally.image && !tally.image.w) {
      const meta = json(textOf(res));
      if (meta?.image) Object.assign(tally.image, { w: meta.image.w, h: meta.image.h });
    }
    if (res?.isError) throw new CallError(`${name}: ${textOf(res).slice(0, 160)}`);
    return res;
  };
}

// Times `fn(c)` where `c` is a counting call. fn returns {ok, note?}.
export async function measure(call, fn, now = () => performance.now()) {
  const tally = { calls: 0, chars: 0, image: null };
  const c = counter(call, tally);
  let out;
  const t0 = now();
  try { out = await fn(c); } catch (e) { out = { ok: false, note: e instanceof CallError ? e.message : `threw: ${e.message}` }; }
  const ms = now() - t0;
  const rep = { ms, calls: tally.calls, chars: tally.chars, ok: !!out?.ok };
  if (tally.image) rep.image = tally.image;
  if (out?.note) rep.note = out.note;
  return rep;
}

// innerText renders the textarea's "\n" as a space inside a normal-flow <p>,
// so a whitespace-collapsed match counts, with a note saying so.
export function statusMatches(actual) {
  if (actual === EXPECTED_STATUS) return { ok: true };
  const squash = (s) => String(s).replace(/\s+/g, " ").trim();
  if (squash(actual) === squash(EXPECTED_STATUS)) return { ok: true, note: "matched after whitespace collapse (innerText shows the newline as a space)" };
  return { ok: false, note: `status was ${JSON.stringify(actual)}` };
}

// ---- op suite ----

// `ok !== false` on a JSON body: perch reports misses as {ok:false, error}.
const landed = (res, what) => {
  const o = json(textOf(res));
  if (o && o.ok === false) throw new CallError(`${what}: ${JSON.stringify(o).slice(0, 160)}`);
  return o;
};

async function nav(c, ctx) {
  const o = landed(await c("navigate", { url: ctx.fixture, target: ctx.target }), "navigate");
  // Safari handles change on navigation; navigate returns the current one.
  if (o?.tabId) ctx.target = { tabId: o.tabId };
  return { ok: true };
}

async function fillForm(c, ctx) {
  const target = ctx.target;
  landed(await c("fill", { label_pattern: "^name", text: "Ada", target }), "fill name");
  landed(await c("fill", { label_pattern: "^email", text: "ada@x.test", target }), "fill email");
  landed(await c("fill", { label_pattern: "^message", text: "hello\nworld", target }), "fill message");
  landed(await c("select", { label_pattern: "^country", text: "Argentina", target }), "select country");
  landed(await c("click", { selector: "#agree", target }), "click agree");
  return { ok: true };
}

async function fillFields(c, ctx) {
  landed(await c("fill", { target: ctx.target, fields: [
    { label_pattern: "^name", text: "Ada" },
    { label_pattern: "^email", text: "ada@x.test" },
    { label_pattern: "^message", text: "hello\nworld" },
    { label_pattern: "^country", option: "Argentina" },
    { selector: "#agree", checked: true },
  ] }), "fill fields");
  return { ok: true };
}

export const OPS = [
  { id: "O1", name: "list_tabs", run: async (c, ctx) => {
    const o = json(textOf(await c("list_tabs", { app: ctx.app, urlContains: "127.0.0.1" })));
    const hit = o?.tabs?.some((t) => String(t.url).startsWith(ctx.fixture));
    return hit ? { ok: true } : { ok: false, note: `fixture tab not listed (${o?.tabs?.length ?? "?"} rows)` };
  } },
  { id: "O2", name: "navigate", run: nav },
  { id: "O3", name: "read_text", run: async (c, ctx) => {
    const t = textOf(await c("get_text", { target: ctx.target }));
    return t.includes("Paragraph 29") ? { ok: true } : { ok: false, note: `text lacks Paragraph 29 (${t.length} chars)` };
  } },
  { id: "O4", name: "snapshot", run: async (c, ctx) => {
    const t = textOf(await c("accessibility_snapshot", { target: ctx.target }));
    return t.startsWith("# {") ? { ok: true } : { ok: false, note: `bad header: ${t.slice(0, 80)}` };
  } },
  { id: "O5", name: "eval", run: async (c, ctx) => {
    const t = textOf(await c("eval_js", { script: "return document.title", target: ctx.target }));
    const v = json(t) ?? t;
    return v === FIXTURE_TITLE ? { ok: true } : { ok: false, note: `title was ${JSON.stringify(t)}` };
  } },
  { id: "O6", name: "fill_form", setup: nav, run: fillForm },
  { id: "O7", name: "click_verify", setup: async (c, ctx) => { await nav(c, ctx); await fillForm(c, ctx); }, run: async (c, ctx) => {
    await c("click", { selector: "#submit", target: ctx.target });
    return statusMatches(textOf(await c("get_text", { selector: "#status", target: ctx.target })));
  } },
  { id: "O8", name: "screenshot", run: async (c, ctx) => {
    const res = await c("screenshot", { target: ctx.target });
    return res.content?.some((b) => b.type === "image") ? { ok: true } : { ok: false, note: "no image block" };
  } },
  // The same form and submit through the one-call APIs: fill {fields}, click {readback}.
  { id: "O6b", name: "fill_form_fields", setup: nav, run: fillFields },
  { id: "O7b", name: "click_readback", setup: async (c, ctx) => { await nav(c, ctx); await fillFields(c, ctx); }, run: async (c, ctx) => {
    const o = landed(await c("click", { selector: "#submit", readback: "#status", target: ctx.target }), "click readback");
    return statusMatches(String(o?.readback ?? ""));
  } },
];
export const OP_IDS = OPS.map((o) => o.id);

// Setup runs untimed with a counter nobody reads; its failure fails the rep.
async function once(call, op, ctx, now) {
  if (op.setup) {
    try { await op.setup(counter(call, { calls: 0, chars: 0 }), ctx); }
    catch (e) { return { ms: 0, calls: 0, chars: 0, ok: false, note: `setup: ${e.message}` }; }
  }
  return measure(call, (c) => op.run(c, ctx), now);
}

// Runs the whole suite with an injectable `call(name, args)` and `close(tab)`.
export async function runSuite(call, { app, reps = 10, fixture = FIXTURE_URL, now, close, activate = false, log = () => {} } = {}) {
  const res = await call("new_tab", { app, url: fixture });
  if (res?.isError) throw new Error(`new_tab failed: ${textOf(res)}`);
  const created = json(textOf(res));
  if (!created?.tabId) throw new Error(`new_tab returned no tabId: ${textOf(res).slice(0, 160)}`);
  const ctx = { app, fixture, target: { tabId: created.tabId } };
  const ops = {};
  try {
    if (activate) {
      const a = await call("activate_tab", { target: ctx.target });
      if (a?.isError) throw new Error(`activate_tab failed: ${textOf(a)}`);
    }
    for (const op of OPS) {
      await once(call, op, ctx, now);
      const list = [];
      for (let i = 0; i < reps; i++) list.push(await once(call, op, ctx, now));
      ops[op.id] = { name: op.name, reps: list };
      log(op, list);
    }
  } finally {
    if (close) await close({ app: created.app, tabId: ctx.target.tabId });
  }
  return { app: created.app, tabId: ctx.target.tabId, ops };
}

// ---- report ----

export function shapeReport(suite, { app, date, node, macos }) {
  const ops = {};
  for (const [id, { name, reps }] of Object.entries(suite.ops)) {
    const good = reps.filter((r) => r.ok);
    const basis = good.length ? good : reps;
    const notes = [...new Set(reps.map((r) => r.note).filter(Boolean))];
    if (good.length && good.length < reps.length) notes.push("ms/calls/chars cover ok reps only");
    ops[id] = {
      name,
      calls: median(basis.map((r) => r.calls)),
      chars: median(basis.map((r) => r.chars)),
      ms: summarize(basis.map((r) => r.ms)),
      ok_rate: reps.length ? Math.round((good.length / reps.length) * 1000) / 1000 : 0,
      notes,
    };
    const img = basis.map((r) => r.image).filter(Boolean).pop();
    if (img) ops[id].image = img;
  }
  return { tool: "perch", app: app ?? suite.app, date, node, macos, ops };
}

export function parseArgs(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const app = opt("--app");
  if (!app) throw new Error("usage: compare.mjs --app <browser> [--reps 10] [--out bench/compare/perch.json] [--activate]; --app is required");
  const reps = Number(opt("--reps", 10));
  if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps must be a positive integer");
  return { app, reps, out: opt("--out", "bench/compare/perch.json"), activate: argv.includes("--activate") };
}

// ---- CLI ----

// perch has no close-tab tool; close the scratch tab by handle through AppleScript
// (same approach as scripts/smoke.mjs).
function closeTab(t) {
  const [key, raw] = [t.tabId.slice(0, t.tabId.indexOf(":")), t.tabId.slice(t.tabId.indexOf(":") + 1)];
  const js = key === "safari"
    ? `const w=Application(${JSON.stringify(t.app)}).windows.byId(${JSON.stringify(Number(raw.split(".")[0]))}); w.tabs[${Number(raw.split(".")[1])}].close()`
    : `const a=Application(${JSON.stringify(t.app)}); for (let i=0;i<a.windows.length;i++){ const w=a.windows[i]; if (w.tabs.id().map(String).indexOf(${JSON.stringify(raw)})>=0){ w.tabs.byId(${JSON.stringify(raw)}).close(); break; } }`;
  try { execFileSync("osascript", ["-l", "JavaScript", "-e", js]); return true; }
  catch { console.error(`could not close scratch tab ${t.tabId}; close it by hand`); return false; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await connect({ timeoutMs: 60000 });
  let suite;
  try {
    suite = await runSuite(client.call, {
      app: args.app, reps: args.reps, activate: args.activate, close: closeTab,
      log: (op, reps) => {
        const ok = reps.filter((r) => r.ok).length;
        console.log(`${op.id} ${op.name.padEnd(13)} ok ${ok}/${reps.length}  median ${summarize(reps.map((r) => r.ms)).median}ms  calls ${reps[0]?.calls}`);
      },
    });
  } finally {
    client.close();
  }
  const report = shapeReport(suite, {
    app: suite.app,
    date: new Date().toISOString(),
    node: process.version,
    macos: execFileSync("sw_vers", ["-productVersion"]).toString().trim(),
  });
  const p = resolve(ROOT, args.out);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(report, null, 2) + "\n");
  console.log(`wrote ${p}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
