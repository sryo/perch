#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile, spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ---- JXA runtime ----
//
// Everything that runs inside osascript lives in this one function. Its source
// (not a template) is shipped once per daemon as the prelude, so each tool call
// sends only `__perch.<fn>(<json args>)`. It must stay self-contained (no Node
// scope) and ES2019; test/runtime.test.mjs runs it under node:vm with a fake
// JXA world and compiles it with real osascript.
//
// JXA access rules (see AGENTS.md): collections are read lazily (`windows[i]`,
// never `windows()`), multi-tab reads use bulk property access (`tabs.url()`).
function jxaRuntime(BROWSERS) {
  ObjC.import("CoreGraphics");
  const KIND = {};
  BROWSERS.forEach((b) => { KIND[b.app] = b.kind; });
  const apps = {};
  const app = (name) => apps[name] || (apps[name] = Application(name));

  // One CGWindowList read replaces System Events: z-order of on-screen browsers,
  // the frontmost app, pids and CGWindowIDs. ~4ms vs ~60ms for a System Events
  // `frontmost` query, and it needs no extra permission.
  function procs() {
    const out = { front: null, z: [], pid: {}, wins: {} };
    let list = [];
    try { list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || []; } catch (e) {}
    for (const w of list) {
      const b = w.kCGWindowBounds || {};
      if (w.kCGWindowLayer !== 0 || b.Width < 100 || b.Height < 100) continue;
      const owner = w.kCGWindowOwnerName;
      if (out.front === null) out.front = owner;
      if (!KIND[owner]) continue;
      if (!out.wins[owner]) { out.z.push(owner); out.pid[owner] = w.kCGWindowOwnerPID; out.wins[owner] = []; }
      out.wins[owner].push({ wid: w.kCGWindowNumber, x: b.X, y: b.Y, w: b.Width, h: b.Height });
    }
    return out;
  }

  // Browsers on screen first (topmost first), then the rest in declared order.
  function candidates(P, onlyApp) {
    const names = P.z.concat(BROWSERS.map((b) => b.app).filter((n) => P.z.indexOf(n) < 0));
    return names.filter((n) => {
      if (onlyApp && n !== onlyApp) return false;
      if (P.z.indexOf(n) >= 0) return true;
      try { return app(n).running(); } catch (e) { return false; }
    });
  }

  function activeIndex(kind, win, tabs) {
    try {
      if (kind === "chrome") return win.activeTabIndex() - 1;
      // Arc: activeTabIndex()/currentTab throw; activeTab's UUID is the only signal.
      if (kind === "arc") return Math.max(0, tabs.id().indexOf(win.activeTab.id()));
      return Math.max(0, tabs.index().indexOf(win.currentTab().index()));
    } catch (e) { return 0; }
  }

  function resolve(want) {
    want = want || {};
    const P = procs();
    for (const name of candidates(P, want.app)) {
      const a = app(name), kind = KIND[name];
      let n;
      try { n = a.windows.length; } catch (e) { continue; }
      for (let w = 0; w < n; w++) {
        const win = a.windows[w];
        if (want.windowId != null) {
          let id; try { id = win.id(); } catch (e) { id = w; }
          if (String(id) !== String(want.windowId)) continue;
        }
        let tabs;
        try { tabs = win.tabs; if (!tabs.length) continue; } catch (e) { continue; }
        const idx = want.tabIndex != null ? want.tabIndex : activeIndex(kind, win, tabs);
        if (idx < 0 || idx >= tabs.length) {
          if (want.tabIndex != null) throw new Error("tabIndex " + want.tabIndex + " out of range; window has " + tabs.length + " tabs");
          continue;
        }
        return { tab: tabs[idx], kind, app: name, win, P };
      }
    }
    throw new Error(want.app && !KIND[want.app] ? "unknown browser " + want.app : "no matching tab");
  }

  function isActive(t) {
    try {
      if (t.kind === "chrome") return t.win.activeTabIndex() === t.tab.index();
      if (t.kind === "arc") return t.tab.id() === t.win.activeTab.id();
      return t.win.currentTab().index() === t.tab.index();
    } catch (e) { return false; }
  }

  // Switches the window's visible tab without raising the window or the app.
  function selectTab(t) {
    if (isActive(t)) return false;
    try {
      if (t.kind === "chrome") t.win.activeTabIndex = t.tab.index();
      // Arc forbids writing activeTab/currentTab; its `select` verb works.
      else if (t.kind === "arc") t.tab.select();
      else t.win.currentTab = t.tab;
    } catch (e) { return false; }
    return true;
  }

  function focus(t) {
    try { t.win.index = 1; } catch (e) {}
    selectTab(t);
    app(t.app).activate();
  }

  // Arc's execute hangs (until timeout) on background tabs; refuse up front.
  function arcGuard(t, tool) {
    if (t.kind === "arc" && !isActive(t)) throw new Error("Arc cannot " + tool + " on background tabs; activate_tab first.");
  }

  function exec(t, js) {
    if (t.kind === "safari") return app(t.app).doJavaScript(js, { in: t.tab });
    const x = t.tab.execute({ javascript: js });
    // Arc JSON.stringifies whatever execute returns; perch's wrappers already did.
    if (t.kind === "arc") { try { return JSON.parse(x); } catch (e) { return x; } }
    return x;
  }

  // Re-runs `js` (which returns a JSON string) until it yields non-null/non-false.
  function poll(t, js, timeout, interval) {
    const start = Date.now();
    for (;;) {
      let v = null;
      try { const r = exec(t, js); if (r != null && r !== "") v = JSON.parse(String(r)); } catch (e) {}
      if (v !== null && v !== false) return { value: v, waited: Date.now() - start };
      if (Date.now() - start >= timeout) return null;
      delay(interval / 1000);
    }
  }

  const stripHash = (u) => String(u).split("#")[0];

  globalThis.__perch = {
    listTabs(a) {
      const P = procs();
      const out = [];
      const names = candidates(P, a.app);
      for (const name of names) {
        const ap = app(name), kind = KIND[name];
        let n;
        try { n = ap.windows.length; } catch (e) { continue; }
        for (let w = 0; w < n; w++) {
          const win = ap.windows[w];
          let id; try { id = win.id(); } catch (e) { id = w; }
          let urls, titles = [];
          try { urls = win.tabs.url(); } catch (e) { continue; }
          try { titles = kind === "safari" ? win.tabs.name() : win.tabs.title(); } catch (e) {}
          // `active` is reported for the topmost browser's front window only.
          const act = w === 0 && name === names[0] && P.z[0] === name ? activeIndex(kind, win, win.tabs) : -1;
          for (let i = 0; i < urls.length; i++) {
            const row = { app: name, windowId: id, tabIndex: i, url: urls[i] || "", title: titles[i] || "" };
            if (i === act) row.active = true;
            out.push(row);
          }
        }
      }
      return out;
    },
    evalJs(a) {
      const t = resolve(a.target);
      arcGuard(t, a.tool || "eval_js");
      return exec(t, a.js);
    },
    evalAsync(a) {
      const t = resolve(a.target);
      arcGuard(t, "eval_js");
      exec(t, a.kick);
      const r = poll(t, a.poll, a.timeout, 50);
      if (!r) throw new Error("eval_js (awaitPromise) timed out after " + a.timeout + "ms");
      return r.value;
    },
    wait(a) {
      const t = resolve(a.target);
      arcGuard(t, "wait");
      const r = poll(t, a.js, a.timeout, a.interval || 150);
      if (!r) throw new Error("wait timed out after " + a.timeout + "ms");
      return r;
    },
    // One round trip: stamp the current document, set the url, then wait until a
    // document without the stamp reports readyState 'complete'. Checking readyState
    // alone can read the OLD document's 'complete' right after the url is set.
    navigate(a) {
      const t = resolve(a.target);
      const canEval = t.kind !== "arc" || isActive(t);
      let sameDoc = false;
      try { const cur = t.tab.url(); sameDoc = String(a.url).indexOf("#") >= 0 && stripHash(cur) === stripHash(a.url); } catch (e) {}
      const token = "n" + Date.now() + Math.random().toString(36).slice(2, 6);
      if (canEval && !sameDoc) { try { exec(t, "window.__perch_nav=" + JSON.stringify(token) + ";'1'"); } catch (e) {} }
      // Safari only applies url on the document's current tab.
      if (t.kind === "safari") { try { t.win.currentTab = t.tab; } catch (e) {} }
      t.tab.url = a.url;
      if (!canEval || sameDoc) return { waited: false };
      const check = "(function(){try{return JSON.stringify(window.__perch_nav!==" + JSON.stringify(token) + "&&document.readyState==='complete')}catch(e){return 'false'}})()";
      const start = Date.now();
      let idle = 0;
      while (Date.now() - start < a.timeout) {
        let done = false;
        try { done = JSON.parse(String(exec(t, check))) === true; } catch (e) {}
        if (done) return { waited: true };
        // A download or 204 never replaces the document; Chrome's `loading` settles.
        if (t.kind !== "safari" && Date.now() - start > 300) {
          try { idle = t.tab.loading() ? 0 : idle + 1; } catch (e) {}
          if (idle >= 2) return { waited: true };
        }
        delay(0.1);
      }
      return { waited: false };
    },
    newTab(a) {
      const kind = KIND[a.app];
      const ap = app(a.app);
      if (!ap.running()) ap.activate();
      let win, newId = null;
      if (kind === "chrome" || kind === "arc") {
        if (!ap.windows.length) ap.Window().make();
        win = ap.windows[0];
        const tab = ap.Tab({ url: a.url });
        win.tabs.push(tab);
        try {
          if (kind === "arc") {
            try { newId = tab.id(); } catch (e) {}
            try { tab.select(); } catch (e) { win.tabs[win.tabs.length - 1].select(); }
          } else win.activeTabIndex = win.tabs.length;
        } catch (e) {}
      } else {
        // Safari: documents[0].tabs throws under JXA; windows[0].tabs works.
        if (!ap.windows.length) { try { ap.Document().make(); } catch (e) {} }
        win = ap.windows[0];
        let created = false;
        try { win.tabs.push(ap.Tab({ url: a.url })); created = true; } catch (e) {}
        try { win.currentTab = win.tabs[win.tabs.length - 1]; } catch (e) {}
        if (!created) {
          ap.activate();
          delay(0.1);
          Application("System Events").keystroke("t", { using: "command down" });
          delay(0.15);
          try { win.currentTab.url = a.url; } catch (e) {}
        }
      }
      let windowId = null; try { windowId = win.id(); } catch (e) {}
      // Arc inserts new tabs mid-collection (sidebar "Today"), so resolve by UUID.
      let tabIndex = null;
      try {
        if (kind === "arc" && newId != null) { const i = win.tabs.id().indexOf(newId); tabIndex = i >= 0 ? i : null; }
        else tabIndex = win.tabs.length - 1;
      } catch (e) {}
      return { windowId, tabIndex };
    },
    activate(a) {
      focus(resolve(a.target));
      return true;
    },
  };
}

