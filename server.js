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

async function listTabs(args = {}) {
  let tabs = await rt("listTabs", { app: args.app || null });
  const { urlContains, titleContains, limit } = args;
  if (urlContains == null && titleContains == null && limit == null) return tabs;
  if (urlContains) tabs = tabs.filter(t => t.url.toLowerCase().includes(String(urlContains).toLowerCase()));
  if (titleContains) tabs = tabs.filter(t => t.title.toLowerCase().includes(String(titleContains).toLowerCase()));
  const total = tabs.length;
  if (limit != null && tabs.length > limit) tabs = tabs.slice(0, Math.max(0, limit));
  // tabIndex fields keep their original window positions, so filtered rows stay addressable.
  return { tabs, total };
}

async function evalJs(script, target, { awaitPromise = false, timeout = 30000, tool = "eval_js" } = {}) {
  if (!awaitPromise) return parsePage(await rt("evalJs", { target, js: buildEvalWrapper(script), tool }, { raw: true }));
  const key = `__perch_async_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const r = await rt("evalAsync", { target, kick: buildAsyncKickoff(script, key), poll: buildAsyncPoll(key), timeout },
    { lane: "slow", timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD });
  return r && Object.hasOwn(r, "value") ? r.value : r;
}

async function wait(args = {}) {
  const { selector, readyState = "complete", expression, timeout = 10000, interval = 150, target } = args;
  const js = expression
    ? `(function(){try{var __r=(${expression});return JSON.stringify(__r===undefined?null:__r)}catch(e){return "null"}})()`
    : buildEvalWrapper(`
        const order = { loading: 0, interactive: 1, complete: 2 };
        const wantReady = ${JSON.stringify(readyState)};
        if (wantReady && order[document.readyState] < order[wantReady]) return false;
        const wantSel = ${JSON.stringify(selector || "")};
        if (wantSel && !document.querySelector(wantSel)) return false;
        return true;`);
  const r = await rt("wait", { target, js, timeout, interval }, { lane: "slow", timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD });
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
  return { ok: true, app: browser.app, url: targetUrl, windowId, tabIndex };
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

async function pageState(target) {
  return evalJs(`
    function vis(el) {
      if (!el || el.hidden) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return !(r.width === 0 && r.height === 0);
    }
    function nm(el) {
      const al = el.getAttribute && el.getAttribute('aria-label');
      if (al) return al.trim().slice(0, 80);
      const lb = el.getAttribute && el.getAttribute('aria-labelledby');
      if (lb) { const t = lb.split(/\\s+/).map(id => { const n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ').trim(); if (t) return t.slice(0, 80); }
      if (el.labels && el.labels[0]) return (el.labels[0].textContent || '').trim().slice(0, 80);
      if (el.placeholder) return el.placeholder.trim().slice(0, 80);
      const tt = el.getAttribute && (el.getAttribute('title') || el.getAttribute('name'));
      return (tt || '').trim().slice(0, 80);
    }
    function role(el) {
      const ex = el.getAttribute && el.getAttribute('role'); if (ex) return ex;
      if (el.isContentEditable) return 'textbox';
      const tag = el.tagName.toLowerCase();
      if (tag === 'textarea' || tag === 'input') return 'textbox';
      return tag;
    }
    const INPUT_SKIP = ['hidden','checkbox','radio','file','submit','button','image','reset','range','color'];
    const out = {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      scroll: { x: window.scrollX, y: window.scrollY },
      doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      meta: (function() {
        const keep = ['description', 'og:title', 'og:description', 'og:image'];
        const o = {};
        document.querySelectorAll('meta').forEach(m => {
          const k = m.getAttribute('name') || m.getAttribute('property');
          if (k && keep.indexOf(k) >= 0 && !(k in o)) o[k] = m.getAttribute('content');
        });
        return o;
      })()
    };
    const active = document.activeElement;
    if (active && active !== document.body) out.focused = { tag: active.tagName.toLowerCase(), role: role(active), name: nm(active) };
    const dialogs = Array.from(document.querySelectorAll('[role=dialog], [aria-modal=true], dialog[open]')).filter(vis).slice(0, 20).map(d => ({ name: nm(d) }));
    if (dialogs.length) out.dialogs = dialogs;
    const editors = Array.from(document.querySelectorAll('textarea, input, [contenteditable]')).filter(el => {
      if (el.tagName === 'INPUT') return INPUT_SKIP.indexOf((el.type || 'text').toLowerCase()) < 0 && vis(el);
      if (el.tagName === 'TEXTAREA') return vis(el);
      return el.isContentEditable && vis(el);
    }).slice(0, 20).map(el => {
      const val = (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? (el.value || '') : (el.innerText || el.textContent || '');
      return { role: role(el), name: nm(el), empty: !val.trim(), value: val.slice(0, 80), focused: el === active };
    });
    if (editors.length) out.editors = editors;
    const openControls = Array.from(document.querySelectorAll('[aria-expanded=true], [role=listbox]')).filter(vis).slice(0, 20).map(el => ({
      role: role(el), name: nm(el), optionCount: el.querySelectorAll ? el.querySelectorAll('[role=option]').length : 0
    }));
    if (openControls.length) out.openControls = openControls;
    const forms = Array.from(document.querySelectorAll('form')).filter(vis);
    if (forms.length) {
      let big = forms[0], bigN = -1;
      forms.forEach(f => { const n = f.querySelectorAll('input, textarea, select, [contenteditable=true]').length; if (n > bigN) { bigN = n; big = f; } });
      const fields = Array.from(big.querySelectorAll('input, textarea, select, [contenteditable=true]')).filter(el => !(el.tagName === 'INPUT' && INPUT_SKIP.indexOf((el.type || 'text').toLowerCase()) >= 0));
      const requiredEmpty = fields.filter(el => (el.required || (el.getAttribute && el.getAttribute('aria-required') === 'true')) && !((el.value || el.textContent || '').trim())).length;
      out.form = { fields: fields.length, requiredEmpty: requiredEmpty };
    }
    return out;
  `, target);
}

// Slices page-side so oversized strings never cross the osascript bridge.
function sliceReturnJs(expr, args) {
  const maxChars = Math.max(1, Number(args.maxChars) || 20000);
  const offset = Math.max(0, Number(args.offset) || 0);
  return `
    const __s = ${expr};
    if (__s == null) return null;
    if (${offset} === 0 && __s.length <= ${maxChars}) return __s;
    return __s.slice(${offset}, ${offset} + ${maxChars}) +
      "\\n[truncated: chars ${offset}-" + Math.min(${offset} + ${maxChars}, __s.length) +
      " of " + __s.length + "; pass offset/maxChars for the rest]";
  `;
}

async function getText(args = {}) {
  const { selector, ref, target } = args;
  if (ref) {
    return evalJs(`
      const el = (window.__perch_refs || {})[${JSON.stringify(ref)}];
      if (!el) return { __perch_ref_miss: true, ref: ${JSON.stringify(ref)} };
      ${sliceReturnJs("el.innerText", args)}
    `, target);
  }
  return evalJs(`
    const el = document.querySelector(${JSON.stringify(selector || "body")});
    if (!el) return null;
    ${sliceReturnJs("el.innerText", args)}
  `, target);
}

async function getHtml(args = {}) {
  const { selector, ref, target } = args;
  if (ref) {
    return evalJs(`
      const el = (window.__perch_refs || {})[${JSON.stringify(ref)}];
      if (!el) return { __perch_ref_miss: true, ref: ${JSON.stringify(ref)} };
      ${sliceReturnJs("el.outerHTML", args)}
    `, target);
  }
  return evalJs(`
    const el = document.querySelector(${JSON.stringify(selector || "html")});
    if (!el) return null;
    ${sliceReturnJs("el.outerHTML", args)}
  `, target);
}

async function accessibilitySnapshot(args = {}) {
  const { target, max = 500, include_bounds = false, role = null } = args;
  const roleList = role == null ? null : (Array.isArray(role) ? role : [role]);
  const script = `
    const refs = {};
    window.__perch_refs = refs;

    function visible(el) {
      if (el.hidden) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      return true;
    }

    function trim(s, max) {
      s = (s || '').replace(/\\s+/g, ' ').trim();
      return s.length > max ? s.slice(0, max) + '…' : s;
    }

    function accName(el) {
      const lb = el.getAttribute && el.getAttribute('aria-labelledby');
      if (lb) {
        const txt = lb.split(/\\s+/).map(id => {
          const t = document.getElementById(id);
          return t ? (t.innerText || t.textContent || '').trim() : '';
        }).filter(Boolean).join(' ');
        if (txt) return trim(txt, 120);
      }
      const al = el.getAttribute && el.getAttribute('aria-label');
      if (al) return trim(al, 120);
      if (el.labels && el.labels[0]) {
        const t = el.labels[0].innerText || el.labels[0].textContent || '';
        if (t.trim()) return trim(t, 120);
      }
      if (el.placeholder) return trim(el.placeholder, 120);
      if (el.alt) return trim(el.alt, 120);
      if (el.value && (el.tagName === 'INPUT' || el.tagName === 'BUTTON')) {
        const t = el.tagName === 'BUTTON' ? null : el.value;
        if (t) return trim(t, 120);
      }
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt) return trim(txt, 120);
      if (el.name) return el.name;
      if (el.title) return trim(el.title, 120);
      return '';
    }

    function roleOf(el) {
      const explicit = el.getAttribute && el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.href) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button' || t === 'image' || t === 'reset') return 'button';
        if (t === 'range') return 'slider';
        return 'textbox';
      }
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'summary') return 'button';
      if (el.isContentEditable) return 'textbox';
      return 'generic';
    }

    function describe(el, ref, role) {
      const tag = el.tagName.toLowerCase();
      const out = { ref, role, name: accName(el) };
      if (role === 'link' && el.href) out.href = el.href.length > 300 ? el.href.slice(0, 300) + '...' : el.href;
      // Form-specific extras — emitted only when set so the tree stays compact for
      // non-form pages but contains everything a form-filler needs in one snapshot.
      // Skip subtype values already implied by role (radio/checkbox/button/submit).
      if (tag === 'input') {
        const t = (el.type || 'text').toLowerCase();
        if (t && t !== 'text' && t !== 'radio' && t !== 'checkbox' && t !== 'button' && t !== 'submit') out.subtype = t;
      } else if (tag === 'textarea') {
        out.subtype = 'textarea';
      }
      if (el.name && (tag === 'input' || tag === 'textarea' || tag === 'select')) out.attr_name = el.name;
      if (role === 'textbox' && el.value) out.value = trim(String(el.value), 200);
      if ((role === 'checkbox' || role === 'radio') && el.checked) out.checked = true;
      if (el.disabled) out.disabled = true;
      if (el.required) out.required = true;
      if (tag === 'select') {
        const opts = [];
        for (let i = 0; i < el.options.length && opts.length < 30; i++) {
          const t = (el.options[i].text || '').trim();
          if (t && t !== '--') opts.push(t);
        }
        if (opts.length) out.options = opts;
        if (el.value) out.value = el.value;
      }
      if (role === 'heading') {
        const lvl = /^h([1-6])$/.exec(tag);
        out.level = lvl ? Number(lvl[1]) : Number(el.getAttribute('aria-level')) || null;
      }
      if (${include_bounds}) {
        const r = el.getBoundingClientRect();
        out.bounds = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      }
      return out;
    }

    const SEL = 'a[href], button, input:not([type=hidden]), textarea, select, [role], [tabindex]:not([tabindex="-1"]), h1, h2, h3, h4, h5, h6, [contenteditable=true], [contenteditable=""], summary';
    const seen = new Set();
    const elements = [];
    const max = ${Number(max) || 500};
    const roleFilter = ${JSON.stringify(roleList)};
    const roleSet = roleFilter && roleFilter.length ? new Set(roleFilter) : null;
    let id = 0;
    for (const el of document.querySelectorAll(SEL)) {
      if (elements.length >= max) break;
      if (seen.has(el)) continue;
      const role = roleOf(el);
      if (roleSet && !roleSet.has(role)) continue;
      if (!visible(el)) continue;
      seen.add(el);
      id += 1;
      const ref = String(id);
      refs[ref] = el;
      elements.push(describe(el, ref, role));
    }

    return { url: location.href, title: document.title, count: elements.length, truncated: elements.length >= max, elements };
  `;
  return await evalJs(script, target);
}

async function consoleCapture(args = {}) {
  const { mode = "read", target, max = 500 } = args;
  if (mode === "start") {
    return evalJs(`
      if (window.__perch_console && window.__perch_console.installed) {
        return { ok: true, already: true, count: window.__perch_console.entries.length };
      }
      const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
      const state = { entries: [], orig, installed: true, max: ${Number(max) || 500} };
      window.__perch_console = state;
      function safe(v) {
        let s;
        try {
          if (typeof v === 'string') s = v;
          else if (v instanceof Error) s = v.stack || v.message || String(v);
          else s = JSON.stringify(v, function(k, val) {
            if (typeof val === 'function') return '[Function ' + (val.name || '') + ']';
            if (typeof val === 'undefined') return '[undefined]';
            return val;
          });
        } catch (e) { s = String(v); }
        s = String(s);
        // Cap at record time so a page logging huge payloads can't bloat the buffer.
        return s.length > 1000 ? s.slice(0, 1000) + '...[+' + (s.length - 1000) + ' chars]' : s;
      }
      function record(level, args) {
        if (state.entries.length >= state.max) state.entries.shift();
        const arr = []; for (let i = 0; i < args.length; i++) arr.push(safe(args[i]));
        state.entries.push({ level, ts: Date.now(), args: arr });
      }
      console.log   = function() { record('log',   arguments); orig.log  .apply(console, arguments); };
      console.info  = function() { record('info',  arguments); orig.info .apply(console, arguments); };
      console.warn  = function() { record('warn',  arguments); orig.warn .apply(console, arguments); };
      console.error = function() { record('error', arguments); orig.error.apply(console, arguments); };
      console.debug = function() { record('debug', arguments); orig.debug.apply(console, arguments); };
      return { ok: true, started: true, max: state.max };
    `, target);
  }
  if (mode === "read") {
    return evalJs(`
      const s = window.__perch_console;
      if (!s || !s.installed) return { ok: false, error: 'console_capture not started on this page (or page navigated since start)' };
      const out = s.entries.slice();
      s.entries.length = 0;
      return { ok: true, entries: out };
    `, target);
  }
  if (mode === "clear") {
    return evalJs(`
      const s = window.__perch_console;
      if (!s || !s.installed) return { ok: false, error: 'console_capture not started' };
      const n = s.entries.length;
      s.entries.length = 0;
      return { ok: true, cleared: n };
    `, target);
  }
  if (mode === "stop") {
    return evalJs(`
      const s = window.__perch_console;
      if (!s || !s.installed) return { ok: false, error: 'console_capture not started' };
      const out = s.entries.slice();
      console.log = s.orig.log;
      console.info = s.orig.info;
      console.warn = s.orig.warn;
      console.error = s.orig.error;
      console.debug = s.orig.debug;
      s.installed = false;
      return { ok: true, entries: out };
    `, target);
  }
  throw new Error("console_capture: unknown mode '" + mode + "' (expected start | read | clear | stop)");
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

async function click(args = {}) {
  const {
    ref = null,
    selector = null,
    x = null, y = null,
    button = "left",
    clickCount = 1,
    trusted = false,
    raise = false,
    target,
  } = args;

  if (trusted) return await trustedClick({ ref, selector, x, y, button, clickCount, raise, target });

  if (!ref && !selector) {
    throw new Error("click without trusted:true requires `ref` or `selector` (x,y is screen coords, only meaningful with trusted:true)");
  }
  // Plain path: el.click() in the page. Same isTrusted:false semantics as today's
  // eval_js({script:'...refs[ref].click()'}) pattern, just a first-class tool call.
  const script = `
    const refId = ${JSON.stringify(ref)};
    const sel = ${JSON.stringify(selector)};
    const button = ${JSON.stringify(button)};
    const clickCount = ${Number(clickCount) || 1};
    let el = null;
    if (refId) el = (window.__perch_refs || {})[refId];
    else if (sel) el = document.querySelector(sel);
    if (!el) return refId ? { __perch_ref_miss: true, ref: refId } : { ok: false, error: 'no element for selector ' + sel };
    if (button === 'right') {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, button: 2 }));
    } else {
      el.click();
      if (clickCount === 2) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    }
    return { ok: true };
  `;
  return await evalJs(script, target);
}

async function trustedClick(args = {}) {
  const {
    ref = null,
    selector = null,
    x = null, y = null,
    button = "left",
    clickCount = 1,
    raise = false,
    target,
  } = args;
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

async function fill(args = {}) {
  const { selector, label_pattern, ref, text, text_path, target, trusted = false } = args;
  if (!text && !text_path) throw new Error("fill requires `text` or `text_path`");
  if (text && text_path) throw new Error("fill: pass `text` OR `text_path`, not both");

  let body = text;
  if (text_path) ({ data: body } = await readUserFile(text_path, "utf8"));
  if (!body || !body.trim()) throw new Error("fill: empty body");

  if (trusted) return await trustedFill({ ref, selector, label_pattern, text: body, target });

  const script = `
    const text = ${JSON.stringify(body)};
    const labelRe = ${label_pattern ? `new RegExp(${JSON.stringify(label_pattern)}, 'i')` : "null"};
    const selector = ${selector ? JSON.stringify(selector) : "null"};
    const ref = ${ref ? JSON.stringify(ref) : "null"};
    const MIN_RATIO = 0.9;
    const expectedLen = Math.max(1, Math.floor(text.trim().length * MIN_RATIO));
    // Rich-editor innerText normalizes whitespace and may add/drop chars, so allow a
    // lower bound that's never less than ~50 — covers cases where setter "worked" but
    // some structural transform shrunk the visible text.
    const richMinLen = Math.max(50, expectedLen);

    function fVisible(el) {
      if (!el || el.hidden) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return !(r.width === 0 && r.height === 0);
    }
    function fRole(el) {
      const ex = el.getAttribute && el.getAttribute('role'); if (ex) return ex;
      const tag = el.tagName.toLowerCase();
      if (tag === 'textarea' || tag === 'input') return 'textbox';
      if (el.isContentEditable) return 'textbox';
      return 'generic';
    }
    function fName(el) {
      return ((el.labels && el.labels[0] && el.labels[0].textContent) || (el.getAttribute && el.getAttribute('aria-label')) || el.placeholder || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    }
    function fIdentity(el, matchedBy) {
      return { tag: el.tagName.toLowerCase(), role: fRole(el), name: fName(el), id: el.id || '', visible: fVisible(el), matchedBy: matchedBy };
    }
    function fReadback(el) {
      const raw = (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? (el.value || '') : (el.innerText || el.textContent || '');
      return raw.slice(0, 120);
    }

    function setPlain(el) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      ['input', 'change', 'blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
      return (el.value || '').trim().length >= expectedLen;
    }
    function setRich(root) {
      root.focus();
      // Build nodes rather than assigning innerHTML: an HTML-string sink trips
      // Trusted Types (require-trusted-types-for 'script') on Gmail/strict-CSP pages.
      while (root.firstChild) root.removeChild(root.firstChild);
      text.split(/\\n\\n+/).forEach(para => {
        const block = document.createElement('div');
        para.split('\\n').forEach((line, i) => {
          if (i) block.appendChild(document.createElement('br'));
          block.appendChild(document.createTextNode(line));
        });
        if (!block.childNodes.length) block.appendChild(document.createElement('br'));
        root.appendChild(block);
      });
      ['input', 'change', 'blur'].forEach(t => root.dispatchEvent(new InputEvent(t, { bubbles: true, inputType: 'insertText', data: text })));
      return (root.innerText || root.textContent || '').trim().length >= richMinLen;
    }
    function isRich(el) {
      return el && (el.isContentEditable || el.classList?.contains('fr-element') || el.classList?.contains('ql-editor') || el.classList?.contains('ProseMirror'));
    }
    function tryFill(el, kindLabel) {
      if (!el) return null;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        if (setPlain(el)) return { ok: true, kind: 'plain_' + kindLabel, len: el.value.length, matched: fIdentity(el, kindLabel), value: fReadback(el) };
      }
      if (isRich(el)) {
        if (setRich(el)) return { ok: true, kind: 'rich_' + kindLabel, host: el.className || el.tagName, len: (el.innerText || '').length, matched: fIdentity(el, kindLabel), value: fReadback(el) };
      }
      return null;
    }

    if (ref) {
      const el = (window.__perch_refs || {})[ref];
      if (!el) return { ok: false, error: 'ref ' + ref + ' missing (call accessibility_snapshot first, or the page navigated)' };
      const r = tryFill(el, 'ref');
      if (r) return r;
      return { ok: false, error: 'ref ' + ref + ' is not a fillable element' };
    }

    if (selector) {
      const hits = Array.from(document.querySelectorAll(selector)).filter(fVisible);
      const r = tryFill(document.querySelector(selector), 'selector');
      if (r) {
        if (hits.length > 1) {
          r.ambiguous = true;
          r.candidates = hits.slice(0, 3).map(e => ({ tag: e.tagName.toLowerCase(), role: fRole(e), name: fName(e), visible: fVisible(e) }));
        }
        return r;
      }
    }

    if (labelRe) {
      // Unified, ranked candidate search across every editable surface (textarea, text
      // input, contenteditable/rich editor) so a visible field outranks a hidden one and
      // we never silently drop text into the wrong element.
      const INPUT_SKIP = ['hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'image', 'reset', 'range', 'color'];
      const roots = [];
      document.querySelectorAll('textarea, input, [contenteditable=true], [contenteditable=""], .fr-element, .ql-editor, .ProseMirror, .tox-edit-area iframe').forEach(el => {
        if (el.tagName === 'INPUT' && INPUT_SKIP.indexOf((el.type || 'text').toLowerCase()) >= 0) return;
        const root = el.tagName === 'IFRAME' ? (el.contentDocument && el.contentDocument.body) : el;
        if (root) roots.push({ el: el, root: root });
      });
      const strongLabel = (el) => ((el.labels && el.labels[0] && el.labels[0].textContent) || (el.getAttribute && el.getAttribute('aria-label')) || '').trim();
      const weakLabel = (el) => (el.placeholder || el.name || (el.getAttribute && el.getAttribute('data-tooltip')) || el.title || '').trim();
      const scored = [];
      for (const cand of roots) {
        const el = cand.el;
        let s = 0;
        if (labelRe.test(strongLabel(el))) s += 100;
        else if (labelRe.test(weakLabel(el))) s += 40;
        else {
          // Loose fallback: a labeled wrapper within 6 ancestors (old behavior, low weight).
          let scope = el, hit = false;
          for (let i = 0; i < 6 && scope; i++) { if (labelRe.test(scope.textContent || '')) { hit = true; break; } scope = scope.parentElement; }
          if (!hit) continue;
          s += 10;
        }
        if (fVisible(el)) s += 20;
        if (!el.disabled && !el.readOnly) s += 10;
        scored.push({ el: el, root: cand.root, s: s });
      }
      scored.sort((a, b) => b.s - a.s);
      if (scored.length) {
        const best = scored[0];
        const target = (best.el.tagName === 'TEXTAREA' || best.el.tagName === 'INPUT') ? best.el : best.root;
        const r = tryFill(target, 'label');
        if (r) {
          const rivals = scored.filter(c => (best.s - c.s) <= 10 && c.s >= 50);
          if (rivals.length > 1) {
            r.ambiguous = true;
            r.candidates = rivals.slice(0, 3).map(c => ({ tag: c.el.tagName.toLowerCase(), role: fRole(c.el), name: fName(c.el), visible: fVisible(c.el) }));
          }
          return r;
        }
      }
    }

    return { ok: false, error: 'no fillable field matched', tried: { selector: !!selector, label: !!labelRe } };
  `;
  return await evalJs(script, target);
}

// Trusted typing: real CGEvent keyboard events with isTrusted:true. Plain input/textarea
// only — rich editors are React-controlled and the InputEvent path already works for them.
// The probe clears the field via the setter before typing so the trusted keys land on
// an empty target (avoids appending to existing text or relying on Cmd+A, which would be
// keyboard-layout-dependent on non-US layouts).
async function trustedFill({ ref, selector, label_pattern, text, target }) {
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

// ---- MCP plumbing ----

// Pick an option from a native <select>, a react-select, or an ARIA combobox/listbox in
// one call: resolve the control, open it, filter if searchable, click the matching option,
// and read back what got selected. Uses the async eval path so it can await the option list.
async function select(args = {}) {
  const { ref = null, selector = null, label_pattern = null, text = null, target } = args;
  if (text == null) throw new Error("select requires `text` (the option to choose)");
  if (!ref && !selector && !label_pattern) throw new Error("select requires `ref`, `selector`, or `label_pattern`");
  const script = `
    const refId = ${JSON.stringify(ref)};
    const sel = ${JSON.stringify(selector)};
    const labelRe = ${label_pattern ? `new RegExp(${JSON.stringify(label_pattern)}, 'i')` : "null"};
    const want = ${JSON.stringify(String(text))};
    const d = ms => new Promise(r => setTimeout(r, ms));
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const wantN = norm(want);
    function vis(el) {
      if (!el || el.hidden) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return !(r.width === 0 && r.height === 0);
    }
    function nm(el) {
      return ((el.labels && el.labels[0] && el.labels[0].textContent) || (el.getAttribute && el.getAttribute('aria-label')) || (el.getAttribute && el.getAttribute('placeholder')) || el.name || '').trim().slice(0, 120);
    }
    function ident(el) { return { tag: el.tagName.toLowerCase(), role: (el.getAttribute && el.getAttribute('role')) || el.tagName.toLowerCase(), name: nm(el), visible: vis(el) }; }

    let ctl = null;
    if (refId) ctl = (window.__perch_refs || {})[refId];
    else if (sel) ctl = document.querySelector(sel);
    else if (labelRe) {
      const cands = Array.from(document.querySelectorAll('select, [role=combobox], [aria-haspopup=listbox], [role=listbox]'));
      ctl = cands.filter(vis).find(el => labelRe.test(nm(el)) || labelRe.test((el.closest('label') && el.closest('label').textContent) || '')) || cands.find(el => labelRe.test(nm(el)));
    }
    if (!ctl) return refId ? { __perch_ref_miss: true, ref: refId } : { ok: false, error: 'no select/combobox matched' };

    // Native <select>
    const nativeSel = ctl.tagName === 'SELECT' ? ctl : (ctl.querySelector && ctl.querySelector('select'));
    if (nativeSel && nativeSel.tagName === 'SELECT') {
      const opts = Array.from(nativeSel.options);
      const opt = opts.find(o => norm(o.text) === wantN || norm(o.value) === wantN) || opts.find(o => norm(o.text).indexOf(wantN) >= 0);
      if (!opt) return { ok: false, error: 'no matching option', candidates: opts.slice(0, 8).map(o => o.text.trim()) };
      nativeSel.value = opt.value;
      ['input', 'change'].forEach(t => nativeSel.dispatchEvent(new Event(t, { bubbles: true })));
      return { ok: true, selected: opt.text.trim(), matched: ident(nativeSel) };
    }

    // Custom combobox / react-select / ARIA listbox
    ctl.focus && ctl.focus();
    ctl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    ctl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    ctl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true }));
    const input = ctl.tagName === 'INPUT' ? ctl : (ctl.querySelector && ctl.querySelector('input'));
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, want);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    let opt = null;
    for (let attempt = 0; attempt < 2 && !opt; attempt++) {
      await d(attempt === 0 ? 400 : 300);
      const opts = Array.from(document.querySelectorAll('[role=option]')).filter(vis);
      opt = opts.find(o => norm(o.textContent) === wantN) || opts.find(o => norm(o.textContent).indexOf(wantN) >= 0);
      if (!opt && attempt === 1) return { ok: false, error: 'no matching option after open', candidates: opts.slice(0, 8).map(o => (o.textContent || '').trim()) };
    }
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    opt.click();
    await d(200);
    const shown = (ctl.innerText || ctl.textContent || (input && input.value) || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    return { ok: true, selected: (opt.textContent || '').trim().slice(0, 80), matched: ident(ctl), value: shown };
  `;
  return await evalJs(script, target, { awaitPromise: true });
}

const TARGET_SCHEMA = {
  type: "object",
  description: "Optional; default = active tab of the frontmost browser. windowId/tabIndex come from list_tabs.",
  properties: {
    app: { type: "string" },
    windowId: { type: ["string", "number"] },
    tabIndex: { type: "number" },
  },
};

const TOOLS = [
  {
    name: "list_tabs",
    description: "List open tabs across running browsers (Chrome family, Safari, Arc). `active: true` marks the active tab of the frontmost browser. Prefer the filters over dumping everything; with any filter the result is `{tabs, total}` and `tabIndex` keeps each tab's real window position.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "One browser, e.g. 'Google Chrome', 'Safari', 'Arc'." },
        urlContains: { type: "string", description: "Case-insensitive URL substring filter." },
        titleContains: { type: "string", description: "Case-insensitive title substring filter." },
        limit: { type: "number", description: "Max rows returned; `total` reports matches before the cut." },
      },
    },
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
    name: "activate_tab",
    description: "Bring the target tab and its window to the foreground.",
    inputSchema: { type: "object", properties: { target: TARGET_SCHEMA } },
  },
  {
    name: "navigate",
    description: "Navigate the target tab to a URL. `wait: true` (default) blocks until document.readyState is 'complete'.",
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
    name: "eval_js",
    description: "Run JS in the target tab inside an IIFE; `return <value>` sends the value back. `awaitPromise: true` runs async code and waits for its Promise. Pass `script_path` to load the code from a local file, keeping large scripts out of tool args. Needs the browser's 'Allow JavaScript from Apple Events' toggle; on Arc the target tab must be active (activate_tab first).",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Mutually exclusive with `script_path`." },
        script_path: { type: "string", description: "Absolute or ~/ path to a JS file to run." },
        awaitPromise: { type: "boolean", description: "Default false." },
        timeout: { type: "number", description: "ms, awaitPromise only. Default 30000." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "wait",
    description: "Block until the target tab matches `readyState`/`selector`, or until a polled JS `expression` returns non-null/non-false (returned as `value`). Polls inside one osascript call.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector that must exist." },
        readyState: { type: "string", enum: ["loading", "interactive", "complete"], description: "Minimum readyState. Default 'complete'." },
        expression: { type: "string", description: "JS expression; mutually exclusive with selector/readyState." },
        timeout: { type: "number", description: "ms. Default 10000." },
        interval: { type: "number", description: "Poll interval ms. Default 150." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "screenshot",
    description: "Capture the target browser window. CGWindowID capture reads pixels regardless of z-order, so obscured windows work without stealing focus. An explicit `tabIndex` targeting a non-active tab silently switches the window to it first. Images are downscaled to `maxWidth` before returning. A second text block carries `{window:{x,y,w,h}, image:{w,h}}` (screen points / pixels) for mapping image coordinates to screen: screenX = window.x + imageX * window.w / image.w.",
    inputSchema: {
      type: "object",
      properties: {
        raise: { type: "boolean", description: "Bring window to front before capture. Default false (focus-preserving)." },
        maxWidth: { type: "number", description: "Downscale to this pixel width; 0 = original size. Default 1568." },
        format: { type: "string", enum: ["png", "jpeg"], description: "Default png; jpeg is smaller." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "page_state",
    description: "Return URL, title, readyState, viewport, scroll, document size, and selected meta tags (description, og:*) for the target tab.",
    inputSchema: { type: "object", properties: { target: TARGET_SCHEMA } },
  },
  {
    name: "get_text",
    description: "innerText of an element (default body). Accepts `ref` from accessibility_snapshot instead of `selector`. Output is capped at `maxChars` with a truncation marker; page through long content with `offset`.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector. Default 'body'." },
        ref: { type: "string", description: "Ref from a prior accessibility_snapshot; invalidated by the next snapshot or navigation." },
        maxChars: { type: "number", description: "Default 20000." },
        offset: { type: "number", description: "Start offset for paging. Default 0." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "get_html",
    description: "outerHTML of an element (default <html>). Accepts `ref` from accessibility_snapshot instead of `selector`. Output is capped at `maxChars` with a truncation marker; page with `offset`. Prefer accessibility_snapshot or get_text when you don't need markup.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector. Default 'html'." },
        ref: { type: "string", description: "Ref from a prior accessibility_snapshot." },
        maxChars: { type: "number", description: "Default 20000." },
        offset: { type: "number", description: "Start offset for paging. Default 0." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "accessibility_snapshot",
    description: "Compact tree of interactive + landmark elements (links, buttons, form fields, headings) with stable `ref` IDs that click/fill/get_text/get_html accept in place of selectors. Refs are invalidated by the next snapshot or page navigation; re-snapshot before reusing them. Pass `role` to filter at the walk, shrinking both payload and walk time. Form fields carry `subtype`/`attr_name`/`options`; headings carry `level`. Cheaper than get_html for agent loops.",
    inputSchema: {
      type: "object",
      properties: {
        max: { type: "number", description: "Element cap; result gets `truncated: true` when hit. Default 500." },
        include_bounds: { type: "boolean", description: "Include viewport bounds {x,y,w,h}. Default false." },
        role: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Filter: 'link', 'button', 'textbox', 'combobox', 'checkbox', 'radio', 'heading', 'slider'. Unknown roles return empty.",
        },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "console_capture",
    description: "Capture page console output by patching console methods. `mode`: 'start' installs the wrapper, 'read' drains new entries, 'clear' empties, 'stop' uninstalls and drains. Misses messages logged before start; navigation wipes the buffer (start again after).",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["start", "read", "clear", "stop"], description: "Default 'read'." },
        max: { type: "number", description: "Max buffered entries (only used with `start`). Default 500." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "notify",
    description: "Show a macOS notification, e.g. to ping the user when a long task finishes. Fire-and-forget; shows as from 'Script Editor' (osascript limitation).",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        message:  { type: "string", description: "Body text." },
        title:    { type: "string", description: "Default 'perch'." },
        subtitle: { type: "string" },
        sound:    { type: "string", description: "System sound name (Glass, Ping, Hero, ...). Default 'Glass'." },
      },
    },
  },
  {
    name: "file_upload",
    description: "Set a file on an `<input type=file>` without shipping bytes through agent context; perch reads the file from disk and assigns it in the page. Works on background tabs (except Arc: activate_tab first), never activates the browser. On `{ok: false}` don't retry; the widget likely isn't a plain file input, so fall back to a manual hand-off.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute or ~/ path to the file." },
        selector: { type: "string", description: "File input selector. Default 'input[type=file]'." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "click",
    description: "Click an element by `ref`, `selector`, or screen `x`/`y` (trusted only). Default path is el.click() (isTrusted: false). `trusted: true` posts a real CGEvent mouse click (isTrusted: true) for WAF buttons, React submits that ignore synthetic clicks, and Workday-class validators; it needs Accessibility permission and the window frontmost (or `raise: true`).",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Ref from a prior accessibility_snapshot." },
        selector: { type: "string", description: "CSS selector, used when `ref` is absent." },
        x: { type: "number", description: "Screen X (trusted only), e.g. from a screenshot vision pass." },
        y: { type: "number", description: "Screen Y (trusted only)." },
        button: { type: "string", enum: ["left", "right"], description: "Default 'left'." },
        clickCount: { type: "number", description: "2 for double-click. Default 1." },
        trusted: { type: "boolean", description: "Real CGEvent instead of el.click(). Default false." },
        raise: { type: "boolean", description: "Bring window to front first (trusted only). Default false." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "fill",
    description: "Fill a plain input/textarea or rich-text editor (Quill, TinyMCE, ProseMirror, Froala, contenteditable), then verify the value landed. Target priority: `ref` > `selector` > `label_pattern`. Use `text_path` for long bodies so the text stays out of tool args. `trusted: true` types real keystrokes for plain fields that reject synthetic input (Workday class); needs Accessibility permission and the window frontmost. Rich editors don't need trusted mode.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Mutually exclusive with `text_path`." },
        text_path: { type: "string", description: "Path to a file with the text; for cover letters / long answers." },
        ref: { type: "string", description: "Ref from a prior accessibility_snapshot." },
        selector: { type: "string", description: "CSS selector for the field." },
        label_pattern: { type: "string", description: "Case-insensitive regex against label/aria-label/placeholder/name." },
        trusted: { type: "boolean", description: "Real CGEvent keystrokes; plain input/textarea only. Default false." },
        target: TARGET_SCHEMA,
      },
    },
  },
  {
    name: "select",
    description: "Choose an option from a native <select>, a react-select, or an ARIA combobox/listbox in one call: resolves the control, opens it, filters if searchable, clicks the matching option, and reads back what got selected. Target priority: `ref` > `selector` > `label_pattern`. Returns { ok, selected, matched, value } or { ok:false, error, candidates }.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The option text to choose (case-insensitive; exact match preferred, else substring)." },
        ref: { type: "string", description: "Ref from a prior accessibility_snapshot." },
        selector: { type: "string", description: "CSS selector for the select/combobox control." },
        label_pattern: { type: "string", description: "Case-insensitive regex against the control's label/aria-label." },
        target: TARGET_SCHEMA,
      },
      required: ["text"],
    },
  },
];

export const HANDLERS = {
  list_tabs:     (a) => listTabs(a),
  new_tab:       (a) => newTab(a.url, a.app),
  activate_tab:  (a) => activateTab(a.target),
  navigate:      (a) => navigate(a.url, a.target),
  eval_js:       async (a) => {
    let script = a.script;
    if (a.script_path) {
      if (script) throw new Error("eval_js: pass `script` OR `script_path`, not both");
      ({ data: script } = await readUserFile(a.script_path, "utf8"));
    }
    if (!script) throw new Error("eval_js requires `script` or `script_path`");
    return evalJs(script, a.target, { awaitPromise: a.awaitPromise, timeout: a.timeout });
  },
  wait:          (a) => wait(a),
  screenshot:    (a) => screenshot(a),
  page_state:    (a) => pageState(a.target),
  get_text:      (a) => getText(a),
  get_html:      (a) => getHtml(a),
  accessibility_snapshot: (a) => accessibilitySnapshot(a),
  console_capture:        (a) => consoleCapture(a),
  notify:        (a) => notify(a),
  file_upload:   (a) => fileUpload(a),
  click:         (a) => click(a),
  fill:          (a) => fill(a),
  select:        (a) => select(a),
};

export function formatResult(result) {
  if (result && result.__image) {
    const content = [{ type: "image", data: result.data, mimeType: result.mimeType }];
    if (result.meta) content.push({ type: "text", text: JSON.stringify(result.meta) });
    return { content };
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

export { TOOLS };

// Start only when run as the entry point (realpath: npm's bin is a symlink), so tests can import.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = new Server({ name: "perch", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (req) => handleCall(req.params.name, req.params.arguments || {}));
  await server.connect(new StdioServerTransport());
}
