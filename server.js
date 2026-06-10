#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile, spawn } from "node:child_process";
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

// Default 30s. Tools that intentionally poll longer (wait, evalJs awaitPromise)
// pass their own timeout + JXA_OVERHEAD so the outer process doesn't kill the inner loop.
const JXA_DEFAULT_TIMEOUT = 30000;
const JXA_OVERHEAD = 5000;

function translatePermissionError(msg) {
  if (/Allow JavaScript from Apple Events/i.test(msg) ||
      /Executing JavaScript through AppleScript is turned off/i.test(msg) ||
      /JavaScript from Apple events is turned off/i.test(msg)) {
    return PERMISSION_HINT;
  }
  if (/Not authorized to send Apple events/i.test(msg) ||
      /errAEEventNotPermitted/i.test(msg) ||
      /-1743/.test(msg)) {
    return "Automation permission denied. Grant it in System Settings > Privacy & Security > Automation, " +
           "then tick the target browser under the controlling app (Claude Code / Terminal / iTerm).";
  }
  return null;
}

// One long-lived `osascript -i -l JavaScript` REPL across all tool calls. Realistic
// perch scripts run ~90ms cold-spawn vs ~25ms in the warm REPL — the savings are
// dominated by the JXA bridge's startup, not the fork. Serialize commands via a FIFO
// queue; on any infrastructure failure (process exit, stdin write error, framing
// timeout) the daemon is killed and the call falls back to the one-shot path.
//
// Framing: each script is URI-encoded (one ASCII line, no quotes, no newlines) and
// sent as `eval(decodeURIComponent("..."))` inside an IIFE that catches errors and
// prints a result marker. `<`, `>`, and `:` are always percent-encoded by
// encodeURIComponent, so the markers can't appear inside the result payload.
//
// Disable with PERCH_DAEMON=0.
const DAEMON_DISABLED = process.env.PERCH_DAEMON === "0";

class OsaDaemon {
  constructor() {
    this.proc = null;
    this.queue = [];
    this.current = null;
    this.starting = null;
  }
  async _spawn() {
    const p = spawn("osascript", ["-i", "-l", "JavaScript"], { stdio: ["pipe", "pipe", "pipe"] });
    p.stdout.on("data", d => this._onData(d.toString()));
    p.stderr.on("data", d => this._onData(d.toString()));
    p.stdin.on("error", () => this._onExit());
    p.on("exit",  () => this._onExit());
    p.on("error", () => this._onExit());
    this.proc = p;
    // No robust ready signal from `osascript -i`; a short settle lets the REPL print
    // its initial prompt before we start writing.
    await new Promise(r => setTimeout(r, 150));
  }
  async _ensure() {
    if (this.proc) return;
    if (!this.starting) this.starting = this._spawn().finally(() => { this.starting = null; });
    await this.starting;
  }
  _onData(s) {
    if (!this.current) return;
    this.current.buffer += s;
    const m = this.current.buffer.match(this.current.re);
    if (!m) return;
    const c = this.current;
    this.current = null;
    clearTimeout(c.timer);
    if (m[1] === "O") c.resolve(decodeURIComponent(m[2]));
    else              c.reject(new Error(decodeURIComponent(m[2])));
    this._drain();
  }
  _onExit() {
    if (!this.proc && !this.current && this.queue.length === 0) return;
    const dying = [this.current, ...this.queue].filter(Boolean);
    this.current = null;
    this.queue = [];
    this.proc = null;
    for (const c of dying) {
      if (c.timer) clearTimeout(c.timer);
      c.reject(Object.assign(new Error("osa daemon exited"), { daemonFault: true }));
    }
  }
  _kill() {
    if (this.proc) { try { this.proc.kill("SIGKILL"); } catch (e) {} }
  }
  run(script, timeout) {
    return new Promise((resolve, reject) => {
      this.queue.push({ script, timeout, resolve, reject });
      this._drain();
    });
  }
  async _drain() {
    if (this.current || this.queue.length === 0) return;
    try { await this._ensure(); }
    catch (e) {
      const err = Object.assign(new Error("osa daemon failed to start: " + (e.message || e)), { daemonFault: true });
      while (this.queue.length) this.queue.shift().reject(err);
      return;
    }
    const c = this.queue.shift();
    const id = Math.random().toString(36).slice(2, 10);
    const re = new RegExp(`<<P:${id}:(O|E):([^>]*)>>`);
    const enc = encodeURIComponent(c.script);
    const wrapped =
      `(function(){var __r;try{__r=eval(decodeURIComponent("${enc}"))}` +
      `catch(e){console.log("<<P:${id}:E:"+encodeURIComponent((e&&e.message)?e.message:String(e))+">>");return}` +
      `var __s=__r===undefined||__r===null?"":(typeof __r==="string"?__r:JSON.stringify(__r));` +
      `console.log("<<P:${id}:O:"+encodeURIComponent(__s)+">>")})();\n`;
    const job = {
      buffer: "", re,
      resolve: c.resolve, reject: c.reject,
      timer: setTimeout(() => {
        if (this.current !== job) return;
        this.current = null;
        this._kill();
        job.reject(Object.assign(new Error(
          `osascript timed out after ${c.timeout}ms. Target tab is unreachable — likely a stale ` +
          `tabIndex, a hung page, or (Arc) a background tab the bridge can't reach. Run list_tabs ` +
          `to recheck the tabIndex, then activate_tab on Arc background tabs before retrying. ` +
          `(Real permission errors surface in <1s with their own message, so a 30s timeout is not ` +
          `a permission issue.)`
        ), { daemonFault: true }));
      }, c.timeout),
    };
    this.current = job;
    try { this.proc.stdin.write(wrapped); }
    catch (e) {
      this.current = null;
      clearTimeout(job.timer);
      this._kill();
      job.reject(Object.assign(new Error("osa daemon stdin: " + (e.message || e)), { daemonFault: true }));
    }
  }
}

