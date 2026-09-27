#!/usr/bin/env node
// Live smoke test: boots server.js over stdio and exercises the real bridge.
// Browser-dependent checks SKIP when no browser runs. `--app <name>` picks the
// browser (loosely matched, e.g. arc, safari, canary); otherwise perch picks.
// Page-mutating checks run on an existing scratch about:blank tab. The default
// never creates, closes or activates a tab; --with-tab-creation opts into that
// (a created tab is closed afterwards) and may focus the browser. Non-zero exit
// on any FAIL.

import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, text } from "./mcp-client.mjs";
import { SCHEMA_BUDGET } from "../server.js";

const withTabCreation = process.argv.includes("--with-tab-creation");
const appArg = process.argv.includes("--app") ? process.argv[process.argv.indexOf("--app") + 1] : null;
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
    const out = await json("list_tabs", { limit: 500, ...(appArg ? { app: appArg } : {}) });
    expect(Array.isArray(out.tabs) && typeof out.total === "number", `got ${JSON.stringify(out).slice(0, 80)}`);
    tabs = out.tabs;
    return `${out.total} tabs`;
  });
  const haveBrowser = tabs.length > 0;
  const active = tabs.find((t) => t.active) || tabs[0];

  await check("eval_js round-trip on the active tab", async () => {
    if (!haveBrowser) return skip("no browser running");
    const out = text(await call("eval_js", { script: "return 1+1", target: { tabId: active.tabId } }));
    expect(out === "2", `expected "2", got ${JSON.stringify(out)}`);
  });

  await check("screenshot image + metadata block", async () => {
    if (!haveBrowser) return skip("no browser running");
    const res = await call("screenshot", { target: { tabId: active.tabId } });
    if (res.isError && /window_offscreen/.test(text(res))) return skip("target browser window is minimized or on another Space");
    expect(!res.isError, text(res));
    expect(res.content.find((c) => c.type === "image"), "no image block");
    const meta = JSON.parse(text(res));
    for (const k of ["x", "y", "w", "h"]) expect(typeof meta.window?.[k] === "number", `window.${k} missing`);
    return `window ${meta.window.w}x${meta.window.h}pt, image ${meta.image.w}x${meta.image.h}px`;
  });

  // Page-mutating checks use a scratch about:blank tab. Some browsers run page JS
  // only in the tab its window shows (tab_not_visible); activating it takes focus,
  // so only --with-tab-creation does that. Never create a tab in the default run.
  // Rows name the app in full ("Google Chrome Canary"), so compare against a row, not --app.
  const app = active?.app || appArg;
  let scratch = null;
  const created = [];
  const setDom = (html) => call("eval_js", { script: `document.body.innerHTML = ${JSON.stringify(html)}; return 1`, target: scratch });
  // Makes `target` evaluable; returns a skip reason, or null when ready.
  async function reachable(target) {
    const probe = await call("eval_js", { script: "return 1", target });
    if (!probe.isError) return null;
    if (!/tab_not_visible/.test(text(probe))) throw new Error(text(probe));
    if (!withTabCreation) return "tab isn't the one its window shows; --with-tab-creation activates it (takes focus)";
    await call("activate_tab", { target });
    const again = await call("eval_js", { script: "return 1", target });
    expect(!again.isError, text(again));
    return null;
  }
  const closeTab = (t) => call("close_tab", { tabId: t.tabId }).catch(() => {});

  await check("scratch tab", async () => {
    if (!haveBrowser) return skip("no browser running");
    const blank = tabs.find((t) => t.app === app && t.url === "about:blank");
    if (!blank && !withTabCreation) return skip("no existing scratch tab; --with-tab-creation may focus the browser");
    scratch = blank ? { tabId: blank.tabId } : { tabId: (await json("new_tab", { app, url: "about:blank" })).tabId };
    if (!blank) created.push({ app, tabId: scratch.tabId });
    const why = await reachable(scratch);
    if (why) { scratch = null; return skip(why); }
    return `${blank ? "reused" : "opened"} ${app} ${scratch.tabId}`;
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
    if (!withTabCreation) return skip("requires tab creation, which may focus the browser");
    if (!haveBrowser) return skip("no browser running");
    // Trusted Types only engages when the page LOADS with the CSP, so set it at tab creation.
    const ttHtml = `<!doctype html><meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'"><div contenteditable aria-label="Body"></div>`;
    const made = await json("new_tab", { app, url: "data:text/html," + encodeURIComponent(ttHtml) });
    await call("wait", { readyState: "complete", timeout: 5000, target: { tabId: made.tabId } }).catch(() => {});
    // Some handles follow the URL; re-read it once the page has loaded.
    const row = (await json("list_tabs", { app, urlContains: "data:text/html" })).tabs.find((t) => t.tabId.split(":")[0] === made.tabId.split(":")[0]);
    const tt = { tabId: (row || made).tabId };
    const reset = () => closeTab(tt);
    const why = await reachable(tt).catch((e) => e.message);
    if (why) { await reset(); return skip(why); }
    const present = text(await call("eval_js", { script: "return !!document.querySelector('[contenteditable]')", target: tt }));
    if (present !== "true") { await reset(); return skip("browser did not load the data: URL"); }
    const o = await json("fill", { label_pattern: "body", text: body, target: tt });
    await reset();
    expect(o.ok, `not ok under Trusted Types: ${JSON.stringify(o)}`);
  });

  if (scratch) await call("eval_js", { script: "document.body.innerHTML=''; return 1", target: scratch }).catch(() => {});
  for (const t of created) await closeTab(t);
} catch (e) {
  failures++;
  console.log(`FAIL harness — ${e.message}`);
} finally {
  client.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
