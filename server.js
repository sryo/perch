#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile, spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// `key` prefixes tab handles; `bundle` maps the system default browser to an app.
const BROWSERS = [
  { app: "Google Chrome",        kind: "chrome", key: "chrome",      bundle: "com.google.Chrome" },
  { app: "Google Chrome Beta",   kind: "chrome", key: "chrome-beta", bundle: "com.google.Chrome.beta" },
  { app: "Google Chrome Canary", kind: "chrome", key: "canary",      bundle: "com.google.Chrome.canary" },
  { app: "Brave Browser",        kind: "chrome", key: "brave",       bundle: "com.brave.Browser" },
  { app: "Microsoft Edge",       kind: "chrome", key: "edge",        bundle: "com.microsoft.edgemac" },
  { app: "Vivaldi",              kind: "chrome", key: "vivaldi",     bundle: "com.vivaldi.Vivaldi" },
  { app: "Arc",                  kind: "arc",    key: "arc",         bundle: "company.thebrowser.Browser" },
  { app: "Safari",               kind: "safari", key: "safari",      bundle: "com.apple.Safari" },
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
  ObjC.import("Foundation");
  const KIND = {}, KEY = {}, BY_KEY = {};
  BROWSERS.forEach((b) => { KIND[b.app] = b.kind; KEY[b.app] = b.key; BY_KEY[b.key] = b.app; });

  // Errors start with a stable, browser-neutral code that clients branch on.
  const notVisible = (what) => "tab_not_visible: " + what + " needs the tab its window shows; activate_tab (takes focus) or retry later";
  const OFFSCREEN = "window_offscreen: the browser window isn't on screen (minimized or on another Space)";

  // Tab handles are opaque to clients: "<key>:<raw id>". Chromium ids are
  // per-process counters, so the key keeps two Chromium apps from colliding.
  // Safari tabs have no id, so theirs is "safari:<windowId>.<index>.<url hash>",
  // re-found by URL when the index moved; a navigation makes it stale.
  function fp(url) {
    // Safari reports a blank tab's URL as null; treat null, "" and about:blank alike.
    const str = !url || url === "about:blank" ? "" : String(url).split("#")[0];
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36);
  }
  const handle = (name, raw) => KEY[name] + ":" + raw;
  const safariHandle = (winId, i, url) => "safari:" + winId + "." + i + "." + fp(url);
  function parseHandle(h) {
    const m = /^([a-z-]+):(.+)$/.exec(String(h));
    return m && BY_KEY[m[1]] ? { app: BY_KEY[m[1]], raw: m[2] } : null;
  }
  function handleOf(t) {
    try {
      if (t.kind === "safari") return safariHandle(t.win.id(), t.idx, t.tab.url());
      if (t.tabId != null) return handle(t.app, t.tabId);
    } catch (e) {}
    return null;
  }
  const apps = {};
  const app = (name) => apps[name] || (apps[name] = Application(name));

  // Touching a quit app's windows relaunches it; on screen means running.
  function alive(name, P) {
    if (P && P.z.indexOf(name) >= 0) return true;
    try { return app(name).running(); } catch (e) { return false; }
  }

  // Each Apple Event to a browser costs about one display frame (~16ms live),
  // while CGWindowList and running() cost well under that, so the hot paths
  // below count events. errAENoSuchObject (or a bad index) means the specifier
  // matched nothing, so the page script never ran and a slower path may retry.
  const noSuchObject = (e) => !!e && (e.errorNumber === -1728 || e.errorNumber === -1719);

  // Chromium handle -> {w: window position, id: the tab's native id}, learned
  // from list_tabs, new_tab and resolve. `windows[w].tabs.byId(id)` pins the
  // exact tab, so a wrong hint can only miss (errAENoSuchObject), never mis-target.
  let hints = {}, hintCount = 0;
  function hint(name, id, w) {
    if (KIND[name] !== "chrome" || id == null) return;
    if (++hintCount > 5000) { hints = {}; hintCount = 0; }
    hints[handle(name, id)] = { w: w, id: id };
  }

  // One CGWindowList read replaces System Events: z-order of on-screen browsers,
  // the frontmost app, pids and CGWindowIDs. ~4ms vs ~60ms for a System Events
  // `frontmost` query, and it needs no extra permission.
  function procs() {
    const out = { front: null, frontPid: null, frontWid: null, z: [], pid: {}, wins: {} };
    let list = [];
    try { list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || []; } catch (e) {}
    for (const w of list) {
      const b = w.kCGWindowBounds || {};
      if (w.kCGWindowLayer !== 0 || b.Width < 100 || b.Height < 100) continue;
      const owner = w.kCGWindowOwnerName;
      if (out.front === null) { out.front = owner; out.frontPid = w.kCGWindowOwnerPID; out.frontWid = w.kCGWindowNumber; }
      if (!KIND[owner]) continue;
      if (!out.wins[owner]) { out.z.push(owner); out.pid[owner] = w.kCGWindowOwnerPID; out.wins[owner] = []; }
      out.wins[owner].push({ wid: w.kCGWindowNumber, name: w.kCGWindowName || "", x: b.X, y: b.Y, w: b.Width, h: b.Height });
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

  // -1 when the window shows no tab (a fresh Arc window) or the read fails.
  function activeIndex(kind, win, tabs) {
    try {
      if (kind === "chrome") return win.activeTabIndex() - 1;
      if (kind === "arc") return tabs.id().indexOf(win.activeTab.id());
      return win.currentTab.index() - 1;
    } catch (e) { return -1; }
  }

  // Arc's `win.tabs` order is unrelated to the sidebar (effectively random) and
  // includes Favorites. Display order: Favorites, then the active space's sidebar,
  // then anything left. order[k] is the raw `win.tabs` position of display row k.
  function arcOrder(win) {
    const ids = win.tabs.id();
    let loc = [], side = [];
    try { loc = win.tabs.location(); } catch (e) {}
    try { side = win.activeSpace.tabs.id(); } catch (e) {}
    const pos = {}, seen = {}, order = [];
    ids.forEach(function (id, i) { pos[id] = i; });
    const add = function (i) { if (i != null && !seen[ids[i]]) { seen[ids[i]] = true; order.push(i); } };
    ids.forEach(function (id, i) { if (loc[i] === "topApp") add(i); });
    side.forEach(function (id) { add(pos[id]); });
    ids.forEach(function (id, i) { add(i); });
    return { ids: ids, loc: loc, order: order };
  }

  // Arc windows on one space share the same tabs, and a tab can be active in
  // several windows at once. execute only works through a window where the tab is
  // active (it hangs through any other), so a tabId prefers such a window.
  function resolveById(want, P) {
    const key = String(want.raw);
    // A hinted Chromium window first: one event instead of a window walk.
    const hn = want.windowId == null && hints[want.tabId];
    if (hn && alive(want.app, P)) {
      try {
        const win = app(want.app).windows[hn.w], i = win.tabs.id().map(String).indexOf(key);
        if (i >= 0) return { tab: win.tabs.byId(hn.id), idx: i, tabId: hn.id, kind: "chrome", app: want.app, win, w: hn.w, P };
      } catch (e) {}
      delete hints[want.tabId];
    }
    for (const name of candidates(P, want.app)) {
      const a = app(name), kind = KIND[name];
      if (kind === "safari") continue;
      let n;
      try { n = a.windows.length; } catch (e) { continue; }
      let fallback = null;
      for (let w = 0; w < n; w++) {
        const win = a.windows[w];
        if (want.windowId != null) {
          let id; try { id = win.id(); } catch (e) { id = w; }
          if (String(id) !== String(want.windowId)) continue;
        }
        let ids;
        try { ids = win.tabs.id(); } catch (e) { continue; }
        const i = ids.map(String).indexOf(key);
        if (i < 0) continue;
        const t = { tab: win.tabs.byId(ids[i]), idx: i, tabId: ids[i], kind, app: name, win, w, P };
        hint(name, ids[i], w);
        if (kind !== "arc" || isActive(t)) return t;
        if (!fallback) fallback = t;
      }
      if (fallback) return fallback;
    }
    throw new Error("stale_tab: tab " + want.tabId + " is gone; re-run list_tabs");
  }

  function resolveSafari(want, raw, P) {
    const parts = raw.split("."), winId = parts[0], idx = Number(parts[1]), hash = parts.slice(2).join(".");
    if (!alive("Safari", P)) throw new Error("stale_tab: tab " + want.tabId + " is gone (its browser quit); re-run list_tabs");
    const a = app("Safari");
    const nearest = function (urls) {
      let best = -1;
      urls.forEach(function (u, i) { if (fp(u) === hash && (best < 0 || Math.abs(i - idx) < Math.abs(best - idx))) best = i; });
      return best;
    };
    // The recorded window by id: one event when the tab is still in it.
    if (/^\d+$/.test(winId)) {
      try {
        const win = a.windows.byId(Number(winId)), best = nearest(win.tabs.url());
        if (best >= 0) return { tab: win.tabs[best], idx: best, tabId: null, kind: "safari", app: "Safari", win, w: null, P };
      } catch (e) {}
    }
    let n = 0; try { n = a.windows.length; } catch (e) {}
    // The recorded window first, then the rest: the tab may have been dragged out.
    const order = [];
    for (let w = 0; w < n; w++) {
      let id = null; try { id = String(a.windows[w].id()); } catch (e) {}
      if (id === winId) order.unshift(w); else order.push(w);
    }
    for (const w of order) {
      const win = a.windows[w];
      let urls; try { urls = win.tabs.url(); } catch (e) { continue; }
      const best = nearest(urls);
      if (best >= 0) return { tab: win.tabs[best], idx: best, tabId: null, kind: "safari", app: "Safari", win, w, P };
    }
    throw new Error("stale_tab: tab " + want.tabId + " is gone (closed or navigated); re-run list_tabs");
  }

  // Tabs are pinned by id where the browser has one: `tabs[i]` is positional and
  // re-evaluated on every use, so a long poll could drift to another tab.
  function resolve(want) {
    want = want || {};
    const P = procs();
    if (want.tabId != null) {
      const h = parseHandle(want.tabId);
      if (h && KIND[h.app] === "safari") return resolveSafari(want, h.raw, P);
      // A bare id (from before handles) is searched across browsers, narrowed by `app`.
      return resolveById({ tabId: want.tabId, raw: h ? h.raw : String(want.tabId), app: h ? h.app : want.app, windowId: want.windowId }, P);
    }
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
        let tabs, len;
        try { tabs = win.tabs; len = tabs.length; if (!len) continue; } catch (e) { continue; }
        if (kind === "arc") {
          let id;
          if (want.tabIndex != null) {
            const o = arcOrder(win);
            if (want.tabIndex < 0 || want.tabIndex >= o.order.length) throw new Error("stale_tab: tabIndex " + want.tabIndex + " out of range; window has " + o.order.length + " tabs");
            id = o.ids[o.order[want.tabIndex]];
          } else {
            try { id = win.activeTab.id(); } catch (e) { continue; }
          }
          return { tab: tabs.byId(id), idx: want.tabIndex, tabId: id, kind, app: name, win, w, P };
        }
        const idx = want.tabIndex != null ? want.tabIndex : activeIndex(kind, win, tabs);
        if (idx < 0 || idx >= len) {
          if (want.tabIndex != null) throw new Error("stale_tab: tabIndex " + want.tabIndex + " out of range; window has " + len + " tabs");
          continue;
        }
        let tab = tabs[idx], tabId = null;
        if (kind === "chrome") { try { tabId = tab.id(); tab = tabs.byId(tabId); } catch (e) {} }
        return { tab, idx, tabId, kind, app: name, win, w, P };
      }
    }
    throw new Error(want.app && !KIND[want.app] ? "no_browser: unknown browser " + want.app : "no_browser: no browser window with an open tab" + (want.app ? " in " + want.app : ""));
  }

  // Chrome tabs have no `index` property (it throws), so positions come from resolve.
  function isActive(t) {
    try {
      if (t.kind === "chrome") {
        if (t.tabId != null) return String(t.win.activeTab.id()) === String(t.tabId);
        return t.win.activeTabIndex() === t.idx + 1;
      }
      if (t.kind === "arc") return String(t.win.activeTab.id()) === String(t.tabId);
      return t.win.currentTab.index() === t.idx + 1;
    } catch (e) { return false; }
  }

  // Switches the window's visible tab without raising the window or the app.
  function selectTab(t) {
    if (isActive(t)) return false;
    try {
      // Chrome has no tab `select` verb; re-read the position, since it may have moved.
      if (t.kind === "chrome") t.win.activeTabIndex = (t.tabId != null ? t.win.tabs.id().map(String).indexOf(String(t.tabId)) : t.idx) + 1;
      // Arc forbids writing activeTab/currentTab; its `select` verb works.
      else if (t.kind === "arc") t.tab.select();
      else t.win.currentTab = t.tab;
    } catch (e) { return false; }
    return true;
  }

  // windows[w] is a by-position specifier and raising reorders the list, so pin the
  // window (and tab) by id first; afterwards it is the app's front window.
  function focus(t) {
    try {
      t.win = app(t.app).windows.byId(t.win.id());
      t.tab = t.tabId != null ? t.win.tabs.byId(t.tabId) : t.win.tabs[t.idx];
    } catch (e) {}
    try { t.win.index = 1; t.w = 0; } catch (e) {}
    selectTab(t);
    app(t.app).activate();
  }

  // Arc's execute hangs (until timeout) on background tabs and on its own arc://
  // pages (a new tab sits on arc://newtab until its URL commits); refuse up front.
  function visibleGuard(t, tool) {
    if (t.kind !== "arc") return;
    if (!isActive(t)) throw new Error(notVisible(tool));
    let url = ""; try { url = t.tab.url(); } catch (e) {}
    if (/^arc:/i.test(url)) throw new Error("tab_not_scriptable: " + tool + " can't run on the browser's own pages (new tab, settings); navigate the tab to a web page first");
  }

  function exec(t, js) {
    if (t.kind === "safari") {
      try { return app(t.app).doJavaScript(js, { in: t.tab }); }
      catch (e) { if (!isActive(t)) throw new Error(notVisible("page JS")); throw e; }
    }
    const x = t.tab.execute({ javascript: js });
    // Arc JSON.stringifies whatever execute returns; perch's wrappers already did.
    if (t.kind === "arc") { try { return JSON.parse(x); } catch (e) { return x; } }
    return x;
  }

  // One-event page JS for a target that needs no guard: a Chromium handle with a
  // window hint, a Safari handle (the page checks its own URL hash first), or the
  // default target when the topmost browser is Chromium or Safari. Returns {v},
  // or null (only when the script cannot have run) for the full resolve path.
  const WRONG_TAB = "__perch_wrong_tab__";
  function quickExec(want, js) {
    want = want || {};
    if (want.windowId != null || want.tabIndex != null) return null;
    if (want.tabId != null) {
      const h = parseHandle(want.tabId);
      if (!h) return null;
      if (KIND[h.app] === "safari") {
        const m = /^(\d+)\.(\d+)\.(.+)$/.exec(h.raw);
        if (!m || !alive("Safari", procs())) return null;
        const guarded = "(function(){if((" + fp + ")(location.href)!==" + JSON.stringify(m[3]) + ")return " + JSON.stringify(WRONG_TAB) + ";return (" + js + ")})()";
        let v;
        try { v = app("Safari").doJavaScript(guarded, { in: app("Safari").windows.byId(Number(m[1])).tabs[Number(m[2])] }); }
        catch (e) { if (e && e.errorNumber === -1712) throw e; return null; }
        return v === WRONG_TAB ? null : { v: v };
      }
      const hn = hints[want.tabId];
      if (KIND[h.app] !== "chrome" || !hn || !alive(h.app, procs())) return null;
      try { return { v: app(h.app).windows[hn.w].tabs.byId(hn.id).execute({ javascript: js }) }; }
      catch (e) { if (noSuchObject(e)) { delete hints[want.tabId]; return null; } throw e; }
    }
    if (want.app != null) return null;
    const top = procs().z[0], kind = KIND[top];
    if (!top || (kind !== "chrome" && kind !== "safari")) return null;
    const win = app(top).windows[0];
    try {
      if (kind === "chrome") return { v: win.activeTab.execute({ javascript: js }) };
      return { v: app(top).doJavaScript(js, { in: win.currentTab }) };
    } catch (e) {
      if (noSuchObject(e) || (kind === "safari" && !(e && e.errorNumber === -1712))) return null;
      throw e;
    }
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


  // Window geometry plus the pid and CGWindowID that screencapture -l and CGEvent
  // routing need. Chrome has position()/size(), Safari bounds(); Arc has neither,
  // so its frame comes from its own CG entry. AppleScript reports inner-content
  // bounds while CG includes the titlebar, so the closest CG entry wins.
  function ids(t) {
    let geom = null;
    try { const p = t.win.position(), s = t.win.size(); geom = { x: p[0], y: p[1], w: s[0], h: s[1] }; } catch (e) {}
    if (!geom) { try { const b = t.win.bounds(); geom = { x: b.x, y: b.y, w: b.width, h: b.height }; } catch (e) {} }
    const cands = t.P.wins[t.app] || [];
    let best = null;
    if (geom) {
      let bestScore = Infinity;
      cands.forEach(function (c) {
        const score = Math.abs(c.x - geom.x) + Math.abs(c.y - geom.y) + Math.abs(c.w - geom.w) + Math.abs(c.h - geom.h);
        if (score < bestScore) { bestScore = score; best = c; }
      });
    } else {
      best = byTitle(t, cands) || cands[t.w] || cands[0] || null;
      if (best) geom = { x: best.x, y: best.y, w: best.w, h: best.h };
    }
    if (!geom) throw new Error(OFFSCREEN);
    return {
      geom: geom,
      pid: t.P.pid[t.app] == null ? null : t.P.pid[t.app],
      windowNumber: best ? best.wid : null,
      cgBounds: best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null,
    };
  }

  // Arc has no geometry verbs, so its window is matched to a CG entry by title.
  // Both lists run front to back, so same-titled windows pair up in order.
  function byTitle(t, cands) {
    try {
      const wins = app(t.app).windows;
      const pos = wins.id().map(String).indexOf(String(t.win.id()));
      const names = wins.name();
      if (pos < 0 || !names[pos]) return null;
      const rank = names.slice(0, pos).filter(function (n) { return n === names[pos]; }).length;
      const same = cands.filter(function (c) { return c.name === names[pos]; });
      return same[rank] || same[0] || null;
    } catch (e) { return null; }
  }

  function requireAccessibility() {
    ObjC.import("ApplicationServices");
    // Read-only permission check; AXIsProcessTrusted never triggers the grant prompt.
    if (!$.AXIsProcessTrusted()) {
      throw new Error("Accessibility permission required: System Settings > Privacy & Security > Accessibility, enable the app running perch (Codex / ChatGPT / Terminal / iTerm), then retry.");
    }
  }

  // Resolves the target for trusted input: permission, optional foreground, ids.
  function trustedTarget(a) {
    const t = resolve(a.target);
    requireAccessibility();
    if (a.raise) { focus(t); delay(0.2); t.P = procs(); }
    else if (!isActive(t)) throw new Error(notVisible("a background trusted click") + ", or pass raise:true");
    const I = ids(t);
    if (I.windowNumber == null) throw new Error(OFFSCREEN);
    if (a.raise && t.P.front !== t.app) throw new Error("target did not become frontmost after raise");
    return { t: t, I: I, background: !a.raise };
  }

  // The explicit raise path uses the HID tap and restores the real cursor.
  // The default route addresses the exact pid/window through SkyLight. Chromium
  // needs the window/gesture fields and an off-screen primer pair; a bare
  // SLEventPostToPid (as in the old --delivery probe) is ignored by its renderer.
  // Field 1 is kCGMouseEventClickState, 11 kCGMouseEventPressure (raw indices:
  // $.kCG* constants aren't reliably bridged).
  function mouse(I, pt, type, state, pressure) {
    const r = I.cgBounds || I.geom;
    if (!(pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h)) {
      throw new Error("point " + Math.round(pt.x) + "," + Math.round(pt.y) + " is outside the target window; nothing was clicked");
    }
    const e = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(pt.x, pt.y), 0);
    $.CGEventSetIntegerValueField(e, 1, state);
    $.CGEventSetDoubleValueField(e, 11, pressure);
    $.CGEventPost(0, e); // kCGHIDEventTap
  }

  function leftClick(I, pt) {
    mouse(I, pt, 1, 1, 1.0); // kCGEventLeftMouseDown
    delay(0.012);
    mouse(I, pt, 2, 1, 0.0); // kCGEventLeftMouseUp
  }

  let skyReady = false;
  function skyInit() {
    if (skyReady) return;
    ObjC.bindFunction("dlopen", ["void *", ["char *", "int"]]);
    if (!$.dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", 2)) {
      throw new Error("SkyLight framework unavailable; use raise:true for foreground trusted input");
    }
    ObjC.bindFunction("SLEventPostToPid", ["void", ["int", "void *"]]);
    ObjC.bindFunction("SLEventSetIntegerValueField", ["void", ["void *", "unsigned int", "long long"]]);
    ObjC.bindFunction("CGEventSetWindowLocation", ["void", ["void *", "double", "double"]]);
    skyReady = true;
  }

  function skyMouse(I, pt, type, phase, clickState, group) {
    skyInit();
    if (I.pid == null || I.windowNumber == null) throw new Error("SkyLight target has no pid/window id");
    const e = $.CGEventCreateMouseEvent($.CGEventSourceCreate(1), type, $.CGPointMake(pt.x, pt.y), 0);
    // Command permits delivery to a background window. Release it on mouseup
    // so Chromium emits an ordinary click rather than a Command-click.
    if (type !== 2) $.CGEventSetFlags(e, 0x100000);
    const set = function (field, value) { $.SLEventSetIntegerValueField(e, field, value); };
    set(0, phase); set(1, clickState); set(3, 0); set(7, 3);
    set(40, I.pid); set(51, I.windowNumber); set(58, group);
    set(91, I.windowNumber); set(92, I.windowNumber);
    // This SPI expects the point relative to the target window. Passing the
    // screen point shifts background Chrome clicks by the window's origin.
    const r = I.cgBounds || I.geom;
    const primer = pt.x === -1 && pt.y === -1;
    $.CGEventSetWindowLocation(e, primer ? -1 : pt.x - r.x, primer ? -1 : pt.y - r.y);
    $.SLEventPostToPid(I.pid, e);
  }

  function skyClick(I, pt) {
    const r = I.cgBounds || I.geom;
    if (!(pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h)) {
      throw new Error("point " + Math.round(pt.x) + "," + Math.round(pt.y) + " is outside the target window; nothing was clicked");
    }
    const group = Date.now() % 1000000000;
    skyMouse(I, pt, 5, 2, 0, group);
    delay(0.015);
    skyMouse(I, { x: -1, y: -1 }, 1, 1, 1, group);
    delay(0.001);
    skyMouse(I, { x: -1, y: -1 }, 2, 2, 1, group);
    delay(0.1);
    skyMouse(I, pt, 1, 3, 1, group);
    delay(0.001);
    skyMouse(I, pt, 2, 3, 1, group);
  }

  const cursorAt = () => { const p = $.CGEventGetLocation($.CGEventCreate($())); return { x: p.x, y: p.y }; };

  // Chunks are pre-split in Node (<= 20 UTF-16 units, CGEvent's buffer cap,
  // never splitting a surrogate pair).
  function typeChunks(chunks) {
    // The stock bridge signature rejects NSData bytes as a UniChar*; rebinding it
    // with void* parameters passes them through.
    ObjC.bindFunction("CGEventKeyboardSetUnicodeString", ["void", ["void *", "unsigned long", "void *"]]);
    chunks.forEach(function (chunk) {
      const data = $(chunk).dataUsingEncoding(0x94000100); // NSUTF16LittleEndianStringEncoding
      [true, false].forEach(function (down) {
        const e = $.CGEventCreateKeyboardEvent($(), 0, down);
        $.CGEventKeyboardSetUnicodeString(e, chunk.length, data.bytes);
        $.CGEventPost(1, e); // kCGSessionEventTap: foreground target
      });
      delay(0.005);
    });
  }

  const parseExec = function (t, js) { return JSON.parse(String(exec(t, js))); };

  // Finds the screen point for a trusted press. The target tab is shown first: a
  // background tab's screenX/outerWidth are stale. The page's estimate can't tell
  // which side a panel is on, or the zoom, so a harmless mouse move at the estimate
  // is posted and the page reports where it landed; the point is corrected (twice
  // at most). If no move reaches the page, the estimate is used as is.
  function aim(T, a, tool) {
    if (!T.background) selectTab(T.t);
    visibleGuard(T.t, tool);
    let probe;
    for (let i = 0; ; i++) {
      probe = parseExec(T.t, a.probe);
      if (!probe.retry) break;
      if (i >= 20) return { out: { ok: false, error: "tab never became visible to measure" } };
      delay(0.05);
    }
    if (!probe.ok) return { out: probe };
    let pt = { x: probe.x, y: probe.y };
    const trace = [];
    // Only the move this loop posted counts: late events and the user's real mouse
    // also reach the page, so match on the screen point the move was posted at.
    const ours = function (at) {
      for (let tries = 0; tries < 10; tries++) {
        let got = null;
        try { got = parseExec(T.t, a.cal); } catch (e) {}
        // Directed SkyLight moves may report a window-local screenX/Y in Blink.
        // The buffer was cleared immediately before the post and the target is
        // behind another app, so use its latest directed move for calibration.
        const m = got && (T.background ? got.moves.pop() : got.moves.filter(function (v) { return Math.abs(v[2] - at.x) < 2 && Math.abs(v[3] - at.y) < 2; }).pop());
        if (m) return m;
        delay(0.025);
      }
      return null;
    };
    for (let i = 0; i < 3; i++) {
      exec(T.t, a.calReset);
      if (T.background) skyMouse(T.I, pt, 5, 2, 0, Date.now() % 1000000000);
      else mouse(T.I, pt, 5, 0, 0.0); // kCGEventMouseMoved
      const m = ours(pt);
      if (!m) break;
      const dx = Math.round(probe.cx - m[0]), dy = Math.round(probe.cy - m[1]);
      trace.push([dx, dy]);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
      pt = { x: pt.x + dx, y: pt.y + dy };
    }
    return { pt: pt, el: probe.el, calibrated: trace.length > 0, calibration: trace };
  }

  // The browser the user is using: topmost on screen, else the system default
  // browser if it runs, else any running browser.
  function defaultBrowser(P) {
    if (P.z.length) return P.z[0];
    try {
      ObjC.import("AppKit");
      const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com"));
      const id = ObjC.unwrap($.NSBundle.bundleWithURL(u).bundleIdentifier);
      const b = BROWSERS.filter(function (x) { return x.bundle === id; })[0];
      if (b && app(b.app).running()) return b.app;
    } catch (e) {}
    const any = candidates(P)[0];
    if (any) return any;
    throw new Error("no_browser: no browser is running (new_tab never launches one)");
  }

  // One row per Arc tab, in sidebar order. Windows on one space share their tabs,
  // so a shared tab is listed once, under the frontmost window showing it.
  function listArc(ap, name, n, out) {
    const wins = [];
    for (let w = 0; w < n; w++) {
      const win = ap.windows[w];
      let id; try { id = win.id(); } catch (e) { id = w; }
      let o;
      try { o = arcOrder(win); } catch (e) { continue; }
      let act = null; try { act = win.activeTab.id(); } catch (e) {}
      const same = wins.filter(function (x) { return x.o.ids.join() === o.ids.join(); })[0];
      let urls = [], titles = [];
      if (same) { urls = same.urls; titles = same.titles; }
      else {
        try { urls = win.tabs.url(); } catch (e) { continue; }
        try { titles = win.tabs.title(); } catch (e) {}
      }
      const at = {};
      o.order.forEach(function (i, k) { at[o.ids[i]] = k; });
      wins.push({ id: id, o: o, act: act, urls: urls, titles: titles, at: at });
    }
    const owner = {};
    wins.forEach(function (x) { if (x.act != null && !owner[x.act]) owner[x.act] = x; });
    const done = {};
    wins.forEach(function (x) {
      x.o.order.forEach(function (i) {
        const tabId = x.o.ids[i];
        if (done[tabId]) return;
        done[tabId] = true;
        const home = owner[tabId] || x;
        const row = { app: name, tabId: handle(name, tabId), url: x.urls[i] || "", title: x.titles[i] || "" };
        if (x.o.loc[i] === "pinned") row.pinned = true;
        else if (x.o.loc[i] === "topApp") row.favorite = true;
        if (owner[tabId]) row.active = true;
        out.push(row);
      });
    });
  }

  // Every window of a Chromium or Safari app in at most five events, instead of
  // five or six per window. false (nothing pushed) when a bulk read fails or the
  // per-window arrays don't line up; the caller then walks the windows.
  function listBulk(ap, name, kind, out) {
    let wids, urls, titles, tids = null, acts;
    try {
      const W = ap.windows;
      wids = W.id();
      urls = W.tabs.url();
      titles = kind === "safari" ? W.tabs.name() : W.tabs.title();
      if (kind === "chrome") tids = W.tabs.id();
      acts = kind === "chrome" ? W.activeTabIndex() : W.currentTab.index();
    } catch (e) { return false; }
    const n = wids.length;
    const lined = function (x) { return Array.isArray(x) && x.length === n; };
    if (!lined(urls) || !lined(titles) || !lined(acts) || (tids && !lined(tids))) return false;
    for (let w = 0; w < n; w++) if (!Array.isArray(urls[w])) return false;
    for (let w = 0; w < n; w++) {
      const u = urls[w], ti = titles[w] || [], ids = tids ? tids[w] || [] : [];
      for (let i = 0; i < u.length; i++) {
        const row = { app: name };
        if (kind === "safari") row.tabId = safariHandle(wids[w], i, u[i]);
        else if (ids[i] != null) { row.tabId = handle(name, ids[i]); hint(name, ids[i], w); }
        else { row.windowId = wids[w]; row.tabIndex = i; }
        row.url = u[i] || ""; row.title = ti[i] || "";
        if (i === acts[w] - 1) row.active = true;
        out.push(row);
      }
    }
    return true;
  }

  globalThis.__perch = {
    listTabs(a) {
      const P = procs();
      const out = [];
      const names = candidates(P, a.app);
      for (const name of names) {
        const ap = app(name), kind = KIND[name];
        if (kind !== "arc" && listBulk(ap, name, kind, out)) continue;
        let n;
        try { n = ap.windows.length; } catch (e) { continue; }
        if (kind === "arc") { listArc(ap, name, n, out); continue; }
        for (let w = 0; w < n; w++) {
          const win = ap.windows[w];
          let id; try { id = win.id(); } catch (e) { id = w; }
          let urls, titles = [], tabIds = [];
          try { urls = win.tabs.url(); } catch (e) { continue; }
          try { titles = kind === "safari" ? win.tabs.name() : win.tabs.title(); } catch (e) {}
          if (kind === "chrome") { try { tabIds = win.tabs.id(); } catch (e) {} }
          // `active` marks the tab each window shows (one extra read per window).
          const act = activeIndex(kind, win, win.tabs);
          for (let i = 0; i < urls.length; i++) {
            if (kind === "chrome") hint(name, tabIds[i], w);
            const row = { app: name };
            if (kind === "safari") row.tabId = safariHandle(id, i, urls[i]);
            else if (tabIds[i] != null) row.tabId = handle(name, tabIds[i]);
            else { row.windowId = id; row.tabIndex = i; }
            row.url = urls[i] || ""; row.title = titles[i] || "";
            if (i === act) row.active = true;
            out.push(row);
          }
        }
      }
      return out;
    },
    evalJs(a) {
      const q = quickExec(a.target, a.js);
      if (q) return q.v;
      const t = resolve(a.target);
      visibleGuard(t, a.tool || "eval_js");
      return exec(t, a.js);
    },
    evalAsync(a) {
      const t = resolve(a.target);
      visibleGuard(t, "eval_js");
      exec(t, a.kick);
      const r = poll(t, a.poll, a.timeout, 50);
      if (!r) throw new Error("timeout: eval_js (awaitPromise) timed out after " + a.timeout + "ms");
      return r.value;
    },
    wait(a) {
      const t = resolve(a.target);
      visibleGuard(t, "wait");
      const r = poll(t, a.js, a.timeout, a.interval || 150);
      if (!r) throw new Error("timeout: wait timed out after " + a.timeout + "ms");
      if (r.value && r.value.__perch_error) throw new Error("wait: " + r.value.__perch_error);
      return r;
    },
    // One round trip: stamp the current document, set the url, then wait until a
    // document without the stamp reports readyState 'complete'. Checking readyState
    // alone can read the OLD document's 'complete' right after the url is set.
    navigate(a) {
      const t = resolve(a.target);
      // Safari only runs JS in, and applies url to, the window's current tab.
      if (t.kind === "safari") { try { t.win.currentTab = t.tab; } catch (e) {} }
      const canEval = t.kind !== "arc" || isActive(t);
      const token = "n" + Date.now() + Math.random().toString(36).slice(2, 6);
      // The page resolves the url against its own location, so a #fragment change is
      // recognized as same-document even when the two spellings differ.
      let sameDoc = false;
      if (canEval) {
        const stamp = "(function(){try{var u=new URL(" + JSON.stringify(a.url) + ",location.href);" +
          "if(u.hash&&u.href.split('#')[0]===location.href.split('#')[0])return 'same'}catch(e){}" +
          "window.__perch_nav=" + JSON.stringify(token) + ";return 'stamped'})()";
        try { sameDoc = exec(t, stamp) === "same"; } catch (e) {}
      }
      t.tab.url = a.url;
      if (!canEval || sameDoc) return { waited: false, tabId: handleOf(t) };
      const check = "(function(){try{return JSON.stringify(window.__perch_nav!==" + JSON.stringify(token) + "&&document.readyState==='complete')}catch(e){return 'false'}})()";
      const start = Date.now();
      let idle = 0;
      while (Date.now() - start < a.timeout) {
        let done = false;
        try { done = JSON.parse(String(exec(t, check))) === true; } catch (e) {}
        if (done) return { waited: true, tabId: handleOf(t) };
        // A download or 204 never replaces the document; Chrome's `loading` settles.
        if (t.kind !== "safari" && Date.now() - start > 300) {
          try { idle = t.tab.loading() ? 0 : idle + 1; } catch (e) {}
          if (idle >= 2) return { waited: true, tabId: handleOf(t) };
        }
        delay(0.1);
      }
      return { waited: false, tabId: handleOf(t) };
    },
    newTab(a) {
      const name = a.app || defaultBrowser(procs());
      const kind = KIND[name];
      const ap = app(name);
      if (!ap.running()) throw new Error("no_browser: " + name + " must already be running (new_tab never launches it)");
      if (!ap.windows.length) throw new Error("no_browser: " + name + " needs an existing window (new_tab never makes one)");
      let win, newId = null;
      if (kind === "chrome" || kind === "arc") {
        win = ap.windows[0];
        let beforeIds = null;
        try { beforeIds = win.tabs.id(); } catch (e) {}
        // Arc's `make new tab` rejects about: and data: URLs but accepts them set
        // afterwards, so such tabs start on its own new-tab page.
        const later = kind === "arc" && /^(about|data):/i.test(a.url);
        const tab = ap.Tab({ url: later ? "arc://newtab" : a.url });
        win.tabs.push(tab);
        try { newId = tab.id(); } catch (e) {}
        if (newId == null && beforeIds) {
          try { newId = win.tabs.id().find(function (id) { return beforeIds.indexOf(id) < 0; }); } catch (e) {}
        }
        if (later) {
          if (newId == null) throw new Error("no_browser: " + name + " created a tab perch could not find to load " + a.url);
          const nt = win.tabs.byId(newId);
          nt.url = a.url;
          // Until the URL commits the tab still shows arc://newtab, where page JS hangs.
          for (let i = 0; i < 40; i++) {
            let u = ""; try { u = nt.url(); } catch (e) {}
            if (!/^arc:/i.test(u)) break;
            delay(0.05);
          }
        }
      } else {
        // Safari: documents[0].tabs throws under JXA; windows[0].tabs works.
        win = ap.windows[0];
        let created = false;
        try { win.tabs.push(ap.Tab({ url: a.url })); created = true; } catch (e) {}
        if (!created) throw new Error("no_browser: " + name + " could not create a background tab");
      }
      let tabId = null;
      try {
        if (kind === "safari") {
          const i = win.tabs.length - 1;
          tabId = safariHandle(win.id(), i, win.tabs[i].url() || a.url);
        } else if (newId != null) { tabId = handle(name, newId); hint(name, newId, 0); }
      } catch (e) {}
      return { app: name, tabId };
    },
    activate(a) {
      focus(resolve(a.target));
      return true;
    },
    // Only the active tab of a window is rendered. Never switch tabs implicitly:
    // that can put Chrome's window into focus even without app.activate().
    shotGeom(a) {
      const t = resolve(a.target);
      if (a.raise) { focus(t); delay(0.25); t.P = procs(); }
      else if (a.target && (a.target.tabIndex != null || a.target.tabId != null) && !isActive(t)) {
        throw new Error(notVisible("a background screenshot") + ", or pass raise:true");
      }
      const I = ids(t);
      if (I.windowNumber == null) throw new Error(OFFSCREEN);
      return I;
    },
    select(a) {
      const t = resolve(a.target);
      visibleGuard(t, "select");
      const r = parseExec(t, a.start);
      if (!r || !r.pending) return r;
      const picked = poll(t, a.pick, 1500, 50);
      if (!picked) return parseExec(t, a.miss);
      if (picked.value.ok === false) return picked.value;
      const read = poll(t, a.read, 500, 50);
      return read ? read.value : parseExec(t, a.readFinal);
    },
    trustedClick(a) {
      const T = trustedTarget(a);
      const home = T.background ? null : cursorAt();
      try {
        if (a.x != null) {
          if (T.background) skyClick(T.I, { x: a.x, y: a.y });
          else leftClick(T.I, { x: a.x, y: a.y });
          return { ok: true, point: { x: a.x, y: a.y }, delivery: T.background ? "skylight" : "hid" };
        }
        const A = aim(T, a, "click");
        if (A.out) return A.out;
        if (T.background) skyClick(T.I, A.pt);
        else leftClick(T.I, A.pt);
        delay(0.05);
        const check = parseExec(T.t, a.check);
        return Object.assign({ ok: check.hit === true, el: A.el, point: A.pt, calibrated: A.calibrated, calibration: A.calibration, delivery: T.background ? "skylight" : "hid" }, check);
      } finally {
        if (home) $.CGWarpMouseCursorPosition($.CGPointMake(home.x, home.y));
      }
    },
    trustedFill(a) {
      const T = trustedTarget(a);
      const home = cursorAt();
      try {
        const A = aim(T, a, "fill");
        if (A.out) return A.out;
        leftClick(T.I, A.pt);
        delay(0.05); // let focus settle before typing
        typeChunks(a.chunks);
        delay(0.05);
        return Object.assign({ el: A.el, calibrated: A.calibrated, calibration: A.calibration, delivery: "hid" }, parseExec(T.t, a.check));
      } finally {
        $.CGWarpMouseCursorPosition($.CGPointMake(home.x, home.y));
      }
    },
  };
}