export const JXA_PRELUDE = `(${jxaRuntime})(${JSON.stringify(BROWSERS)})`;

export const ERR = {
  jsOff: "JavaScript-from-AppleEvents is off. Enable it: Chromium-family → View > Developer > Allow JavaScript from Apple Events. " +
    "Safari → Settings > Advanced > Show Develop menu, then Develop > Allow JavaScript from Apple Events.",
  automation: "Automation permission denied. Grant it in System Settings > Privacy & Security > Automation, " +
    "ticking the target browser under the controlling app (Claude Code / Terminal / iTerm).",
  timeout: (ms) => `osascript timed out after ${ms}ms: target tab unreachable (stale tabIndex, hung page, or Arc background tab). Re-run list_tabs.`,
};

export function translatePermissionError(msg) {
  if (/Allow JavaScript from Apple Events|JavaScript through AppleScript is turned off|JavaScript from Apple events is turned off/i.test(msg)) return ERR.jsOff;
  if (/Not authorized to send Apple events|errAEEventNotPermitted|-1743/i.test(msg)) return ERR.automation;
  return null;
}

// One long-lived `osascript -i -l JavaScript` REPL per lane. A warm REPL runs a
// realistic script in ~25ms vs ~90ms cold, dominated by JXA bridge startup.
// Two lanes so a long `wait`/awaitPromise poll (slow) never blocks quick calls (fast).
//
// Framing: each script is URI-encoded (one ASCII line, no quotes, no newlines) and
// sent as `eval(decodeURIComponent("..."))` inside an IIFE that prints a result
// marker. encodeURIComponent always escapes `<`, `>` and `:`, so markers can't
// appear inside the payload.
//
// Failure policy: only a script that never reached stdin (`notSent`) may be retried
// one-shot. A timeout or mid-call exit may already have had side effects (a tab
// opened, a click posted), so it rejects without retry; the next call respawns.
//
// Disable with PERCH_DAEMON=0.
export class OsaDaemon {
  constructor({ spawn: spawnFn = spawn, prelude = "" } = {}) {
    this.spawnFn = spawnFn;
    this.prelude = prelude;
    this.proc = null;
    this.ready = null;
    this.queue = [];
    this.current = null;
  }
  run(script, timeout) {
    return new Promise((resolve, reject) => {
      this.queue.push({ script, timeout, resolve, reject });
      this._drain();
    });
  }
  kill() {
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    if (p) { try { p.kill("SIGKILL"); } catch {} }
  }
  _spawn() {
    let p;
    try { p = this.spawnFn("osascript", ["-i", "-l", "JavaScript"], { stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { return Promise.reject(e); }
    this.proc = p;
    // osascript's console.log goes to stderr; listen to both.
    p.stdout.on("data", (d) => this._onData(d.toString()));
    p.stderr.on("data", (d) => this._onData(d.toString()));
    p.stdin.on("error", () => this._onExit(p));
    p.on("exit", () => this._onExit(p));
    p.on("error", () => this._onExit(p));
    // Handshake instead of a fixed settle: the prelude (or a no-op) must round-trip first.
    return new Promise((resolve, reject) => this._send({ script: this.prelude + ";1", timeout: 10000, resolve, reject }));
  }
  async _drain() {
    if (this.current || this.queue.length === 0) return;
    if (!this.proc) this.ready = this._spawn();
    const ready = this.ready;
    try { await ready; }
    catch (e) {
      if (this.ready === ready) this.kill();
      const err = Object.assign(new Error("osascript failed to start: " + (e.message || e)), { notSent: true });
      while (this.queue.length) this.queue.shift().reject(err);
      return;
    }
    if (this.current || this.queue.length === 0) return;
    this._send(this.queue.shift());
  }
  _send(c) {
    const id = Math.random().toString(36).slice(2, 10);
    const job = {
      ...c, prefix: `<<P:${id}:`, buffer: "", start: -1, scan: 0,
      timer: setTimeout(() => {
        if (this.current !== job) return;
        this.current = null;
        this.kill();
        job.reject(new Error(ERR.timeout(c.timeout)));
        this._drain();
      }, c.timeout),
    };
    this.current = job;
    const line =
      `(function(){var __r;try{__r=eval(decodeURIComponent("${encodeURIComponent(c.script)}"))}` +
      `catch(e){console.log("<<P:${id}:E:"+encodeURIComponent((e&&e.message)?e.message:String(e))+">>");return}` +
      `var __s=__r===undefined||__r===null?"":(typeof __r==="string"?__r:JSON.stringify(__r));` +
      `console.log("<<P:${id}:O:"+encodeURIComponent(__s)+">>")})();\n`;
    try { this.proc.stdin.write(line); }
    catch (e) {
      this.current = null;
      clearTimeout(job.timer);
      this.kill();
      job.reject(Object.assign(new Error("osascript stdin: " + (e.message || e)), { notSent: true }));
    }
  }
  _onData(s) {
    const c = this.current;
    if (!c) return;
    c.buffer += s;
    // Incremental scan: never rescan bytes already searched.
    if (c.start < 0) {
      const i = c.buffer.indexOf(c.prefix, c.scan);
      if (i < 0) { c.scan = Math.max(0, c.buffer.length - c.prefix.length); return; }
      c.start = i;
      c.scan = i + c.prefix.length + 2;
    }
    const end = c.buffer.indexOf(">>", c.scan);
    if (end < 0) { c.scan = Math.max(c.scan, c.buffer.length - 1); return; }
    this.current = null;
    clearTimeout(c.timer);
    const kind = c.buffer[c.start + c.prefix.length];
    const payload = decodeURIComponent(c.buffer.slice(c.start + c.prefix.length + 2, end));
    if (kind === "O") c.resolve(payload);
    else c.reject(new Error(payload));
    this._drain();
  }
  _onExit(p) {
    if (p !== this.proc && p !== undefined && this.proc !== null) return;
    this.proc = null;
    this.ready = null;
    const c = this.current;
    this.current = null;
    if (c) { clearTimeout(c.timer); c.reject(new Error("osascript exited mid-call")); }
    if (this.queue.length) this._drain();
  }
}

const JXA_DEFAULT_TIMEOUT = 30000;
// Tools that poll inside one call (wait, awaitPromise) pass their own timeout plus
// this margin so the outer kill never races the inner loop.
const JXA_OVERHEAD = 5000;

export const DAEMONS = process.env.PERCH_DAEMON === "0" ? {} : {
  fast: new OsaDaemon({ prelude: JXA_PRELUDE }),
  slow: new OsaDaemon({ prelude: JXA_PRELUDE }),
};

export async function jxa(script, { timeout = JXA_DEFAULT_TIMEOUT, lane = "fast", daemons = DAEMONS, oneShot = jxaOneShot } = {}) {
  const d = daemons[lane] || daemons.fast;
  if (d) {
    try { return await d.run(script, timeout); }
    catch (e) {
      if (!e.notSent) throw new Error(translatePermissionError(e.message) || e.message);
    }
  }
  return oneShot(script, { timeout });
}

export function formatOsaFailure(e, timeout) {
  if (e.killed) return ERR.timeout(timeout);
  const msg = String(e.stderr || e.message || e).trim();
  const translated = translatePermissionError(msg);
  if (translated) return translated;
  if (e.code === 1 && !msg) return ERR.automation;
  // "execution error: Error: <msg> (-2700)" → "<msg>"
  return msg.replace(/^.*?execution error: (?:Error: )?/s, "").replace(/ \(-?\d+\)$/, "");
}

async function jxaOneShot(script, { timeout = JXA_DEFAULT_TIMEOUT } = {}) {
  try {
    const { stdout } = await exec("osascript", ["-l", "JavaScript", "-e", JXA_PRELUDE + ";\n" + script], { maxBuffer: 32 << 20, timeout });
    return stdout.replace(/\n$/, "");
  } catch (e) {
    throw new Error(formatOsaFailure(e, timeout));
  }
}

// Calls a runtime entry. `raw` returns the entry's string result untouched
// (page JSON from eval); otherwise the result is JSON round-tripped.
async function rt(fn, args, { raw = false, lane, timeout } = {}) {
  const call = `__perch.${fn}(${JSON.stringify(args)})`;
  const out = await jxa(raw ? call : `JSON.stringify(${call})`, { lane, timeout });
  return raw ? out : JSON.parse(out);
}

const FRONTMOST = `
  let fm = '';
  try { fm = Application('System Events').applicationProcesses.whose({frontmost: true})[0].name(); } catch (e) {}
`;

// Assumes targetClause bindings in scope. Arc's activeTabIndex()/currentTab both throw;
// the activeTab UUID match is the only working activeness signal.
const ARC_TAB_IS_ACTIVE = `tab.id() === tab_window.activeTab.id()`;

function arcActiveTabGuardJxa(toolName) {
  return `
    if (tab_kind === 'arc') {
      let __arcActive = false;
      try { __arcActive = ${ARC_TAB_IS_ACTIVE}; } catch (e) {}
      if (!__arcActive) throw new Error("Arc cannot ${toolName} on background tabs; call activate_tab on this target first, or operate on Arc's active tab.");
    }
  `;
}

// Runs the page JS held in JXA-side variable `jsVar` in the target tab and binds the
// bridge's return value to `resultVar`. Assumes targetClause bindings in scope.
// Arc auto-JSON.stringifies execute() returns, so its branch unwraps one layer.
function execTabJsFragment(resultVar, jsVar) {
  return `
    let ${resultVar};
    if (tab_kind === 'safari') ${resultVar} = Application(tab_app).doJavaScript(${jsVar}, { in: tab });
    else if (tab_kind === 'arc') {
      const __x = tab.execute({javascript: ${jsVar}});
      try { ${resultVar} = JSON.parse(__x); } catch (e) { ${resultVar} = __x; }
    }
    else ${resultVar} = tab.execute({javascript: ${jsVar}});
  `;
}

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
        // Once a candidate is locked in, only the frontmost browser can replace it.
        if (chosen && b.app !== fm) continue;
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
          } else if (b.kind === 'arc') {
            try { idx = Math.max(0, tabs.id().indexOf(win.activeTab.id())); } catch (e) { idx = 0; }
          } else {
            try { idx = Math.max(0, tabs.index().indexOf(win.currentTab().index())); } catch (e) { idx = 0; }
          }
          if (idx < 0 || idx >= tabs.length) {
            if (want.tabIndex != null) {
              throw new Error('tabIndex ' + want.tabIndex + ' out of range; window has ' + tabs.length + ' tabs');
            }
            continue;
          }
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
        } else if (tab_kind === 'arc') {
          // Arc forbids writing activeTab/currentTab, but the dictionary's select verb works.
          tab.select();
        } else {
          tab_window.currentTab = tab;
        }
      } catch (e) {}
      app.activate();
    }
  `;
}

// Page-side error shape, shared by the sync wrapper and the async kickoff.
const ERROR_SHAPE = `function(e){return {__perch_error:(e&&e.message)?e.message:String(e),__perch_error_name:(e&&e.name)||'Error',__perch_error_stack_head:(e&&e.stack)?String(e.stack).split('\\n').slice(0,2).join(' | ').slice(0,300):null}}`;

// The newline before `})` keeps a trailing `// comment` in user code from eating the wrapper.
export function buildEvalWrapper(js) {
  return `(function(){var __E=${ERROR_SHAPE};try{var __r=(function(){${js}\n})();return JSON.stringify(__r===undefined?null:__r)}catch(e){return JSON.stringify(__E(e))}})()`;
}

