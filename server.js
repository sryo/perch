#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const BROWSERS = [
  { app: "Google Chrome",        kind: "chrome" },
  { app: "Google Chrome Beta",   kind: "chrome" },
  { app: "Google Chrome Canary", kind: "chrome" },
  { app: "Brave Browser",        kind: "chrome" },
  { app: "Microsoft Edge",       kind: "chrome" },
  { app: "Vivaldi",              kind: "chrome" },
  { app: "Arc",                  kind: "arc" },
  { app: "Safari",               kind: "safari" },
];

const PERMISSION_HINT =
  "JavaScript-from-AppleEvents is off. Enable it: " +
  "Chromium-family → View > Developer > Allow JavaScript from Apple Events. " +
  "Safari → Preferences > Advanced > Show Develop menu, then Develop > Allow JavaScript from Apple Events. " +
  "macOS may also prompt for Automation permission (System Settings > Privacy & Security > Automation) on first use.";

// Default 30s. Tools that intentionally poll longer (waitFor, evalJs awaitPromise)
// pass their own timeout + JXA_OVERHEAD so the outer process doesn't kill the inner loop.
const JXA_DEFAULT_TIMEOUT = 30000;
const JXA_OVERHEAD = 5000;

async function jxa(script, options = {}) {
  const { timeout = JXA_DEFAULT_TIMEOUT } = options;
  try {
    const { stdout } = await exec("osascript", ["-l", "JavaScript", "-e", script], { maxBuffer: 32 << 20, timeout });
    return stdout.replace(/\n$/, "");
  } catch (e) {
    // execFile sets `killed: true` + `signal: 'SIGTERM'` (or whatever was sent) on timeout.
    // We surface this as a clean error so a hung browser shows up in seconds instead of
    // waiting the default 2-min Apple Events `-1712`.
    if (e.killed && (e.signal === "SIGTERM" || e.code === null)) {
      throw new Error(
        `osascript timed out after ${timeout}ms. The target browser is most likely unresponsive ` +
        `(check 'Allow JavaScript from Apple Events' in the browser's Developer menu, ` +
        `or restart the browser).`
      );
    }
    const msg = String(e.stderr || e.message || e);
    if (/Allow JavaScript from Apple Events/i.test(msg) ||
        /Executing JavaScript through AppleScript is turned off/i.test(msg) ||
        /JavaScript from Apple events is turned off/i.test(msg)) {
      throw new Error(PERMISSION_HINT);
    }
    if (/Not authorized to send Apple events/i.test(msg) ||
        /errAEEventNotPermitted/i.test(msg) ||
        /-1743/.test(msg) ||
        (e.code === 1 && !msg.trim())) {
      throw new Error(
        "Automation permission denied. Grant it in System Settings > Privacy & Security > Automation, " +
        "then tick the target browser under the controlling app (Claude Code / Terminal / iTerm)."
      );
    }
    throw new Error(msg.trim());
  }
}

const FRONTMOST = `
  let fm = '';
  try { fm = Application('System Events').applicationProcesses.whose({frontmost: true})[0].name(); } catch (e) {}
`;

function targetClause(target) {
  const want = target || {};
  return `
    let tab, tab_kind, tab_app, tab_window;
    {
      ${FRONTMOST}
      const browsers = ${JSON.stringify(BROWSERS)};
      const want = ${JSON.stringify(want)};
      let chosen = null;
      for (const b of browsers) {
        if (want.app && b.app !== want.app) continue;
        let app;
        try { app = Application(b.app); if (!app.running()) continue; } catch (e) { continue; }
        let winsLen;
        try { winsLen = app.windows.length; } catch (e) { continue; }
        for (let w = 0; w < winsLen; w++) {
          const win = app.windows[w];
          let winId; try { winId = win.id(); } catch (e) { winId = w; }
          if (want.windowId != null && String(winId) !== String(want.windowId)) continue;
          let tabs;
          try { tabs = win.tabs; tabs.length; } catch (e) { continue; }
          let idx;
          if (want.tabIndex != null) idx = want.tabIndex;
          else if (b.kind === 'chrome') {
            try { idx = win.activeTabIndex() - 1; } catch (e) { idx = 0; }
          } else {
            idx = 0;
            try {
              const cur = win.currentTab();
              const curIdx = cur.index();
              for (let i = 0; i < tabs.length; i++) {
                try { if (tabs[i].index() === curIdx) { idx = i; break; } } catch (e) {}
              }
            } catch (e) {}
          }
          if (idx < 0 || idx >= tabs.length) continue;
          const cand = { tab: tabs[idx], kind: b.kind, app: b.app, window: win };
          if (b.app === fm) { chosen = cand; break; }
          if (!chosen) chosen = cand;
        }
        if (chosen && chosen.app === fm) break;
      }
      if (!chosen) throw new Error('no matching tab');
      tab = chosen.tab;
      tab_kind = chosen.kind;
      tab_app = chosen.app;
      tab_window = chosen.window;
    }
  `;
}