const daemon = DAEMON_DISABLED ? null : new OsaDaemon();

async function jxa(script, options = {}) {
  const { timeout = JXA_DEFAULT_TIMEOUT } = options;
  if (daemon) {
    try {
      return await daemon.run(script, timeout);
    } catch (e) {
      if (!e.daemonFault) {
        // Real JS-side error from the script. Translate permission hints, rethrow.
        const translated = translatePermissionError(String(e.message || e));
        if (translated) throw new Error(translated);
        throw e;
      }
      // Infrastructure failure: fall through to one-shot. Next call lazily respawns.
    }
  }
  return jxaOneShot(script, { timeout });
}

async function jxaOneShot(script, options = {}) {
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
        `osascript timed out after ${timeout}ms. Target tab is unreachable — likely a stale ` +
        `tabIndex, a hung page, or (Arc) a background tab the bridge can't reach. Run list_tabs ` +
        `to recheck the tabIndex, then activate_tab on Arc background tabs before retrying. ` +
        `(Real permission errors surface in <1s with their own message, so a 30s timeout is not ` +
        `a permission issue.)`
      );
    }
    const msg = String(e.stderr || e.message || e);
    const translated = translatePermissionError(msg);
    if (translated) throw new Error(translated);
    if (e.code === 1 && !msg.trim()) {
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

function buildEvalWrapper(userScript) {
  return `(function(){ try { var __r = (function(){ ${userScript} })(); return JSON.stringify(__r === undefined ? null : __r); } catch(e) { return JSON.stringify({__perch_error: (e && e.message) ? e.message : String(e)}); } })()`;
}

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
  const { app: filterApp = null } = args;
  const src = `
    ${FRONTMOST}
    const browsers = ${JSON.stringify(BROWSERS)};
    const filterApp = ${JSON.stringify(filterApp)};
    const out = [];
    for (const b of browsers) {
      if (filterApp && b.app !== filterApp) continue;
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
          // The active flag is only reported for window 0 of the frontmost browser;
          // skip the detection round-trips everywhere else.
          let activeIdx = -1;
          if (w === 0 && b.app === fm) {
            if (b.kind === 'chrome') {
              try { activeIdx = win.activeTabIndex() - 1; } catch (e) {}
            } else if (b.kind === 'arc') {
              try { activeIdx = win.tabs.id().indexOf(win.activeTab.id()); } catch (e) {}
            } else {
              try { activeIdx = win.tabs.index().indexOf(win.currentTab().index()); } catch (e) {}
            }
          }
          for (let t = 0; t < urls.length; t++) {
            out.push({ app: b.app, windowId: winId, tabIndex: t, url: urls[t] || '', title: titles[t] || '', active: t === activeIdx });
          }
        }
      } catch (e) {}
    }
    JSON.stringify(out);
  `;
  let tabs = JSON.parse(await jxa(src));
  const { urlContains, titleContains, limit } = args;
  if (urlContains == null && titleContains == null && limit == null) return tabs;
  if (urlContains) tabs = tabs.filter(t => t.url.toLowerCase().includes(String(urlContains).toLowerCase()));
  if (titleContains) tabs = tabs.filter(t => t.title.toLowerCase().includes(String(titleContains).toLowerCase()));
  const total = tabs.length;
  if (limit != null && tabs.length > limit) tabs = tabs.slice(0, Math.max(0, limit));
  // tabIndex fields keep their original window positions, so filtered rows stay addressable.
  return { tabs, total };
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
      let arcBg = false;
      if (tab_kind === 'arc') {
        let isCurrent = false;
        try { isCurrent = ${ARC_TAB_IS_ACTIVE}; } catch (e) {}
        if (!isCurrent) arcBg = true;
      }
      let outcome;
      if (arcBg) {
        outcome = JSON.stringify({__perch_arc_bg: true});
      } else {
        const __kickJs = ${JSON.stringify(kickoff)};
        const __pollJs = ${JSON.stringify(poll)};
        ${execTabJsFragment("__kick", "__kickJs")}
        const start = Date.now();
        const timeout = ${timeout};
        outcome = JSON.stringify({__perch_timeout: true});
        while (Date.now() - start < timeout) {
          let r = 'null';
          try {
            ${execTabJsFragment("__r", "__pollJs")}
            // null/'' from the bridge mean "nothing yet", matching the old
            // String(x || 'null'); the poll otherwise returns non-empty JSON.
            r = (__r == null || __r === '') ? 'null' : String(__r);
          } catch (e) {}
          if (r !== 'null') { outcome = r; break; }
          delay(0.05);
        }
      }
      outcome;
    `;
    const raw = await jxa(src, { timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD });
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return raw; }
    if (parsed && parsed.__perch_arc_bg) throw new Error("Arc cannot eval_js on background tabs; call activate_tab on this target first, or operate on Arc's current tab.");
    if (parsed && parsed.__perch_timeout) throw new Error(`eval_js (awaitPromise) timed out after ${timeout}ms`);
    if (parsed && parsed.ok === false) return { __perch_error: parsed.error };
    return parsed && Object.prototype.hasOwnProperty.call(parsed, "value") ? parsed.value : parsed;
  }

  const wrapped = buildEvalWrapper(script);
  const src = `
    ${targetClause(target)}
    const __evalJs = ${JSON.stringify(wrapped)};
    let raw;
    let arcBg = false;
    if (tab_kind === 'arc') {
      // Arc tab.execute hangs on background tabs — pre-check we're the active tab.
      let isCurrent = false;
      try { isCurrent = ${ARC_TAB_IS_ACTIVE}; } catch (e) {}
      arcBg = !isCurrent;
    }
    if (arcBg) raw = '__PERCH_ARC_BG__';
    else {
      ${execTabJsFragment("__raw", "__evalJs")}
      raw = __raw;
    }
    raw == null ? 'null' : String(raw);
  `;
  const raw = await jxa(src);
  if (raw === '__PERCH_ARC_BG__') {
    throw new Error("Arc cannot eval_js on background tabs; call activate_tab on this target first, or operate on Arc's current tab.");
  }
  try { return JSON.parse(raw); } catch { return raw; }
}

async function wait(args = {}, target) {
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
    let arcBg = false;
    if (tab_kind === 'arc') {
      let isCurrent = false;
      try { isCurrent = ${ARC_TAB_IS_ACTIVE}; } catch (e) {}
      if (!isCurrent) arcBg = true;
    }
    let outcome;
    if (arcBg) {
      outcome = JSON.stringify({ok: false, arc_background: true});
    } else {
      const start = Date.now();
      const timeout = ${timeout};
      const interval = ${interval};
      outcome = JSON.stringify({ok: false, timeout: true});
      const __checkJs = ${JSON.stringify(wrapped)};
      while (Date.now() - start < timeout) {
        let resultStr = 'null';
        try {
          ${execTabJsFragment("__chk", "__checkJs")}
          resultStr = (__chk == null || __chk === '') ? 'null' : String(__chk);
        } catch (e) {}
        let parsed = null;
        try { parsed = JSON.parse(resultStr); } catch (e) {}
        if (parsed !== null && parsed !== false) {
          outcome = JSON.stringify({ok: true, waited: Date.now() - start, value: parsed});
          break;
        }
        delay(interval / 1000);
      }
    }
    outcome;
  `;
  const out = JSON.parse(await jxa(src, { timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD }));
  if (out.arc_background) throw new Error("Arc cannot wait on background tabs; call activate_tab on this target first, or operate on Arc's current tab.");
  if (!out.ok) throw new Error(`wait timed out after ${timeout}ms`);
  if (!expression) return { ok: true, waited: out.waited };
  return out;
}