// AppleScript can't await, so async code stashes its outcome on window[key] and JXA polls it.
function buildAsyncKickoff(js, key) {
  const k = JSON.stringify(key);
  return `(function(){var __E=${ERROR_SHAPE};(async function(){try{var __r=await (async function(){${js}\n})();window[${k}]={value:__r===undefined?null:__r}}catch(e){window[${k}]=__E(e)}})();return "1"})()`;
}

function buildAsyncPoll(key) {
  const k = JSON.stringify(key);
  return `(function(){var v=window[${k}];if(v===undefined)return "null";delete window[${k}];return JSON.stringify(v)})()`;
}

const parsePage = (raw) => { if (raw === "") return null; try { return JSON.parse(raw); } catch { return raw; } };

// Returns a JXA fragment that binds `geom`, `pid`, and `windowNumber` in scope.
// Requires `tab`, `tab_kind`, `tab_app`, `tab_window` from a prior `targetClause(target)`.
// Geometry source varies by browser: Chrome has position()+size(), Safari has bounds(),
// Arc has neither, so we fall back to the System Events accessibility frame.
// `windowNumber` (CGWindowID) is needed by screencapture -l and by CGEvent's window
// addressing fields. Match by owner + bounds with a 2px tolerance for off-by-one
// between AppleScript and CG coordinate systems.
function resolveTargetIdsJxa() {
  return `
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

    let pid = null;
    try { pid = Application('System Events').processes.byName(tab_app).unixId(); } catch (e) {}

    let windowNumber = null, cgBounds = null;
    try {
      ObjC.import('CoreGraphics');
      // kCGWindowListOptionOnScreenOnly (1) | kCGWindowListExcludeDesktopElements (16) = 17.
      // Match by kCGWindowOwnerPID first (reliable across browser variants), then by bounds
      // (some browsers split a window into multiple CG entries — toolbars, popovers, the
      // actual content). Among the pid-matching entries, prefer the one whose bounds are
      // closest to the AppleScript geom. AppleScript Chrome reports inner-content bounds
      // while CG includes the titlebar, so an exact match is brittle.
      const list = $.CGWindowListCopyWindowInfo(17, 0);
      const n = list.count;
      let best = null, bestScore = Infinity, bestBounds = null;
      for (let i = 0; i < n; i++) {
        const entry = list.objectAtIndex(i);
        const entryPid = ObjC.unwrap(entry.objectForKey('kCGWindowOwnerPID'));
        const owner = ObjC.unwrap(entry.objectForKey('kCGWindowOwnerName'));
        if (pid != null ? entryPid !== pid : owner !== tab_app) continue;
        const b = entry.objectForKey('kCGWindowBounds');
        if (!b) continue;
        const bx = ObjC.unwrap(b.objectForKey('X'));
        const by = ObjC.unwrap(b.objectForKey('Y'));
        const bw = ObjC.unwrap(b.objectForKey('Width'));
        const bh = ObjC.unwrap(b.objectForKey('Height'));
        // Skip obvious non-content entries (chrome dropdowns are tiny, decorations are thin).
        if (bw < 200 || bh < 100) continue;
        const score = Math.abs(bx - geom.x) + Math.abs(by - geom.y) + Math.abs(bw - geom.w) + Math.abs(bh - geom.h);
        if (score < bestScore) {
          bestScore = score;
          best = ObjC.unwrap(entry.objectForKey('kCGWindowNumber'));
          bestBounds = { x: bx, y: by, w: bw, h: bh };
        }
      }
      if (best != null) { windowNumber = best; cgBounds = bestBounds; }
    } catch (e) {}
  `;
}

// Defines __postMouse for trusted-input CGEvent dispatch. Requires __pt (CGPoint),
// pid, and windowNumber in scope (resolveTargetIdsJxa + the caller's CGPointMake).
function postMouseFragmentJxa() {
  return `
      function __postMouse(evtType, pressure, state, mouseBtn) {
        const e = $.CGEventCreateMouseEvent($(), evtType, __pt, mouseBtn);
        $.CGEventSetIntegerValueField(e, 1, state);          // kCGMouseEventClickState
        $.CGEventSetDoubleValueField(e, 11, pressure);        // kCGMouseEventPressure
        $.CGEventSetIntegerValueField(e, 9, pid);             // kCGEventTargetUnixProcessID
        if (windowNumber != null) {
          $.CGEventSetIntegerValueField(e, 27, windowNumber); // kCGMouseEventWindowUnderMousePointer
          $.CGEventSetIntegerValueField(e, 28, windowNumber); // ...ThatCanHandleThisEvent
          $.CGEventSetIntegerValueField(e, 51, windowNumber); // private: target window
          $.CGEventSetIntegerValueField(e, 58, 1);            // private: routing flag
        }
        $.CGEventPostToPid(pid, e);
      }
  `;
}

// JXA fragment that throws if the controlling app lacks Accessibility permission.
// Used by every trusted-input dispatch (click {trusted:true}, fill {trusted:true}).
// kCFBooleanFalse suppresses the OS prompt — controlling apps may surface odd icons there.
function assertAccessibilityGrantedJxa() {
  return `
    ObjC.import('ApplicationServices');
    const __axOpts = $.NSDictionary.dictionaryWithObjectForKey($.kCFBooleanFalse, $.kAXTrustedCheckOptionPrompt);
    if (!$.AXIsProcessTrustedWithOptions(__axOpts)) {
      throw new Error("Accessibility permission required: System Settings > Privacy & Security > Accessibility, tick the controlling app (Claude Code / Terminal / iTerm). Then retry.");
    }
  `;
}