function focusTabFragment() {
  return `
    {
      const app = Application(tab_app);
      try { tab_window.index = 1; } catch (e) {}
      try {
        if (tab_kind === 'chrome') {
          let idx; try { idx = tab.index(); } catch (e) { idx = 1; }
          tab_window.activeTabIndex = idx;
        } else {
          tab_window.currentTab = tab;
        }
      } catch (e) {}
      app.activate();
    }
  `;
}

function buildEvalWrapper(userScript) {
  return `(function(){ try { var __r = (function(){ ${userScript} })(); return JSON.stringify(__r === undefined ? null : __r); } catch(e) { return JSON.stringify({__perch_error: (e && e.message) ? e.message : String(e)}); } })()`;
}

// ---- tools ----

async function listTabs() {
  const src = `
    ${FRONTMOST}
    const browsers = ${JSON.stringify(BROWSERS)};
    const out = [];
    for (const b of browsers) {
      let app;
      try { app = Application(b.app); if (!app.running()) continue; } catch (e) { continue; }
      try {
        // Lazy windows[w] access preserves the bridge context that the called form
        // loses on Arc — making property chains like win.tabs.url() fail otherwise.
        const winsLen = app.windows.length;
        for (let w = 0; w < winsLen; w++) {
          const win = app.windows[w];
          let winId; try { winId = win.id(); } catch (e) { winId = w; }
          // Bulk-fetch URL + title in one JXA call each — per-tab access is ~30x slower
          // and hits timeouts on Arc windows with hundreds of tabs.
          let urls = [], titles = [];
          try { urls = win.tabs.url(); } catch (e) { continue; }
          try { titles = b.kind === 'safari' ? win.tabs.name() : win.tabs.title(); } catch (e) {}
          let activeIdx = -1;
          if (b.kind === 'chrome') {
            try { activeIdx = win.activeTabIndex() - 1; } catch (e) {}
          } else {
            try {
              const curIdx = win.currentTab().index();
              const idxs = win.tabs.index();
              for (let i = 0; i < idxs.length; i++) { if (idxs[i] === curIdx) { activeIdx = i; break; } }
            } catch (e) {}
          }
          for (let t = 0; t < urls.length; t++) {
            out.push({ app: b.app, windowId: winId, tabIndex: t, url: urls[t] || '', title: titles[t] || '', active: t === activeIdx && w === 0 && b.app === fm });
          }
        }
      } catch (e) {}
    }
    JSON.stringify(out);
  `;
  return JSON.parse(await jxa(src));
}

