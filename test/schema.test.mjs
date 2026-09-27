import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS, INSTRUCTIONS, SCHEMA_BUDGET, composeEvalScript, shapeTabs, formatResult } from "../server.js";

test("tool schemas stay within the token budget", () => {
  const size = JSON.stringify(TOOLS).length;
  assert.ok(size < SCHEMA_BUDGET, `${size} chars >= ${SCHEMA_BUDGET}`);
  for (const t of TOOLS) assert.ok(JSON.stringify(t).length < 900, `${t.name} is ${JSON.stringify(t).length} chars`);
  assert.ok(INSTRUCTIONS.length < 1200, `instructions ${INSTRUCTIONS.length}`);
});

test("tool surface is the agreed 16", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), [
    "list_tabs", "new_tab", "activate_tab", "navigate", "eval_js", "wait", "screenshot", "get_text",
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
  assert.equal(formatResult({ __perch_error: "x" }).isError, true);
  assert.equal(formatResult({ ok: false, error: "no match" }).isError, undefined);
  assert.equal(formatResult("# {}").content[0].text, "# {}");
  const img = formatResult({ __image: true, data: "AA", mimeType: "image/png", meta: { image: { w: 1, h: 1 } } });
  assert.deepEqual(img.content.map((c) => c.type), ["image", "text"]);
});