// ---- tools ----

export function shapeTabs(rows, { urlContains, titleContains, limit = 50 } = {}) {
  const has = (v, q) => v.toLowerCase().includes(String(q).toLowerCase());
  if (urlContains) rows = rows.filter((t) => has(t.url, urlContains));
  if (titleContains) rows = rows.filter((t) => has(t.title, titleContains));
  // tabIndex keeps each tab's real window position, so filtered rows stay addressable.
  return { tabs: rows.slice(0, Math.max(0, limit)), total: rows.length };
}

async function listTabs(args = {}) {
  return shapeTabs(await rt("listTabs", { app: args.app || null }), args);
}

async function evalJs(script, target, { awaitPromise = false, timeout = 30000, tool = "eval_js" } = {}) {
  if (!awaitPromise) return parsePage(await rt("evalJs", { target, js: buildEvalWrapper(script), tool }, { raw: true }));
  const key = `__perch_async_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const r = await rt("evalAsync", { target, kick: buildAsyncKickoff(script, key), poll: buildAsyncPoll(key), timeout },
    { lane: "slow", timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD });
  return r && Object.hasOwn(r, "value") ? r.value : r;
}

async function wait(args = {}) {
  const { selector, readyState = "complete", expression, timeout = 10000, target } = args;
  const js = expression
    ? `(function(){try{var __r=(${expression});return JSON.stringify(__r===undefined?null:__r)}catch(e){return "null"}})()`
    : buildEvalWrapper(pageScript("wait_check", { selector, readyState }));
  const r = await rt("wait", { target, js, timeout }, { lane: "slow", timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD });
  return expression ? { ok: true, waited: r.waited, value: r.value } : { ok: true, waited: r.waited };
}

const NAV_TIMEOUT = 15000;

async function navigate(url, target) {
  await rt("navigate", { target, url, timeout: NAV_TIMEOUT }, { lane: "slow", timeout: NAV_TIMEOUT + JXA_OVERHEAD });
  return { ok: true, url };
}

async function newTab(url, appName = "Google Chrome") {
  const browser = BROWSERS.find(b => b.app === appName);
  if (!browser) throw new Error(`unknown browser ${appName}; one of: ${BROWSERS.map(b => b.app).join(", ")}`);
  const targetUrl = url || "about:blank";
  const { windowId = null, tabIndex = null } = await rt("newTab", { app: browser.app, url: targetUrl });
  return { app: browser.app, windowId, tabIndex };
}

async function activateTab(target) {
  await rt("activate", { target });
  return { ok: true };
}

async function screenshot(args = {}) {
  const { raise = false, target, format = "png", maxWidth = 1568 } = args;
  const src = `
    ${targetClause(target)}
    ${raise ? focusTabFragment() : !(target && target.tabIndex != null) ? "" : `
      // An explicit tabIndex may target a non-active tab; silently switch the window to it
      // so the right tab renders. No app.activate(), no window raise; user's focus stays put.
      // Gated on explicit tabIndex: on the default path tab is the active tab by construction,
      // and switching there could act on a bad fallback if active-tab detection failed.
      let __switched = false;
      try {
        if (tab_kind === 'chrome') {
          const __want = tab.index();
          if (tab_window.activeTabIndex() !== __want) { tab_window.activeTabIndex = __want; __switched = true; }
        } else if (tab_kind === 'arc') {
          if (!(${ARC_TAB_IS_ACTIVE})) { tab.select(); __switched = true; }
        } else if (tab_kind === 'safari') {
          const __want = tab.index();
          if (tab_window.currentTab().index() !== __want) { tab_window.currentTab = tab; __switched = true; }
        }
      } catch (e) {}
      if (__switched) delay(0.15);
    `}
    ${raise ? "delay(0.25);" : ""}
    ${resolveTargetIdsJxa()}
    // screencapture -l reads the window's pixels regardless of z-order, capturing
    // obscured windows without raising them. (Doesn't help with background tabs in
    // the same window: only the active tab is rendered to the window's pixel buffer.)
    JSON.stringify({ geom, windowNumber, cgBounds });
  `;
  const { geom, windowNumber, cgBounds } = JSON.parse(await jxa(src));
  const tmp = `/tmp/perch-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  if (windowNumber != null) {
    await exec("screencapture", ["-l", String(windowNumber), "-x", "-o", tmp]);
  } else {
    // No CGWindowID match (minimized, on another Space, ObjC bridge failed). Fall back to
    // rect capture, which is only reliable if the window happens to be on top.
    await exec("screencapture", ["-R", `${geom.x},${geom.y},${geom.w},${geom.h}`, "-x", "-o", tmp]);
  }
  if (maxWidth > 0) {
    try {
      const { stdout } = await exec("sips", ["-g", "pixelWidth", tmp]);
      const m = /pixelWidth: (\d+)/.exec(stdout);
      if (m && Number(m[1]) > maxWidth) await exec("sips", ["--resampleWidth", String(maxWidth), tmp]);
    } catch (e) {} // downscale is best-effort; full-size capture still returns
  }
  let outPath = tmp, mime = "image/png";
  if (format === "jpeg") {
    const jpg = tmp.replace(/\.png$/, ".jpg");
    await exec("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", tmp, "--out", jpg]);
    outPath = jpg;
    mime = "image/jpeg";
  }
  // Final pixel dims (post-downscale/format) let callers map image -> screen
  // coordinates: screenX = window.x + imageX * (window.w / image.w).
  let imageDims = null;
  try {
    const { stdout } = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", outPath]);
    const w = /pixelWidth: (\d+)/.exec(stdout), h = /pixelHeight: (\d+)/.exec(stdout);
    if (w && h) imageDims = { w: Number(w[1]), h: Number(h[1]) };
  } catch (e) {}
  const buf = await readFile(outPath);
  await unlink(tmp).catch(() => {});
  if (outPath !== tmp) await unlink(outPath).catch(() => {});
  // The -l capture's pixels correspond to the CG window bounds (titlebar included),
  // not AppleScript's inner-content geom; report whichever rect was actually captured.
  const captureRect = windowNumber != null && cgBounds ? cgBounds : geom;
  return {
    __image: true,
    data: buf.toString("base64"),
    mimeType: mime,
    meta: imageDims ? { window: captureRect, image: imageDims } : undefined,
  };
}

// ---- page scripts ----
//
// Page code is plain strings (String.raw, no `${`): one shared prelude plus one
// body per tool. Tool arguments enter only through `const A = <json>`, so no
// user value is ever spliced into code. test/page.test.mjs runs every script
// in happy-dom through the same wrappers the bridge uses.
export const PAGE_PRELUDE = String.raw`
const INPUT_SKIP = ["hidden", "checkbox", "radio", "file", "submit", "button", "image", "reset", "range", "color"];
function attr(el, k) { return (el && el.getAttribute && el.getAttribute(k)) || ""; }
function clip(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; }
function textOf(n) { return n ? (n.innerText || n.textContent || "") : ""; }
// A <label>'s own words, without the text of the control(s) it wraps.
function labelWords(l) {
  const c = l.cloneNode(true);
  c.querySelectorAll("select, input, textarea, button").forEach(function (x) { x.remove(); });
  return c.textContent || "";
}
function editable(el) { return !!el && (el.isContentEditable === true || (!!el.hasAttribute && el.hasAttribute("contenteditable") && attr(el, "contenteditable") !== "false")); }
function vis(el) {
  if (!el || el.hidden) return false;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
  const r = el.getBoundingClientRect();
  return !(r.width === 0 && r.height === 0);
}
// Strong label sources, in accessible-name precedence order.
function labelText(el) {
  const ids = attr(el, "aria-labelledby");
  if (ids) {
    const t = ids.split(/\s+/).map(function (id) { return textOf(document.getElementById(id)); }).join(" ");
    if (t.trim()) return clip(t, 120);
  }
  const al = attr(el, "aria-label");
  if (al.trim()) return clip(al, 120);
  if (el.labels && el.labels[0] && labelWords(el.labels[0]).trim()) return clip(labelWords(el.labels[0]), 120);
  // Custom widgets aren't labelable; a wrapping <label> still names them.
  const wrap = !el.labels && el.closest && el.closest("label");
  return wrap ? clip(labelWords(wrap), 120) : "";
}
function hintText(el) { return attr(el, "placeholder") || attr(el, "name") || attr(el, "data-tooltip") || attr(el, "title"); }
function accName(el) {
  let s = labelText(el) || attr(el, "placeholder") || attr(el, "alt");
  if (!s && el.tagName === "INPUT" && /^(submit|button|reset)$/i.test(el.type)) s = el.value;
  // A <select>'s text is its options, not a name.
  if (!s && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) s = textOf(el);
  if (!s) s = attr(el, "title") || attr(el, "name");
  return clip(s, 120);
}
function role(el) {
  const ex = attr(el, "role");
  if (ex) return ex;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const t = (el.type || "text").toLowerCase();
    if (t === "checkbox" || t === "radio") return t;
    if (/^(submit|button|image|reset)$/.test(t)) return "button";
    if (t === "range") return "slider";
    return "textbox";
  }
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (editable(el)) return "textbox";
  return "generic";
}
function ident(el) { return role(el) + " " + JSON.stringify(accName(el)) + (vis(el) ? "" : " hidden"); }
// The prototype setter reaches React-controlled fields whose instance setter is patched.
function setNativeValue(el, v) {
  const P = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : el.tagName === "SELECT" ? HTMLSelectElement : HTMLInputElement;
  const d = Object.getOwnPropertyDescriptor(P.prototype, "value");
  if (d && d.set) d.set.call(el, v); else el.value = v;
}
function fire(el, types) { types.forEach(function (t) { el.dispatchEvent(new Event(t, { bubbles: true })); }); }
// -> {el} or {out}, where out is the tool's return value (ref miss or no match).
function resolveEl(a, dflt) {
  if (a.ref) {
    const el = (window.__perch_refs || {})[a.ref];
    return el && el.isConnected ? { el: el } : { out: { __perch_ref_miss: true, ref: String(a.ref) } };
  }
  const sel = a.selector || dflt;
  if (!sel) return { el: null };
  let el;
  try { el = document.querySelector(sel); } catch (e) { return { out: { ok: false, error: "bad selector: " + sel } }; }
  return el ? { el: el } : { out: { ok: false, error: "no element for selector " + sel } };
}
`;