async function evalJs(script, target, options = {}) {
  const { awaitPromise = false, timeout = 30000 } = options;

  if (awaitPromise) {
    // The AppleScript bridge is synchronous — it doesn't await Promises. To
    // support async user code we wrap it in an async IIFE that stashes its
    // result on window[key], then poll that slot from JXA until it appears.
    const key = `__perch_async_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const kickoff = `(function(){
      (async () => {
        try {
          var __r = await (async () => { ${script} })();
          window[${JSON.stringify(key)}] = { ok: true, value: __r === undefined ? null : __r };
        } catch(e) {
          window[${JSON.stringify(key)}] = { ok: false, error: (e && e.message) ? e.message : String(e) };
        }
      })();
    })()`;
    const poll = buildEvalWrapper(`
      if (window[${JSON.stringify(key)}] === undefined) return null;
      var v = window[${JSON.stringify(key)}];
      delete window[${JSON.stringify(key)}];
      return v;
    `);
    const src = `
      ${targetClause(target)}
      if (tab_kind === 'chrome') tab.execute({javascript: ${JSON.stringify(kickoff)}});
      else if (tab_kind === 'arc') tab.execute({javascript: ${JSON.stringify(kickoff)}});
      else Application(tab_app).doJavaScript(${JSON.stringify(kickoff)}, { in: tab });
      const start = Date.now();
      const timeout = ${timeout};
      let outcome = JSON.stringify({__perch_timeout: true});
      while (Date.now() - start < timeout) {
        let r = 'null';
        try {
          if (tab_kind === 'chrome') r = String(tab.execute({javascript: ${JSON.stringify(poll)}}) || 'null');
          else if (tab_kind === 'arc') {
            const a = tab.execute({javascript: ${JSON.stringify(poll)}});
            try { r = String(JSON.parse(a) || 'null'); } catch (e) { r = String(a); }
          }
          else r = String(Application(tab_app).doJavaScript(${JSON.stringify(poll)}, {in: tab}) || 'null');
        } catch (e) {}
        if (r !== 'null') { outcome = r; break; }
        delay(0.05);
      }
      outcome;
    `;
    const raw = await jxa(src, { timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD });
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return raw; }
    if (parsed && parsed.__perch_timeout) throw new Error(`eval_js (awaitPromise) timed out after ${timeout}ms`);
    if (parsed && parsed.ok === false) return { __perch_error: parsed.error };
    return parsed && Object.prototype.hasOwnProperty.call(parsed, "value") ? parsed.value : parsed;
  }

  const wrapped = buildEvalWrapper(script);
  const src = `
    ${targetClause(target)}
    let raw;
    if (tab_kind === 'chrome') raw = tab.execute({javascript: ${JSON.stringify(wrapped)}});
    else if (tab_kind === 'arc') {
      // Arc auto-JSON.stringifies tab.execute return values, so the wrapper's
      // JSON-stringified result ends up double-encoded. Undo one layer here.
      const r = tab.execute({javascript: ${JSON.stringify(wrapped)}});
      try { raw = JSON.parse(r); } catch (e) { raw = r; }
    }
    else raw = Application(tab_app).doJavaScript(${JSON.stringify(wrapped)}, { in: tab });
    raw == null ? 'null' : String(raw);
  `;
  const raw = await jxa(src);
  try { return JSON.parse(raw); } catch { return raw; }
}

async function waitFor(args = {}, target) {
  const { selector, readyState = "complete", expression, timeout = 10000, interval = 150 } = args;
  let wrapped;
  if (expression) {
    // Expression mode: poll a user JS expression. Truthy non-null/false result is returned as `value`.
    wrapped = `(function(){ try { var __r = (${expression}); return JSON.stringify(__r === undefined ? null : __r); } catch(e) { return 'null'; } })()`;
  } else {
    const checkScript = `
      return (function(){
        const order = { loading: 0, interactive: 1, complete: 2 };
        const wantReady = ${JSON.stringify(readyState)};
        if (wantReady && order[document.readyState] < order[wantReady]) return false;
        const wantSel = ${JSON.stringify(selector || "")};
        if (wantSel && !document.querySelector(wantSel)) return false;
        return true;
      })();
    `;
    wrapped = buildEvalWrapper(checkScript);
  }
  const src = `
    ${targetClause(target)}
    const start = Date.now();
    const timeout = ${timeout};
    const interval = ${interval};
    let outcome = JSON.stringify({ok: false, timeout: true});
    while (Date.now() - start < timeout) {
      let resultStr = 'null';
      try {
        if (tab_kind === 'chrome') resultStr = String(tab.execute({javascript: ${JSON.stringify(wrapped)}}) || 'null');
        else if (tab_kind === 'arc') {
          // Arc auto-stringifies; unwrap one layer so JSON.parse below sees the same shape Chrome emits.
          const r = tab.execute({javascript: ${JSON.stringify(wrapped)}});
          let unwrapped; try { unwrapped = JSON.parse(r); } catch (e) { unwrapped = r; }
          resultStr = String(unwrapped == null ? 'null' : unwrapped);
        }
        else resultStr = String(Application(tab_app).doJavaScript(${JSON.stringify(wrapped)}, {in: tab}) || 'null');
      } catch (e) {}
      let parsed = null;
      try { parsed = JSON.parse(resultStr); } catch (e) {}
      if (parsed !== null && parsed !== false) {
        outcome = JSON.stringify({ok: true, waited: Date.now() - start, value: parsed});
        break;
      }
      delay(interval / 1000);
    }
    outcome;
  `;
  const out = JSON.parse(await jxa(src, { timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD }));
  if (!out.ok) throw new Error(`wait_for timed out after ${timeout}ms`);
  if (!expression) return { ok: true, waited: out.waited };
  return out;
}

async function navigate(url, target, wait = true) {
  const src = `
    ${targetClause(target)}
    // Safari's tab.url assignment only takes effect on the document's currentTab —
    // make our target current first. Chrome family accepts it on any tab.
    if (tab_kind === 'safari') { try { tab_window.currentTab = tab; } catch (e) {} }
    tab.url = ${JSON.stringify(url)};
    'ok';
  `;
  await jxa(src);
  if (wait) {
    try { await waitFor({ readyState: "complete", timeout: 15000 }, target); }
    catch (e) {}
  } else {
    await new Promise(r => setTimeout(r, 200));
  }
  return { ok: true, url };
}

async function newTab(url, app = "Google Chrome") {
  const browser = BROWSERS.find(b => b.app === app) || BROWSERS[0];
  const targetUrl = url || "about:blank";
  const src = `
    const app = Application(${JSON.stringify(browser.app)});
    if (!app.running()) app.activate();
    const kind = ${JSON.stringify(browser.kind)};
    let win;
    if (kind === 'chrome' || kind === 'arc') {
      if (!app.windows.length) app.Window().make();
      win = app.windows[0];
      const t = app.Tab({ url: ${JSON.stringify(targetUrl)} });
      win.tabs.push(t);
      try { win.activeTabIndex = win.tabs.length; } catch (e) {}
    } else {
      // Safari: documents[0].tabs throws "cannot get object" under JXA, but
      // windows[0].tabs works. Use windows everywhere here for the same reason
      // listTabs/targetClause do.
      if (!app.windows.length) {
        try { app.Document().make(); } catch (e) {}
      }
      win = app.windows[0];
      let created = false;
      try {
        const t = app.Tab({ url: ${JSON.stringify(targetUrl)} });
        win.tabs.push(t);
        created = true;
      } catch (e) {}
      try { win.currentTab = win.tabs[win.tabs.length - 1]; } catch (e) {}
      if (!created) {
        const se = Application('System Events');
        app.activate();
        delay(0.1);
        se.keystroke('t', {using: 'command down'});
        delay(0.15);
        try { win.currentTab.url = ${JSON.stringify(targetUrl)}; } catch (e) {}
      }
    }
    let winId = null; try { winId = win.id(); } catch (e) {}
    let tabIndex = null; try { tabIndex = win.tabs.length - 1; } catch (e) {}
    JSON.stringify({ windowId: winId, tabIndex });
  `;
  const { windowId = null, tabIndex = null } = JSON.parse(await jxa(src));
  return { ok: true, app: browser.app, url: targetUrl, windowId, tabIndex };
}

async function closeTab(target) {
  const src = `
    ${targetClause(target)}
    try { tab.close(); }
    catch (e) {
      ${focusTabFragment()}
      delay(0.1);
      Application('System Events').keystroke('w', {using: 'command down'});
    }
    'ok';
  `;
  await jxa(src);
  return { ok: true };
}

async function activateTab(target) {
  const src = `
    ${targetClause(target)}
    ${focusTabFragment()}
    'ok';
  `;
  await jxa(src);
  return { ok: true };
}

async function reload(target) {
  const src = `
    ${targetClause(target)}
    if (tab_kind === 'chrome' || tab_kind === 'arc') tab.reload();
    else Application(tab_app).doJavaScript('location.reload()', { in: tab });
    'ok';
  `;
  await jxa(src);
  return { ok: true };
}

async function goBack(target) {
  const src = `
    ${targetClause(target)}
    if (tab_kind === 'chrome' || tab_kind === 'arc') tab.goBack();
    else Application(tab_app).doJavaScript('history.back()', { in: tab });
    'ok';
  `;
  await jxa(src);
  return { ok: true };
}

async function goForward(target) {
  const src = `
    ${targetClause(target)}
    if (tab_kind === 'chrome' || tab_kind === 'arc') tab.goForward();
    else Application(tab_app).doJavaScript('history.forward()', { in: tab });
    'ok';
  `;
  await jxa(src);
  return { ok: true };
}

async function screenshot(args = {}) {
  const { raise = false, target } = args;
  const src = `
    ${targetClause(target)}
    ${raise ? focusTabFragment() : `
      // When tabIndex targets a non-active tab, silently switch the window to it so the
      // right tab renders. No app.activate(), no window raise; user's focus stays put.
      // Arc lacks reliable active-tab detection, so the switch is skipped there.
      let __switched = false;
      try {
        if (tab_kind === 'chrome') {
          const __want = tab.index();
          if (tab_window.activeTabIndex() !== __want) { tab_window.activeTabIndex = __want; __switched = true; }
        } else if (tab_kind === 'safari') {
          const __want = tab.index();
          if (tab_window.currentTab().index() !== __want) { tab_window.currentTab = tab; __switched = true; }
        }
      } catch (e) {}
      if (__switched) delay(0.15);
    `}
    ${raise ? "delay(0.25);" : ""}
    // Geometry source varies by browser: Chrome has position()+size(), Safari has bounds(),
    // Arc has neither, so fall back to System Events accessibility frame.
    let geom = null;
    try { const p = tab_window.position(), s = tab_window.size(); geom = {x: p[0], y: p[1], w: s[0], h: s[1]}; } catch (e) {}
    if (!geom) { try { const b = tab_window.bounds(); geom = {x: b.x, y: b.y, w: b.width, h: b.height}; } catch (e) {} }
    if (!geom) {
      try {
        const proc = Application('System Events').processes.byName(tab_app);
        const win = proc.windows[0];
        const p = win.position(), s = win.size();
        geom = {x: p[0], y: p[1], w: s[0], h: s[1]};
      } catch (e) {}
    }
    if (!geom) throw new Error('cannot get window geometry for ' + tab_app);
    // Look up the CGWindowID so 'screencapture -l' can read pixels regardless of z-order,
    // capturing obscured windows without raising them. (Doesn't help with background tabs
    // in the same window: only the active tab is rendered to the window's pixel buffer.)
    // Match by owner + bounds, with a 2px tolerance for off-by-one between AppleScript and
    // CG coordinate systems.
    let cgId = null;
    try {
      ObjC.import('CoreGraphics');
      // kCGWindowListOptionOnScreenOnly (1) | kCGWindowListExcludeDesktopElements (16) = 17
      const list = $.CGWindowListCopyWindowInfo(17, 0);
      const n = list.count;
      for (let i = 0; i < n; i++) {
        const entry = list.objectAtIndex(i);
        const owner = ObjC.unwrap(entry.objectForKey('kCGWindowOwnerName'));
        if (owner !== tab_app) continue;
        const b = entry.objectForKey('kCGWindowBounds');
        if (!b) continue;
        const bx = ObjC.unwrap(b.objectForKey('X'));
        const by = ObjC.unwrap(b.objectForKey('Y'));
        const bw = ObjC.unwrap(b.objectForKey('Width'));
        const bh = ObjC.unwrap(b.objectForKey('Height'));
        if (Math.abs(bx - geom.x) <= 2 && Math.abs(by - geom.y) <= 2 &&
            Math.abs(bw - geom.w) <= 2 && Math.abs(bh - geom.h) <= 2) {
          cgId = ObjC.unwrap(entry.objectForKey('kCGWindowNumber'));
          break;
        }
      }
    } catch (e) {}
    JSON.stringify({ geom, cgId });
  `;
  const { geom, cgId } = JSON.parse(await jxa(src));
  const tmp = `/tmp/perch-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  if (cgId != null) {
    await exec("screencapture", ["-l", String(cgId), "-x", "-o", tmp]);
  } else {
    // No CGWindowID match (minimized, on another Space, ObjC bridge failed). Fall back to
    // rect capture, which is only reliable if the window happens to be on top.
    await exec("screencapture", ["-R", `${geom.x},${geom.y},${geom.w},${geom.h}`, "-x", "-o", tmp]);
  }
  const buf = await readFile(tmp);
  await unlink(tmp).catch(() => {});
  return { __image: true, data: buf.toString("base64"), mimeType: "image/png" };
}

async function getPageInfo(target) {
  return evalJs(`
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      scroll: { x: window.scrollX, y: window.scrollY },
      doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      meta: (function() {
        const out = {};
        document.querySelectorAll('meta').forEach(m => {
          const k = m.getAttribute('name') || m.getAttribute('property');
          if (k && !(k in out)) out[k] = m.getAttribute('content');
        });
        return out;
      })()
    };
  `, target);
}

async function getText(selector, target) {
  return evalJs(`
    const el = document.querySelector(${JSON.stringify(selector || "body")});
    return el ? el.innerText : null;
  `, target);
}

async function getHtml(selector, target) {
  return evalJs(`
    const el = document.querySelector(${JSON.stringify(selector || "html")});
    return el ? el.outerHTML : null;
  `, target);
}

async function notify(args = {}) {
  const { message, title = "perch", subtitle, sound = "Glass" } = args;
  const opts = { withTitle: title };
  if (subtitle) opts.subtitle = subtitle;
  if (sound) opts.soundName = sound;
  await jxa(`
    const app = Application.currentApplication();
    app.includeStandardAdditions = true;
    app.displayNotification(${JSON.stringify(message)}, ${JSON.stringify(opts)});
    'ok';
  `);
  return { ok: true };
}

async function openDevtools(args = {}) {
  const { panel, target } = args;
  // Cmd+Opt+I toggles DevTools / Web Inspector on Chrome family, Arc, and Safari.
  // Cmd+Opt+J / Cmd+Opt+C jump to Console / Elements on Chrome-family (and Arc);
  // Safari's Web Inspector uses Cmd+Shift+1..N for panels — too brittle to expose,
  // so `panel` is silently ignored on Safari.
  let key = "i";
  if (panel === "console") key = "j";
  else if (panel === "elements") key = "c";
  const src = `
    ${targetClause(target)}
    ${focusTabFragment()}
    delay(0.15);
    Application('System Events').keystroke(${JSON.stringify(key)}, {using: ['command down', 'option down']});
    'ok';
  `;
  await jxa(src);
  return { ok: true };
}

const MIME_BY_EXT = {
  pdf:  "application/pdf",
  doc:  "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt:  "text/plain",
  rtf:  "application/rtf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pages: "application/x-iwork-pages-sffpages",
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
};

async function readUserFile(p, encoding) {
  const abs = p.startsWith("~")
    ? resolvePath(homedir(), p.slice(p.startsWith("~/") ? 2 : 1))
    : resolvePath(p);
  try { return { abs, data: await readFile(abs, encoding) }; }
  catch (e) { throw new Error(`cannot read ${abs}: ${e.message}`); }
}

async function fileUpload(args = {}) {
  const { selector = "input[type=file]", path, target } = args;
  if (!path) throw new Error("file_upload requires `path`");

  const { abs, data: bytes } = await readUserFile(path);
  const b64 = bytes.toString("base64");
  const filename = abs.split("/").pop();
  const mime = MIME_BY_EXT[filename.split(".").pop().toLowerCase()] || "application/octet-stream";

  // CSS-hidden inputs reject .files assignment, so promote to visible via inline !important then restore.
  const script = `
    const b64 = ${JSON.stringify(b64)};
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], ${JSON.stringify(filename)}, { type: ${JSON.stringify(mime)} });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return { ok: false, error: 'no input matching ' + ${JSON.stringify(selector)} };
    const orig = { display: input.style.display, visibility: input.style.visibility, hidden: input.hidden };
    if (input.hidden) input.hidden = false;
    input.style.setProperty('display', 'block', 'important');
    input.style.setProperty('visibility', 'visible', 'important');
    input.files = dt.files;
    ['change', 'input', 'blur'].forEach(t => input.dispatchEvent(new Event(t, { bubbles: true })));
    setTimeout(() => {
      input.hidden = orig.hidden;
      input.style.display = orig.display;
      input.style.visibility = orig.visibility;
    }, 150);
    return {
      ok: input.files && input.files.length === 1,
      name: file.name,
      size: file.size,
      type: file.type,
    };
  `;
  return await evalJs(script, target);
}

async function textInput(args = {}) {
  const { selector, label_pattern, text, text_path, target } = args;
  if (!text && !text_path) throw new Error("text_input requires `text` or `text_path`");
  if (text && text_path) throw new Error("text_input: pass `text` OR `text_path`, not both");

  let body = text;
  if (text_path) ({ data: body } = await readUserFile(text_path, "utf8"));
  if (!body || !body.trim()) throw new Error("text_input: empty body");

  const script = `
    const text = ${JSON.stringify(body)};
    const labelRe = ${label_pattern ? `new RegExp(${JSON.stringify(label_pattern)}, 'i')` : "null"};
    const selector = ${selector ? JSON.stringify(selector) : "null"};
    const MIN_RATIO = 0.9;
    const minLen = Math.max(50, Math.floor(text.trim().length * MIN_RATIO));

    function setPlain(el) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      ['input', 'change', 'blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
      return (el.value || '').trim().length >= minLen;
    }
    function setRich(root) {
      root.focus();
      root.innerHTML = text.split(/\\n\\n+/).map(p => '<p>' + p.replace(/\\n/g, '<br>') + '</p>').join('');
      ['input', 'change', 'blur'].forEach(t => root.dispatchEvent(new InputEvent(t, { bubbles: true, inputType: 'insertText', data: text })));
      return (root.innerText || root.textContent || '').trim().length >= minLen;
    }
    function isRich(el) {
      return el && (el.isContentEditable || el.classList?.contains('fr-element') || el.classList?.contains('ql-editor') || el.classList?.contains('ProseMirror'));
    }

    if (selector) {
      const el = document.querySelector(selector);
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
        if (setPlain(el)) return { ok: true, kind: 'plain_selector', len: el.value.length };
      }
      if (isRich(el)) {
        if (setRich(el)) return { ok: true, kind: 'rich_selector', len: (el.innerText || '').length };
      }
    }

    if (labelRe) {
      const labelOf = (el) => (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.placeholder || el.name || '').trim();
      const ta = Array.from(document.querySelectorAll('textarea')).find(el => labelRe.test(labelOf(el)));
      if (ta && setPlain(ta)) return { ok: true, kind: 'plain_label', len: ta.value.length };

      // iframe editors (TinyMCE) expose their root via contentDocument, not the iframe element itself.
      const editors = Array.from(document.querySelectorAll('[contenteditable=true], .fr-element, .ql-editor, .ProseMirror, .tox-edit-area iframe'));
      for (const ed of editors) {
        const root = ed.tagName === 'IFRAME' ? (ed.contentDocument && ed.contentDocument.body) : ed;
        if (!root) continue;
        // Walk up to a labeled wrapper so we don't drop the text into the wrong contenteditable.
        let scope = ed;
        for (let i = 0; i < 6 && scope; i++) {
          if (labelRe.test(scope.textContent || '')) break;
          scope = scope.parentElement;
        }
        if (!scope || !labelRe.test(scope.textContent || '')) continue;
        if (setRich(root)) return { ok: true, kind: 'rich_label', host: ed.className || ed.tagName, len: (root.innerText || '').length };
      }
    }

    return { ok: false, error: 'no fillable field matched', tried: { selector: !!selector, label: !!labelRe } };
  `;
  return await evalJs(script, target);
}

// ---- MCP plumbing ----

const TARGET_SCHEMA = {
  type: "object",
  description: "Optional. Defaults to the active tab of the frontmost browser.",
  properties: {
    app: { type: "string", description: "App name, e.g. 'Google Chrome', 'Safari', 'Arc'." },
    windowId: { type: ["string", "number"], description: "Window id as returned by list_tabs." },
    tabIndex: { type: "number", description: "0-based tab index within the window." },
  },
};

const TOOLS = [
  {
    name: "list_tabs",
    description: "List open tabs across running macOS browsers (Chrome family + Safari). `active: true` marks the active tab of the frontmost browser's front window.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "new_tab",
    description: "Open a new tab in the named browser. Launches the app if it isn't running.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional. Defaults to about:blank." },
        app: { type: "string", description: "Optional. Defaults to Google Chrome." },
      },
    },
  },
  {
    name: "close_tab",
    description: "Close the target tab. Falls back to focus + Cmd+W if the native close verb fails (Safari sometimes).",
    inputSchema: { type: "object", properties: { target: TARGET_SCHEMA } },
  },
  {
    name: "activate_tab",
    description: "Bring the target tab and its window to the foreground.",
    inputSchema: { type: "object", properties: { target: TARGET_SCHEMA } },
  },
  {
    name: "navigate",
    description: "Navigate the target tab to a URL. Waits for document.readyState to reach 'complete' by default.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        wait: { type: "boolean", description: "Wait for load. Default true." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "reload",
    description: "Reload the target tab.",
    inputSchema: { type: "object", properties: { target: TARGET_SCHEMA } },
  },
  {
    name: "go_back",
    description: "Navigate the target tab back in history.",
    inputSchema: { type: "object", properties: { target: TARGET_SCHEMA } },
  },
  {
    name: "go_forward",
    description: "Navigate the target tab forward in history.",
    inputSchema: { type: "object", properties: { target: TARGET_SCHEMA } },
  },
  {
    name: "eval_js",
    description: "Run JavaScript in the target tab. Your code runs inside an IIFE — use `return` to send a value back. The value is JSON-stringified on the page side and parsed here. Pass `awaitPromise: true` for async user code — perch wraps it in `await (async () => { ... })()`, stashes the result on the page, and polls until it lands. Requires the browser's 'Allow JavaScript from Apple Events' toggle.",
    inputSchema: {
      type: "object",
      required: ["script"],
      properties: {
        script: { type: "string", description: "Use `return <value>` to send a value back. With `awaitPromise: true`, you can use `await` freely." },
        awaitPromise: { type: "boolean", description: "Treat the script as async; wait for its Promise to resolve before returning. Default false." },
        timeout: { type: "number", description: "Async timeout in milliseconds (only with `awaitPromise`). Default 30000." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "wait_for",
    description: "Wait until the target tab matches a condition. Three modes: readyState/selector (returns {ok, waited}); or `expression` mode where a JS expression is polled and its truthy value is returned as {ok, waited, value}. Use expression mode for hands-free agent loops, e.g. `expression: \"window.__avis.summary().filter(a=>!a.status).length ? window.__avis.summary() : null\"`. Polls inside a single osascript call.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector that must exist." },
        readyState: { type: "string", enum: ["loading", "interactive", "complete"], description: "Minimum readyState. Default 'complete'." },
        expression: { type: "string", description: "JS expression. When the value is non-null and non-false, it's returned in the response's `value` field. Mutually exclusive with selector/readyState." },
        timeout: { type: "number", description: "Milliseconds. Default 10000." },
        interval: { type: "number", description: "Poll interval ms. Default 150." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "screenshot",
    description: "Capture a PNG of the target browser window. Defaults to CGWindowID capture, reading the window's pixels regardless of z-order so a window obscured by other apps captures without stealing focus. If `tabIndex` targets a non-active tab, perch silently switches the window to that tab first (Chrome/Safari; Arc no-ops) so the right pixels render. No app activation, no window raise. Pass `raise: true` to bring the window forward.",
    inputSchema: {
      type: "object",
      properties: {
        raise: { type: "boolean", description: "Bring window to front before capture. Default false (focus-preserving)." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "get_page_info",
    description: "Return URL, title, readyState, viewport, scroll, document size, and meta tags for the target tab.",
    inputSchema: { type: "object", properties: { target: TARGET_SCHEMA } },
  },
  {
    name: "get_text",
    description: "Return the innerText of an element (default: body) in the target tab.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector. Default 'body'." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "get_html",
    description: "Return the outerHTML of an element (default: <html>) in the target tab.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector. Default 'html'." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "notify",
    description: "Display a macOS notification (appears in Notification Center). Useful for pinging the user when a long-running task finishes — agent has no other channel to interrupt. Fire-and-forget: no action buttons, no click handler, no return signal. Notification shows as coming from 'Script Editor' (osascript limitation, not fixable). Default sound 'Glass'.",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        message:  { type: "string", description: "Body text." },
        title:    { type: "string", description: "Default 'perch'." },
        subtitle: { type: "string", description: "Optional subtitle line." },
        sound: {
          type: "string",
          enum: ["Basso","Blow","Bottle","Frog","Funk","Glass","Hero","Morse","Ping","Pop","Purr","Sosumi","Submarine","Tink"],
          description: "System sound. Default 'Glass'.",
        },
      },
    },
  },
  {
    name: "open_devtools",
    description: "Toggle DevTools / Web Inspector for the target tab via Cmd+Opt+I. Focus-stealer: activates the app and raises the target window/tab first so the keystroke lands. Optional `panel` jumps to Console or Elements on Chrome-family/Arc; ignored on Safari.",
    inputSchema: {
      type: "object",
      properties: {
        panel: { type: "string", enum: ["console", "elements"], description: "Chrome/Arc only. Omit to toggle the last-used panel." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "file_upload",
    description: "Upload a file to an `<input type=file>` in the target tab WITHOUT shipping the file bytes through the agent context. Perch reads the file from disk, base64-encodes it server-side, and runs a DataTransfer assignment in the page via eval_js. Focus-independent: works on background tabs, never activates the browser, never steals focus from whatever you're doing. Agent only sends `{path, selector?, target?}` (~200 bytes) in the tool call. Returns `{ok, name, size, type}` on success. On `{ok: false}`, fall back to your manual-attach hand-off — don't retry, the failure is usually a non-standard upload widget that doesn't expose a plain `<input type=file>`.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path or `~/...` to the file to upload. Resolved against $HOME before keystroking into the dialog." },
        selector: { type: "string", description: "CSS selector for the file input. Default 'input[type=file]'." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "text_input",
    description: "Fill a text field — plain `<textarea>`/`<input>` OR a rich-text editor (Froala, Quill, TinyMCE, ProseMirror, generic contenteditable). Tries plain first, falls back to detecting and assigning into the editor's content root with a synthetic InputEvent, then verifies the value landed (≥90% of input length). Pass `text_path` instead of `text` for long bodies (cover letters, essays) — perch reads from disk so the body stays out of the agent's tool args on retries. Returns `{ok, kind, len}` on success or `{ok: false, error}` if nothing matched. Provide `selector` for a direct hit, or `label_pattern` (regex string) to find by associated label / aria-label / placeholder / name.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to fill in. Mutually exclusive with `text_path`." },
        text_path: { type: "string", description: "Path to a file containing the text. Mutually exclusive with `text`. Use this for cover letters / long answers." },
        selector: { type: "string", description: "Optional CSS selector for the target field. If both given, `selector` is tried before `label_pattern`." },
        label_pattern: { type: "string", description: "Optional regex (case-insensitive) matched against label / aria-label / placeholder / name. Example: 'cover letter|carta de motivaci[oó]n'." },
        target: TARGET_SCHEMA,
      },
    },
  },
];

const server = new Server(
  { name: "perch", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    switch (name) {
      case "list_tabs":     result = await listTabs(); break;
      case "new_tab":       result = await newTab(args.url, args.app); break;
      case "close_tab":     result = await closeTab(args.target); break;
      case "activate_tab":  result = await activateTab(args.target); break;
      case "navigate":      result = await navigate(args.url, args.target, args.wait !== false); break;
      case "reload":        result = await reload(args.target); break;
      case "go_back":       result = await goBack(args.target); break;
      case "go_forward":    result = await goForward(args.target); break;
      case "eval_js":       result = await evalJs(args.script, args.target, { awaitPromise: args.awaitPromise, timeout: args.timeout }); break;
      case "wait_for":      result = await waitFor(args, args.target); break;
      case "screenshot":    result = await screenshot(args); break;
      case "get_page_info": result = await getPageInfo(args.target); break;
      case "get_text":      result = await getText(args.selector, args.target); break;
      case "get_html":      result = await getHtml(args.selector, args.target); break;
      case "open_devtools": result = await openDevtools(args); break;
      case "notify":        result = await notify(args); break;
      case "file_upload":   result = await fileUpload(args); break;
      case "text_input":    result = await textInput(args); break;
      default: throw new Error(`unknown tool: ${name}`);
    }
    if (result && result.__image) {
      return { content: [{ type: "image", data: result.data, mimeType: result.mimeType }] };
    }
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
