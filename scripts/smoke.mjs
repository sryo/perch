#!/usr/bin/env node
// Live smoke test: boots server.js over stdio and exercises the real bridge.
// Browser-dependent checks SKIP when no browser runs. Page-mutating checks run
// on a scratch about:blank tab in a Chrome-family browser (reused across runs),
// never on the user's own tabs. Non-zero exit on any FAIL.

import { execFileSync } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, text } from "./mcp-client.mjs";
import { SCHEMA_BUDGET } from "../server.js";

const client = await connect();
const call = client.call;
const json = async (name, args) => JSON.parse(text(await call(name, args)));

let failures = 0;
const SKIP = Symbol("skip");
let skipReason = "";
const skip = (why) => { skipReason = why; return SKIP; };
async function check(label, fn) {
  let status = "PASS", detail = "";
  try {
    const r = await fn();
    if (r === SKIP) { status = "SKIP"; detail = skipReason; } else detail = r || "";
  } catch (e) { status = "FAIL"; detail = e.message; failures++; }
  console.log(`${status.padEnd(4)} ${label}${detail ? ` — ${detail}` : ""}`);
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

try {
  await check("tools/list within schema budget", async () => {
    const { tools } = (await client.rpc("tools/list", {})).result;
    const size = JSON.stringify(tools).length;
    expect(size < SCHEMA_BUDGET, `${size} chars >= budget ${SCHEMA_BUDGET}`);
    expect(client.init.instructions, "no server instructions");
    return `${tools.length} tools, ${size} chars`;
  });

  let tabs = [];
  await check("list_tabs returns {tabs, total}", async () => {
    const out = await json("list_tabs", { limit: 500 });
    expect(Array.isArray(out.tabs) && typeof out.total === "number", `got ${JSON.stringify(out).slice(0, 80)}`);
    tabs = out.tabs;
    return `${out.total} tabs`;
  });
  const haveBrowser = tabs.length > 0;
  const active = tabs.find((t) => t.active) || tabs[0];

  await check("eval_js round-trip on the active tab", async () => {
    if (!haveBrowser) return skip("no browser running");
    const out = text(await call("eval_js", { script: "return 1+1", target: { app: active.app, windowId: active.windowId, tabIndex: active.tabIndex } }));
    expect(out === "2", `expected "2", got ${JSON.stringify(out)}`);
  });

  await check("screenshot image + metadata block", async () => {
    if (!haveBrowser) return skip("no browser running");
    const res = await call("screenshot", { target: { app: active.app, windowId: active.windowId } });
    expect(res.content.find((c) => c.type === "image"), "no image block");
    const meta = JSON.parse(text(res));
    for (const k of ["x", "y", "w", "h"]) expect(typeof meta.window?.[k] === "number", `window.${k} missing`);
    return `window ${meta.window.w}x${meta.window.h}pt, image ${meta.image.w}x${meta.image.h}px`;
  });

  // Page-mutating checks: a scratch about:blank tab in a Chrome-family browser
  // (Arc can't eval background tabs). Reuse one from an earlier run if present.
  const chromeTabs = tabs.filter((t) => /chrome|chromium|brave|edge|vivaldi/i.test(t.app));
  let scratch = null;
  const setDom = (html) => call("eval_js", { script: `document.body.innerHTML = ${JSON.stringify(html)}; return 1`, target: scratch });

  await check("scratch tab", async () => {
    if (!chromeTabs.length) return skip("no chrome-family browser");
    const blank = chromeTabs.find((t) => t.url === "about:blank");
    scratch = blank ? { app: blank.app, windowId: blank.windowId, tabIndex: blank.tabIndex } : await json("new_tab", { app: chromeTabs[0].app, url: "about:blank" });
    return `${blank ? "reused" : "opened"} ${scratch.app} @${scratch.tabIndex}`;
  });

  await check("eval_js typed error sets isError + name", async () => {
    if (!scratch) return skip("no scratch tab");
    const res = await call("eval_js", { script: "throw new TypeError('boom')", target: scratch });
    expect(res.isError === true, "isError not set");
    const o = JSON.parse(text(res));
    expect(o.__perch_error_name === "TypeError" && /boom/.test(o.__perch_error), text(res));
  });

  await check("eval_js script_path + script in one call", async () => {
    if (!scratch) return skip("no scratch tab");
    const dir = await mkdtemp(join(tmpdir(), "perch-smoke-"));
    const lib = join(dir, "lib.js");
    await writeFile(lib, "(function(){ window.__smoke = 41 })()");
    const out = text(await call("eval_js", { script_path: lib, script: "return window.__smoke + 1", target: scratch }));
    expect(out === "42", `got ${out}`);
  });

  const body = "Hi there, this is a multi-line reply body.\nSecond line.\n\nA second paragraph that makes the text comfortably longer than fifty characters.";

  await check("fill skips hidden textarea, hits visible contenteditable", async () => {
    if (!scratch) return skip("no scratch tab");
    await setDom(`<textarea name="bodyHtml" style="display:none"></textarea><div contenteditable aria-label="Message Body"></div>`);
    const o = await json("fill", { label_pattern: "body", text: body, target: scratch });
    expect(o.ok && o.kind === "rich" && o.el === 'textbox "Message Body"', JSON.stringify(o));
    return o.el;
  });

  await check("snapshot lists the editor with its value", async () => {
    if (!scratch) return skip("no scratch tab");
    await setDom(`<div contenteditable aria-label="Reply"></div><input aria-label="Subject" value="Re: hi">`);
    const out = text(await call("accessibility_snapshot", { role: "textbox", target: scratch }));
    const lines = out.split("\n");
    expect(lines[0].startsWith("# {"), `header: ${lines[0]}`);
    expect(lines.includes('1 textbox "Reply"') && lines.includes('2 textbox "Subject" value="Re: hi"'), out);
    return `${lines.length - 1} lines`;
  });

  await check("get_text html", async () => {
    if (!scratch) return skip("no scratch tab");
    await setDom(`<p id=p>para</p>`);
    const out = text(await call("get_text", { selector: "#p", html: true, target: scratch }));
    expect(out === '<p id="p">para</p>', out);
  });

  await check("stale ref is an error with a re-snapshot hint", async () => {
    if (!scratch) return skip("no scratch tab");
    const res = await call("click", { ref: "9999", target: scratch });
    expect(res.isError && /accessibility_snapshot/.test(text(res)), text(res));
  });

  await check("select picks from a native <select>", async () => {
    if (!scratch) return skip("no scratch tab");
    await setDom(`<label>Country <select><option>Pick</option><option>Argentina</option><option>Brazil</option></select></label>`);
    const o = await json("select", { label_pattern: "country", text: "Argentina", target: scratch });
    expect(o.ok && o.selected === "Argentina" && o.el === 'combobox "Country"', JSON.stringify(o));
  });

  await check("TT-safe rich fill under Trusted Types", async () => {
    if (!chromeTabs.length) return skip("no chrome-family browser");
    // Trusted Types only engages when the page LOADS with the CSP, so set it at tab creation.
    const ttHtml = `<!doctype html><meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'"><div contenteditable aria-label="Body"></div>`;
    const tt = await json("new_tab", { app: chromeTabs[0].app, url: "data:text/html," + encodeURIComponent(ttHtml) });
    // perch has no close-tab tool, so close the throwaway tab straight through AppleScript.
    const reset = async () => {
      try { execFileSync("osascript", ["-l", "JavaScript", "-e", `Application(${JSON.stringify(tt.app)}).windows.byId(${JSON.stringify(String(tt.windowId))}).tabs[${tt.tabIndex}].close()`]); }
      catch { await call("eval_js", { script: "location.href='about:blank'; return 1", target: tt }).catch(() => {}); }
    };
    const present = text(await call("eval_js", { script: "return !!document.querySelector('[contenteditable]')", target: tt }));
    if (present !== "true") { await reset(); return skip("browser did not load the data: URL"); }
    const o = await json("fill", { label_pattern: "body", text: body, target: tt });
    await reset();
    expect(o.ok, `not ok under Trusted Types: ${JSON.stringify(o)}`);
  });

  if (scratch) await call("eval_js", { script: "document.body.innerHTML=''; return 1", target: scratch }).catch(() => {});
} catch (e) {
  failures++;
  console.log(`FAIL harness — ${e.message}`);
} finally {
  client.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