// Param must not be named `wait` — it would shadow the module-level wait() called below.
async function navigate(url, target, waitForLoad = true) {
  const src = `
    ${targetClause(target)}
    // Safari's tab.url assignment only takes effect on the document's currentTab —
    // make our target current first. Chrome family accepts it on any tab.
    if (tab_kind === 'safari') { try { tab_window.currentTab = tab; } catch (e) {} }
    tab.url = ${JSON.stringify(url)};
    'ok';
  `;
  await jxa(src);
  if (waitForLoad) {
    try { await wait({ readyState: "complete", timeout: 15000 }, target); }
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
    let newTabId = null;
    if (kind === 'chrome' || kind === 'arc') {
      if (!app.windows.length) app.Window().make();
      win = app.windows[0];
      const t = app.Tab({ url: ${JSON.stringify(targetUrl)} });
      win.tabs.push(t);
      try {
        if (kind === 'arc') {
          try { newTabId = t.id(); } catch (e) {}
          // Prefer the pushed specifier (race-free); fall back to positional.
          try { t.select(); } catch (e) { win.tabs[win.tabs.length - 1].select(); }
        }
        else win.activeTabIndex = win.tabs.length;
      } catch (e) {}
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
    // Arc inserts new tabs mid-collection (sidebar "Today" section), so length-1
    // is wrong there; resolve the pushed tab's real position by UUID.
    let tabIndex = null;
    try {
      if (kind === 'arc' && newTabId != null) {
        const i = win.tabs.id().indexOf(newTabId);
        tabIndex = i >= 0 ? i : null;
      } else tabIndex = win.tabs.length - 1;
    } catch (e) {}
    JSON.stringify({ windowId: winId, tabIndex });
  `;
  const { windowId = null, tabIndex = null } = JSON.parse(await jxa(src));
  return { ok: true, app: browser.app, url: targetUrl, windowId, tabIndex };
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
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      scroll: { x: window.scrollX, y: window.scrollY },
      doc: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      meta: (function() {
        const keep = ['description', 'og:title', 'og:description', 'og:image'];
        const out = {};
        document.querySelectorAll('meta').forEach(m => {
          const k = m.getAttribute('name') || m.getAttribute('property');
          if (k && keep.indexOf(k) >= 0 && !(k in out)) out[k] = m.getAttribute('content');
        });
        return out;
      })()
    };
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

    function setPlain(el) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      ['input', 'change', 'blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
      return (el.value || '').trim().length >= expectedLen;
    }
    function setRich(root) {
      root.focus();
      root.innerHTML = text.split(/\\n\\n+/).map(p => '<p>' + p.replace(/\\n/g, '<br>') + '</p>').join('');
      ['input', 'change', 'blur'].forEach(t => root.dispatchEvent(new InputEvent(t, { bubbles: true, inputType: 'insertText', data: text })));
      return (root.innerText || root.textContent || '').trim().length >= richMinLen;
    }
    function isRich(el) {
      return el && (el.isContentEditable || el.classList?.contains('fr-element') || el.classList?.contains('ql-editor') || el.classList?.contains('ProseMirror'));
    }
    function tryFill(el, kindLabel) {
      if (!el) return null;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        if (setPlain(el)) return { ok: true, kind: 'plain_' + kindLabel, len: el.value.length };
      }
      if (isRich(el)) {
        if (setRich(el)) return { ok: true, kind: 'rich_' + kindLabel, len: (el.innerText || '').length };
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
      const r = tryFill(document.querySelector(selector), 'selector');
      if (r) return r;
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
      case "list_tabs":     result = await listTabs(args); break;
      case "new_tab":       result = await newTab(args.url, args.app); break;
      case "activate_tab":  result = await activateTab(args.target); break;
      case "navigate":      result = await navigate(args.url, args.target, args.wait !== false); break;
      case "eval_js": {
        let script = args.script;
        if (args.script_path) {
          if (script) throw new Error("eval_js: pass `script` OR `script_path`, not both");
          ({ data: script } = await readUserFile(args.script_path, "utf8"));
        }
        if (!script) throw new Error("eval_js requires `script` or `script_path`");
        result = await evalJs(script, args.target, { awaitPromise: args.awaitPromise, timeout: args.timeout });
        break;
      }
      case "wait":          result = await wait(args, args.target); break;
      case "screenshot":    result = await screenshot(args); break;
      case "page_state":    result = await pageState(args.target); break;
      case "get_text":      result = await getText(args); break;
      case "get_html":      result = await getHtml(args); break;
      case "accessibility_snapshot": result = await accessibilitySnapshot(args); break;
      case "console_capture":        result = await consoleCapture(args); break;
      case "notify":        result = await notify(args); break;
      case "file_upload":   result = await fileUpload(args); break;
      case "click":         result = await click(args); break;
      case "fill":          result = await fill(args); break;
      default: throw new Error(`unknown tool: ${name}`);
    }
    if (result && result.__image) {
      const content = [{ type: "image", data: result.data, mimeType: result.mimeType }];
      if (result.meta) content.push({ type: "text", text: JSON.stringify(result.meta) });
      return { content };
    }
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
