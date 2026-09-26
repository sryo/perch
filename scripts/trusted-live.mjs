#!/usr/bin/env node
// Live check for trusted input (click/fill {trusted:true}). Foreground mode raises
// the browser briefly; --background checks that input reaches it without changing
// the front app or cursor. Both modes post real input and require --yes.
//   node scripts/trusted-live.mjs --yes [--app "Google Chrome Canary"]
//   node scripts/trusted-live.mjs --yes --background [--app "Google Chrome Canary"]
// Uses a scratch about:blank tab in a Chrome-family browser (reused like smoke's).

import { execFileSync } from "node:child_process";
import { connect, text } from "./mcp-client.mjs";

const argv = process.argv.slice(2);
if (!argv.includes("--yes")) {
  console.error("trusted-live posts real clicks/keys and may raise a browser. Re-run with --yes to consent.");
  process.exit(2);
}
const appArg = argv.includes("--app") ? argv[argv.indexOf("--app") + 1] : null;
const background = argv.includes("--background");
if (background && argv.includes("--delivery")) {
  console.error("--background and --delivery are separate probes; run one at a time.");
  process.exit(2);
}

const frontApp = () => execFileSync("osascript", ["-l", "JavaScript", "-e",
  "ObjC.import('CoreGraphics');const l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17,0)));" +
  "(l.find(w=>w.kCGWindowLayer===0&&w.kCGWindowBounds.Width>100)||{}).kCGWindowOwnerName||''"]).toString().trim();
const cursorAt = () => JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e",
  "ObjC.import('CoreGraphics');const p=$.CGEventGetLocation($.CGEventCreate($()));JSON.stringify({x:p.x,y:p.y})"]).toString().trim());

const PAGE = `
  document.body.innerHTML = '<div style="height:200px"></div>' +
    '<button id=b style="margin-left:180px;width:220px;height:56px">Trusted target</button>' +
    '<p style="margin-left:180px"><input id=i aria-label="Name" style="width:320px;height:32px"></p>';
  window.__rec = { downs: [], moves: [], inputs: [] };
  document.onmousedown = e => window.__rec.downs.push({ id: e.target.id, trusted: e.isTrusted, x: e.clientX, y: e.clientY });
  document.onmousemove = e => { if (window.__rec.moves.length < 10) window.__rec.moves.push([e.clientX, e.clientY]); };
  document.oninput = e => window.__rec.inputs.push({ id: e.target.id, trusted: e.isTrusted });
  const c = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  return { b: c('b'), i: c('i') };`;

const TEXT = "Ada Lovelace 😀 élan ok";

// --delivery: which event-posting path reaches the page at all? One button per method.
const METHODS = ["pid", "pidPlain", "skylight", "hid"];
const DELIVERY_PAGE = `
  document.body.innerHTML = ${JSON.stringify(METHODS)}.map(m => '<button id=' + m + ' style="display:block;margin:24px 180px;width:220px;height:44px">' + m + '</button>').join('');
  window.__rec = [];
  for (const t of ['mousemove', 'mousedown']) document.addEventListener(t, e => window.__rec.push(t + ':' + (e.target.id || e.target.tagName) + ':' + e.isTrusted), true);
  return 1`;
const POINTS = `
  const ox = screenX + (outerWidth - innerWidth), oy = screenY + (outerHeight - innerHeight);
  return ${JSON.stringify(METHODS)}.map(m => { const r = document.getElementById(m).getBoundingClientRect(); return { m, x: ox + r.left + r.width / 2, y: oy + r.top + r.height / 2 }; });`;