export const PAGE_SCRIPTS = {
  get_text: String.raw`
const r = resolveEl(A, A.html ? "html" : "body");
if (r.out) return r.out;
const s = A.html ? r.el.outerHTML : textOf(r.el);
if (A.offset === 0 && s.length <= A.maxChars) return s;
return s.slice(A.offset, A.offset + A.maxChars) + "\n[truncated: chars " + A.offset + "-" + Math.min(A.offset + A.maxChars, s.length) + " of " + s.length + "; pass offset/maxChars for the rest]";
`,

  // Line format: "# {header json}", then "<ref> <role> <json name> key=<json>... flags".
  snapshot: String.raw`
const refs = {};
window.__perch_refs = refs;
const SEL = 'a[href], button, input:not([type=hidden]), textarea, select, [role], [tabindex]:not([tabindex="-1"]), h1, h2, h3, h4, h5, h6, [contenteditable]:not([contenteditable=false]), summary';
const roles = A.role == null ? null : [].concat(A.role);
const q = JSON.stringify;
const origin = location.origin;
const lines = [];
let n = 0, truncated = false;
for (const el of document.querySelectorAll(SEL)) {
  const r = role(el);
  if (roles && roles.indexOf(r) < 0) continue;
  if (!vis(el)) continue;
  if (n >= A.max) { truncated = true; break; }
  const ref = String(++n);
  refs[ref] = el;
  const tag = el.tagName;
  let line = ref + " " + r + " " + q(accName(el));
  const kv = function (k, v) { line += " " + k + "=" + q(v); };
  if (r === "heading") { const m = /^H([1-6])$/.exec(tag); kv("level", m ? Number(m[1]) : Number(attr(el, "aria-level")) || 0); }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && el.name) kv("name", el.name);
  if (tag === "INPUT") { const t = (el.type || "text").toLowerCase(); if (!/^(text|checkbox|radio|button|submit)$/.test(t)) kv("type", t); }
  else if (tag === "TEXTAREA") kv("type", "textarea");
  if (tag === "SELECT") {
    const o = [];
    for (const opt of el.options) { if (o.length >= 30) break; const t = clip(opt.text, 60); if (t && t !== "--") o.push(t); }
    if (o.length) kv("options", o);
    if (el.value) kv("value", el.value);
  } else if (r === "textbox" && el.value) kv("value", clip(el.value, 200));
  if (r === "link") {
    let h = el.href || "";
    if (h.indexOf(origin + "/") === 0) h = h.slice(origin.length);
    kv("href", h.length > 150 ? h.slice(0, 150) + "…" : h);
  }
  if (el.required || attr(el, "aria-required") === "true") line += " required";
  if (el.checked) line += " checked";
  if (el.disabled) line += " disabled";
  if (attr(el, "aria-expanded") === "true") line += " expanded";
  lines.push(line);
}
const head = { url: location.href, title: document.title, ready: document.readyState, count: n };
if (truncated) head.truncated = true;
const act = document.activeElement;
if (act && act !== document.body && act !== document.documentElement) {
  let fr = null;
  for (const k in refs) if (refs[k] === act) { fr = k; break; }
  head.focus = fr || ident(act);
}
const dialogs = Array.from(document.querySelectorAll("[role=dialog], [aria-modal=true], dialog[open]")).filter(vis).slice(0, 5).map(accName);
if (dialogs.length) head.dialogs = dialogs;
const forms = Array.from(document.querySelectorAll("form")).filter(vis);
if (forms.length) {
  const FIELDS = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
  let big = forms[0];
  forms.forEach(function (f) { if (f.querySelectorAll(FIELDS).length > big.querySelectorAll(FIELDS).length) big = f; });
  const fields = Array.from(big.querySelectorAll(FIELDS)).filter(function (el) { return !(el.tagName === "INPUT" && INPUT_SKIP.indexOf((el.type || "text").toLowerCase()) >= 0); });
  const requiredEmpty = fields.filter(function (el) { return (el.required || attr(el, "aria-required") === "true") && !String(el.value || el.textContent || "").trim(); }).length;
  head.form = { fields: fields.length, requiredEmpty: requiredEmpty };
}
return "# " + JSON.stringify(head) + (lines.length ? "\n" + lines.join("\n") : "");
`,

  fill: String.raw`
const text = A.text;
// Compare non-whitespace counts: rich editors normalize whitespace on the way in.
const want = Math.floor(text.replace(/\s/g, "").length * 0.9);
const landed = function (s) { return String(s || "").replace(/\s/g, "").length >= want; };
const isField = function (el) { return el.tagName === "TEXTAREA" || el.tagName === "INPUT"; };
function isRich(el) {
  return !!el && (editable(el) || !!(el.classList && (el.classList.contains("fr-element") || el.classList.contains("ql-editor") || el.classList.contains("ProseMirror"))));
}
function setPlain(el) {
  setNativeValue(el, text);
  fire(el, ["input", "change", "blur"]);
  return landed(el.value);
}
function setRich(root) {
  root.focus();
  // Build nodes rather than assigning innerHTML: an HTML-string sink trips
  // Trusted Types (require-trusted-types-for 'script') on Gmail-class pages.
  while (root.firstChild) root.removeChild(root.firstChild);
  text.split(/\n\n+/).forEach(function (para) {
    const block = document.createElement("div");
    para.split("\n").forEach(function (line, i) {
      if (i) block.appendChild(document.createElement("br"));
      block.appendChild(document.createTextNode(line));
    });
    if (!block.childNodes.length) block.appendChild(document.createElement("br"));
    root.appendChild(block);
  });
  ["input", "change", "blur"].forEach(function (t) { root.dispatchEvent(new InputEvent(t, { bubbles: true, inputType: "insertText", data: text })); });
  return landed(textOf(root));
}
function tryFill(el, host) {
  if (isField(el)) return setPlain(el) ? { ok: true, kind: "plain", el: ident(el), len: el.value.length } : null;
  if (isRich(el)) return setRich(el) ? { ok: true, kind: "rich", el: ident(host || el), len: textOf(el).length } : null;
  return null;
}
if (A.ref || A.selector) {
  const r = resolveEl(A);
  if (r.out) return r.out;
  const out = tryFill(r.el);
  if (!out) return { ok: false, error: ident(r.el) + " is not fillable or rejected the text" };
  if (A.selector) {
    const hits = Array.from(document.querySelectorAll(A.selector)).filter(vis);
    if (hits.length > 1) out.ambiguous = hits.slice(0, 3).map(ident);
  }
  return out;
}
// Ranked search across every editable surface, so a visible field outranks a
// hidden one and text never lands silently in the wrong element.
const re = new RegExp(A.label_pattern, "i");
const scored = [];
document.querySelectorAll("textarea, input, [contenteditable], .fr-element, .ql-editor, .ProseMirror, .tox-edit-area iframe").forEach(function (el) {
  if (el.tagName === "INPUT" && INPUT_SKIP.indexOf((el.type || "text").toLowerCase()) >= 0) return;
  if (el.hasAttribute("contenteditable") && !editable(el)) return;
  const root = el.tagName === "IFRAME" ? el.contentDocument && el.contentDocument.body : el;
  if (!root) return;
  let s;
  if (re.test(labelText(el))) s = 100;
  else if (re.test(hintText(el))) s = 40;
  else {
    let p = el, hit = false;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) if (re.test(p.textContent || "")) { hit = true; break; }
    if (!hit) return;
    s = 10;
  }
  if (vis(el)) s += 20;
  if (!el.disabled && !el.readOnly) s += 10;
  scored.push({ el: el, root: root, s: s });
});
scored.sort(function (a, b) { return b.s - a.s; });
if (!scored.length) return { ok: false, error: "no fillable field matched /" + A.label_pattern + "/i" };
const best = scored[0];
const out = tryFill(isField(best.el) ? best.el : best.root, best.el);
if (!out) return { ok: false, error: ident(best.el) + " did not accept the text" };
const rivals = scored.filter(function (c) { return best.s - c.s <= 10 && c.s >= 50; });
if (rivals.length > 1) out.ambiguous = rivals.slice(0, 3).map(function (c) { return ident(c.el); });
return out;
`,

  // Async: custom comboboxes render options after a tick. Polls instead of fixed sleeps.
  select: String.raw`
const want = String(A.text);
const norm = function (s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); };
const wantN = norm(want);
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let ctl;
if (A.ref || A.selector) {
  const r = resolveEl(A);
  if (r.out) return r.out;
  ctl = r.el;
} else {
  const re = new RegExp(A.label_pattern, "i");
  const cands = Array.from(document.querySelectorAll("select, [role=combobox], [aria-haspopup=listbox], [role=listbox]"));
  const hit = function (el) { return re.test(labelText(el)) || re.test(hintText(el)); };
  ctl = cands.filter(vis).find(hit) || cands.find(hit);
  if (!ctl) return { ok: false, error: "no select/combobox matched /" + A.label_pattern + "/i" };
}
const nat = ctl.tagName === "SELECT" ? ctl : ctl.querySelector && ctl.querySelector("select");
if (nat) {
  const opts = Array.from(nat.options);
  const opt = opts.find(function (o) { return norm(o.text) === wantN || norm(o.value) === wantN; }) || opts.find(function (o) { return norm(o.text).indexOf(wantN) >= 0; });
  if (!opt) return { ok: false, error: "no matching option", candidates: opts.slice(0, 8).map(function (o) { return clip(o.text, 60); }) };
  setNativeValue(nat, opt.value);
  fire(nat, ["input", "change"]);
  return { ok: true, selected: clip(opt.text, 80), el: ident(nat) };
}
// react-select and friends open on a left-button press with a view, on the control wrapper.
const press = function (el) {
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (t) {
    const C = t.indexOf("pointer") === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new C(t, { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window }));
  });
};
if (attr(ctl, "aria-expanded") !== "true") {
  if (ctl.focus) ctl.focus();
  press((ctl.closest && ctl.closest(".select__control")) || ctl);
}
const input = ctl.tagName === "INPUT" ? ctl : ctl.querySelector && ctl.querySelector("input");
if (input) { setNativeValue(input, want); fire(input, ["input"]); }
const find = function () {
  const os = Array.from(document.querySelectorAll("[role=option]")).filter(vis);
  return { os: os, opt: os.find(function (o) { return norm(o.textContent) === wantN; }) || os.find(function (o) { return norm(o.textContent).indexOf(wantN) >= 0; }) };
};
let f = find();
for (let i = 0; !f.opt && i < 30; i++) { await sleep(50); f = find(); }
if (!f.opt) return { ok: false, error: "no matching option after open", candidates: f.os.slice(0, 8).map(function (o) { return clip(o.textContent, 60); }) };
press(f.opt);
const picked = norm(f.opt.textContent);
const shown = function () { return clip(textOf(ctl) || (input && input.value) || "", 120); };
for (let i = 0; i < 10 && norm(shown()).indexOf(picked) < 0; i++) await sleep(50);
const out = { ok: true, selected: clip(f.opt.textContent, 80), el: ident(ctl), value: shown() };
if (norm(out.value).indexOf(picked) < 0) out.unverified = true;
return out;
`,

  click: String.raw`
const r = resolveEl(A);
if (r.out) return r.out;
r.el.click();
return { ok: true, el: ident(r.el) };
`,

  file_upload: String.raw`
const r = resolveEl(A, "input[type=file]");
if (r.out) return r.out;
const input = r.el;
const bin = atob(A.b64);
const arr = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
const file = new File([arr], A.name, { type: A.mime });
const dt = new DataTransfer();
dt.items.add(file);
// CSS-hidden inputs reject .files assignment; unhide with !important, then restore.
const orig = { display: input.style.display, visibility: input.style.visibility, hidden: input.hidden };
input.hidden = false;
input.style.setProperty("display", "block", "important");
input.style.setProperty("visibility", "visible", "important");
input.files = dt.files;
fire(input, ["change", "input", "blur"]);
setTimeout(function () { input.hidden = orig.hidden; input.style.display = orig.display; input.style.visibility = orig.visibility; }, 150);
return { ok: !!input.files && input.files.length === 1, name: file.name, size: file.size, type: file.type };
`,

  console_start: String.raw`
const s = window.__perch_console;
if (s && s.installed) return { ok: true, already: true, count: s.entries.length };
const st = { entries: [], dropped: 0, orig: {}, installed: true };
window.__perch_console = st;
function safe(v) {
  let out;
  try {
    if (typeof v === "string") out = v;
    else if (v instanceof Error) out = v.stack || v.message || String(v);
    else out = JSON.stringify(v, function (k, x) { return typeof x === "function" ? "[Function " + (x.name || "") + "]" : x === undefined ? "[undefined]" : x; });
  } catch (e) { out = String(v); }
  out = String(out);
  // Capped at record time so a page logging huge payloads can't bloat the buffer.
  return out.length > 1000 ? out.slice(0, 1000) + "...[+" + (out.length - 1000) + " chars]" : out;
}
["log", "info", "warn", "error", "debug"].forEach(function (level) {
  const orig = st.orig[level] = console[level];
  console[level] = function () {
    if (st.entries.length >= 500) { st.entries.shift(); st.dropped++; }
    const parts = [];
    for (let i = 0; i < arguments.length; i++) parts.push(safe(arguments[i]));
    st.entries.push(level + ": " + parts.join(" "));
    return orig.apply(console, arguments);
  };
});
return { ok: true, started: true };
`,

  console_read: String.raw`
const s = window.__perch_console;
if (!s || !s.installed) return { ok: false, error: "console_capture not started on this page (or it navigated since)" };
const out = { ok: true, entries: s.entries.splice(0) };
if (s.dropped) { out.dropped = s.dropped; s.dropped = 0; }
return out;
`,

  console_stop: String.raw`
const s = window.__perch_console;
if (!s || !s.installed) return { ok: false, error: "console_capture not started" };
for (const k in s.orig) console[k] = s.orig[k];
s.installed = false;
return { ok: true, entries: s.entries.splice(0) };
`,

  wait_check: String.raw`
const order = { loading: 0, interactive: 1, complete: 2 };
if (A.readyState && order[document.readyState] < order[A.readyState]) return false;
if (A.selector && !document.querySelector(A.selector)) return false;
return true;
`,
};