export const JXA_PRELUDE = `(${jxaRuntime})(${JSON.stringify(BROWSERS)})`;

export const ERR = {
  jsOff: "JavaScript-from-AppleEvents is off. Enable it: Chromium-family → View > Developer > Allow JavaScript from Apple Events. " +
    "Safari → Settings > Advanced > Show Develop menu, then Develop > Allow JavaScript from Apple Events.",
  automation: "Automation permission denied. Grant it in System Settings > Privacy & Security > Automation, " +
    "ticking the target browser under the controlling app (Claude Code / Terminal / iTerm).",
  timeout: (ms) => `timeout: osascript gave up after ${ms}ms: the tab is unreachable (hung page, or a tab its window doesn't show). Re-run list_tabs.`,
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
// The daemon's own read-eval loop. `osascript -i` over a pipe evaluates nothing
// until stdin hits EOF (seen on macOS 27.2), so perch reads lines itself.
// Indirect eval keeps the prelude's globals across lines. NSData.length comes
// back as a string in JXA, hence Number().
const DAEMON_LOOP = `ObjC.import("Foundation");
var __in = $.NSFileHandle.fileHandleWithStandardInput, __buf = "";
for (;;) {
  var __d = __in.availableData;
  if (!__d || Number(__d.length) === 0) break;
  __buf += $.NSString.alloc.initWithDataEncoding(__d, 4).js;
  var __nl;
  while ((__nl = __buf.indexOf("\\n")) >= 0) {
    var __line = __buf.slice(0, __nl);
    __buf = __buf.slice(__nl + 1);
    try { (0, eval)(__line); } catch (e) { console.log("!! " + e); }
  }
}`;

export class OsaDaemon {
  constructor({ spawn: spawnFn = spawn, prelude = "", handshakeTimeout = 10000 } = {}) {
    this.spawnFn = spawnFn;
    this.prelude = prelude;
    this.handshakeTimeout = handshakeTimeout;
    // Set when a REPL never answered its handshake: later calls go one-shot
    // at once instead of each waiting the handshake out.
    this.disabled = null;
    this.proc = null;
    this.ready = null;
    this.queue = [];
    this.current = null;
  }
  run(script, timeout) {
    if (this.disabled) return Promise.reject(Object.assign(new Error(this.disabled), { notSent: true }));
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
    try { p = this.spawnFn("osascript", ["-l", "JavaScript", "-e", DAEMON_LOOP], { stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { return Promise.reject(e); }
    this.proc = p;
    // osascript's console.log goes to stderr; listen to both.
    p.stdout.on("data", (d) => this._onData(d.toString()));
    p.stderr.on("data", (d) => this._onData(d.toString()));
    p.stdin.on("error", () => this._onExit(p));
    p.on("exit", () => this._onExit(p));
    p.on("error", () => this._onExit(p));
    // Handshake instead of a fixed settle: the prelude (or a no-op) must round-trip first.
    return new Promise((resolve, reject) => this._send({ script: this.prelude + ";1", timeout: this.handshakeTimeout, resolve, reject, handshake: true }));
  }
  async _drain() {
    if (this.current || this.queue.length === 0) return;
    if (!this.proc) this.ready = this._spawn();
    const ready = this.ready;
    try { await ready; }
    catch (e) {
      if (this.ready === ready) this.kill();
      const msg = "osascript failed to start: " + (e.message || e);
      if (e.handshake && !this.disabled) {
        this.disabled = msg;
        process.stderr.write(`perch: osascript daemon disabled (${msg}); using one-shot calls\n`);
      }
      const err = Object.assign(new Error(msg), { notSent: true });
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
        job.reject(Object.assign(new Error(ERR.timeout(c.timeout)), { handshake: !!c.handshake }));
        // A failed handshake is settled by the _drain awaiting it; draining here would respawn.
        if (!c.handshake) this._drain();
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
  // stderr is osascript's own report. execFile's message is "Command failed: <cmd>",
  // and a one-shot cmd embeds the whole prelude, so it is used only without stderr
  // (a spawn failure).
  const msg = (e.stderr != null ? String(e.stderr) : String(e.message || e)).trim();
  const translated = translatePermissionError(msg);
  if (translated) return translated;
  if (e.code === 1 && !msg) return ERR.automation;
  // "execution error: Error: <msg> (-2700)" → "<msg>"
  return msg.replace(/^.*?execution error: (?:Error: )?/s, "").replace(/ \(-?\d+\)$/, "");
}

async function jxaOneShot(script, { timeout = JXA_DEFAULT_TIMEOUT } = {}) {
  try {
    const { stdout } = await deps.exec("osascript", ["-l", "JavaScript", "-e", JXA_PRELUDE + ";\n" + script], { maxBuffer: 32 << 20, timeout });
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

// ---- tools ----

export function shapeTabs(rows, { urlContains, titleContains, limit = 50 } = {}) {
  const has = (v, q) => v.toLowerCase().includes(String(q).toLowerCase());
  if (urlContains) rows = rows.filter((t) => has(t.url, urlContains));
  if (titleContains) rows = rows.filter((t) => has(t.title, titleContains));
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

// Some handles follow the page's URL, so navigate returns the tab's current one.
async function navigate(url, target) {
  const r = await rt("navigate", { target, url, timeout: NAV_TIMEOUT }, { lane: "slow", timeout: NAV_TIMEOUT + JXA_OVERHEAD });
  return r && r.tabId ? { ok: true, url, tabId: r.tabId } : { ok: true, url };
}

async function newTab(url, app) {
  return rt("newTab", { app: app || null, url: url || "about:blank" });
}

// Browser names are matched loosely (case-insensitive app name, key such as
// "canary", or a unique substring), so callers needn't spell them exactly.
export function matchApp(name) {
  if (name == null || name === "") return null;
  const q = String(name).toLowerCase();
  const b = BROWSERS.find((x) => x.app.toLowerCase() === q) || BROWSERS.find((x) => x.key === q);
  if (b) return b.app;
  const hits = BROWSERS.filter((x) => x.app.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0].app;
  throw new Error(`no_browser: ${hits.length ? "ambiguous" : "unknown"} browser '${name}'; one of: ${BROWSERS.map((x) => x.app).join(", ")}`);
}

async function activateTab(target) {
  await rt("activate", { target });
  return { ok: true };
}

// Pixel size from the PNG IHDR or the JPEG SOFn header, so no `sips -g` spawn.
export function imageDims(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// Process spawning behind a seam so tests can fake screencapture/sips.
export const deps = { exec };

async function screenshot(args = {}) {
  const { raise = false, target, format = "png", maxWidth = 1568 } = args;
  const g = await rt("shotGeom", { target, raise });
  const ext = format === "jpeg" ? "jpg" : "png";
  const base = join(tmpdir(), `perch-${process.pid}-${Date.now().toString(36)}`);
  const files = [`${base}.${ext}`];
  try {
    // A missing CGWindowID is rejected by shotGeom: a screen-rect capture would
    // show the user's foreground app rather than a minimized browser window.
    await deps.exec("screencapture", ["-l", String(g.windowNumber), "-x", "-o", "-t", ext, files[0]]);
    let buf = await readFile(files[0]);
    let dims = imageDims(buf);
    if (maxWidth > 0 && dims && dims.w > maxWidth) {
      files.push(`${base}-s.${ext}`);
      // Best effort: if sips fails, the full-size capture still goes back.
      try {
        await deps.exec("sips", ["--resampleWidth", String(maxWidth), ...(ext === "jpg" ? ["-s", "formatOptions", "80"] : []), files[0], "--out", files[1]]);
        buf = await readFile(files[1]);
        dims = imageDims(buf);
      } catch {}
    }
    // -l pixels cover the CG bounds (titlebar included), not AppleScript's inner geom.
    const rect = g.cgBounds || g.geom;
    return { __image: true, data: buf.toString("base64"), mimeType: ext === "jpg" ? "image/jpeg" : "image/png", meta: dims ? { window: rect, image: dims } : undefined };
  } finally {
    await Promise.all(files.map((f) => unlink(f).catch(() => {})));
  }
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

const SELECT_LIB = String.raw`
const norm = function (s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); };
const wantN = norm(A.text);
const options = function () { return Array.from(document.querySelectorAll("[role=option]")).filter(vis); };
const press = function (el) {
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (t) {
    const C = t.indexOf("pointer") === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new C(t, { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window }));
  });
};
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

  // select runs in phases polled from JXA (runtime `select`), never with page
  // timers: Chrome throttles those to ~1/s in background tabs.
  select_start: SELECT_LIB + String.raw`
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
if (attr(ctl, "aria-expanded") !== "true") {
  if (ctl.focus) ctl.focus();
  press((ctl.closest && ctl.closest(".select__control")) || ctl);
}
const input = ctl.tagName === "INPUT" ? ctl : ctl.querySelector && ctl.querySelector("input");
if (input) { setNativeValue(input, A.text); fire(input, ["input"]); }
// Where the choice shows: react-select v5 puts role=combobox on an inner <input>
// that it empties after a pick, so read the surrounding control instead.
const box = (ctl.closest && ctl.closest('.select__control, [class*="-control"]')) || (ctl.tagName === "INPUT" ? ctl.parentElement : ctl);
window.__perch_select = { ctl: ctl, input: input, box: box };
return { pending: true };
`,

  // null = keep polling.
  select_pick: SELECT_LIB + String.raw`
const s = window.__perch_select;
if (!s) return { ok: false, error: "select state lost (did the page navigate?)" };
const opt = options().find(function (o) { return norm(o.textContent) === wantN; }) || options().find(function (o) { return norm(o.textContent).indexOf(wantN) >= 0; });
if (!opt) return null;
press(opt);
s.picked = clip(opt.textContent, 80);
s.pickedN = norm(opt.textContent);
return { picked: true };
`,

  select_miss: SELECT_LIB + String.raw`
return { ok: false, error: "no matching option after open", candidates: options().slice(0, 8).map(function (o) { return clip(o.textContent, 60); }) };
`,

  // Until the control shows the choice: null (keep polling); A.final reports anyway.
  select_read: SELECT_LIB + String.raw`
const s = window.__perch_select;
const full = textOf(s.box) || (s.input && s.input.value) || "";
const shown = clip(full, 120);
const seen = norm(full).indexOf(s.pickedN) >= 0;
if (!seen && !A.final) return null;
const out = { ok: true, selected: s.picked, el: ident(s.ctl), value: shown };
if (!seen) out.unverified = true;
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

  // Chrome runs this in an isolated world, whose console the page never calls. A
  // <script> patches the main world's console and relays entries as perch:console
  // events (DOM events cross worlds). If CSP blocks it, the local console is patched.
  console_start: String.raw`
const s = window.__perch_console;
if (s && s.installed) return { ok: true, already: true, count: s.entries.length };
const st = { entries: [], dropped: 0, orig: {}, installed: true, bridge: false };
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
function mainWorld(safe) {
  if (window.__perchConsoleBridge) return;
  window.__perchConsoleBridge = true;
  const orig = {};
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    orig[level] = console[level];
    console[level] = function () {
      try {
        const parts = [];
        for (let i = 0; i < arguments.length; i++) parts.push(safe(arguments[i]));
        document.dispatchEvent(new CustomEvent("perch:console", { detail: level + ": " + parts.join(" ") }));
      } catch (e) {}
      return orig[level].apply(this, arguments);
    };
  });
  const ping = function () { document.dispatchEvent(new CustomEvent("perch:console-pong")); };
  const stop = function () {
    for (const k in orig) console[k] = orig[k];
    delete window.__perchConsoleBridge;
    document.removeEventListener("perch:console-ping", ping);
    document.removeEventListener("perch:console-stop", stop);
  };
  document.addEventListener("perch:console-ping", ping);
  document.addEventListener("perch:console-stop", stop);
}
function push(entry) {
  if (st.entries.length >= 500) { st.entries.shift(); st.dropped++; }
  st.entries.push(entry);
}
st.relay = function (e) { if (typeof e.detail === "string") push(e.detail); };
document.addEventListener("perch:console", st.relay);
const script = document.createElement("script");
script.textContent = "(" + mainWorld + ")(" + safe + ");";
(document.head || document.documentElement).appendChild(script);
script.remove();
const pong = function () { st.bridge = true; };
document.addEventListener("perch:console-pong", pong);
document.dispatchEvent(new CustomEvent("perch:console-ping"));
document.removeEventListener("perch:console-pong", pong);
if (!st.bridge) {
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    const orig = st.orig[level] = console[level];
    console[level] = function () {
      const parts = [];
      for (let i = 0; i < arguments.length; i++) parts.push(safe(arguments[i]));
      push(level + ": " + parts.join(" "));
      return orig.apply(console, arguments);
    };
  });
}
return { ok: true, started: true, bridge: st.bridge };
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
if (s.bridge) document.dispatchEvent(new CustomEvent("perch:console-stop"));
for (const k in s.orig) console[k] = s.orig[k];
document.removeEventListener("perch:console", s.relay);
s.installed = false;
return { ok: true, entries: s.entries.splice(0) };
`,

  // Trusted input: find the element, scroll it into view, estimate its screen
  // point, and arm listeners: mousemove for calibration, mousedown for `hit`.
  // Estimate: screen origin + browser chrome (outer - inner, assumed left and top)
  // + the element's center. A hidden tab's screenX/outerWidth are stale, so it
  // asks to retry until the tab is visible.
  trusted_probe: String.raw`
if (document.visibilityState === "hidden") return { ok: false, retry: "hidden" };
let el;
if (A.ref || A.selector) {
  const r = resolveEl(A);
  if (r.out) return r.out;
  el = r.el;
} else {
  const re = new RegExp(A.label_pattern, "i");
  const fields = Array.from(document.querySelectorAll("input, textarea")).filter(function (e) {
    return !(e.tagName === "INPUT" && INPUT_SKIP.indexOf((e.type || "text").toLowerCase()) >= 0) && !e.disabled && !e.readOnly;
  });
  const hit = function (e) { return re.test(labelText(e)) || re.test(hintText(e)); };
  el = fields.filter(vis).find(hit) || fields.find(hit);
  if (!el) return { ok: false, error: "no fillable field matched /" + A.label_pattern + "/i" };
}
if (A.forFill && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return { ok: false, error: "fill {trusted:true} types into plain inputs/textareas only; rich editors work without trusted" };
try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (e) {}
const r = el.getBoundingClientRect();
if (!r.width || !r.height) return { ok: false, error: ident(el) + " has no size (hidden or offscreen)" };
if (A.forFill && !A.background) { setNativeValue(el, ""); fire(el, ["input"]); }
const prev = window.__perch_trusted;
if (prev && prev.off) prev.off();
const st = window.__perch_trusted = { el: el, down: null, moves: [] };
const onMove = function (e) { if (st.moves.length < 20) st.moves.push([e.clientX, e.clientY, e.screenX, e.screenY]); };
const onDown = function (e) { st.down = el === e.target || el.contains(e.target); window.removeEventListener("mousedown", onDown, true); };
window.addEventListener("mousemove", onMove, true);
window.addEventListener("mousedown", onDown, true);
st.off = function () { window.removeEventListener("mousemove", onMove, true); window.removeEventListener("mousedown", onDown, true); };
const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
return {
  ok: true,
  el: ident(el),
  x: window.screenX + (window.outerWidth - window.innerWidth) + cx,
  y: window.screenY + (window.outerHeight - window.innerHeight) + cy,
  cx: cx,
  cy: cy,
};`,

  // Drains recorded mouse moves as [clientX, clientY, screenX, screenY]; null if none.
  // A.reset only clears them.
  trusted_cal: String.raw`
const st = window.__perch_trusted || {};
const moves = st.moves || [];
st.moves = [];
return A.reset || !moves.length ? null : { moves: moves };
`,

  // Chrome's editing command emits a trusted input event in an inactive tab,
  // including when its window has no on-screen CG entry. It needs no mouse
  // event, tab selection, window geometry, or AppKit focus change.
  trusted_fill_background: String.raw`
let el;
if (A.ref || A.selector) {
  const r = resolveEl(A);
  if (r.out) return r.out;
  el = r.el;
} else {
  const re = new RegExp(A.label_pattern, "i");
  const fields = Array.from(document.querySelectorAll("input, textarea")).filter(function (e) {
    return !(e.tagName === "INPUT" && INPUT_SKIP.indexOf((e.type || "text").toLowerCase()) >= 0) && !e.disabled && !e.readOnly;
  });
  const hit = function (e) { return re.test(labelText(e)) || re.test(hintText(e)); };
  el = fields.filter(vis).find(hit) || fields.find(hit);
  if (!el) return { ok: false, error: "no fillable field matched /" + A.label_pattern + "/i" };
}
if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return { ok: false, error: "fill {trusted:true} supports plain inputs/textareas only" };
if (el.disabled || el.readOnly) return { ok: false, error: ident(el) + " is disabled or read-only" };
let trusted = false;
const onInput = function (e) { if (e.target === el && e.isTrusted) trusted = true; };
el.addEventListener("input", onInput, true);
try {
  el.focus({ preventScroll: true });
  if (document.activeElement !== el) return { ok: false, error: ident(el) + " did not accept focus" };
  if (el.select) el.select();
  const accepted = document.execCommand(A.text ? "insertText" : "delete", false, A.text);
  const value = String(el.value || "");
  const ok = accepted === true && trusted && value === A.text;
  return { ok: ok, trusted: trusted, value: value, el: ident(el), ...(ok ? {} : { error: "background editing did not produce the requested trusted input" }) };
} finally { el.removeEventListener("input", onInput, true); }
`,

  // hit: the mousedown landed on the element; null: no mousedown reached the page.
  trusted_check: String.raw`
const st = window.__perch_trusted || {};
if (st.off) st.off();
const out = { hit: st.down };
if (A.forFill && st.el) {
  const got = String(st.el.value || "");
  out.len = got.length;
  out.ok = got.replace(/\s/g, "").length >= Math.floor(A.text.replace(/\s/g, "").length * 0.9);
  if (!out.ok) out.error = "trusted typing did not land (got " + got.length + " chars)";
}
return out;
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

// Splits text into <= max UTF-16 unit chunks without cutting a surrogate pair.
export function chunkUtf16(text, max = 20) {
  const out = [];
  let cur = "";
  for (const ch of text) {
    if (cur.length + ch.length > max) { out.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const pageFn = (name, A) => buildEvalWrapper(pageScript(name, A));

async function trustedClick({ ref, selector, x, y, raise, target }) {
  if (!ref && !selector && (x == null || y == null)) throw new Error("click {trusted:true} requires `ref`, `selector`, or both `x` and `y`");
  const probing = !!(ref || selector);
  return rt("trustedClick", {
    target, raise, x, y,
    probe: probing ? pageFn("trusted_probe", { ref, selector }) : null,
    cal: probing ? pageFn("trusted_cal", {}) : null,
    calReset: probing ? pageFn("trusted_cal", { reset: true }) : null,
    check: probing ? pageFn("trusted_check", {}) : null,
  });
}

// Background fields use the browser's trusted editing command; the explicit
// foreground route keeps the hardware-style keystrokes. Both verify the value.
async function trustedFill({ ref, selector, label_pattern, text, raise, target }) {
  if (!raise) return runPage("fill", "trusted_fill_background", { ref, selector, label_pattern, text }, target);
  return rt("trustedFill", {
    target, raise,
    probe: pageFn("trusted_probe", { ref, selector, label_pattern, forFill: true, background: !raise }),
    cal: pageFn("trusted_cal", {}),
    calReset: pageFn("trusted_cal", { reset: true }),
    check: pageFn("trusted_check", { forFill: true, text }),
    chunks: chunkUtf16(text),
  });
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
  const A = { ref, selector, label_pattern, text: String(text) };
  const step = (name, extra = {}) => pageFn(name, { ...A, ...extra });
  return rt("select", {
    target,
    start: step("select_start"), pick: step("select_pick"), miss: step("select_miss"),
    read: step("select_read"), readFinal: step("select_read", { final: true }),
  }, { lane: "slow" });
}

// Shared guidance lives here once instead of in every tool description.
export const INSTRUCTIONS = `perch drives the user's own macOS browsers over AppleScript. Which browser a tab lives in is perch's concern, not the caller's.
Targeting: pass \`target: {tabId}\` with a tabId from list_tabs or new_tab; it works for every browser and survives other tabs opening and closing. With no target, tools use the active tab of the topmost browser window. new_tab defaults to the browser in use and creates an unselected tab, but may focus the browser; defer it while the user works.
Elements: prefer \`ref\` (from accessibility_snapshot) over \`selector\` over \`label_pattern\` (case-insensitive regex over label/aria-label/placeholder/name). Refs die on the next snapshot or navigation; a stale ref errors with a re-snapshot hint.
{ok:false, error} is a normal outcome (no match, value didn't land): read it rather than retrying blindly.
Errors start with a code: tab_not_visible (needs the tab its window shows: activate_tab, which takes focus, or retry later), stale_tab (re-run list_tabs), window_offscreen, no_browser, timeout, tab_not_scriptable (a browser-internal page; navigate first). Only activate_tab and raise:true take focus.`;

const TARGET = { type: "object", properties: { tabId: { type: ["string", "number"] }, app: { type: "string" }, windowId: { type: ["string", "number"] }, tabIndex: { type: "number" } } };
const REF = { type: "string", description: "From accessibility_snapshot." };
const SEL = { type: "string", description: "CSS selector." };
const LABEL = { type: "string", description: "Regex over the field's label." };
const tool = (name, description, properties = {}, required) =>
  ({ name, description, inputSchema: { type: "object", properties, ...(required ? { required } : {}) } });

const TOOLS = [
  tool("list_tabs", "List open tabs as {tabs:[{app,tabId,url,title,active?}], total}; pass a row's tabId as target. `active`: the tab its window shows. Filter rather than dumping; `total` counts matches before `limit`.", {
    app: { type: "string" },
    urlContains: { type: "string" },
    titleContains: { type: "string" },
    limit: { type: "number", description: "Default 50." },
  }),
  tool("new_tab", "Create an unselected tab in an already running browser window. Creation may focus the browser; defer while the user works. Returns {app,tabId}.", {
    url: { type: "string", description: "Default about:blank." },
    app: { type: "string", description: "Default: the browser in use." },
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
  tool("screenshot", "Capture the target window without raising it; background mode requires an already active tab. Returns the image plus {window:{x,y,w,h}, image:{w,h}}; screenX = window.x + imageX * window.w / image.w.", {
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
  tool("click", "Click by ref/selector (el.click()). `trusted` targets a window through SkyLight (needs Accessibility); `raise:true` uses the foreground HID route. Check `hit` after trusted input. Only trusted accepts screen `x`/`y`.", {
    ref: REF,
    selector: SEL,
    x: { type: "number" },
    y: { type: "number" },
    trusted: { type: "boolean" },
    raise: { type: "boolean" },
    target: TARGET,
  }),
  tool("fill", "Set a field's text and verify it landed: inputs, textareas, and rich editors (contenteditable, ProseMirror, Quill…). Returns {ok,kind,el,len,ambiguous?}. `trusted` gives plain fields a trusted input event in background tabs without taking key focus; `raise:true` types foreground keys.", {
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
    if (args.app != null) args = { ...args, app: matchApp(args.app) };
    if (args.target && args.target.app != null) args = { ...args, target: { ...args.target, app: matchApp(args.target.app) } };
    return formatResult(await handler(args));
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
}

export { TOOLS };

// Start only when run as the entry point (realpath: npm's bin is a symlink), so tests can import.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = new Server({ name: "perch", version: "0.2.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (req) => handleCall(req.params.name, req.params.arguments || {}));
  await server.connect(new StdioServerTransport());
}