function postJxa(method, pid, wid, p) {
  return `ObjC.import('CoreGraphics');
    ${method === "skylight" ? "ObjC.bindFunction('SLEventPostToPid', ['void', ['int', 'void *']]);" : ""}
    function send(type) {
      const e = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(${p.x}, ${p.y}), 0);
      $.CGEventSetIntegerValueField(e, 1, type === 5 ? 0 : 1);
      if (${JSON.stringify(method)} === 'pid' && ${wid} != null) {
        $.CGEventSetIntegerValueField(e, 9, ${pid});
        for (const f of [27, 28, 51]) $.CGEventSetIntegerValueField(e, f, ${wid});
        $.CGEventSetIntegerValueField(e, 58, 1);
      }
      if (${JSON.stringify(method)} === 'pid' || ${JSON.stringify(method)} === 'pidPlain') $.CGEventPostToPid(${pid}, e);
      else if (${JSON.stringify(method)} === 'skylight') $.SLEventPostToPid(${pid}, e);
      else $.CGEventPost(0, e);
    }
    send(5); delay(0.05); send(1); delay(0.02); send(2); 'ok'`;
}
const before = frontApp();
const client = await connect({ timeoutMs: 60000 });
let failures = 0;
const report = (ok, label, detail) => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${label} — ${detail}`); };

try {
  const listed = JSON.parse(text(await client.call("list_tabs", { urlContains: "about:blank", limit: 200 })));
  const chrome = (t) => /chrome|chromium|brave|edge|vivaldi/i.test(t.app) && (!appArg || t.app === appArg);
  let tab = listed.tabs.find(chrome);
  if (!tab) {
    const all = JSON.parse(text(await client.call("list_tabs", { limit: 500 }))).tabs.find(chrome);
    if (!all) throw new Error("no Chrome-family browser running");
    tab = JSON.parse(text(await client.call("new_tab", { app: all.app, url: "about:blank" })));
  }
  const target = { app: tab.app, windowId: tab.windowId, tabIndex: tab.tabIndex };
  if (argv.includes("--delivery")) {
    await client.call("eval_js", { target, script: DELIVERY_PAGE });
    await client.call("activate_tab", { target });
    execFileSync("osascript", ["-l", "JavaScript", "-e", "delay(0.5)"]);
    const pts = JSON.parse(text(await client.call("eval_js", { target, script: POINTS })));
    const ids = execFileSync("osascript", ["-l", "JavaScript", "-e",
      `ObjC.import('CoreGraphics');const l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17,0)));` +
      `const w=l.find(w=>w.kCGWindowOwnerName===${JSON.stringify(tab.app)}&&w.kCGWindowLayer===0&&w.kCGWindowBounds.Width>100);JSON.stringify(w?{pid:w.kCGWindowOwnerPID,wid:w.kCGWindowNumber}:null)`]).toString().trim();
    const { pid, wid } = JSON.parse(ids);
    console.log(`INFO front after activate: ${frontApp()}; pid ${pid}, window ${wid}`);
    for (const p of pts) {
      try { execFileSync("osascript", ["-l", "JavaScript", "-e", postJxa(p.m, pid, wid, p)]); }
      catch (e) { console.log(`INFO ${p.m}: post threw ${e.message.split("\n")[0].slice(0, 160)}`); }
      execFileSync("osascript", ["-l", "JavaScript", "-e", "delay(0.3)"]);
    }
    const rec = JSON.parse(text(await client.call("eval_js", { target, script: "return window.__rec" })));
    for (const m of METHODS) {
      const got = rec.filter((r) => r.split(":")[1] === m);
      console.log(`${m.padEnd(9)} ${got.length ? got.join("  ") : "nothing reached the page"}`);
    }
    await client.call("eval_js", { target, script: "document.body.innerHTML=''; delete window.__rec; return 1" });
    throw Object.assign(new Error("delivery probe done"), { done: true });
  }
  const centers = JSON.parse(text(await client.call("eval_js", { target, script: PAGE })));

  if (background && !before) {
    throw new Error("could not identify the front app before the background probe");
  }
  if (background && before === tab.app) {
    throw new Error(`bring another app in front of ${tab.app} before running --background`);
  }
  if (background && frontApp() !== before) {
    throw new Error(`scratch-tab setup changed the front app from ${before} to ${frontApp()}`);
  }
  const cursorBefore = background ? cursorAt() : null;
  const foregroundSamples = [];
  let poll;
  if (background) {
    foregroundSamples.push(frontApp());
    poll = setInterval(() => {
      try { foregroundSamples.push(frontApp()); }
      catch (e) { foregroundSamples.push(`(probe error: ${e.message})`); }
    }, 75);
  }

  let clickRes, fillRes, inputError;
  try {
    clickRes = await client.call("click", { trusted: true, raise: !background, selector: "#b", target });
    if (background) foregroundSamples.push(frontApp());
    fillRes = await client.call("fill", { trusted: true, raise: !background, selector: "#i", text: TEXT, target });
    if (background) foregroundSamples.push(frontApp());
  } catch (e) {
    inputError = e;
  } finally {
    if (poll) clearInterval(poll);
    if (background) {
      foregroundSamples.push(frontApp());
      report(foregroundSamples.every((app) => app === before), "front app stays unchanged", JSON.stringify({ expected: before, observed: [...new Set(foregroundSamples)], samples: foregroundSamples.length }));
      const cursorAfter = cursorAt();
      if (Math.abs(cursorAfter.x - cursorBefore.x) <= 1 && Math.abs(cursorAfter.y - cursorBefore.y) <= 1) {
        report(true, "cursor stays in place", JSON.stringify({ before: cursorBefore, after: cursorAfter }));
      } else {
        console.log(`INFO cursor moved during the probe; stability is inconclusive in this run — ${JSON.stringify({ before: cursorBefore, after: cursorAfter })}`);
      }
    }
  }
  if (inputError) throw inputError;
  const click = JSON.parse(text(clickRes).replace(/^error: (.*)$/s, (_, m) => JSON.stringify({ error: m })));
  const fill = JSON.parse(text(fillRes).replace(/^error: (.*)$/s, (_, m) => JSON.stringify({ error: m })));
  const rec = JSON.parse(text(await client.call("eval_js", { target, script: "return { rec: window.__rec, value: document.getElementById('i').value }" })));

  const down = rec.rec.downs.find((d) => d.id === "b");
  report(click.hit === true && !!down?.trusted, "trusted click lands on the button", JSON.stringify({ result: click, pageSaw: rec.rec.downs[0] || null }));
  if (down) report(Math.abs(down.x - centers.b[0]) <= 3 && Math.abs(down.y - centers.b[1]) <= 3, "click point matches the element center", `center ${centers.b.map(Math.round)}, pressed ${[down.x, down.y]}`);
  const firstMove = rec.rec.moves[0];
  if (!background && firstMove) console.log(`INFO estimate before calibration was off by ${[Math.round(centers.b[0] - firstMove[0]), Math.round(centers.b[1] - firstMove[1])]} (px)`);
  else if (!firstMove) console.log("INFO no mousemove reached the page (calibration unavailable)");
  report(fill.ok === true && rec.value === TEXT, "trusted fill types the full text, emoji included", JSON.stringify({ result: fill, value: rec.value }));
  const trustedInputs = rec.rec.inputs.filter((e) => e.id === "i" && e.trusted);
  report(trustedInputs.length > 0, "page receives a trusted input event", JSON.stringify({ trusted: trustedInputs.length, total: rec.rec.inputs.length }));
  await client.call("eval_js", { target, script: "document.body.innerHTML=''; delete window.__rec; return 1" });
} catch (e) {
  if (!e.done) report(false, "harness", e.message);
} finally {
  client.close();
  if (before && before !== frontApp()) {
    try { execFileSync("osascript", ["-e", `tell application ${JSON.stringify(before)} to activate`]); } catch {}
  }
  console.log(`front app after test: ${frontApp() || "(unknown)"}`);
}
process.exit(failures ? 1 : 0);