export function pageScript(name, A) {
  return PAGE_PRELUDE + "\nconst A = " + JSON.stringify(A) + ";\n" + (name ? PAGE_SCRIPTS[name] : "");
}

export function validateLabelPattern(tool, p) {
  try { new RegExp(p, "i"); } catch (e) { throw new Error(`${tool}: invalid label_pattern: ${e.message}`); }
}

const runPage = (tool, name, A, target, opts = {}) => evalJs(pageScript(name, A), target, { tool, ...opts });

// ---- page tools ----

async function getText(args = {}) {
  const { selector, ref, html = false, target } = args;
  const maxChars = Math.max(1, Number(args.maxChars) || 20000);
  const offset = Math.max(0, Number(args.offset) || 0);
  return runPage("get_text", "get_text", { selector, ref, html, maxChars, offset }, target);
}

async function accessibilitySnapshot(args = {}) {
  const { role = null, target } = args;
  const max = args.max == null ? 500 : Math.max(0, Number(args.max) || 0);
  return runPage("accessibility_snapshot", "snapshot", { max, role }, target);
}

async function consoleCapture(args = {}) {
  const { mode = "read", target } = args;
  if (!["start", "read", "stop"].includes(mode)) throw new Error(`console_capture: unknown mode '${mode}' (expected start | read | stop)`);
  return runPage("console_capture", "console_" + mode, {}, target);
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

async function trustedClick(args = {}) {
  const {
    ref = null,
    selector = null,
    x = null, y = null,
    raise = false,
    target,
  } = args;
  const button = "left", clickCount = 1;
  if (!ref && !selector && (x == null || y == null)) {
    throw new Error("click {trusted:true} requires `ref`, `selector`, or both `x` and `y`");
  }
  const needProbe = !!(ref || selector);
  // The probe runs in the page via tab.execute / doJavaScript synchronously, so the
  // whole trusted-click dispatch fits in one osascript round-trip. Two layers of
  // JSON-stringify: inside the probe (to return data back through the bridge), and
  // around the probe body itself (to embed it as a string into the JXA script).
  const probeBody = `
    (function(){
      try {
        var ref = ${JSON.stringify(ref)};
        var sel = ${JSON.stringify(selector)};
        var el = null;
        if (ref) el = (window.__perch_refs || {})[ref];
        else if (sel) el = document.querySelector(sel);
        if (!el) return JSON.stringify(ref ? { __perch_ref_miss: true, ref: ref } : { ok: false, error: 'no element for selector ' + sel });
        try { el.scrollIntoView({block:'center', inline:'center', behavior:'instant'}); } catch (e) {}
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return JSON.stringify({ ok: false, error: 'element offscreen / zero size' });
        return JSON.stringify({ ok: true, sx: window.screenX + r.left + r.width/2, sy: window.screenY + r.top + r.height/2 });
      } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
    })()
  `;

  const src = `
    ${targetClause(target)}
    ${assertAccessibilityGrantedJxa()}
    ${raise ? focusTabFragment() + "delay(0.2);" : `
      ${FRONTMOST}
      if (tab_app !== fm) throw new Error('target not frontmost; pass raise:true or call activate_tab first');
    `}
    ${resolveTargetIdsJxa()}
    if (pid == null) throw new Error('could not resolve PID for ' + tab_app);

    let __result = null;
    do {
      let sx = ${x === null ? "null" : Number(x)};
      let sy = ${y === null ? "null" : Number(y)};
      ${needProbe ? `
        ${arcActiveTabGuardJxa('click')}
        const __probeJs = ${JSON.stringify(probeBody)};
        ${execTabJsFragment("__probeRaw", "__probeJs")}
        const __probe = JSON.parse(String(__probeRaw));
        if (__probe.__perch_ref_miss) { __result = __probe; break; }
        if (!__probe.ok) { __result = { ok: false, error: __probe.error }; break; }
        sx = __probe.sx; sy = __probe.sy;
      ` : ""}

      // CGEvent dispatch — see AGENTS.md "Trusted input via CGEventPostToPid".
      ObjC.import('CoreGraphics');
      const __isRight = ${JSON.stringify(button)} === 'right';
      const __mouseBtn = __isRight ? 1 : 0;
      const __evtDown = __isRight ? 3 : 1;   // kCGEventRightMouseDown / kCGEventLeftMouseDown
      const __evtUp   = __isRight ? 4 : 2;   // kCGEventRightMouseUp / kCGEventLeftMouseUp
      const __pt = $.CGPointMake(sx, sy);

      ${postMouseFragmentJxa()}

      __postMouse(__evtDown, 1.0, 1, __mouseBtn);
      delay(0.012);
      __postMouse(__evtUp, 0.0, 1, __mouseBtn);
      if (${Number(clickCount) === 2 ? "true" : "false"}) {
        delay(0.06);
        __postMouse(__evtDown, 1.0, 2, __mouseBtn);
        delay(0.012);
        __postMouse(__evtUp, 0.0, 2, __mouseBtn);
      }

      __result = { ok: true, point: { x: sx, y: sy }, pid, windowNumber };
    } while (false);
    JSON.stringify(__result);
  `;
  return JSON.parse(await jxa(src));
}

// Trusted typing: real CGEvent keyboard events with isTrusted:true. Plain input/textarea
// only — rich editors are React-controlled and the InputEvent path already works for them.
// The probe clears the field via the setter before typing so the trusted keys land on
// an empty target (avoids appending to existing text or relying on Cmd+A, which would be
// keyboard-layout-dependent on non-US layouts).
async function trustedFill({ ref, selector, label_pattern, text, target }) { // TODO(phase4): raise
  const probeBody = `
    (function(){
      try {
        var ref = ${JSON.stringify(ref)};
        var sel = ${JSON.stringify(selector)};
        var labelRe = ${label_pattern ? `new RegExp(${JSON.stringify(label_pattern)}, 'i')` : "null"};
        var el = null;
        if (ref) el = (window.__perch_refs || {})[ref];
        else if (sel) el = document.querySelector(sel);
        else if (labelRe) {
          var labelOf = function(e){ return (e.labels && e.labels[0] && e.labels[0].textContent || (e.getAttribute && e.getAttribute('aria-label')) || e.placeholder || e.name || '').trim(); };
          el = Array.from(document.querySelectorAll('input, textarea')).find(function(e){ return labelRe.test(labelOf(e)); }) || null;
        }
        if (!el) return JSON.stringify(ref ? { __perch_ref_miss: true, ref: ref } : { ok: false, error: 'no fillable field matched' });
        if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
          return JSON.stringify({ ok: false, error: 'fill {trusted:true} supports plain input/textarea only; rich editors must use trusted:false' });
        }
        try { el.scrollIntoView({block:'center', inline:'center', behavior:'instant'}); } catch (e) {}
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        try { setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return JSON.stringify({ ok: false, error: 'element offscreen / zero size' });
        var tag = el.tagName.toLowerCase();
        try { window.__perch_trusted_fill_target = el; } catch (e) {}
        return JSON.stringify({ ok: true, sx: window.screenX + r.left + r.width/2, sy: window.screenY + r.top + r.height/2, tag: tag });
      } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
    })()
  `;

  const verifyBody = `
    (function(){
      try {
        var el = window.__perch_trusted_fill_target || document.activeElement;
        if (!el) return JSON.stringify({ ok: false, error: 'verification: no element' });
        return JSON.stringify({ ok: true, value: el.value || '' });
      } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
    })()
  `;

  const src = `
    ${targetClause(target)}
    ${assertAccessibilityGrantedJxa()}
    ${FRONTMOST}
    if (tab_app !== fm) throw new Error('target not frontmost; call activate_tab first');
    ${resolveTargetIdsJxa()}
    if (pid == null) throw new Error('could not resolve PID for ' + tab_app);
    ${arcActiveTabGuardJxa('fill')}

    let __result = null;
    do {
      const __probeJs = ${JSON.stringify(probeBody)};
      ${execTabJsFragment("__probeRaw", "__probeJs")}
      const __probe = JSON.parse(String(__probeRaw));
      if (__probe.__perch_ref_miss) { __result = __probe; break; }
      if (!__probe.ok) { __result = { ok: false, error: __probe.error }; break; }

      ObjC.import('CoreGraphics');
      ObjC.import('Foundation');
      const __pt = $.CGPointMake(__probe.sx, __probe.sy);

      ${postMouseFragmentJxa()}
      __postMouse(1, 1.0, 1, 0);  // leftMouseDown
      delay(0.012);
      __postMouse(2, 0.0, 1, 0);  // leftMouseUp
      delay(0.05);  // let focus settle before typing

      const __text = ${JSON.stringify(text)};
      const __chunkSize = 20;
      // NSUTF16LittleEndianStringEncoding = 0x14000100. NSData's .bytes is a const void* the
      // ObjC bridge passes straight to CGEventKeyboardSetUnicodeString — no manual UniChar
      // buffer allocation needed. Length is bytes/2.
      const __enc = 0x14000100;
      for (let __i = 0; __i < __text.length; __i += __chunkSize) {
        const __chunk = __text.slice(__i, __i + __chunkSize);
        const __ns = $.NSString.stringWithUTF8String(__chunk);
        const __data = __ns.dataUsingEncoding(__enc);
        const __len = __data.length / 2;
        const __buf = __data.bytes;

        const __eDown = $.CGEventCreateKeyboardEvent($(), 0, true);
        $.CGEventKeyboardSetUnicodeString(__eDown, __len, __buf);
        $.CGEventSetIntegerValueField(__eDown, 9, pid);
        $.CGEventPostToPid(pid, __eDown);

        const __eUp = $.CGEventCreateKeyboardEvent($(), 0, false);
        $.CGEventKeyboardSetUnicodeString(__eUp, __len, __buf);
        $.CGEventSetIntegerValueField(__eUp, 9, pid);
        $.CGEventPostToPid(pid, __eUp);
        delay(0.005);
      }

      delay(0.05);
      const __verifyJs = ${JSON.stringify(verifyBody)};
      ${execTabJsFragment("__vRaw", "__verifyJs")}
      const __v = JSON.parse(String(__vRaw));
      if (!__v.ok) { __result = { ok: false, error: __v.error }; break; }
      const __expected = Math.max(1, Math.floor(__text.trim().length * 0.9));
      const __actual = (__v.value || '').trim().length;
      if (__actual < __expected) {
        __result = { ok: false, error: 'trusted fill: value did not land (got ' + __actual + ' chars, expected >= ' + __expected + ')', got: String(__v.value || '').slice(0, 200) };
        break;
      }
      __result = { ok: true, kind: 'trusted_' + __probe.tag, len: __actual };
    } while (false);
    JSON.stringify(__result);
  `;
  return JSON.parse(await jxa(src));
}

async function fileUpload(args = {}) {
  const { selector, ref, path, target } = args;
  if (!path) throw new Error("file_upload requires `path`");
  const { abs, data } = await readUserFile(path);
  const name = abs.split("/").pop();
  const mime = MIME_BY_EXT[name.split(".").pop().toLowerCase()] || "application/octet-stream";
  return runPage("file_upload", "file_upload", { selector, ref, b64: data.toString("base64"), name, mime }, target);
}

async function click(args = {}) {
  const { ref = null, selector = null, x = null, y = null, trusted = false, raise = false, target } = args;
  if (trusted) return trustedClick({ ref, selector, x, y, raise, target });
  if (!ref && !selector) throw new Error("click requires `ref` or `selector` (x/y is screen coords, trusted:true only)");
  return runPage("click", "click", { ref, selector }, target);
}

async function fill(args = {}) {
  const { selector, label_pattern, ref, text, text_path, target, trusted = false, raise = false } = args;
  if (!text && !text_path) throw new Error("fill requires `text` or `text_path`");
  if (text && text_path) throw new Error("fill: pass `text` OR `text_path`, not both");
  if (!ref && !selector && !label_pattern) throw new Error("fill requires `ref`, `selector`, or `label_pattern`");
  if (label_pattern) validateLabelPattern("fill", label_pattern);
  let body = text;
  if (text_path) ({ data: body } = await readUserFile(text_path, "utf8"));
  if (!body || !body.trim()) throw new Error("fill: empty body");
  if (trusted) return trustedFill({ ref, selector, label_pattern, text: body, raise, target });
  return runPage("fill", "fill", { ref, selector, label_pattern, text: body }, target);
}

async function select(args = {}) {
  const { ref = null, selector = null, label_pattern = null, text = null, target } = args;
  if (text == null) throw new Error("select requires `text` (the option to choose)");
  if (!ref && !selector && !label_pattern) throw new Error("select requires `ref`, `selector`, or `label_pattern`");
  if (label_pattern) validateLabelPattern("select", label_pattern);
  return runPage("select", "select", { ref, selector, label_pattern, text: String(text) }, target, { awaitPromise: true, timeout: 5000 });
}

// Shared guidance lives here once instead of in every tool description.
export const INSTRUCTIONS = `perch drives the user's own macOS browsers (Chrome family, Arc, Safari) over AppleScript.
Targeting: tools take an optional \`target\` {app, windowId, tabIndex}; the default is the active tab of the topmost browser window. tabIndex is a position, not an id: it shifts as tabs open and close, so re-list instead of caching it. new_tab returns a ready-made target.
Elements: prefer \`ref\` (from accessibility_snapshot) over \`selector\` over \`label_pattern\` (case-insensitive regex over label/aria-label/placeholder/name). Refs die on the next snapshot or navigation; a stale ref errors with a re-snapshot hint.
{ok:false, error} is a normal outcome (no match, value didn't land): read it rather than retrying blindly.
Arc runs page JS only on a window's active tab (activate_tab first). Only activate_tab, screenshot{raise} and trusted input with raise take focus.`;

const TARGET = { type: "object", properties: { app: { type: "string" }, windowId: { type: ["string", "number"] }, tabIndex: { type: "number" } } };
const REF = { type: "string", description: "From accessibility_snapshot." };
const SEL = { type: "string", description: "CSS selector." };
const LABEL = { type: "string", description: "Regex over the field's label." };
const tool = (name, description, properties = {}, required) =>
  ({ name, description, inputSchema: { type: "object", properties, ...(required ? { required } : {}) } });

const TOOLS = [
  tool("list_tabs", "List open tabs as {tabs:[{app,windowId,tabIndex,url,title,active?}], total}. Filter rather than dumping; `total` counts matches before `limit`.", {
    app: { type: "string" },
    urlContains: { type: "string" },
    titleContains: { type: "string" },
    limit: { type: "number", description: "Default 50." },
  }),
  tool("new_tab", "Open a tab (launches the browser if needed). Returns {app,windowId,tabIndex}, usable as `target`.", {
    url: { type: "string", description: "Default about:blank." },
    app: { type: "string", description: "Default Google Chrome." },
  }),
  tool("activate_tab", "Bring the target tab and its window to the front.", { target: TARGET }),
  tool("navigate", "Load a URL in the target tab and wait for the new page to finish loading.", { url: { type: "string" }, target: TARGET }, ["url"]),
  tool("eval_js", "Run JS in the tab as a function body; `return` a JSON-able value. With both `script_path` and `script`, the file runs first, then `script`, in one call.", {
    script: { type: "string" },
    script_path: { type: "string", description: "Local .js file." },
    awaitPromise: { type: "boolean", description: "Await async code (30s cap)." },
    target: TARGET,
  }),
  tool("wait", "Wait until `selector` exists and `readyState` is reached, or until `expression` is truthy (returned as `value`).", {
    selector: SEL,
    readyState: { type: "string", enum: ["loading", "interactive", "complete"], description: "Default complete." },
    expression: { type: "string" },
    timeout: { type: "number", description: "ms, default 10000." },
    target: TARGET,
  }),
  tool("screenshot", "Capture the target window without raising it; an explicit tabIndex switches that window to the tab first. Returns the image plus {window:{x,y,w,h}, image:{w,h}}; screenX = window.x + imageX * window.w / image.w.", {
    raise: { type: "boolean" },
    maxWidth: { type: "number", description: "Default 1568; 0 = full size." },
    format: { type: "string", enum: ["png", "jpeg"] },
    target: TARGET,
  }),
  tool("get_text", "innerText (or outerHTML with `html`) of an element, default body/html, paged by `offset`/`maxChars`.", {
    selector: SEL,
    ref: REF,
    html: { type: "boolean" },
    maxChars: { type: "number", description: "Default 20000." },
    offset: { type: "number" },
    target: TARGET,
  }),
  tool("accessibility_snapshot", "Page outline: a `# {url,title,ready,count,focus,dialogs,form}` header, then one line per visible interactive element: `ref role \"name\" key=json… flags`. Refs feed click/fill/select/get_text.", {
    max: { type: "number", description: "Element cap, default 500; 0 = header only." },
    role: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Only these roles, e.g. textbox, combobox, button." },
    target: TARGET,
  }),
  tool("console_capture", "Patch console.* in the page: `start`, then `read` drains entries as \"level: text\" strings, `stop` restores. Navigation clears it.", {
    mode: { type: "string", enum: ["start", "read", "stop"], description: "Default read." },
    target: TARGET,
  }),
  tool("notify", "Show a macOS notification (appears as Script Editor).", {
    message: { type: "string" },
    title: { type: "string" },
    subtitle: { type: "string" },
    sound: { type: "string", description: "Default Glass." },
  }, ["message"]),
  tool("file_upload", "Put a local file on an <input type=file> (default the first one) without the bytes entering context. {ok:false} means it isn't a plain file input: hand off instead of retrying.", {
    path: { type: "string" },
    ref: REF,
    selector: SEL,
    target: TARGET,
  }, ["path"]),
  tool("click", "Click by ref/selector (el.click()). `trusted` posts a real OS click (isTrusted, needs Accessibility permission and the window in front or `raise`); only trusted accepts screen `x`/`y`.", {
    ref: REF,
    selector: SEL,
    x: { type: "number" },
    y: { type: "number" },
    trusted: { type: "boolean" },
    raise: { type: "boolean" },
    target: TARGET,
  }),
  tool("fill", "Set a field's text and verify it landed: inputs, textareas, and rich editors (contenteditable, ProseMirror, Quill…). Returns {ok,kind,el,len,ambiguous?}. `trusted` types real keys into plain fields.", {
    text: { type: "string" },
    text_path: { type: "string", description: "File with the text." },
    ref: REF,
    selector: SEL,
    label_pattern: LABEL,
    trusted: { type: "boolean" },
    raise: { type: "boolean" },
    target: TARGET,
  }),
  tool("select", "Choose an option in a native <select>, react-select, or ARIA combobox/listbox, and read back what's shown. Exact text or value first, then substring.", {
    text: { type: "string" },
    ref: REF,
    selector: SEL,
    label_pattern: LABEL,
    target: TARGET,
  }, ["text"]),
];

export const SCHEMA_BUDGET = 9000;

export const HANDLERS = {
  list_tabs:     (a) => listTabs(a),
  new_tab:       (a) => newTab(a.url, a.app),
  activate_tab:  (a) => activateTab(a.target),
  navigate:      (a) => navigate(a.url, a.target),
  eval_js:       async (a) => evalJs(await composeEvalScript(a), a.target, { awaitPromise: a.awaitPromise }),
  wait:          (a) => wait(a),
  screenshot:    (a) => screenshot(a),
  get_text:      (a) => getText(a),
  accessibility_snapshot: (a) => accessibilitySnapshot(a),
  console_capture:        (a) => consoleCapture(a),
  notify:        (a) => notify(a),
  file_upload:   (a) => fileUpload(a),
  click:         (a) => click(a),
  fill:          (a) => fill(a),
  select:        (a) => select(a),
};

// File first, then `script`, in one function body: one call can inject a library and read it back.
export async function composeEvalScript({ script, script_path } = {}) {
  let file = "";
  if (script_path) ({ data: file } = await readUserFile(script_path, "utf8"));
  if (!file && !script) throw new Error("eval_js requires `script` or `script_path`");
  return file && script ? file + "\n;\n" + script : file || script;
}

export function formatResult(result) {
  if (result && result.__image) {
    const content = [{ type: "image", data: result.data, mimeType: result.mimeType }];
    if (result.meta) content.push({ type: "text", text: JSON.stringify(result.meta) });
    return { content };
  }
  if (result && typeof result === "object" && result.__perch_ref_miss) {
    return { content: [{ type: "text", text: `error: ref ${result.ref} is stale or unknown; call accessibility_snapshot again (refs die on re-snapshot and navigation)` }], isError: true };
  }
  if (result && typeof result === "object" && result.__perch_error !== undefined) {
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true };
  }
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
}

export async function handleCall(name, args = {}) {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
  try {
    if (!handler) throw new Error(`unknown tool: ${name}`);
    return formatResult(await handler(args));
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
}

export { TOOLS, buildAsyncKickoff };

// Start only when run as the entry point (realpath: npm's bin is a symlink), so tests can import.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = new Server({ name: "perch", version: "0.2.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (req) => handleCall(req.params.name, req.params.arguments || {}));
  await server.connect(new StdioServerTransport());
}
