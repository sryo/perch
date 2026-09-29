import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS, INSTRUCTIONS, SCHEMA_BUDGET, composeEvalScript, shapeTabs, formatResult, JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

test("tool schemas stay within the token budget", () => {
  const size = JSON.stringify(TOOLS).length;
  assert.ok(size < SCHEMA_BUDGET, `${size} chars >= ${SCHEMA_BUDGET}`);
  for (const t of TOOLS) assert.ok(JSON.stringify(t).length < 900, `${t.name} is ${JSON.stringify(t).length} chars`);
  assert.ok(INSTRUCTIONS.length < 1200, `instructions ${INSTRUCTIONS.length}`);
});

test("target lists only tabId and app; windowId and tabIndex are still accepted", async () => {
  const targeted = TOOLS.filter((t) => t.inputSchema.properties.target);
  assert.equal(targeted.length, 13);
  for (const t of targeted) {
    const target = t.inputSchema.properties.target;
    assert.deepEqual(Object.keys(target.properties), ["tabId", "app"], t.name);
    assert.equal(target.properties.tabId.type, "string", t.name);
    assert.notEqual(target.additionalProperties, false, t.name);
  }
  const world = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [
    { id: 1, active: 0, tabs: [{ url: "https://a.test/", title: "a", id: "a" }] },
    { id: 2, active: 0, tabs: [{ url: "https://b.test/", title: "b", id: "b" }, { url: "https://c.test/", title: "c", id: "c" }] },
  ] }], cg: [{ owner: "Google Chrome" }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  const r = await handleCall("eval_js", { script: "window.hit = 1; return location.href", target: { app: "chrome", windowId: 2, tabIndex: 1 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(world.page("Google Chrome", 1, 1).hit, 1);
});

test("tool surface is the agreed 17", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), [
    "list_tabs", "new_tab", "activate_tab", "close_tab", "navigate", "eval_js", "wait", "screenshot", "get_text",
    "accessibility_snapshot", "console_capture", "notify", "file_upload", "click", "press", "fill", "select",
  ]);
});

test("composeEvalScript: file then script, either alone, neither errors", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "perch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = join(dir, "lib.js");
  await writeFile(f, "(function(){ window.__x = 41 })()");
  assert.equal(await composeEvalScript({ script_path: f, script: "return window.__x + 1" }), "(function(){ window.__x = 41 })()\n;\nreturn window.__x + 1");
  assert.equal(await composeEvalScript({ script: "return 1" }), "return 1");
  assert.equal(await composeEvalScript({ script_path: f }), "(function(){ window.__x = 41 })()");
  await assert.rejects(composeEvalScript({}), /requires `script` or `script_path`/);
  await assert.rejects(composeEvalScript({ script_path: join(dir, "nope.js") }), /cannot read/);
});

test("eval_js takes a ref", () => {
  const t = TOOLS.find((x) => x.name === "eval_js");
  assert.equal(t.inputSchema.properties.ref.type, "string");
});

test("composeEvalScript: no ref is byte-identical; a ref splices only its JSON literal", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "perch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = join(dir, "lib.js");
  await writeFile(f, "window.__x = 41");
  for (const a of [{ script: "return 1" }, { script_path: f }, { script_path: f, script: "return 2" }]) {
    const plain = await composeEvalScript(a);
    assert.equal(await composeEvalScript({ ...a, ref: undefined }), plain);
    assert.equal(await composeEvalScript({ ...a, ref: null }), plain);
    assert.equal(await composeEvalScript({ ...a, awaitPromise: true }), plain);
  }
  const shape = (ref, body) => composeEvalScript({ ref, script: body });
  const a = await shape("e1", "return el");
  const b = await shape("e22", "return el");
  assert.equal(b, a.split(JSON.stringify("e1")).join(JSON.stringify("e22")), "the ref's JSON literal is the only varying part");
  assert.ok(a.includes("\nreturn el\n"));
  const odd = `e"]\\'x`;
  const c = await shape(odd, "return el");
  assert.equal(c, a.split(JSON.stringify("e1")).join(JSON.stringify(odd)));
  assert.doesNotThrow(() => new Function(c));
  const asy = await composeEvalScript({ ref: "e1", script: "await 0; return el", awaitPromise: true });
  assert.doesNotThrow(() => new Function("return (async function(){" + asy + "\n})"));
});

test("shapeTabs: always {tabs,total}; filters are case-insensitive; default limit 50", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ app: "Arc", windowId: 1, tabIndex: i, url: `https://Site${i}.test`, title: `T${i}` }));
  const all = shapeTabs(rows, {});
  assert.equal(all.tabs.length, 50);
  assert.equal(all.total, 60);
  const f = shapeTabs(rows, { urlContains: "site5", limit: 3 });
  assert.deepEqual(f.tabs.map((t) => t.tabIndex), [5, 50, 51]);
  assert.equal(f.total, 11);
  assert.equal(shapeTabs(rows, { titleContains: "t59" }).tabs[0].tabIndex, 59);
});

test("formatResult: ref miss and page errors are isError; ok:false and strings are not", () => {
  const miss = formatResult({ __perch_ref_miss: true, ref: "4" });
  assert.equal(miss.isError, true);
  assert.match(miss.content[0].text, /ref 4 is stale.*accessibility_snapshot/);
  // Only eval_js reaches formatResult with a raw page error; handleCall codes every other tool's.
  assert.equal(formatResult({ __perch_error: "x" }).isError, true);
  assert.equal(formatResult({ ok: false, error: "no match" }).isError, undefined);
  assert.equal(formatResult("# {}").content[0].text, "# {}");
  const img = formatResult({ __image: true, data: "AA", mimeType: "image/png", meta: { image: { w: 1, h: 1 } } });
  assert.deepEqual(img.content.map((c) => c.type), ["image", "text"]);
});
