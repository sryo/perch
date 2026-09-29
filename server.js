#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile, spawn } from "node:child_process";
import { readFile, stat, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";

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
function jxaRuntime(BROWSERS, HANG) {
  ObjC.import("CoreGraphics");
  ObjC.import("Foundation");
  const KIND = {}, KEY = {}, BY_KEY = {}, BUNDLE = {};
  BROWSERS.forEach((b) => { KIND[b.app] = b.kind; KEY[b.app] = b.key; BY_KEY[b.key] = b.app; BUNDLE[b.app] = b.bundle; });

  // Errors start with a stable, browser-neutral code that clients branch on.
  const notVisible = (what) => "tab_not_visible: " + what + " needs the tab its window shows; activate_tab (takes focus) or retry later";
  const OFFSCREEN = "window_offscreen: the browser window isn't on screen (minimized or on another Space)";
  const AMBIGUOUS = "window_ambiguous: another window of this browser has the same frame, so perch can't tell which is the target's; move or resize one";
  const TWINS = "window_ambiguous: two instances of this browser have windows on screen, so perch can't tell which is the target's; quit the other one";

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
  // `count`: the caller issues the handle (navigate), so its window's counts go in the note.
  function handleOf(t, count) {
    try {
      if (t.kind === "safari") {
        const id = t.win.id();
        if (t.idx == null || !count) return safariHandle(id, t.idx, t.tab.url());
        const urls = t.win.tabs.url(), h = safariHandle(id, t.idx, urls[t.idx]);
        counted(h, urls, t.idx);
        return h;
      }
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
  // A running browser whose tabs couldn't be read (Automation denied, no answer,
  // its handler failed), as opposed to one that quit or has no windows.
  const UNLISTED = [-1743, -1712, -10000, -1708];
  // Of those, a running browser that failed or didn't understand the event:
  // busy, starting up or behind a modal dialog, so it says nothing of any tab.
  const UNREAD = [-10000, -1708];
  // The browser quit, or dropped the connection, during the call.
  const QUIT = [-600, -609];

  // Chromium handle -> {w: window position, id: the tab's native id}, learned
  // from list_tabs, new_tab and resolve. `windows[w].tabs.byId(id)` pins the
  // exact tab, so a wrong hint can only miss (errAENoSuchObject), never mis-target.
  // Arc's go to `arcHints`, and only for a window that showed the tab: Arc windows
  // share tabs, so a hint counts only while `windows[w].activeTab.id()` is the tab.
  let hints = {}, arcHints = {}, hintCount = 0;
  function hint(name, id, w) {
    if ((KIND[name] !== "chrome" && KIND[name] !== "arc") || id == null) return;
    if (++hintCount > 5000) { hints = {}; arcHints = {}; hintCount = 0; }
    (KIND[name] === "arc" ? arcHints : hints)[handle(name, id)] = { w: w, id: id };
  }

  // AppKit's classes (NSRunningApplication, NSWorkspace, NSBitmapImageRep) exist
  // only once it is imported. Only DAEMON_LOOP touches NSApplication, to keep the
  // lanes out of the Dock.
  let appKitReady = false;
  function appKit() {
    if (appKitReady) return;
    ObjC.import("AppKit");
    appKitReady = true;
  }

  // A browser's CG windows go by owner name, which a second instance of the same
  // app shares (another tool's headless copy). Only a regular app (activation
  // policy 0, a Dock icon) is the user's; a pid's policy is read once, over ObjC.
  // A failed read counts as the user's but is not remembered.
  const userPid = {};
  function isUserPid(pid) {
    if (pid in userPid) return userPid[pid];
    try {
      appKit();
      const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      return (userPid[pid] = a.isNil() || Number(a.activationPolicy) === 0);
    } catch (e) { return true; }
  }

  // One CGWindowList read replaces System Events: z-order of on-screen browsers,
  // the frontmost app, pids and CGWindowIDs. ~4ms vs ~60ms for a System Events
  // `frontmost` query, and it needs no extra permission.
  function procs() {
    // `byPid` keeps every layer-0 window of a pid, small ones too, front to back.
    // `dupe[owner]`: windows of two regular instances, which geometry can't separate.
    const out = { front: null, frontPid: null, frontWid: null, z: [], pid: {}, wins: {}, byPid: {}, dupe: {} };
    let list = [];
    try { list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || []; } catch (e) {}
    for (const w of list) {
      const b = w.kCGWindowBounds || {};
      if (w.kCGWindowLayer !== 0) continue;
      (out.byPid[w.kCGWindowOwnerPID] = out.byPid[w.kCGWindowOwnerPID] || []).push({ wid: w.kCGWindowNumber, x: b.X, y: b.Y, w: b.Width, h: b.Height });
      if (b.Width < 100 || b.Height < 100) continue;
      const owner = w.kCGWindowOwnerName;
      if (KIND[owner] && !isUserPid(w.kCGWindowOwnerPID)) continue;
      if (out.front === null) { out.front = owner; out.frontPid = w.kCGWindowOwnerPID; out.frontWid = w.kCGWindowNumber; }
      if (!KIND[owner]) continue;
      if (out.wins[owner] && out.pid[owner] !== w.kCGWindowOwnerPID) out.dupe[owner] = true;
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
    let loc = [], side = [];
    const ids = win.tabs.id();
    try { loc = win.tabs.location(); } catch (e) {}
    try { side = win.activeSpace.tabs.id(); } catch (e) {}
    return arcSort(ids, loc, side);
  }
  function arcSort(ids, loc, side) {
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
    // A hinted Arc window that still shows the tab: one event, and no isActive later.
    const ah = want.windowId == null && arcHints[want.tabId];
    if (ah && alive(want.app, P)) {
      const win = app(want.app).windows[ah.w];
      let shown = null; try { shown = win.activeTab.id(); } catch (e) {}
      if (shown != null && String(shown) === key) return { tab: win.tabs.byId(ah.id), idx: null, tabId: ah.id, kind: "arc", app: want.app, win, w: ah.w, P, shown: true };
      delete arcHints[want.tabId];
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
        if (kind === "arc" && !isActive(t)) { if (!fallback) fallback = t; continue; }
        if (kind === "arc") t.shown = true;
        hint(name, ids[i], w);
        return t;
      }
      if (fallback) return fallback;
    }
    throw new Error("stale_tab: tab " + want.tabId + " is gone; re-run list_tabs");
  }

  // strict (close_tab): only the recorded window, and only the tab at the recorded index.
  function resolveSafari(want, raw, P, strict) {
    const parts = raw.split("."), winId = parts[0], idx = Number(parts[1]), hash = parts.slice(2).join(".");
    if (!alive("Safari", P)) throw new Error("stale_tab: tab " + want.tabId + " is gone (its browser quit); re-run list_tabs");
    const a = app("Safari");
    const matches = function (urls) {
      const m = [];
      urls.forEach(function (u, i) { if (fp(u) === hash) m.push(i); });
      return m;
    };
    const nearest = function (m) {
      return m.reduce(function (best, i) { return Math.abs(i - idx) < Math.abs(best - idx) ? i : best; });
    };
    const record = function (win, i, w) { return { tab: win.tabs[i], idx: i, tabId: null, kind: "safari", app: "Safari", win, w, P }; };
    // Which candidate is the handle's own is settled by the stamp on the first page JS (pickRun).
    const picking = function (t, m, id, away, total) {
      t.pick = { tabId: want.tabId, raw: raw, hash: hash, idx: away ? -1 : idx, winId: id, cands: m, total: total, cnt: want.cnt, own: !!want.own, mine: ours(want, raw), foreign: want.foreign };
      return t;
    };
    // The recorded window by id: one event when the tab is still in it.
    let searched = false;
    if (/^\d+$/.test(winId)) {
      try {
        const win = a.windows.byId(Number(winId)), urls = win.tabs.url(), m = matches(urls);
        searched = true;
        if (m.length) {
          // A tab at another index with the URL may be the user's, once the agent's is gone.
          if (strict && m.indexOf(idx) < 0) throw new Error("stale_tab: can't tell which tab " + want.tabId + " is; re-run list_tabs");
          if (strict) return record(win, idx, null);
          return picking(record(win, nearest(m), null), m, winId, false, urls.length);
        }
      } catch (e) { if (isStale(e)) throw e; }
    }
    if (strict) throw new Error("stale_tab: tab " + want.tabId + " is no longer in its window; re-run list_tabs");
    let n = 0; try { n = a.windows.length; } catch (e) {}
    // The tab may have been dragged out, but only a URL no other tab shows says which.
    let found = null, count = 0;
    for (let w = 0; w < n && count < 2; w++) {
      const win = a.windows[w];
      let id = null;
      if (searched) {
        try { id = String(win.id()); } catch (e) {}
        if (id === winId) continue;
      }
      let urls; try { urls = win.tabs.url(); } catch (e) { continue; }
      const m = matches(urls);
      count += m.length;
      if (m.length === 1 && count === 1) {
        if (id == null) { try { id = String(win.id()); } catch (e) {} }
        found = picking(record(win, m[0], w), m, id, true, urls.length);
      }
    }
    if (count > 1) throw new Error("stale_tab: tab " + want.tabId + " is gone; several tabs show its URL; re-run list_tabs");
    if (found) return found;
    throw new Error("stale_tab: tab " + want.tabId + " is gone (closed or navigated); re-run list_tabs");
  }

  // Tabs are pinned by id where the browser has one: `tabs[i]` is positional and
  // re-evaluated on every use, so a long poll could drift to another tab.
  function resolve(want, strict) {
    want = want || {};
    const P = procs();
    if (want.tabId != null) {
      const h = parseHandle(want.tabId);
      if (h && KIND[h.app] === "safari") return resolveSafari(want, h.raw, P, strict);
      // A bare id (from before handles) is searched across browsers, narrowed by `app`.
      return resolveById({ tabId: want.tabId, raw: h ? h.raw : String(want.tabId), app: h ? h.app : want.app, windowId: want.windowId }, P);
    }
    const names = candidates(P, want.app);
    // A browser that couldn't be read is why nothing matched, if one was.
    let blocked = null, blockedApp = null;
    const note = function (e, name) { if (!blocked && e && (UNLISTED.indexOf(e.errorNumber) >= 0 || QUIT.indexOf(e.errorNumber) >= 0)) { blocked = e; blockedApp = name; } };
    // The front window's shown tab in one event; a window showing no tab (or no
    // window) falls through to the walk.
    if (want.windowId == null && want.tabIndex == null && (KIND[names[0]] === "chrome" || KIND[names[0]] === "arc")) {
      try {
        const win = app(names[0]).windows[0], id = win.activeTab.id();
        if (id != null) return { tab: win.tabs.byId(id), idx: null, tabId: id, kind: KIND[names[0]], app: names[0], win, w: 0, P, shown: true };
      } catch (e) { note(e, names[0]); }
    }
    for (const name of names) {
      const a = app(name), kind = KIND[name];
      let n;
      try { n = a.windows.length; } catch (e) { note(e, name); continue; }
      for (let w = 0; w < n; w++) {
        const win = a.windows[w];
        if (want.windowId != null) {
          let id; try { id = win.id(); } catch (e) { id = w; }
          if (String(id) !== String(want.windowId)) continue;
        }
        let tabs, len;
        try { tabs = win.tabs; len = tabs.length; if (!len) continue; } catch (e) { note(e, name); continue; }
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
    if (want.app && !KIND[want.app]) throw new Error("no_browser: unknown browser " + want.app);
    // No tab was ever matched, so a browser that didn't answer is a transient timeout, not stale_tab.
    if (blocked && UNREAD.indexOf(blocked.errorNumber) >= 0) {
      throw new Error("timeout: no browser window with an open tab answered; " + blockedApp + " did not answer (busy, starting up or showing a dialog), so retry in a moment or target another app (AppleScript " + blocked.errorNumber + ")");
    }
    if (blocked) throw blocked;
    throw new Error("no_browser: no browser window with an open tab" + (want.app ? " in " + want.app : ""));
  }

  // Chrome tabs have no `index` property (it throws), so positions come from resolve.
  // `shown`: resolve just read the tab as its window's shown tab.
  function isActive(t) {
    if (t.shown) return true;
    // A Safari handle with more than one possible tab settles which first, so the
    // tab checked is the one its page JS will run in.
    if (t.pick && !(t.pick.cands.length === 1 && t.pick.cands[0] === t.idx)) execOnce(t, "1");
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
    if (!t.pageOk) arcPageGuard(t, tool);
  }
  function arcPageGuard(t, tool) {
    if (t.kind !== "arc") return;
    let url = ""; try { url = t.tab.url(); } catch (e) {}
    if (/^arc:/i.test(url)) throw new Error("tab_not_scriptable: " + tool + " can't run on the browser's own pages (new tab, settings); navigate the tab to a web page first (with raise:true, unless its window is in front)");
    t.pageOk = true;
  }

  // For tools that only run page JS: a hinted Chromium handle costs no Apple
  // Event here, and an execute that finds no tab in that window re-resolves it
  // (onTab). Anything else resolves and is guarded as usual.
  function pageTarget(want, tool) {
    const hn = want && want.windowId == null && want.tabId != null && hints[want.tabId];
    if (hn) {
      const name = parseHandle(want.tabId).app, P = procs();
      if (alive(name, P)) {
        const win = app(name).windows[hn.w];
        return { tab: win.tabs.byId(hn.id), idx: null, tabId: hn.id, kind: "chrome", app: name, win, w: hn.w, P, lazy: want };
      }
    }
    const t = resolve(want);
    visibleGuard(t, tool);
    return t;
  }

  const isStale = (e) => !!e && /^stale_tab:/.test(e.message);
  function staleError(h) {
    return new Error("stale_tab: " + (h ? "tab " + h : "the tab") + " is gone (closed during the call); re-run list_tabs");
  }

  // Runs `f`, a read or command on t's tab. A specifier that names nothing
  // (errAENoSuchObject: the tab closed, or its window moved in the app's
  // positional window list) is re-resolved by the tab's id once and `f` runs
  // again; a tab found nowhere, or missing again, is stale_tab. Safari tabs have
  // no id to re-find them by, so theirs is stale_tab at once.
  function onTab(t, f) {
    try { return f(); } catch (e) {
      if (!noSuchObject(e)) throw e;
    }
    const h = t.lazy ? t.lazy.tabId : t.tabId != null ? handle(t.app, t.tabId) : null;
    if (t.lazy) delete hints[h];
    if (h == null || t.kind === "safari") throw staleError(h);
    const r = resolve({ tabId: h });
    visibleGuard(r, "page JS");
    t.lazy = t.winId = t.shown = null;
    t.pageOk = false;
    Object.assign(t, r);
    try { return f(); } catch (e) {
      if (noSuchObject(e)) throw staleError(h);
      throw e;
    }
  }

  function exec(t, js) {
    return onTab(t, function () { return execOnce(t, js); });
  }
  function execOnce(t, js) {
    if (t.kind === "safari") {
      if (t.pick) return pickRun(t, js);
      return safariJs(t, js);
    }
    const x = t.tab.execute({ javascript: js });
    // Arc JSON.stringifies whatever execute returns; perch's wrappers already did.
    if (t.kind === "arc") { try { return JSON.parse(x); } catch (e) { return x; } }
    return x;
  }

  function safariJs(t, js) {
    try { return app(t.app).doJavaScript(js, { in: t.tab }); }
    catch (e) {
      if (noSuchObject(e)) throw e;
      if (!isActive(t)) throw new Error(notVisible("page JS"));
      throw e;
    }
  }

  // Safari tabs have no id, so the page keeps the raw id of the handle perch last
  // ran it under in window.__perch_h; a tab at a handle's URL that carries another
  // handle's stamp is some other tab. The guard runs `s` only on a page at `hash`
  // whose stamp `mode` allows, and rewrites the stamp to `set`:
  //   any: any stamp but those in `foreign` (a handle perch hasn't stamped with,
  //        fresh from a listing; `foreign` are handles that stamped since it was issued)
  //   free: one of `ours` or none
  //   ours: one of `ours` only; an unstamped page answers UNSTAMPED
  // `ours` is the handle's raw id and those of the handles perch refreshed it to.
  const WRONG_TAB = "__perch_wrong_tab__", UNSTAMPED = "__perch_unstamped__";
  const ours = function (want, raw) { return [raw].concat(want.next || []); };
  function stampGuard(s, hash, mine, set, mode, foreign) {
    const q = JSON.stringify;
    const refuse = mode !== "any" ? "h!==undefined&&" + q(mine) + ".indexOf(h)<0"
      : foreign && foreign.length ? q(foreign) + ".indexOf(h)>=0" : "";
    return "(function(){if((" + fp + ")(location.href)!==" + q(hash) + ")return " + q(WRONG_TAB) + ";var h=window.__perch_h;" +
      (refuse ? "if(" + refuse + ")return " + q(WRONG_TAB) + ";" : "") +
      (mode === "ours" ? "if(h===undefined)return " + q(UNSTAMPED) + ";" : "") +
      "window.__perch_h=" + q(set) + ";return (\n" + s + "\n)})()";
  }
  // What a call reports beside its result: the handle it stamped a page with (s),
  // and that handle again as m when it differs from the one the call came with.
  let note = null;
  function noted(raw, set) {
    note = note || {};
    note.s = "safari:" + set;
    if (set !== raw) note.m = note.s;
  }
  // A Safari handle's window as last read: [tabs at its URL, tabs in all], as
  // note.c. For a handle that has stamped, an unstamped page at its recorded index
  // is its own reload only while both still match (pickRun). `urls[i]` is the URL
  // the handle hashes; `tally` (tallyOf(urls)) saves recounting a whole window.
  function tallyOf(urls) {
    const t = {};
    urls.forEach(function (u) { const h = fp(u); t[h] = (t[h] || 0) + 1; });
    return t;
  }
  function counted(handle, urls, i, tally) {
    note = note || {};
    (note.c = note.c || {})[handle] = [(tally || tallyOf(urls))[fp(urls[i])] || 0, urls.length];
  }

  // The first page JS on a resolved Safari handle picks its tab among the
  // candidates at its URL. The tab at the recorded index is tried first, then the
  // nearest; each costs one event, so an ambiguous window costs one per candidate.
  function pickRun(t, js) {
    const P = t.pick, c = P.cands;
    t.pick = null;
    if (P.winId == null) { try { P.winId = String(t.win.id()); } catch (e) {} }
    const run = function (i, mode) {
      // A window whose id can't be read has no handle to refresh to; the page keeps the one the call came with.
      const set = P.winId == null ? P.raw : P.winId + "." + i + "." + P.hash;
      t.idx = i;
      t.tab = t.win.tabs[i];
      const r = safariJs(t, stampGuard(js, P.hash, P.mine, set, mode, P.foreign));
      if (r === WRONG_TAB || r === UNSTAMPED) return r;
      noted(P.raw, set);
      if (P.total != null) (note.c = note.c || {})["safari:" + set] = [c.length, P.total];
      return { v: r };
    };
    const one = function (r) {
      if (r === WRONG_TAB || r === UNSTAMPED) throw new Error("stale_tab: tab " + P.tabId + " is gone; the tab at its URL is another one; re-run list_tabs");
      return r.v;
    };
    // A handle that has stamped (own) never adopts an unstamped page off its index:
    // once its tab is gone, that is the user's tab. At the index, an unstamped page
    // is its reload, or a tab that slid in; only unchanged counts say reload.
    const same = P.own && P.cnt != null && P.cnt[0] === c.length && P.cnt[1] === P.total && c.indexOf(P.idx) >= 0;
    if (c.length === 1 && (!P.own || same)) return one(run(c[0], c[0] === P.idx && !P.own ? "any" : "free"));
    // A stamp written since the listing (P.foreign) refuses the tab at the index;
    // another candidate may still carry this handle's own stamp.
    let refused = -1;
    if (!P.own && c.indexOf(P.idx) >= 0) {
      const r = run(P.idx, "any");
      if (r !== WRONG_TAB) return r.v;
      refused = P.idx;
    }
    const order = c.filter(function (i) { return i !== refused; }).sort(function (x, y) { return (x !== P.idx) - (y !== P.idx) || Math.abs(x - P.idx) - Math.abs(y - P.idx) || x - y; });
    for (const i of order) {
      const r = run(i, "ours");
      if (r !== WRONG_TAB && r !== UNSTAMPED) return r.v;
    }
    if (same) return one(run(P.idx, "free"));
    throw new Error("stale_tab: can't tell which tab " + P.tabId + " is; " + (c.length > 1 ? "several tabs show its URL" : "the tab at its URL may be another one") + "; re-run list_tabs");
  }

  // One-event page JS for a target that needs no guard: a Chromium handle with a
  // window hint, a Safari handle (the page checks its own URL hash and stamp
  // first), or the default target when the topmost browser is Chromium or Safari.
  // Returns {v}, or null (only when the script cannot have run) for the full
  // resolve path.
  // `at`, if given, gets the tab's window (app, kind, win, w, winId) and `run`,
  // which sends more page JS the same way.
  function quickExec(want, js, at) {
    want = want || {};
    if (want.windowId != null || want.tabIndex != null) return null;
    if (want.tabId != null) {
      const h = parseHandle(want.tabId);
      if (!h) return null;
      if (KIND[h.app] === "safari") {
        const m = /^(\d+)\.(\d+)\.(.+)$/.exec(h.raw);
        if (!m || !alive("Safari", procs())) return null;
        // A page stamped under another handle, or (for a handle that has stamped
        // before) not stamped at all, is left to pickRun, which sees the other candidates.
        const guard = function (s, mode) { return stampGuard(s, m[3], ours(want, h.raw), h.raw, mode, want.foreign); };
        const win = app("Safari").windows.byId(Number(m[1])), tab = win.tabs[Number(m[2])];
        let v;
        try { v = app("Safari").doJavaScript(guard(js, want.own ? "ours" : "any"), { in: tab }); }
        catch (e) { if (e && e.errorNumber === -1712) throw e; return null; }
        if (v === WRONG_TAB || v === UNSTAMPED) return null;
        noted(h.raw, h.raw);
        if (at) Object.assign(at, { app: "Safari", kind: "safari", win: win, winId: m[1], run: function (s) {
          const r = app("Safari").doJavaScript(guard(s, "ours"), { in: tab });
          if (r === WRONG_TAB || r === UNSTAMPED) throw staleError(want.tabId);
          return r;
        } });
        return { v: v };
      }
      const hn = hints[want.tabId];
      if (KIND[h.app] !== "chrome" || !hn || !alive(h.app, procs())) return null;
      const win = app(h.app).windows[hn.w], tab = win.tabs.byId(hn.id);
      let v;
      try { v = tab.execute({ javascript: js }); }
      catch (e) { if (noSuchObject(e)) { delete hints[want.tabId]; return null; } throw e; }
      if (at) Object.assign(at, { app: h.app, kind: "chrome", win: win, w: hn.w, run: function (s) { return tab.execute({ javascript: s }); } });
      return { v: v };
    }
    if (want.app != null) return null;
    const top = procs().z[0], kind = KIND[top];
    if (!top || (kind !== "chrome" && kind !== "safari")) return null;
    const win = app(top).windows[0];
    const run = kind === "chrome"
      ? function (s) { return win.activeTab.execute({ javascript: s }); }
      : function (s) { return app(top).doJavaScript(s, { in: win.currentTab }); };
    if (at) Object.assign(at, { app: top, kind: kind, win: win, w: 0, run: run });
    try {
      return { v: run(js) };
    } catch (e) {
      if (noSuchObject(e) || (kind === "safari" && !(e && e.errorNumber === -1712))) return null;
      throw e;
    }
  }

  // exec with an Apple Event timeout of `secs`. Chrome never replies to an
  // execute that lands while a navigation is replacing the document, and JXA
  // commands take no timeout, so a plain execute then blocks for the 2-minute
  // Apple Event default. AppleScript's `with timeout` bounds the wait; the
  // abandoned reply is harmless. Only Chrome tabs pinned by id take this path.
  // The error Ref is never read: after a timeout it can hold a freed
  // dictionary, and reading it segfaults osascript.
  // navigate's page JS answers in tens of ms; a dropped reply costs at most this.
  const NAV_EXEC_SECS = 0.5;
  // Schemes of Chromium browsers' own pages (new tab, settings, devtools).
  const BROWSER_PAGE = /^(chrome|chrome-untrusted|chrome-search|devtools|edge|brave|vivaldi|opera):/i;
  // The only urls the runtime hands a browser, checked before any Apple Event
  // for callers that skip Node's checkUrl.
  const loadable = function (tool, u) {
    if (typeof u === "string" && /^(https?:\/\/|file:\/\/|about:blank$)/i.test(u)) return;
    const m = typeof u === "string" ? /^([a-z][a-z0-9+.-]*):/i.exec(u) : null;
    throw new Error("bad_url: " + tool + " takes an absolute http(s) or file URL, or about:blank; got " + (typeof u !== "string" ? "a " + typeof u : m ? m[1].toLowerCase() : "no scheme"));
  };
  // How long navigate holds page JS while the tab reports loading.
  const NAV_GATE_MS = 2000;
  // Provisional: how long a background Arc tab may read not loading after its url
  // is set before a load that never started counts as failed. Not yet measured live.
  const ARC_START_GRACE = 1500;
  // A poll's page JS answers in tens of ms, or seconds on a loaded machine; a reply
  // dropped mid-navigation costs at most this.
  const POLL_EXEC_SECS = 2;
  const asQuote = function (s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; };
  const NO_REPLY = "timeout: " + HANG.noReply;
  const isNoReply = function (e) { return !!e && e.message.indexOf(NO_REPLY) === 0; };
  // NSAppleScript compiles on its first run, which live costs about as much as
  // the execute itself, so each (browser, tab, window) gets one compiled handler
  // taking the JS and the timeout as parameters, kept across calls. A few
  // entries cover a session's tabs; the cache starts over past AS_CACHE_MAX.
  const AS_CACHE_MAX = 32;
  let asScripts = {}, asCount = 0;
  function asScript(app, tabId, win) {
    const key = app + "\n" + tabId + "\n" + win;
    if (asScripts[key]) return asScripts[key];
    if (++asCount > AS_CACHE_MAX) { asScripts = {}; asCount = 1; }
    const src = "on perch_exec(js, ms)\nwith timeout of (ms / 1000) seconds\ntell application " + asQuote(app) +
      " to execute tab id " + asQuote(tabId) + " of " + win + " javascript js\nend timeout\nend perch_exec";
    const s = $.NSAppleScript.alloc.initWithSource(src);
    if (!s.compileAndReturnError(Ref())) return null;
    return (asScripts[key] = s);
  }
  // A subroutine Apple Event ('ascr'/'psbr') calling perch_exec with {js, ms};
  // 'snam' names the handler and '----' holds the arguments.
  function asCall(js, ms) {
    const D = $.NSAppleEventDescriptor;
    const ev = D.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(0x61736372, 0x70736272, D.nullDescriptor, -1, 0);
    ev.setParamDescriptorForKeyword(D.descriptorWithString("perch_exec"), 0x736e616d);
    const args = D.listDescriptor;
    args.insertDescriptorAtIndex(D.descriptorWithString(js), 1);
    args.insertDescriptorAtIndex(D.descriptorWithInt32(ms), 2);
    ev.setParamDescriptorForKeyword(args, 0x2d2d2d2d);
    return ev;
  }
  // `win` is an AppleScript window specifier.
  function asExecute(t, js, secs, win) {
    const s = asScript(t.app, t.tabId, win);
    if (!s) throw new Error("page JS failed");
    const start = Date.now();
    const d = s.executeAppleEventError(asCall(js, Math.round(secs * 1000)), Ref());
    if (d.isNil()) throw new Error(Date.now() - start >= secs * 900 ? NO_REPLY + secs + "s; the page may be navigating; retry" : "page JS failed");
    return ObjC.unwrap(d.stringValue);
  }
  // AppleScript's `tell application "Name"` may reach another instance of the
  // browser (another tool's headless copy), while JXA's Application(name) reaches
  // the user's. With several running, the bounded path is off and page JS takes
  // the plain one. One ObjC read per call, no Apple Event.
  function soleInstance(t) {
    if (t.solo == null) {
      // Fails closed: a count that can't be read takes the plain path.
      t.solo = false;
      try { appKit(); t.solo = Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier(BUNDLE[t.app]).count) <= 1; } catch (e) {}
    }
    return t.solo;
  }
  function execWithin(t, js, secs) {
    if (t.kind !== "chrome" || t.tabId == null || !soleInstance(t)) return exec(t, js);
    if (t.winId == null) t.winId = t.win.id();
    return asExecute(t, js, secs, "window id " + asQuote(t.winId));
  }
  // execWithin for polls and the reads after them, one Apple Event like exec: with
  // no window id at hand the window goes by position (`window N` is JXA's
  // windows[N-1], the window the plain path's specifier names). A fast failure (a
  // raised window moved the tab's window, JS from Apple Events off) takes the
  // plain path, which re-finds a moved tab and reports the real error.
  const pinned = function (t) { return t.kind === "chrome" && t.tabId != null && (t.winId != null || t.w != null) && soleInstance(t); };
  const namedWindow = function (t) { return t.winId != null ? "window id " + asQuote(t.winId) : "window " + (t.w + 1); };
  function pollExec(t, js, secs) {
    if (!pinned(t)) return exec(t, js);
    try { return asExecute(t, js, secs, namedWindow(t)); }
    catch (e) { if (isNoReply(e)) throw e; }
    return exec(t, js);
  }
  // A one-shot read, sent once more with twice the cap after a dropped reply: it
  // is read-only, and after a navigation drop the new document answers at once.
  function readExec(t, js) {
    let r;
    try { r = pollExec(t, js, POLL_EXEC_SECS); }
    catch (e) { if (!isNoReply(e)) throw e; r = pollExec(t, js, 2 * POLL_EXEC_SECS); }
    return JSON.parse(String(r));
  }
  // A step with side effects (opening, typing, pressing) is never sent twice: a
  // dropped reply may mean it ran and the page is leaving.
  const MAY_HAVE_RUN = "; it may have run, and the page may be navigating; retry after checking the page";
  // A step may run long synchronously (a click handler, a picker opening), and a
  // loaded machine answers late; a step's dropped reply costs at most this.
  const STEP_EXEC_SECS = 5;
  // Reads that follow a `tool` step which ran: their dropped reply must not read as
  // "retry", which would repeat the step.
  function afterStep(tool, f) {
    try { return f(); } catch (e) {
      if (!isNoReply(e) || e.message.indexOf(MAY_HAVE_RUN) >= 0) throw e;
      throw new Error("timeout: the " + tool + HANG.ranNoReply + "; the page may be navigating; don't " + tool + " again, check the page");
    }
  }
  // pollExec for steps. A fast failure's error is never read (see asExecute), so the
  // step is resent on the plain path only when that failure proves it never ran:
  // the tab is not in the window named (a raised window moved it), or page JS is
  // off, which the plain probe reports as its own error. Anything else may have run.
  function stepExec(t, js, secs) {
    if (!pinned(t)) return exec(t, js);
    try { return asExecute(t, js, secs, namedWindow(t)); }
    catch (e) { if (isNoReply(e)) throw new Error(NO_REPLY + secs + "s" + MAY_HAVE_RUN); }
    if (!inNamedWindow(t)) return exec(t, js);
    exec(t, "1");
    throw new Error("timeout: " + HANG.failed + MAY_HAVE_RUN);
  }
  function inNamedWindow(t) {
    const w = t.winId != null ? app(t.app).windows.byId(t.winId) : app(t.app).windows[t.w];
    try { w.tabs.byId(t.tabId).id(); return true; } catch (e) { if (noSuchObject(e)) return false; throw e; }
  }
  const stepRead = function (t, js, secs) { return JSON.parse(String(stepExec(t, js, secs || STEP_EXEC_SECS))); };

  function pollValue(r) {
    try { return r != null && r !== "" ? JSON.parse(String(r)) : null; } catch (e) { return null; }
  }
  // Re-runs `js` (which returns a JSON string) until it yields non-null/non-false.
  // A failed run counts as not yet, except a closed tab. A dropped reply doubles
  // the next run's cap, so a slow read still answers while a navigation costs
  // one POLL_EXEC_SECS. `step`: `js` has side effects, so a dropped reply ends it.
  // `done(v)`, if given, decides instead and sees every run, a failed one as null.
  // `start` (default now) is when the caller's clock began: the deadline is
  // start + timeout, and the first run happens even if setup already spent it.
  // `js` may be a function giving each run's script.
  function poll(t, js, timeout, interval, step, done, start) {
    if (start == null) start = Date.now();
    const deadline = start + timeout;
    let cap = POLL_EXEC_SECS, silent = false, answered = null;
    pollSilent = false;
    for (;;) {
      let v = null;
      silent = false;
      // A step run gets the full cap even near the deadline: cutting it short would
      // turn a pick that answered null in time into "may have run".
      const secs = step ? STEP_EXEC_SECS : Math.max(0.1, Math.min(cap, (deadline - Date.now()) / 1000));
      const src = typeof js === "function" ? js() : js;
      try { v = pollValue(step ? stepExec(t, src, secs) : pollExec(t, src, secs)); } catch (e) {
        if (isStale(e) || (step && isNoReply(e))) throw e;
        if (isNoReply(e)) { cap *= 2; silent = true; }
      }
      if (!silent) answered = Date.now();
      if (done ? done(v) : v !== null && v !== false) return { value: v, waited: Date.now() - start };
      const left = deadline - Date.now();
      if (left > 0) delay(Math.min(interval, left) / 1000);
      if (Date.now() >= deadline) { pollSilent = silent && (answered == null || Date.now() - answered >= SILENT_MS); return null; }
    }
  }
  // Whether the last poll ran out with the page unanswered since it began, or for
  // SILENT_MS: the page may be blocked (a dialog), not merely not there yet. Node
  // probes for a dialog then. One lost reply after answered runs is load, not a hang.
  let pollSilent = false;
  const SILENT_MS = 1000;
  const UNANSWERED = HANG.unanswered;
  const ranOut = function (msg) { return new Error(msg + (pollSilent ? UNANSWERED : "")); };


  // Window geometry plus the pid and CGWindowID that screencapture -l and CGEvent
  // routing need. Chromium and Safari answer bounds() (Chromium fails position(), and a
  // failed read costs a full Apple Event); Arc has neither, so its frame comes
  // from its own CG entry. AppleScript reports inner-content bounds while CG
  // includes the titlebar, so the closest CG entry wins, if it is close enough:
  // only y and h may differ by the titlebar and toolbar. A minimized window has no
  // entry, and the nearest one is then another window.
  function ids(t) {
    if (t.P.dupe && t.P.dupe[t.app]) throw new Error(TWINS);
    let geom = null;
    if (t.kind !== "arc") { try { const b = t.win.bounds(); geom = { x: b.x, y: b.y, w: b.width, h: b.height }; } catch (e) {} }
    const cands = t.P.wins[t.app] || [];
    let best = null, ambiguous = false;
    if (geom) {
      const score = function (c) { return Math.abs(c.x - geom.x) + Math.abs(c.y - geom.y) + Math.abs(c.w - geom.w) + Math.abs(c.h - geom.h); };
      let bestScore = Infinity;
      cands.forEach(function (c) { if (score(c) < bestScore) { bestScore = score(c); best = c; } });
      // Another entry about as close: geometry can't say which CGWindowID is ours.
      ambiguous = cands.some(function (c) { return c !== best && score(c) <= bestScore + 2; });
      if (best && (Math.abs(best.x - geom.x) > 4 || Math.abs(best.w - geom.w) > 4 || Math.abs(best.y - geom.y) > 120 || Math.abs(best.h - geom.h) > 120)) { best = null; ambiguous = false; }
    } else {
      best = byTitle(t, cands);
      if (best) geom = { x: best.x, y: best.y, w: best.w, h: best.h };
    }
    if (!geom) throw new Error(OFFSCREEN);
    const I = {
      geom: geom,
      pid: t.P.pid[t.app] == null ? null : t.P.pid[t.app],
      windowNumber: best ? best.wid : null,
      cgBounds: best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null,
    };
    if (ambiguous) I.ambiguous = true;
    return I;
  }

  // Input and frame reads need the one window that is ours; screenshots don't check.
  function ownWindow(I) {
    if (I.windowNumber == null) throw new Error(OFFSCREEN);
    if (I.ambiguous) throw new Error(AMBIGUOUS);
    return I;
  }

  // Arc has no geometry verbs, so its window is matched to a CG entry by title.
  // Both lists run front to back, so same-titled windows pair up in order, but
  // only while each of them is on screen (a minimized one has no entry). CG titles
  // are empty without the Screen Recording grant; then every window must be.
  // t.win is windows[t.w], so one bulk name read covers the target and the rest.
  function byTitle(t, cands) {
    try {
      const names = app(t.app).windows.name(), name = names[t.w];
      const count = function (list, n) { return list.filter(function (x) { return x === n; }).length; };
      if (name && count(cands.map(function (c) { return c.name; }), name) === count(names, name)) {
        return cands.filter(function (c) { return c.name === name; })[count(names.slice(0, t.w), name)];
      }
      return names.length === cands.length ? cands[t.w] || null : null;
    } catch (e) { return null; }
  }

  // Only the active tab of a window is rendered. Never switch tabs implicitly:
  // that can put Chrome's window into focus even without app.activate().
  function shotTarget(a) {
    const t = resolve(a.target);
    if (a.raise) { focus(t); delay(0.25); t.P = procs(); }
    else if (a.target && (a.target.tabIndex != null || a.target.tabId != null) && !isActive(t)) {
      throw new Error(notVisible("a background screenshot") + ", or pass raise:true");
    }
    const I = ids(t);
    if (I.windowNumber == null) throw new Error(OFFSCREEN);
    return { t: t, I: I };
  }
  function shotGeom(a) { return shotTarget(a).I; }

  // screenshot {ref|selector}: a.clip brings the element into view and measures
  // it, the capture is cut to it, and a.restore puts every scroll position back
  // before the call returns, whatever the capture did. Only the Accessibility
  // page area places the viewport in the window: the page's own screenX and
  // outer size can't tell browser chrome from a docked DevTools or side panel.
  // A refusal carries only its error, none of the window's geometry.
  const SHOT_NO_AX = "screenshot: cropping to an element needs the Accessibility grant to place the page in the window; grant it, or screenshot without ref or selector";
  const SHOT_NO_AREA = "screenshot: Accessibility shows no page area matching this tab's viewport; nothing was captured; screenshot without ref or selector";
  const SHOT_OUTSIDE = "screenshot: the element is outside the visible page even after scrolling it into view; nothing was captured";
  // Node's screencapture fallback runs after the restore, so it would see the
  // page as it was, not the rect measured after the scroll.
  const SHOT_MOVED = "screenshot: cropping an element that had to be scrolled into view needs the Screen Recording grant for in-process capture; grant it, or scroll it into view and call again";
  // A window the browser stopped painting (covered, hidden, or too slow) still
  // holds the frame from before the scroll.
  const SHOT_UNPAINTED = "screenshot: the window isn't painting (covered or hidden); show the window or scroll the element into view and call again; nothing was captured";
  // After a scroll, a.painted is polled until the page has run two animation
  // frames, the second after the scroll's frame was painted.
  const SHOT_POLLS = 6;
  function shotPainted(t, fn) {
    for (let i = 0; i < SHOT_POLLS; i++) {
      delay(0.05);
      let p = null;
      try { p = parseExec(t, fn); } catch (e) {}
      if (p && p.painted === true) return true;
    }
    return false;
  }
  function shotClip(a) {
    const s = shotTarget(a), t = s.t, I = s.I;
    visibleGuard(t, "screenshot");
    let trusted = false;
    try { ObjC.import("ApplicationServices"); trusted = !!$.AXIsProcessTrusted(); } catch (e) {}
    if (!trusted) return { ok: false, error: SHOT_NO_AX };
    const c = parseExec(t, a.clip);
    if (!c || c.ok !== true) {
      if (c && c.restore) {
        try { exec(t, a.restore); } catch (e) {}
        return { ok: false, error: c.unpainted ? SHOT_UNPAINTED : c.error };
      }
      if (!threw(c)) return c;
      try { exec(t, a.restore); } catch (e) {}
      // PerchStaleRef stays raw for handleCall, which maps it to the call's ref miss.
      return faultName(c) === "PerchStaleRef" ? c : { ok: false, error: "screenshot: the page script failed on this page (" + faultName(c) + "); nothing was captured" };
    }
    let err = null, refused = null;
    try {
      const m = shotMap(I, c);
      if (typeof m === "string") refused = m;
      else {
        if (c.moved && !shotPainted(t, a.painted)) refused = SHOT_UNPAINTED;
        else {
          const cap = capture(I.windowNumber, a.format, a.maxWidth, m);
          if (cap) Object.assign(I, { data: cap.data, image: cap.image, clip: cap.clip });
          else if (c.moved) refused = SHOT_MOVED;
          else I.map = m;
          I.aim = "ax";
          if (m.clipped || (cap && cap.cut)) I.clipped = true;
        }
      }
    } catch (e) { err = e; }
    let back = null;
    try { back = parseExec(t, a.restore); } catch (e) {}
    if (err) throw err;
    if (refused) return { ok: false, error: refused };
    if (!back || back.ok !== true) I.warning = "the page's scroll positions may not have been restored";
    return I;
  }

  // Where the clip's CSS box lands in the capture: pixel = k * (ox + s*v) for a
  // CSS coordinate v, k being capture pixels per window point, (ox, oy) the
  // Accessibility page area's origin in window points and s its points per CSS
  // px (zoom included). The box is the element plus SHOT_MARGIN CSS px, cut at
  // the viewport. A string is the refusal when there is no box or no area.
  const SHOT_MARGIN = 8;
  function shotMap(I, c) {
    const r = I.cgBounds || I.geom, g = SHOT_MARGIN;
    const box = { x0: Math.max(0, c.x - g), y0: Math.max(0, c.y - g), x1: Math.min(c.iw, c.x + c.w + g), y1: Math.min(c.ih, c.y + c.h + g) };
    if (!(box.x1 > box.x0 && box.y1 > box.y0)) return SHOT_OUTSIDE;
    const w = axPageArea(I, { iw: c.iw, ih: c.ih });
    if (!w) return SHOT_NO_AREA;
    return { ox: w.x - r.x, oy: w.y - r.y, s: w.scale, box: box, cw: r.w, clipped: c.x < 0 || c.y < 0 || c.x + c.w > c.iw || c.y + c.h > c.ih };
  }
  // A shot map's box in pixels of a W x H capture, kept inside it (cut if it had
  // to be). Node's clipPixels does the same for the screencapture fallback.
  function clipPixels(m, W, H) {
    const k = W / m.cw, px = function (o, v) { return k * (o + m.s * v); };
    const x0 = Math.floor(px(m.ox, m.box.x0) + 1e-6), y0 = Math.floor(px(m.oy, m.box.y0) + 1e-6);
    const x1 = Math.ceil(px(m.ox, m.box.x1) - 1e-6), y1 = Math.ceil(px(m.oy, m.box.y1) - 1e-6);
    const x = Math.max(0, x0), y = Math.max(0, y0);
    return { x: x, y: y, w: Math.min(W, x1) - x, h: Math.min(H, y1) - y, cut: x0 < 0 || y0 < 0 || x1 > W || y1 > H };
  }

  // The window's own pixels, captured and encoded here rather than by spawning
  // screencapture and sips. CGPreflightScreenCaptureAccess never prompts; without
  // the grant, or on an empty image, it returns null and screencapture (which
  // asks for the grant itself) takes over, as it does after a failed downscale.
  // With a shot map it keeps only the map's box, cut before any downscale.
  function capture(wid, format, maxWidth, map) {
    try {
      ObjC.import("CoreGraphics");
      appKit();
      ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
      if (!$.CGPreflightScreenCaptureAccess()) return null;
      // kCGWindowListOptionIncludingWindow, kCGWindowImageBoundsIgnoreFraming (no shadow, as screencapture -o).
      let img = $.CGWindowListCreateImage($.CGRectNull, 8, wid, 1);
      let w = Number($.CGImageGetWidth(img)), h = Number($.CGImageGetHeight(img));
      if (!w || !h) return null;
      let clip = null;
      if (map) {
        clip = clipPixels(map, w, h);
        if (!(clip.w > 0 && clip.h > 0)) return null;
        img = $.CGImageCreateWithImageInRect(img, $.CGRectMake(clip.x, clip.y, clip.w, clip.h));
        w = Number($.CGImageGetWidth(img)); h = Number($.CGImageGetHeight(img));
        if (w !== clip.w || h !== clip.h) return null;
      }
      if (maxWidth > 0 && w > maxWidth) {
        const sh = Math.round(h * maxWidth / w);
        // kCGImageAlphaPremultipliedLast, kCGInterpolationHigh.
        const ctx = $.CGBitmapContextCreate(null, maxWidth, sh, 8, 0, $.CGImageGetColorSpace(img), 1);
        $.CGContextSetInterpolationQuality(ctx, 3);
        $.CGContextDrawImage(ctx, $.CGRectMake(0, 0, maxWidth, sh), img);
        const small = $.CGBitmapContextCreateImage(ctx);
        // A failed downscale hands the shot to screencapture and sips, which
        // always shrink it, rather than returning one wider than asked.
        if (Number($.CGImageGetWidth(small)) !== maxWidth) return null;
        img = small; w = maxWidth; h = sh;
      }
      const rep = $.NSBitmapImageRep.alloc.initWithCGImage(img);
      const data = format === "jpeg"
        ? rep.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, $({ NSImageCompressionFactor: 0.8 }))
        : rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
      if (!data || !Number(data.length)) return null;
      const out = { data: data.base64EncodedStringWithOptions(0).js, image: { w: w, h: h } };
      if (clip) { out.clip = { x: clip.x, y: clip.y, w: clip.w, h: clip.h }; if (clip.cut) out.cut = true; }
      return out;
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
  function trustedTarget(a, what, resolved) {
    const t = resolved || resolve(a.target);
    arcPageGuard(t, what || "trusted input");
    requireAccessibility();
    if (a.raise) { focus(t); delay(0.2); t.P = procs(); }
    else if (!isActive(t)) throw new Error(what ? notVisible(what) : notVisible("a background trusted click") + ", or pass raise:true");
    const I = ownWindow(ids(t));
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

  // A key pair addressed to the browser pid only: no window fields, no Command
  // flag. The Unicode string goes on both events, as AppKit's own key events carry it.
  function skyKey(I, vk, uni, flags) {
    skyInit();
    if (I.pid == null) throw new Error("SkyLight target has no pid");
    ObjC.bindFunction("CGEventKeyboardSetUnicodeString", ["void", ["void *", "unsigned long", "void *"]]);
    const data = $(uni).dataUsingEncoding(0x94000100); // NSUTF16LittleEndianStringEncoding
    [true, false].forEach(function (down) {
      if (!down) delay(0.01);
      const e = $.CGEventCreateKeyboardEvent($.CGEventSourceCreate(1), vk, down);
      $.CGEventKeyboardSetUnicodeString(e, uni.length, data.bytes);
      $.CGEventSetFlags(e, flags & ~0x100000);
      $.SLEventPostToPid(I.pid, e);
    });
  }

  // skyKey has no window routing: the browser hands the key to its key window's
  // focused element. So a press goes ahead only when Accessibility (no Apple
  // Events) shows that window is the target's, as the one CG entry of the pid
  // with its frame, and the focused element sits inside the page's own web area,
  // not the toolbar, a popup, a side panel or a child window. Returns why not, or null.
  function keyFocusMiss(I, P, probe) {
    const ax = axInit(), app = $.AXUIElementCreateApplication(I.pid);
    const win = ax.attr(app, "AXFocusedWindow"), wf = win && ax.frame(win);
    const near = function (a, b, d) { return Math.abs(a.x - b.x) <= d && Math.abs(a.y - b.y) <= d && Math.abs(a.w - b.w) <= d && Math.abs(a.h - b.h) <= d; };
    const same = wf ? (P.byPid[I.pid] || []).filter(function (c) { return near(c, wf, 4); }) : [];
    if (same.length !== 1 || same[0].wid !== I.windowNumber) {
      return "another browser window has the keyboard (or it can't be told apart); click {trusted:true, raise:true} on the page first";
    }
    const area = axPageArea(I, probe), af = area && ax.frame(area.el);
    let el = af ? ax.attr(app, "AXFocusedUIElement") : null;
    // The first web area up must be the page's: one below it is an embedded frame's
    // (a captcha, a sign-in widget), where a key must not go.
    let framed = false;
    for (let i = 0; el && i < 64; i++, el = ax.attr(el, "AXParent")) {
      if (ax.str(el, "AXRole") !== "AXWebArea") continue;
      const f = ax.frame(el);
      if (f && near(f, af, 1)) return framed ? "focus is inside an embedded frame; frames take only click {trusted:true}" : null;
      framed = true;
    }
    return "the browser's keyboard focus is outside the page (toolbar, popup or panel); a background trusted click on the page first moves it back";
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

  // After a click armed with readback: the first changed text/url within a.settle ms,
  // else what the element shows now. Polled here because page timers are throttled.
  function readback(t, a) {
    const v = afterStep("click", function () {
      const r = poll(t, a.read, a.settle, 50);
      return r ? r.value : readExec(t, a.readFinal);
    });
    return threw(v) ? { ok: false, error: "click: the click was sent; the page script failed reading it back (" + faultName(v) + "); outcome unverified" } : v;
  }

  // A click that opens a new tab is found by the app's tab lists, one bulk read
  // of every window before and after: ids, or Safari's urls (its tabs have no id),
  // so a tab the browser put in another window counts too. The new tab is never
  // selected; a browser that showed it itself gets a note.
  const winOf = function (t) { return { app: t.app, kind: t.kind, w: t.w }; };
  function tabSet(W) {
    try { const all = app(W.app).windows.tabs; return W.kind === "safari" ? all.url() : all.id(); } catch (e) { return null; }
  }
  // Safari: the indexes `after` added over `before` when the old list is still in
  // it in order, else the first index where they differ; [] when it didn't grow.
  function grewBy(before, after) {
    if (after.length <= before.length) return [];
    const added = [];
    let k = 0;
    for (let i = 0; i < after.length; i++) {
      if (k < before.length && after[i] === before[k]) k++; else added.push(i);
    }
    if (k === before.length) return added;
    for (let i = 0; i < before.length; i++) if (after[i] !== before[i]) return [i];
    return [before.length];
  }
  // {j: window position now, i: tab index in it} of every tab that wasn't there
  // before, the clicked window's first.
  function addedAt(kind, before, after, w) {
    after = after.map(function (l) { return l || []; });
    const out = [];
    if (kind !== "safari") {
      const had = {};
      before.forEach(function (l) { (l || []).forEach(function (id) { had[String(id)] = true; }); });
      const order = after.map(function (l, j) { return j; });
      if (w != null && w < after.length) { order.splice(w, 1); order.unshift(w); }
      order.forEach(function (j) { after[j].forEach(function (id, i) { if (!had[String(id)]) out.push({ j: j, i: i }); }); });
      return out;
    }
    // Safari windows can't be told apart in the same event, so an unchanged list
    // pairs a window with itself; a changed one pairs with a list it grew from; a
    // window left over whose length no old list has is new, and its tab is the first.
    const old = before.map(function (l) { return l || []; }), rest = [];
    after.forEach(function (l, j) {
      const k = old.findIndex(function (b) { return b && b.length === l.length && b.every(function (u, i) { return u === l[i]; }); });
      if (k >= 0) old[k] = null; else rest.push(j);
    });
    const left = old.filter(function (b) { return b; }), placed = {};
    rest.forEach(function (j) {
      for (let k = 0; k < left.length; k++) {
        const is = grewBy(left[k], after[j]);
        if (is.length) { placed[j] = true; is.forEach(function (i) { out.push({ j: j, i: i }); }); return; }
      }
    });
    if (after.length > before.length) {
      rest.forEach(function (j) {
        const len = after[j].length;
        if (!placed[j] && len && !left.some(function (b) { return b.length === len; })) out.push({ j: j, i: 0 });
      });
    }
    if (w != null) out.sort(function (x, y) { return (x.j !== w) - (y.j !== w); });
    return out;
  }
  // A popup blocker drops the tab silently, and a browser adds an allowed one
  // soon after the click, so an empty result is re-read this long first. Only a
  // tab at one of `hrefs` (the same page, else a same-origin redirect) or still
  // blank is the click's; one the user, another agent or a site opened is not.
  const OPEN_WAIT_MS = 500;
  function tabOpened(W, before, hrefs, wait) {
    const start = Date.now();
    let foreign = null;
    for (;;) {
      const after = tabSet(W), found = after ? addedAt(W.kind, before, after, W.w) : [];
      let best = null;
      for (let n = 0; n < found.length && !(best && best.rank === 3); n++) {
        const at = found[n], raw = after[at.j][at.i];
        let url = raw;
        if (W.kind !== "safari") { try { url = app(W.app).windows[at.j].tabs.byId(raw).url(); } catch (e) { continue; } }
        const rank = urlRank(url, hrefs);
        if (rank && (!best || rank > best.rank)) best = { at: at, url: url, rank: rank };
        else if (!rank && !foreign) foreign = originPath(url);
      }
      if (best) return openedTab(W, after, best.at, best.rank === 2 ? hrefs[0] : best.url);
      if (Date.now() - start >= wait) return foreign ? { foreign: foreign } : null;
      delay(0.1);
    }
  }
  // Origin (lowercased) and path of an absolute URL, or null.
  function splitUrl(u) {
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^\/?#]*)([^?#]*)/i.exec(String(u));
    return m ? { o: m[1].toLowerCase(), p: m[2] || "/" } : null;
  }
  function originPath(u) { const s = splitUrl(u); return s ? s.o + s.p : String(u).split(/[?#]/)[0]; }
  // 3: the page an href names; 2: blank or still loading; 1: an href's origin; 0: not the click's.
  function urlRank(url, hrefs) {
    if (fp(url) === fp("")) return 2;
    const s = splitUrl(url);
    let rank = 0;
    if (s) hrefs.forEach(function (h) { const t = splitUrl(h); if (t && t.o === s.o) rank = Math.max(rank, t.p === s.p ? 3 : 1); });
    return rank;
  }
  // A new Safari tab still loading reads blank, so its handle hashes the URL it is loading.
  function openedTab(W, after, at, url) {
    const raw = after[at.j][at.i], out = { tabId: null, url: url, shown: false };
    try {
      const win = app(W.app).windows[at.j];
      if (W.kind === "safari") {
        out.tabId = safariHandle(win.id(), at.i, url);
        const urls = after[at.j].slice();
        urls[at.i] = url;
        counted(out.tabId, urls, at.i);
        out.shown = win.currentTab.index() === at.i + 1;
      } else {
        out.tabId = handle(W.app, raw);
        if (W.kind === "chrome") hint(W.app, raw, at.j);
        out.shown = String(win.activeTab.id()) === String(raw);
      }
    } catch (e) {}
    return out;
  }
  // `r` is a click's result: `cancelled` (the page prevented the default) and
  // window.open's opened/blocked, which a tab found replaces. Only the page seeing
  // window.open return null is `blocked`; no tab in time is `unconfirmed`.
  function noteOpened(r, W, before, href) {
    const cancelled = !!r.cancelled;
    delete r.cancelled;
    const hrefs = [href];
    if (r.opened && r.opened.url) hrefs.push(r.opened.url);
    if (r.blocked && r.href) hrefs.push(r.href);
    const o = tabOpened(W, before, hrefs, cancelled ? 0 : OPEN_WAIT_MS);
    if (o && !o.foreign) {
      delete r.blocked; delete r.href; delete r.note;
      r.opened = { tabId: o.tabId, url: o.url };
      if (o.shown) r.note = "the browser showed the new tab";
    } else if (!cancelled && !r.opened) {
      if (!r.blocked) { r.unconfirmed = true; r.href = href; }
      if (o) r.note = "no new tab for href within 0.5s; a tab opened meanwhile at " + o.foreign + " is not the click's: list_tabs urlContains href";
      else if (!r.blocked) r.note = "no new tab within 0.5s; it may be blocked or still opening: list_tabs urlContains href";
    }
    return r;
  }
  // `go` is the click's second page call (the first found a new-tab element).
  function clickBlank(W, href, go) {
    const before = tabSet(W);
    const r = go();
    if (!r || r.ok !== true) return r;
    if (!before) { delete r.cancelled; return r; }
    return noteOpened(r, W, before, href);
  }

  // A perch page script's thrown error, by name only: its message and stack are
  // page internals. A name that isn't an identifier is the page's text too.
  function faultName(v) {
    const n = v && v.__perch_error_name;
    return typeof n === "string" && /^[A-Za-z_$][\w$]{0,39}$/.test(n) ? n : "Error";
  }
  const threw = function (v) { return !!v && v.__perch_error != null; };
  // Trusted input whose step before the post threw sends nothing; one whose check
  // after it threw was sent but can't be vouched for.
  const armFault = function (tool, v) { return { ok: false, error: tool + ": the page script failed on this page (" + faultName(v) + "); nothing was " + (tool === "press" ? "pressed" : "clicked") }; };
  const checkFault = function (tool, v) { return tool + ": the " + (tool === "press" ? "key" : "click") + " was sent; the page script failed checking it (" + faultName(v) + "); outcome unverified"; };

  // wait {quiet}: timed here, where the clock isn't throttled with the page. The
  // window opens when a run arms the observer (fresh); a run that fails or finds
  // a new document restarts it. Runs send a.arm until one answers, then a.js.
  function waitQuiet(a, start, interval) {
    const t = pageTarget(a.target, "wait");
    let last = start, quietFor = 0, armed = false;
    const r = poll(t, function () { return armed ? a.js : a.arm; }, a.timeout, interval, false, function (v) {
      const now = Date.now();
      if (v && v.__perch_error) return true;
      if (v) armed = true;
      if (!v || v.busy || v.fresh) last = now;
      quietFor = now - last;
      return quietFor >= a.quiet;
    }, start);
    if (!r) throw ranOut("timeout: wait timed out after " + a.timeout + "ms; the page never stayed quiet for " + a.quiet + "ms");
    if (r.value.__perch_error) throw new Error("wait: the page script failed on this page (" + faultName(r.value) + "); nothing verified");
    return { waited: Date.now() - start, quietFor: quietFor };
  }

  // A refusal when the screen point falls on one of the page's embedded frames,
  // placed through Accessibility when it finds the page area, else by the page's
  // estimate. A page that can't answer fails closed.
  function pointOnFrame(T, a, f) {
    if (!f || !f.rects) return { ok: false, error: "could not check the page for embedded frames at that point, so nothing was clicked" + (f && f.__perch_error != null ? " (" + faultName(f) + ")" : "") };
    if (!f.rects.length) return null;
    let w = null;
    try { w = axPageArea(T.I, f); } catch (e) {}
    const x = w ? (a.x - w.x) / w.scale : a.x - f.ox, y = w ? (a.y - w.y) / w.scale : a.y - f.oy;
    const hit = f.rects.some(function (r) { return x >= r[0] && x < r[2] && y >= r[1] && y < r[3]; });
    return hit ? { ok: false, error: "point " + Math.round(a.x) + "," + Math.round(a.y) + " is on an embedded frame; reach frame controls through accessibility_snapshot {frames:true} and click an fN ref with trusted:true" } : null;
  }

  // The last check before a trusted click posts, at its final screen point: the
  // first web area up from Accessibility's hit there must be the page's own. Page
  // JS misses a frame in a closed shadow root (elementFromPoint gives its host);
  // another web area first is such a frame, none at all is browser UI, a bubble
  // or a child window. A hit test that fails, or no page area, refuses too.
  // A standard window other than the target's (by CGWindowID, else frame) is
  // another of the browser's windows in front, named apart for a clearer error.
  // `area` is the page area aim already read, if any.
  function offPage(T, probe, pt, area) {
    const ax = axInit();
    if (area === undefined) try { area = axPageArea(T.I, probe); } catch (e) {}
    let el = area ? ax.hit(T.I.pid, pt) : null, web = false;
    for (let i = 0; el && i < 64; i++, el = ax.attr(el, "AXParent")) {
      const role = ax.str(el, "AXRole");
      if (role === "AXWebArea" && !web) { if (ax.same(el, area.el)) return null; web = true; }
      if (role !== "AXWindow") continue;
      const id = ax.wid(el), f = ax.frame(el), r = T.I.cgBounds || T.I.geom;
      const mine = id != null ? id === T.I.windowNumber : !!f && Math.abs(f.x - r.x) + Math.abs(f.y - r.y) + Math.abs(f.w - r.w) + Math.abs(f.h - r.h) <= 8;
      if (!mine && ax.str(el, "AXSubrole") === "AXStandardWindow") return { ok: false, error: "another of the browser's windows covers the point, so nothing was clicked; raise:true brings the tab's window to the front" };
      break;
    }
    return { ok: false, error: "the point is not on the page itself (embedded frame or browser UI); frame controls need accessibility_snapshot {frames:true} and an fN ref" };
  }

  // A frame click's check at its final point: Accessibility's hit there must be
  // the row's element, or inside it, and the first web area up the row's frame.
  // A frame or control drawn over it, or a failed hit test, says no.
  function hitsRow(I, row, pt) {
    const ax = axInit();
    let el = ax.hit(I.pid, pt), mine = false;
    for (let i = 0; el && i < 64; i++, el = ax.attr(el, "AXParent")) {
      if (!mine && ax.same(el, row.el)) mine = true;
      if (ax.str(el, "AXRole") === "AXWebArea") return mine && ax.same(el, row.fr.el);
    }
    return false;
  }

  // Finds the screen point for a trusted press. The target tab is shown first: a
  // background tab's screenX/outerWidth are stale. The page's estimate can't tell
  // which side a panel is on, or the zoom. The Accessibility tree knows both: its
  // page area is exact, and it answers for background windows, where directed
  // mouse moves never reach the page (seen live on Chrome Canary). In the
  // foreground a harmless mouse move at the estimate is posted and the page
  // reports where it landed; the point is corrected (twice at most). The final
  // point must then pass offPage, which needs the page area, so the estimate alone
  // never clicks.
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
    let via = "estimate", area;
    const fromAx = function () {
      let w = null;
      try { w = axPageArea(T.I, probe); } catch (e) {}
      area = w;
      if (!w) return false;
      const p = { x: w.x + probe.cx * w.scale, y: w.y + probe.cy * w.scale };
      trace.push([Math.round(p.x - pt.x), Math.round(p.y - pt.y)]);
      pt = p;
      via = "ax";
      return true;
    };
    if (T.background) { fromAx(); return aimed(); }
    // Only the move this loop posted counts: late events and the user's real mouse
    // also reach the page, so match on the screen point the move was posted at.
    const ours = function (at) {
      for (let tries = 0; tries < 10; tries++) {
        let got = null;
        try { got = parseExec(T.t, a.cal); } catch (e) {}
        const m = got && got.moves.filter(function (v) { return Math.abs(v[2] - at.x) < 2 && Math.abs(v[3] - at.y) < 2; }).pop();
        if (m) return m;
        delay(0.025);
      }
      return null;
    };
    for (let i = 0; i < 3; i++) {
      exec(T.t, a.calReset);
      mouse(T.I, pt, 5, 0, 0.0); // kCGEventMouseMoved
      const m = ours(pt);
      if (!m) break;
      via = "mouse";
      const dx = Math.round(probe.cx - m[0]), dy = Math.round(probe.cy - m[1]);
      trace.push([dx, dy]);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
      pt = { x: pt.x + dx, y: pt.y + dy };
    }
    if (via === "estimate") fromAx();
    return aimed();

    function aimed() {
      const off = offPage(T, probe, pt, area);
      return off ? { out: off } : { pt: pt, el: probe.el, blank: probe.blank, calibrated: true, calibration: trace, aim: via };
    }
  }

  // A trusted click on the element a.probe arms: aim, the hit test, `before(aim)`
  // (a result with ok:false stops it), the post, then a.check's `hit`. {stop} is a
  // refusal with nothing posted. The cursor is home again on return.
  function aimedClick(T, a, tool, before) {
    const home = T.background ? null : cursorAt();
    try {
      const A = aim(T, a, tool);
      if (A.out) return { stop: A.out };
      const bad = before && before(A);
      if (threw(bad)) return { stop: armFault(tool, bad) };
      if (bad && bad.ok === false) return { stop: bad };
      if (T.background) skyClick(T.I, A.pt);
      else leftClick(T.I, A.pt);
      delay(0.05);
      // The click is posted, so a dropped reply says `tool` ran rather than inviting a
      // retry; the check only reads what the recorders saw, so it may be sent twice.
      const check = afterStep(tool, function () { return readExec(T.t, a.check); });
      const out = { ok: check.hit === true, el: A.el, point: A.pt, calibrated: A.calibrated, calibration: A.calibration, aim: A.aim, delivery: T.background ? "skylight" : "hid" };
      return { out: threw(check) ? Object.assign(out, { ok: false, error: checkFault(tool, check) }) : Object.assign(out, check) };
    } finally {
      if (home) $.CGWarpMouseCursorPosition($.CGPointMake(home.x, home.y));
    }
  }

  // The page's screen rect from the Accessibility tree, in the target window.
  // Chrome can show more than one web area (a side panel's is one too); the page's
  // is the one whose shape matches the viewport the probe measured, and its width
  // over innerWidth is the page zoom. Web areas are not descended into. Null when
  // nothing matches, so the caller falls back.
  function axPageArea(I, probe) {
    if (I.pid == null || !probe.iw || !probe.ih) return null;
    const ax = axInit(), attr = ax.attr, list = ax.list;
    // AXValue has no JS bridge; its description reads "{value = x:917.000000 y:57.000000 ...}".
    const pair = function (el, name, a, b) {
      const v = attr(el, name);
      const m = v && new RegExp(a + ":(-?[\\d.]+) " + b + ":(-?[\\d.]+)").exec(String(ObjC.unwrap(v.description)));
      return m ? [Number(m[1]), Number(m[2])] : null;
    };
    const r = I.cgBounds || I.geom;
    // Every AX window within 8pt of the target's frame. When one reports its
    // CGWindowID, the ids decide; otherwise geometry must leave exactly one.
    let near = list(attr($.AXUIElementCreateApplication(I.pid), "AXWindows")).filter(function (w) {
      const p = pair(w, "AXPosition", "x", "y"), s = pair(w, "AXSize", "w", "h");
      return !!p && !!s && Math.abs(p[0] - r.x) + Math.abs(p[1] - r.y) + Math.abs(s[0] - r.w) + Math.abs(s[1] - r.h) <= 8;
    });
    const wids = near.map(ax.wid);
    if (wids.some(function (n) { return n != null; })) near = near.filter(function (w, i) { return wids[i] === I.windowNumber; });
    if (near.length !== 1) return null;
    const win = near[0];
    let best = null, miss = Infinity, seen = 0;
    const queue = [win];
    while (queue.length && seen < 600) {
      const el = queue.shift();
      seen++;
      if (String(ObjC.unwrap(attr(el, "AXRole"))) !== "AXWebArea") { queue.push.apply(queue, list(attr(el, "AXChildren"))); continue; }
      const p = pair(el, "AXPosition", "x", "y"), s = pair(el, "AXSize", "w", "h");
      if (!p || !s || !s[0]) continue;
      const scale = s[0] / probe.iw, d = Math.abs(s[1] - probe.ih * scale);
      if (scale > 0.2 && scale < 5 && d <= 2 && d < miss) { miss = d; best = { x: p[0], y: p[1], scale: scale, el: el }; }
    }
    return best;
  }

  // Accessibility bindings, bound once per REPL. `attr` is null for a missing
  // or unsupported attribute; `str` unwraps a string attribute ("" if absent).
  let axKit = null;
  function axInit() {
    if (axKit) return axKit;
    ObjC.import("ApplicationServices");
    ObjC.bindFunction("AXUIElementCreateApplication", ["id", ["int"]]);
    ObjC.bindFunction("AXUIElementCopyAttributeValue", ["int", ["id", "id", "id *"]]);
    ObjC.bindFunction("AXUIElementPerformAction", ["int", ["id", "id"]]);
    ObjC.bindFunction("AXUIElementSetAttributeValue", ["int", ["id", "id", "id"]]);
    // Private but long-standing: an AX window's CGWindowID. Null when unavailable.
    let widOk = false;
    try { ObjC.bindFunction("_AXUIElementGetWindow", ["int", ["id", "int *"]]); widOk = true; } catch (e) {}
    const wid = function (el) {
      if (!widOk) return null;
      try { const out = Ref(); return $._AXUIElementGetWindow(el, out) === 0 ? Number(out[0]) : null; } catch (e) { return null; }
    };
    const attr = function (el, name) { const out = Ref(); return $.AXUIElementCopyAttributeValue(el, $(name), out) === 0 ? out[0] : null; };
    const list = function (v) { const n = v ? Number(v.count) : 0, out = []; for (let i = 0; i < n; i++) out.push(v.objectAtIndex(i)); return out; };
    const str = function (el, name) { const v = attr(el, name); return v == null ? "" : String(ObjC.unwrap(v)); };
    // AXValue has no JS bridge; its description reads "{value = x:917.000000 y:57.000000 ...}".
    const pair = function (el, name, a, b) {
      const v = attr(el, name);
      const m = v && new RegExp(a + ":(-?[\\d.]+) " + b + ":(-?[\\d.]+)").exec(String(ObjC.unwrap(v.description)));
      return m ? [Number(m[1]), Number(m[2])] : null;
    };
    const frame = function (el) {
      const p = pair(el, "AXPosition", "x", "y"), s = pair(el, "AXSize", "w", "h");
      return p && s ? { x: p[0], y: p[1], w: s[0], h: s[1] } : null;
    };
    // The element at a screen point in the pid's windows; null when the hit test
    // fails or can't be bound.
    let hitOk = false;
    try { ObjC.bindFunction("AXUIElementCopyElementAtPosition", ["int", ["id", "float", "float", "id *"]]); hitOk = true; } catch (e) {}
    const hit = function (pid, pt) {
      if (!hitOk) return null;
      try { const out = Ref(); return $.AXUIElementCopyElementAtPosition($.AXUIElementCreateApplication(pid), pt.x, pt.y, out) === 0 ? out[0] : null; } catch (e) { return null; }
    };
    // Whether two refs name one element: CFEqual, else the same frame within 1pt.
    let eqOk = false;
    try { ObjC.bindFunction("CFEqual", ["bool", ["id", "id"]]); eqOk = true; } catch (e) {}
    const same = function (a, b) {
      if (eqOk) return !!$.CFEqual(a, b);
      const f = frame(a), g = frame(b);
      return !!f && !!g && Math.abs(f.x - g.x) <= 1 && Math.abs(f.y - g.y) <= 1 && Math.abs(f.w - g.w) <= 1 && Math.abs(f.h - g.h) <= 1;
    };
    axKit = { attr: attr, list: list, str: str, frame: frame, wid: wid, hit: hit, same: same };
    return axKit;
  }

  // Controls inside the page's nested web areas: iframes, cross-origin ones too,
  // which page JS can't see into. The walk starts at the page area axPageArea
  // picks and emits only controls inside a nested web area, so page-level ones
  // stay with the page snapshot. It reads role, name (AXTitle, else
  // AXDescription), enabled/expanded, a checkbox or radio's AXValue and the
  // frame's AXURL: never a field's value. Bounded by node count and time.
  const FRAME_ROLES = {
    AXButton: "button", AXLink: "link", AXCheckBox: "checkbox", AXRadioButton: "radio",
    AXTextField: "textbox", AXTextArea: "textbox", AXSecureTextField: "textbox",
    AXPopUpButton: "combobox", AXComboBox: "combobox", AXMenuItem: "menuitem", AXTab: "tab",
  };
  const FRAME_NODES = 3000, FRAME_MS = 150;
  // A boolean attribute as true/false, or null when it isn't one (live, Chrome
  // gave a frame checkbox's AXValue as "" whether checked or not).
  const axTruth = function (v) {
    const u = v == null ? null : ObjC.unwrap(v);
    return typeof u === "boolean" ? u : typeof u === "number" || /^[01]$/.test(u) ? Number(u) === 1 : null;
  };
  function axUrl(el) {
    const v = axInit().attr(el, "AXURL");
    if (v == null) return "";
    try { if (v.absoluteString !== undefined) return String(ObjC.unwrap(v.absoluteString)); } catch (e) {}
    return String(ObjC.unwrap(v));
  }
  const axName = function (ax, el) {
    const s = (ax.str(el, "AXTitle") || ax.str(el, "AXDescription")).replace(/\s+/g, " ").trim();
    return s.length > 100 ? s.slice(0, 100) + "…" : s;
  };

  // The frame walk's preconditions, the background trusted click's own:
  // Accessibility, the tab its window shows, and an on-screen window.
  function frameTarget(t) {
    requireAccessibility();
    if (!isActive(t)) throw new Error(notVisible("frames"));
    return ownWindow(ids(t));
  }

  function frameWalk(I, vp) {
    const area = axPageArea(I, vp);
    if (!area) throw new Error("no page area: Accessibility found no web area matching the page's viewport");
    const ax = axInit();
    const inside = function (p, b) { return !!b && p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h; };
    const bounds = [I.cgBounds || I.geom, ax.frame(area.el)];
    const rows = [], ords = {}, start = Date.now(), queue = [];
    const kids = function (el, fr) { ax.list(ax.attr(el, "AXChildren")).forEach(function (k) { queue.push({ el: k, fr: fr }); }); };
    kids(area.el, null);
    let n = 0, truncated = false;
    while (queue.length) {
      if (++n > FRAME_NODES || Date.now() - start > FRAME_MS) { truncated = true; break; }
      const q = queue.shift(), axRole = ax.str(q.el, "AXRole");
      if (axRole === "AXWebArea") { kids(q.el, { el: q.el, url: axUrl(q.el), box: ax.frame(q.el), up: q.fr }); continue; }
      const role = FRAME_ROLES[axRole];
      if (!role) { kids(q.el, q.fr); continue; }
      if (!q.fr) continue;
      const box = ax.frame(q.el);
      if (!box || !box.w || !box.h) continue;
      const name = axName(ax, q.el), key = q.fr.url + "\n" + role + "\n" + name;
      const flags = [];
      if ((role === "checkbox" || role === "radio") && axTruth(ax.attr(q.el, "AXValue"))) flags.push("checked");
      if (axTruth(ax.attr(q.el, "AXExpanded"))) flags.push("expanded");
      if (axTruth(ax.attr(q.el, "AXEnabled")) === false) flags.push("disabled");
      if (axRole === "AXSecureTextField" || (axRole === "AXTextField" && ax.str(q.el, "AXSubrole") === "AXSecureTextField")) flags.push("secure");
      const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      let shown = bounds.every(function (b) { return inside(c, b); });
      for (let f = q.fr; f && shown; f = f.up) shown = inside(c, f.box);
      if (!shown) flags.push("offscreen");
      ords[key] = (ords[key] || 0) + 1;
      const up = [];
      for (let f = q.fr.up; f; f = f.up) up.push(f.url);
      rows.push({ role: role, name: name, url: q.fr.url, up: up, ord: ords[key], flags: flags, el: q.el, box: box, fr: q.fr });
    }
    return { rows: rows, truncated: truncated, page: bounds[1] };
  }

  // What a frame click can check afterwards, since no page recorder sees inside:
  // the element's role, name, checkbox/radio state and focus, and its frame's URL.
  function frameState(row) {
    const ax = axInit(), axRole = ax.str(row.el, "AXRole");
    if (!axRole) return { gone: true };
    const s = { role: FRAME_ROLES[axRole] || axRole, name: axName(ax, row.el) };
    if (s.role === "checkbox" || s.role === "radio") s.checked = axTruth(ax.attr(row.el, "AXValue"));
    s.focused = axTruth(ax.attr(row.el, "AXFocused")) === true;
    if (axUrl(row.fr.el) !== row.url) s.navigated = true;
    return s;
  }

  // A page's alert/confirm/prompt is its own window (live, Chrome: subrole
  // AXUnknown) holding, a few levels down, a group with subrole AXApplicationDialog.
  // Browser windows are skipped: a page's role=dialog maps to that subrole too.
  // Parts are read by position, never by localized title, and only the recorded
  // shapes count, each with a heading origin line ("x.test says"): one button
  // (alert), two (confirm), or two and one plain text field (prompt), with nothing
  // but groups and static texts around them. Anything else, such as a sign-in
  // sheet's secure field or a passkey prompt's account list, is kind "other". The
  // static texts are the message. Buttons that carry a subrole (close, zoom) are
  // skipped; buttons and fields are not descended into.
  function scanDialogs(only) {
    ObjC.import("ApplicationServices");
    if (!$.AXIsProcessTrusted()) return [];
    const ax = axInit(), P = procs(), out = [];
    const kids = function (el) { return ax.list(ax.attr(el, "AXChildren")); };
    const text = function (el) { return (ax.str(el, "AXTitle") || ax.str(el, "AXDescription") || ax.str(el, "AXValue")).trim(); };
    P.z.filter(function (n) { return !only || n === only; }).forEach(function (name) {
      ax.list(ax.attr($.AXUIElementCreateApplication(P.pid[name]), "AXWindows")).forEach(function (w) {
        if (ax.str(w, "AXSubrole") === "AXStandardWindow") return;
        let root = null, level = [w];
        for (let depth = 0; depth < 4 && !root && level.length; depth++) {
          root = level.filter(function (el) { return ax.str(el, "AXSubrole") === "AXApplicationDialog"; })[0] || null;
          level = [].concat.apply([], level.map(kids));
        }
        if (!root) return;
        const buttons = [], fields = [], texts = [], stack = [root];
        let origin = null, secure = false, stray = false, seen = 0;
        while (stack.length && seen++ < 300) {
          const el = stack.pop(), role = ax.str(el, "AXRole");
          if (role === "AXButton") { if (!ax.str(el, "AXSubrole")) buttons.push(el); continue; }
          if (/TextField|TextArea/.test(role)) {
            fields.push(el);
            if (role !== "AXTextField" || ax.str(el, "AXSubrole") === "AXSecureTextField") secure = true;
            continue;
          }
          if (role === "AXHeading" && origin == null) { origin = text(el) || kids(el).map(text).join(" "); continue; }
          if (role === "AXStaticText") { const v = ax.str(el, "AXValue").trim(); if (v) texts.push(v); }
          else if (role !== "AXGroup") stray = true;
          stack.push.apply(stack, kids(el).reverse());
        }
        const field = fields.length === 1 && !secure ? fields[0] : null, n = buttons.length;
        const kind = stray || stack.length || origin == null || fields.length !== (field ? 1 : 0) || n < 1 || n > 2 || (field && n !== 2) ? "other"
          : field ? "prompt" : n === 2 ? "confirm" : "alert";
        out.push({
          app: name, pid: P.pid[name], kind: kind, origin: origin, root: root, buttons: buttons, field: field, frame: ax.frame(w),
          // A prompt shows its message as the field's title.
          message: (field ? ax.str(field, "AXTitle") : texts.join(" ")).slice(0, 200),
        });
      });
    });
    return out;
  }

  // The target's own dialogs. A JS dialog is a child window of the browser
  // window showing the tab, and a child window sits directly above its parent in
  // the CGWindowList. So the dialog's CG entry (matched to its AX frame) must be
  // followed by the target's window among the browser's own windows, and the
  // target must be the tab that window shows. Apple Events are spent only once
  // the AX scan has found a candidate; anything ambiguous is left out.
  function ownDialogs(target, withOther) {
    const h = target && target.tabId != null ? parseHandle(target.tabId) : null;
    const found = scanDialogs(h ? h.app : target && target.app).filter(function (d) { return withOther || d.kind !== "other"; });
    if (!found.length) return [];
    const t = resolve(target);
    if (!isActive(t)) return [];
    let I;
    try { I = ids(t); } catch (e) { return []; }
    const wins = t.P.byPid[I.pid] || [];
    const near = function (a, b) { return Math.abs(a.x - b.x) <= 4 && Math.abs(a.y - b.y) <= 4 && Math.abs(a.w - b.w) <= 4 && Math.abs(a.h - b.h) <= 4; };
    return found.filter(function (d) {
      if (d.pid !== I.pid || !d.frame || I.windowNumber == null || I.ambiguous) return false;
      const at = [];
      wins.forEach(function (c, i) { if (near(c, d.frame)) at.push(i); });
      d.t = t;
      return at.length === 1 && !!wins[at[0] + 1] && wins[at[0] + 1].wid === I.windowNumber;
    });
  }

  // "host" of scheme://[user@]host[:port], lower-cased without a leading www.;
  // null for about:, data:, file:, blob: and other hostless URLs.
  function hostOf(url) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@\/?#]*@)?(\[[^\]]*\]|[^:\/?#]*)/i.exec(url || "");
    return m && m[1] ? m[1].toLowerCase().replace(/^www\./, "") : null;
  }

  // Why a dialog's origin line does not name its tab's host, or null when it does.
  // This rules out leave-page prompts and other origins' and frames' dialogs.
  function foreignOrigin(d) {
    let url = "";
    try { url = d.t.tab.url(); } catch (e) {}
    const host = hostOf(url);
    if (!host) return "cannot check the dialog's origin on a page without a host";
    const named = new RegExp("(^|[^a-z0-9.-])(www\\.)?" + host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9-]|\\.[a-z0-9])", "i");
    return named.test(d.origin) ? null : "the dialog is from " + d.origin + ", not this tab's origin " + host;
  }

  // A JS dialog pauses its page's JS; the browser's own prompts (permission,
  // downloads, FedCM, passkey), which can share the shape and the host, do not.
  // So a trivial bounded execute proves it: no reply within the bound means
  // paused (true), a reply means running (false). null when there is no bounded
  // execute (Safari, Arc, a tab without an id) or it failed outright: unproven.
  const DIALOG_PROOF_SECS = 1;
  function pagePaused(t) {
    if (t.kind !== "chrome" || t.tabId == null) return null;
    try { execWithin(t, "'ok'", DIALOG_PROOF_SECS); return false; }
    catch (e) { return /^timeout:/.test(e && e.message) ? true : null; }
  }

  // The target's own dialogs with positive proof: the recorded shape, the tab's
  // host in the origin line, and the page paused. Used for dialog_open reports.
  function provenDialogs(target) {
    const found = ownDialogs(target).filter(function (d) { return !foreignOrigin(d); });
    return found.length && pagePaused(found[0].t) === true ? found : [];
  }

  // Answers the target tab's one open dialog like a user would: Enter presses the
  // last button (OK), Escape the first (Cancel, or an alert's only one). Only with
  // positive proof (see provenDialogs). No activate, no raise.
  function answerDialog(a) {
    if (!a.target || !a.target.tabId) throw new Error("answerDialog requires `target.tabId`");
    requireAccessibility();
    const found = ownDialogs(a.target, true);
    if (!found.length) return { ok: false, error: "no open alert/confirm/prompt on the target tab" };
    if (found.length > 1) return { ok: false, error: "several dialogs open on the target tab" };
    const d = found[0], ax = axInit();
    if (d.kind === "other") return { ok: false, error: "the open dialog is not a page alert/confirm/prompt (sign-in, leave-page or permission prompt); perch does not answer it, hand it to the user" };
    const foreign = foreignOrigin(d);
    if (foreign) return { ok: false, error: foreign };
    if (a.text != null && !d.field) return { ok: false, error: "the open dialog is " + (d.kind === "alert" ? "an alert" : "a confirm") + ", not a prompt; answer it without text" };
    const paused = pagePaused(d.t);
    if (paused === false) return { ok: false, error: "the open dialog does not pause the page, so it is not the page's alert/confirm/prompt (a permission, download or sign-in prompt?); perch does not answer it, hand it to the user" };
    if (paused !== true) return { ok: false, error: "perch cannot confirm the dialog pauses the page in this browser; hand it to the user" };
    if (a.text != null) {
      $.AXUIElementSetAttributeValue(d.field, $("AXValue"), $(a.text));
      if (ax.str(d.field, "AXValue") !== a.text) return { ok: false, error: "the prompt's text did not land" };
    }
    const btn = a.key === "Enter" ? d.buttons[d.buttons.length - 1] : d.buttons[0];
    $.AXUIElementPerformAction(btn, $("AXPress"));
    // A closed dialog's element stops answering; one the page opens next, even an
    // identical one, is a new element.
    const start = Date.now();
    while (ax.attr(d.root, "AXRole") != null) {
      if (Date.now() - start >= 1000) return { ok: false, error: "the dialog is still open" };
      delay(0.05);
    }
    const r = { ok: true, dialog: d.kind, message: d.message, answer: a.key === "Enter" ? "accept" : "dismiss" };
    const next = provenDialogs(a.target)[0];
    if (next) r.next = next.kind;
    if (a.text != null) r.text = a.text;
    return r;
  }

  // The browser the user is using: topmost on screen, else the system default
  // browser if it runs, else any running browser.
  function defaultBrowser(P) {
    if (P.z.length) return P.z[0];
    try {
      appKit();
      const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com"));
      const id = ObjC.unwrap($.NSBundle.bundleWithURL(u).bundleIdentifier);
      const b = BROWSERS.filter(function (x) { return x.bundle === id; })[0];
      if (b && app(b.app).running()) return b.app;
    } catch (e) {}
    const any = candidates(P)[0];
    if (any) return any;
    throw new Error("no_browser: no browser is running (new_tab never launches one)");
  }

  // A filter no tab of a browser can match ends that browser's reads early.
  function misses(q, lists) {
    if (!q) return false;
    q = String(q).toLowerCase();
    return !lists.some(function (l) { return (l || []).some(function (v) { return String(v || "").toLowerCase().indexOf(q) >= 0; }); });
  }
  // shapeTabs' filter.
  function matches(a, url, title) {
    const has = function (v, q) { return !q || String(v || "").toLowerCase().indexOf(String(q).toLowerCase()) >= 0; };
    return has(url, a.urlContains) && has(title, a.titleContains);
  }

  // One list_tabs read of every window of a browser in one Apple Event (nested
  // arrays, one per window).
  function bulkRead(W, kind, k) {
    if (k === "url") return W.tabs.url();
    if (k === "title") return kind === "safari" ? W.tabs.name() : W.tabs.title();
    if (k === "id") return W.tabs.id();
    if (k === "wid") return W.id();
    if (k === "loc") return W.tabs.location();
    if (k === "side") return W.activeSpace.tabs.id();
    return kind === "chrome" ? W.activeTabIndex() : kind === "safari" ? W.currentTab.index() : W.activeTab.id();
  }

  // What counting a browser's matches takes: the lists its filters look at (urls
  // when there is none), plus Arc's tab ids, since its windows share tabs.
  function countNeeds(kind, a) {
    const need = [];
    if (a.urlContains || !(a.titleContains || kind === "arc")) need.push("url");
    if (a.titleContains) need.push("title");
    if (kind === "arc") need.push("id");
    return need;
  }

  // How many of a browser's tabs match, from the reads in `r`, for one past
  // list_tabs' limit. null when the lists don't line up; the caller lists it instead.
  function countTabs(kind, a, r, need) {
    const base = r[need[0]], ids = kind === "arc" ? r.id : null, seen = {};
    const off = function (l) { return !Array.isArray(l) || l.length !== base.length || l.some(function (x, w) { return !Array.isArray(x) || !Array.isArray(base[w]) || x.length !== base[w].length; }); };
    if (!Array.isArray(base) || need.some(function (k) { return off(r[k]); })) return null;
    let n = 0;
    base.forEach(function (win, w) {
      win.forEach(function (_, i) {
        if (ids) { if (seen[ids[w][i]]) return; seen[ids[w][i]] = true; }
        if (matches(a, r.url && r.url[w][i], r.title && r.title[w][i])) n++;
      });
    });
    return n;
  }

  // Matching rows a browser is sure to list, from its first read alone: exact
  // for Chromium and Safari; for Arc, its distinct ids or the most matches in any
  // one window (a window's tabs are distinct). 0 while a second filter is unread.
  function surely(kind, a, list, key) {
    if (a.urlContains && a.titleContains) return 0;
    const q = key === "url" ? a.urlContains : key === "title" ? a.titleContains : null, seen = {};
    let n = 0;
    (list || []).forEach(function (win) {
      if (!Array.isArray(win)) return;
      const hit = win.filter(function (v) { return !q || String(v || "").toLowerCase().indexOf(String(q).toLowerCase()) >= 0; });
      if (kind !== "arc") n += hit.length;
      else if (key === "id") hit.forEach(function (id) { if (!seen[id]) { seen[id] = true; n++; } });
      else n = Math.max(n, hit.length);
    });
    return n;
  }

  // Reads each Arc window on its own; a window sharing an earlier one's tabs
  // reuses its reads. Yields after each Apple Event; returns the windows.
  function* arcWindows(ap) {
    const wins = [];
    let n = 0;
    try { n = ap.windows.length; } catch (e) {}
    yield;
    for (let w = 0; w < n; w++) {
      const win = ap.windows[w];
      let ids = null, loc = [], side = [], act = null;
      try { ids = win.tabs.id(); } catch (e) {}
      yield;
      if (!ids) continue;
      try { loc = win.tabs.location(); } catch (e) {}
      yield;
      try { side = win.activeSpace.tabs.id(); } catch (e) {}
      yield;
      try { act = win.activeTab.id(); } catch (e) {}
      yield;
      const same = wins.filter(function (x) { return x.o.ids.join() === ids.join(); })[0];
      let urls = null, titles = [];
      if (same) { urls = same.urls; titles = same.titles; }
      else {
        try { urls = win.tabs.url(); } catch (e) {}
        yield;
        if (!urls) continue;
        try { titles = win.tabs.title(); } catch (e) {}
        yield;
      }
      wins.push({ o: arcSort(ids, loc, side), act: act, urls: urls, titles: titles, w: w });
    }
    return wins;
  }

  // One row per Arc tab, in sidebar order. Windows on one space share their tabs,
  // so a shared tab is listed once, under the frontmost window showing it.
  function arcRows(name, wins, out) {
    const owner = {};
    wins.forEach(function (x) { if (x.act != null && !owner[x.act]) { owner[x.act] = x; hint(name, x.act, x.w); } });
    const done = {};
    wins.forEach(function (x) {
      x.o.order.forEach(function (i) {
        const tabId = x.o.ids[i];
        if (done[tabId]) return;
        done[tabId] = true;
        const row = { app: name, tabId: handle(name, tabId), url: x.urls[i] || "", title: x.titles[i] || "" };
        if (x.o.loc[i] === "pinned") row.pinned = true;
        else if (x.o.loc[i] === "topApp") row.favorite = true;
        if (owner[tabId]) row.active = true;
        out.push(row);
      });
    });
  }

  // Chromium and Safari rows from the bulk reads; false (nothing pushed) when
  // the per-window arrays don't line up.
  function bulkRows(name, kind, r, out) {
    const n = r.url.length;
    const lined = function (x) { return Array.isArray(x) && x.length === n; };
    if (!lined(r.url) || !lined(r.title) || !lined(r.act) || (r.id && !lined(r.id)) || (r.wid && !lined(r.wid))) return false;
    for (let w = 0; w < n; w++) if (!Array.isArray(r.url[w])) return false;
    for (let w = 0; w < n; w++) {
      const u = r.url[w], ti = r.title[w] || [], ids = r.id ? r.id[w] || [] : [];
      const tally = kind === "safari" ? tallyOf(u) : null;
      for (let i = 0; i < u.length; i++) {
        const row = { app: name };
        if (kind === "safari") { row.tabId = safariHandle(r.wid[w], i, u[i]); counted(row.tabId, u, i, tally); }
        else if (ids[i] != null) { row.tabId = handle(name, ids[i]); hint(name, ids[i], w); }
        else { row.windowId = r.wid[w]; row.tabIndex = i; }
        row.url = u[i] || ""; row.title = ti[i] || "";
        if (i === r.act[w] - 1) row.active = true;
        out.push(row);
      }
    }
    return true;
  }

  // Chromium or Safari one window at a time, when a bulk read fails or its
  // per-window arrays don't line up. Yields after each Apple Event.
  function* walkWindows(ap, name, kind, out) {
    let n = 0;
    try { n = ap.windows.length; } catch (e) {}
    yield;
    for (let w = 0; w < n; w++) {
      const win = ap.windows[w];
      let id; try { id = win.id(); } catch (e) { id = w; }
      yield;
      let urls = null, titles = [], tabIds = [];
      try { urls = win.tabs.url(); } catch (e) {}
      yield;
      if (!urls) continue;
      try { titles = kind === "safari" ? win.tabs.name() : win.tabs.title(); } catch (e) {}
      yield;
      if (kind === "chrome") { try { tabIds = win.tabs.id(); } catch (e) {} yield; }
      // `active` marks the tab each window shows (one extra read per window).
      const act = activeIndex(kind, win, win.tabs);
      yield;
      const tally = kind === "safari" ? tallyOf(urls) : null;
      for (let i = 0; i < urls.length; i++) {
        if (kind === "chrome") hint(name, tabIds[i], w);
        const row = { app: name };
        if (kind === "safari") { row.tabId = safariHandle(id, i, urls[i]); counted(row.tabId, urls, i, tally); }
        else if (tabIds[i] != null) row.tabId = handle(name, tabIds[i]);
        else { row.windowId = id; row.tabIndex = i; }
        row.url = urls[i] || ""; row.title = titles[i] || "";
        if (i === act) row.active = true;
        out.push(row);
      }
    }
  }

  // One browser's part of list_tabs, into its slot `s`: rows, or only the count
  // `s.more` once past() says earlier browsers fill the limit. Every window is
  // read at once, four events on Chromium and Safari and six on Arc (window ids
  // only for Safari handles and Chromium tabs without an id). What the filters
  // look at is read first, so a browser none of whose tabs can match stops at
  // one event, and a count reuses what listing already read. `s.sure` is how
  // many matching rows the slot is sure to hold. Yields after each Apple Event.
  function* lister(ap, name, kind, a, s, past) {
    const r = {}, need = countNeeds(kind, a);
    const rest = kind === "arc" ? ["url", "title", "id", "loc", "side", "act"] : kind === "chrome" ? ["url", "title", "id", "wid", "act"] : ["url", "title", "wid", "act"];
    const order = need.concat(rest.filter(function (k) { return need.indexOf(k) < 0; }));
    const idless = function (x) { return !Array.isArray(x) || x.some(function (v) { return v == null; }); };
    let counts = true, bulk = true;
    for (let j = 0; j < order.length && bulk; j++) {
      const k = order[j];
      if (k === "wid" && kind === "chrome" && r.id && !r.id.some(idless)) continue;
      if (j > 0) yield;
      if (counts && past() && need.every(function (x) { return r[x]; })) {
        const n = countTabs(kind, a, r, need);
        if (n != null) { s.more = n; return; }
        counts = false;
      }
      try { r[k] = bulkRead(ap.windows, kind, k); } catch (e) { bulk = false; if (!s.err && e && UNLISTED.indexOf(e.errorNumber) >= 0) s.err = e.message + " (" + e.errorNumber + ")"; }
      if (bulk && ((k === "url" && misses(a.urlContains, r.url)) || (k === "title" && misses(a.titleContains, r.title)))) return;
      if (bulk && j === 0) s.sure = surely(kind, a, r[k], k);
    }
    if (!bulk) yield;
    if (kind === "arc") {
      let wins = null;
      if (bulk) {
        try {
          wins = r.id.map(function (x, w) {
            if (!Array.isArray(r.url[w]) || r.url[w].length !== x.length) throw new Error("misaligned");
            return { o: arcSort(x, r.loc[w] || [], r.side[w] || []), act: r.act[w], urls: r.url[w], titles: r.title[w] || [], w: w };
          });
        } catch (e) { wins = null; }
      }
      arcRows(name, wins || (yield* arcWindows(ap)), s.rows);
    } else if (!bulk || !bulkRows(name, kind, r, s.rows)) {
      yield* walkWindows(ap, name, kind, s.rows);
    }
    s.sure = s.rows.filter(function (row) { return matches(a, row.url, row.title); }).length;
    if (s.rows.length) s.err = null;
  }

  globalThis.__perch = {
    // Run by the daemons' handshake, so no call pays the AppKit import; one-shot
    // runs keep it lazy.
    warm() { try { appKit(); } catch (e) {} },
    takeNote() { const n = note; note = null; return n; },
    dialogs(a) {
      return provenDialogs(a.target).map(function (d) { return { kind: d.kind, message: d.message }; });
    },
    answerDialog: answerDialog,
    // Node filters and cuts the rows at `limit`; `more` counts matches past it.
    listTabs(a) {
      const P = procs(), names = candidates(P, a.app);
      const slots = names.map(function () { return { rows: [], more: 0, sure: 0 }; });
      // Earlier browsers are sure to fill `limit`, so none of slot k's rows would show.
      const past = function (k) {
        if (a.limit == null) return false;
        let n = 0;
        for (let j = 0; j < k; j++) n += slots[j].sure;
        return n >= a.limit;
      };
      // Browsers take turns, one Apple Event each: each answers at its own next
      // display frame, so the turns overlap instead of queueing.
      let live = names.map(function (name, k) {
        return lister(app(name), name, KIND[name], a, slots[k], function () { return past(k); });
      });
      while (live.length) live = live.filter(function (g) { return !g.next().done; });
      const res = {
        rows: slots.reduce(function (out, s) { return out.concat(s.rows); }, []),
        more: slots.reduce(function (n, s) { return n + s.more; }, 0),
      };
      const failed = names.map(function (name, k) { return slots[k].err ? { app: name, error: slots[k].err } : null; }).filter(Boolean);
      if (failed.length) res.failed = failed;
      return res;
    },
    evalJs(a) {
      const q = quickExec(a.target, a.js);
      if (q) return q.v;
      const t = resolve(a.target);
      visibleGuard(t, a.tool || "eval_js");
      return exec(t, a.js);
    },
    evalAsync(a) {
      const t = pageTarget(a.target, "eval_js"), start = Date.now();
      // The kick is never sent twice. It sets its result slot before the user's
      // code runs, so after a dropped reply the polls tell a kick still running
      // (slot set) from one whose document is gone (slot missing).
      let ran = true;
      try { pollExec(t, a.kick, Math.max(0.1, Math.min(POLL_EXEC_SECS, a.timeout / 1000))); }
      catch (e) { if (!isNoReply(e)) throw e; ran = false; }
      const r = poll(t, a.poll, a.timeout, 50, false, null, start);
      if (!r) throw ranOut("timeout: eval_js (awaitPromise) timed out after " + a.timeout + "ms; the code " + (ran ? "ran" : "may have run") + " and may still be running, so check the page before running it again; background tabs throttle timers, so avoid page sleeps or activate the tab");
      if (r.value.__perch_gone) throw new Error("timeout: eval_js (awaitPromise) lost its result before the promise settled" + MAY_HAVE_RUN);
      return r.value;
    },
    // One event when the page is already there; then polls every 50ms.
    wait(a) {
      const start = Date.now(), interval = a.interval || 50;
      if (a.quiet) return waitQuiet(a, start, interval);
      let q = null, r = null;
      // A hinted Chromium handle's first poll is quickExec's one event, bounded.
      const w = a.target || {};
      const hinted = w.tabId != null && w.windowId == null && w.tabIndex == null && hints[w.tabId];
      if (!hinted) { try { q = quickExec(a.target, a.js); } catch (e) {} }
      const v = q && pollValue(q.v);
      if (v != null && v !== false) r = { value: v, waited: 0 };
      else {
        const t = pageTarget(a.target, "wait");
        if (q) delay(interval / 1000);
        r = poll(t, a.js, a.timeout, interval, false, null, start);
        if (r) r.waited = Date.now() - start;
      }
      if (!r) throw ranOut("timeout: wait timed out after " + a.timeout + "ms");
      if (r.value && r.value.bad && a.selector) throw new Error("wait: bad selector: " + a.selector);
      if (r.value && r.value.__perch_error) throw new Error("wait: the page script failed on this page (" + faultName(r.value) + "); nothing verified");
      return r;
    },
    // One round trip: stamp the current document, start the load, then wait until a
    // document without the stamp reports readyState 'complete'. Checking readyState
    // alone can read the OLD document's 'complete' right after the load starts.
    navigate(a) {
      loadable("navigate", a.url);
      const t = resolve(a.target);
      const deadline = Date.now() + a.timeout;
      // Each page-JS call gets at most NAV_EXEC_SECS, and never more than the time
      // left, so one unanswered execute can't carry navigate past its timeout.
      const secsLeft = function (cap) { return Math.max(0.1, Math.min(cap, (deadline - Date.now()) / 1000)); };
      const run = function (js) { return execWithin(t, js, secsLeft(NAV_EXEC_SECS)); };
      let canEval = t.kind !== "arc" || isActive(t);
      // Reads of the tab. A closed Chromium tab is stale_tab; Arc's are left as they
      // fail, since a new Arc tab's url() fails for a while. `read` makes any other
      // failure unknown (null).
      const tabRead = function (f) { return t.kind === "chrome" ? onTab(t, f) : f(); };
      const read = function (f) { try { return tabRead(f); } catch (e) { if (isStale(e)) throw e; return null; } };
      const token = "n" + Date.now() + Math.random().toString(36).slice(2, 6);
      // The page resolves the url against its own location, so a #fragment change is
      // recognized as same-document even when the two spellings differ.
      // Chrome raises its window when AppleScript sets a tab's url, so the page starts
      // the load itself (the reply ends in '!') when it can; a page can't open data:,
      // javascript: or browser URLs that way, and a file: URL only from a file: page.
      let r = null, wasLoading = false, preUrl = null;
      if (canEval && t.kind !== "safari") {
        wasLoading = !!read(function () { return t.tab.loading(); });
        preUrl = read(function () { return String(t.tab.url()); });
      }
      const fromPage = /^(https?:\/\/|about:blank$)/i.test(a.url) || (/^file:/i.test(a.url) && preUrl != null && /^file:/i.test(preUrl));
      // Arc's execute hangs on its own arc: pages, so no page JS runs on one: none
      // before the tab has left it (an unreadable url counts), none when going to one.
      const arcPage = t.kind === "arc" && canEval && (preUrl == null || /^arc:/i.test(preUrl) || /^arc:/i.test(a.url));
      // Chromium runs no page JS on its own pages either (new tab, settings).
      const ownPage = t.kind === "chrome" && canEval && preUrl != null && BROWSER_PAGE.test(preUrl);
      if (arcPage || ownPage) canEval = false;
      // Setting the url raises a Chromium window (Safari's did not, live), so without
      // raise:true it is set only when that window is already the front one.
      // `now`: re-read the front window, since the page's retries can outlast the
      // window order resolve saw.
      const mayRaise = function (now) {
        if (a.raise || t.kind === "safari") return true;
        const P = procs();
        if (P.front !== t.app || P.dupe[t.app] || t.w !== 0) return false;
        if (!now) return true;
        try { return String(app(t.app).windows[0].tabs.byId(t.tabId).id()) === String(t.tabId); } catch (e) {
          // Not in the front window: moved behind another, or closed (stale_tab).
          if (noSuchObject(e) && t.tabId != null) { try { resolve({ tabId: handle(t.app, t.tabId) }); } catch (x) { if (isStale(x)) throw x; } }
          return false;
        }
      };
      const refuse = function (code, why) {
        return new Error(code + ": " + why + "; loading it from outside the page would bring the browser to the front: pass raise:true to allow that, or activate_tab first");
      };
      if (ownPage && !mayRaise()) throw refuse("tab_not_scriptable", "navigate can't run page JS on the browser's own pages (new tab, settings)");
      if (!canEval && !mayRaise()) throw refuse("tab_not_visible", arcPage ? "navigate can't run page JS on the browser's own pages or load them from a page" : "navigate can't run page JS in a tab its window doesn't show");
      if (canEval && !fromPage && !mayRaise()) throw refuse("tab_not_visible", "a page can only load an absolute http(s) URL, about:blank, or (from a file:// page) another file:// URL itself");
      const q = JSON.stringify(a.url), tok = JSON.stringify(token);
      // On a retry, a document without the stamp is the one the lost call's load
      // committed when it shows the URL asked for (unless the tab already showed it),
      // or, when the tab wasn't loading before, any other URL: a redirect.
      const arrived = function () {
        const pre = JSON.stringify(preUrl);
        return "var h=null;try{h=new URL(" + q + ",location.href).href}catch(e){}" +
          "if(location.href===h&&h!==" + pre + (wasLoading || preUrl == null ? "" : "||location.href!==" + pre) + ")return 'stamped!';";
      };
      // The stamp call keeps its answer on the page, so a retry that reaches the same
      // document repeats that answer instead of starting a second load.
      const stamp = function (retry) {
        return "(function(){var o=window.__perch_navr;if(o&&o[0]===" + tok + ")return o[1];" + (retry ? arrived() : "") +
          "var r=(function(){var s='stamped';try{var u=new URL(" + q + ",location.href);" +
          "if(u.hash&&u.href.split('#')[0]===location.href.split('#')[0])s='same'}catch(e){}" +
          "if(s==='stamped')window.__perch_nav=" + tok + ";" +
          // A Navigation API listener added after the page's own sees whether the
          // page cancelled the load.
          (fromPage ? "var c=false,n=window.navigation,f=function(e){c=e.defaultPrevented};try{n.addEventListener('navigate',f)}catch(e){}" +
            "try{location.assign(" + q + ")}catch(e){return s}finally{try{n.removeEventListener('navigate',f)}catch(e){}}return c?s:s+'!'" : "return s") +
          "})();window.__perch_navr=[" + tok + ",r];return r})()";
      };
      let lastErr = null;
      const tryRun = function (js, secs) {
        try { return String(execWithin(t, js, secsLeft(secs || NAV_EXEC_SECS))); }
        catch (e) { if (isStale(e)) throw e; lastErr = e; return null; }
      };
      if (canEval) r = tryRun(stamp(false));
      // A reply lost as the new document replaced the old one still started the load:
      // the tab is loading, or a document without the stamp answers from another URL.
      // A tab already loading before the stamp shows both for its earlier load.
      let viaPage = /!$/.test(r || "");
      if (canEval && fromPage && r == null && t.kind !== "safari" && !wasLoading) {
        try { viaPage = tabRead(function () { return t.tab.loading(); }) || (preUrl != null && String(tabRead(function () { return t.tab.url(); })) !== preUrl && String(run("String(window.__perch_nav===" + tok + ")")) === "false"); } catch (e) { if (isStale(e)) throw e; }
      }
      // Still unproven: the page was busy, slow, or its reply was lost. Ask again with
      // more time before anything loads the url from outside the page.
      if (canEval && fromPage && r == null && !viaPage && t.kind !== "safari") {
        for (let secs = POLL_EXEC_SECS; r == null && secs <= 2 * POLL_EXEC_SECS && Date.now() < deadline; secs *= 2) r = tryRun(stamp(true), secs);
        viaPage = /!$/.test(r || "");
      }
      // A bounded execute that failed fast says nothing about the page, so the stamp
      // goes once more, bounded; a page that already took it repeats its answer. Only
      // a failure that repeats (the handler didn't compile, JS from Apple Events off)
      // takes the plain path, whose error says which. It has no Apple Event timeout,
      // so a page hung there is ended by the runtime's own, coded timeout.
      if (canEval && r == null && !viaPage && pinned(t) && lastErr && !isNoReply(lastErr)) {
        r = tryRun(stamp(true), POLL_EXEC_SECS);
        if (r == null && !isNoReply(lastErr)) {
          try { r = String(exec(t, stamp(true))); } catch (e) {
            if (isStale(e)) throw e;
            lastErr = e && e.errorNumber === -1712 ? new Error(NO_REPLY + "the Apple Event timeout") : e;
          }
        }
        viaPage = /!$/.test(r || "");
      }
      // `href`: the document the check found; `stayed`: the tab's url when loading
      // settled with it still on the one it had before.
      const result = function (waited, href, stayed) {
        const o = { waited: waited, tabId: handleOf(t, true) };
        if (href != null) o.href = href;
        if (stayed != null) o.stayed = stayed;
        if (!viaPage && t.kind !== "safari") o.warning = "navigating from outside the page may bring the browser to the front";
        return o;
      };
      if (!viaPage && !mayRaise(true)) {
        // Only a page-started load can have begun; anything else went nowhere.
        if (!canEval || !fromPage) throw refuse("tab_not_visible", "the tab's window is no longer in front");
        if (r != null) throw refuse("tab_not_visible", "the page refused or cancelled the load");
        // A fast failure the page itself doesn't answer through either (JS from Apple
        // Events off) is reported as the plain path's error; a page that answers, or
        // is only slow, is a timeout.
        if (lastErr && !isNoReply(lastErr)) {
          let answers = true;
          try { execWithin(t, "1", secsLeft(NAV_EXEC_SECS)); } catch (e) { if (isStale(e)) throw e; answers = isNoReply(e); }
          if (!answers) throw lastErr;
        }
        throw refuse("timeout", HANG.noAnswer + ", so the load may or may not have started; check the tab's url before retrying");
      }
      // A raised background Arc tab runs no page JS (execute hangs there), so its load
      // is followed through its url and loading properties alone.
      const arcBehind = t.kind === "arc" && !canEval && !arcPage;
      if (arcBehind) preUrl = read(function () { return String(t.tab.url()); });
      if (!viaPage) onTab(t, function () { t.tab.url = a.url; });
      if (/^same/.test(r || "")) return result(true);
      // Until the url commits the tab still reads arc:. Arc can drop a url set while
      // its new-tab page is loading, so it is set once more after a second.
      const leftArcPage = function () {
        if (/^arc:/i.test(a.url)) return false;
        for (let i = 0; Date.now() < deadline; i++) {
          const u = read(function () { return t.tab.url(); });
          if (u != null && !/^arc:/i.test(u)) return true;
          if (i === 20) { try { t.tab.url = a.url; } catch (e) {} }
          delay(0.05);
        }
        return false;
      };
      const failed = function () { return Object.assign(result(true), { loadFailed: true }); };
      // The tab shows another url while the old document still answers, so the load
      // never committed. `after`: the time spent, when that is before the deadline.
      const notCommitted = function (u) { return Object.assign(result(false), { notCommitted: String(u) }, Date.now() < deadline ? { after: Date.now() - deadline + a.timeout } : {}); };
      // Loading read settled twice in a row, 300ms or more after t0.
      const idler = function (t0) { let n = 0; return function (busy) { if (Date.now() - t0 > 300 && busy != null) n = busy ? 0 : n + 1; return n >= 2; }; };
      const checkable = arcPage ? leftArcPage() : ownPage;
      if (arcPage && !checkable && !/^arc:/i.test(a.url)) {
        const u = read(function () { return String(t.tab.url()); });
        return u != null && !/^arc:/i.test(u) ? result(false, u) : result(false, null, u || "arc://newtab");
      }
      if (arcBehind && preUrl != null && !/^arc:/i.test(a.url)) {
        const t0 = Date.now();
        const url = function () { return read(function () { return String(t.tab.url()); }); };
        // Arc can read loading false for a while after the set before its load
        // starts, and shows the new url before it commits, so settled idle counts
        // (as committed on a moved url, as stayed on an unmoved one) only once
        // loading was seen, or after ARC_START_GRACE.
        const settled = idler(t0);
        let lastBusy = null, sawBusy = false;
        while (Date.now() < deadline) {
          const busy = read(function () { return t.tab.loading(); });
          if (busy != null) { lastBusy = busy; if (busy) sawBusy = true; }
          if (settled(busy) && (sawBusy || Date.now() - t0 > ARC_START_GRACE)) {
            const u = url();
            if (u != null) return u !== preUrl ? result(true, u) : result(false, null, preUrl);
          }
          delay(0.05);
        }
        // Chromium shows a pending url while the old document still answers, so a
        // moved url counts as committed only when loading last read settled.
        const u = url();
        if (u == null) return result(false);
        return u !== preUrl && lastBusy === false ? result(false, u) : notCommitted(u);
      }
      if (!canEval && !checkable) return result(false);
      // A failed load commits the browser's error page: chrome-error://chromewebdata/,
      // or a safari-resource: document.
      const check = "(function(){try{return JSON.stringify({done:window.__perch_nav!==" + JSON.stringify(token) + "&&document.readyState==='complete',href:location.href,old:window.__perch_nav===" + JSON.stringify(token) +
        ",err:location.protocol==='chrome-error:'||/^safari-resource:/i.test(location.href)})}catch(e){return 'null'}})()";
      const start = Date.now();
      // Page JS sent before the new document commits may never be answered, and
      // Chromium's `loading` is already true when setting url returns, so hold off
      // while it is. Only for NAV_GATE_MS: subframe navigations can keep it true
      // after the document is complete, and a slow server's commit is covered by
      // the bounded execute.
      if (t.kind !== "safari") {
        for (;;) {
          const busy = read(function () { return t.tab.loading(); });
          if (!busy || Date.now() - start >= NAV_GATE_MS || Date.now() >= deadline) break;
          delay(0.02);
        }
      }
      let lastC = null;
      const asked = function (x) { return x === a.url || x.replace(/\/$/, "") === a.url.replace(/\/$/, ""); };
      // No check proved the new document complete; the tab reads url `u`, loading
      // `busy`. Chromium shows a page-started load's pending url while the old
      // document answers, so a moved url is committed only once a check answered
      // from a new document, or the page, asked once more, no longer answers as the
      // stamped one (waited only if complete). Safari has no loading read.
      const decide = function (u, busy) {
        if (u == null) return result(false);
        const old = !!(lastC && lastC.old);
        if (u === preUrl || (old && u === lastC.href)) return busy === true ? notCommitted(u) : result(false, null, u);
        if (lastC && !old) return lastC.err ? failed() : result(true, u);
        if (busy !== false && !(busy === true && viaPage && asked(u))) return notCommitted(u);
        let c = null;
        try { c = JSON.parse(String(execWithin(t, check, NAV_EXEC_SECS))); } catch (e) { if (isStale(e)) throw e; }
        if (c && c.old) return notCommitted(u);
        if (c && c.err) return failed();
        return result(!!(c && c.done), c ? String(c.href) : u);
      };
      const settled = idler(start);
      while (Date.now() < deadline) {
        let c = null;
        try { c = JSON.parse(String(run(check))); } catch (e) { if (isStale(e)) throw e; }
        if (c) lastC = c;
        if (c && c.done) return c.err ? failed() : result(true, String(c.href));
        // A download or 204 never replaces the document; Chrome's `loading` settles.
        // So does a load the page dropped, so it counts only if the tab's URL moved.
        if (t.kind !== "safari" && Date.now() - start > 300 && settled(read(function () { return t.tab.loading(); }))) {
          return decide(read(function () { return String(t.tab.url()); }), false);
        }
        delay(0.05);
      }
      // At the deadline, only when the last check that answered still found the
      // stamped document: a url and a loading read, made only here.
      if (lastC && lastC.old) {
        return decide(read(function () { return String(t.tab.url()); }), t.kind === "safari" ? null : read(function () { return t.tab.loading(); }));
      }
      return result(false);
    },
    // Browsers may show the tab they just made; new_tab puts back the tab the window
    // showed. It can't undo a raise without activating an app, so it reports one.
    newTab(a) {
      loadable("new_tab", a.url);
      const P = procs();
      const name = a.app || defaultBrowser(P);
      const kind = KIND[name];
      const ap = app(name);
      if (!ap.running()) throw new Error("no_browser: " + name + " must already be running (new_tab never launches it)");
      if (!ap.windows.length) throw new Error("no_browser: " + name + " needs an existing window (new_tab never makes one)");
      let win, newId = null;
      if (kind === "chrome" || kind === "arc") {
        win = ap.windows[0];
        let prev = null;
        try { prev = kind === "chrome" ? win.activeTabIndex() : win.activeTab.id(); } catch (e) {}
        let beforeIds = null;
        try { beforeIds = win.tabs.id(); } catch (e) {}
        // Arc's `make new tab` rejects about: and data: URLs but accepts them set
        // afterwards, so such tabs start on its own new-tab page.
        const later = kind === "arc" && /^(about|data):/i.test(a.url);
        const tab = ap.Tab({ url: later ? "arc://newtab" : a.url });
        win.tabs.push(tab);
        // Push appends, so the index still names the tab shown before.
        if (kind === "chrome" && prev != null) {
          try { if (win.activeTabIndex() !== prev) win.activeTabIndex = prev; } catch (e) {}
        }
        try { newId = tab.id(); } catch (e) {}
        if (newId == null && beforeIds) {
          try { newId = win.tabs.id().find(function (id) { return beforeIds.indexOf(id) < 0; }); } catch (e) {}
        }
        // Arc can accept `make new tab` and silently make nothing.
        if (newId == null) throw new Error("no_browser: " + name + " made no tab perch could find for " + a.url + "; retry, or use another browser");
        if (later) {
          const nt = win.tabs.byId(newId);
          nt.url = a.url;
          // Until the URL commits the tab still shows arc://newtab, where page JS hangs.
          // Arc sometimes drops a URL set while its new-tab page is still loading, so
          // the URL is set again once after a second.
          for (let i = 0; i < 100; i++) {
            // A read that throws means the tab isn't ready yet, not that it committed.
            let u = null; try { u = nt.url(); } catch (e) {}
            if (u != null && !/^arc:/i.test(u)) break;
            if (i === 20) { try { nt.url = a.url; } catch (e) {} }
            delay(0.05);
          }
        }
        if (kind === "arc" && prev != null) {
          try { if (win.activeTab.id() !== prev) win.tabs.byId(prev).select(); } catch (e) {}
        }
      } else {
        // Safari: documents[0].tabs throws under JXA; windows[0].tabs works.
        win = ap.windows[0];
        let created = false, prev = null;
        try { prev = win.currentTab.index(); } catch (e) {}
        try { win.tabs.push(ap.Tab({ url: a.url })); created = true; } catch (e) {}
        if (!created) throw new Error("no_browser: " + name + " could not create a background tab");
        if (prev != null) {
          try { if (win.currentTab.index() !== prev) win.currentTab = win.tabs[prev - 1]; } catch (e) {}
        }
      }
      let tabId = null;
      try {
        if (kind === "safari") {
          const urls = win.tabs.url(), i = urls.length - 1;
          // A tab still loading reads blank: its handle hashes the URL it is loading.
          urls[i] = urls[i] || a.url;
          tabId = safariHandle(win.id(), i, urls[i]);
          counted(tabId, urls, i);
        } else if (newId != null) {
          tabId = handle(name, newId);
          // Arc's new tab is put behind the one shown, so it has no window to hint.
          if (kind === "chrome") hint(name, newId, 0);
        }
      } catch (e) {}
      const out = { app: name, tabId };
      if (P.front !== name && procs().front === name) out.warning = "creating the tab brought the browser to the front";
      return out;
    },
    activate(a) {
      focus(resolve(a.target));
      return true;
    },
    // Only by explicit handle: a missing target would resolve to the user's active tab.
    // Closing a window's last tab closes the window; Arc counts the space's tabs.
    closeTab(a) {
      if (!a.target || !a.target.tabId) throw new Error("close_tab requires `tabId`");
      const t = resolve(a.target, true);
      let n = 2;
      try { n = t.kind === "arc" ? t.win.activeSpace.tabs.id().length : t.win.tabs.length; } catch (e) {}
      if (n <= 1) return { ok: false, error: "last tab in its window; closing it would close the window" };
      t.tab.close();
      if (t.tabId != null) delete hints[handle(t.app, t.tabId)];
      return { ok: true, closed: a.target.tabId };
    },
    shotGeom(a) { return shotGeom(a); },
    // The geometry plus, when the runtime could capture, `data` (base64) and
    // `image` {w,h}; without them the caller runs screencapture.
    shot(a) {
      if (a.clip) return shotClip(a);
      const I = shotGeom(a), c = capture(I.windowNumber, a.format, a.maxWidth);
      if (c) { I.data = c.data; I.image = c.image; }
      return I;
    },
    select(a) {
      const t = pageTarget(a.target, a.tool || "select");
      // No start: the caller's own page call already opened the control.
      const r = a.start ? stepRead(t, a.start) : { pending: true };
      if (!r || !r.pending) return r;
      return afterStep(a.tool || "select", function () {
        // a.trusted: a control whose synthetic open shows no list of its own gets a
        // trusted click (the tab its window shows only; never raised). A refused or
        // missed click fails closed.
        const X = a.trusted, used = [];
        const done = function (o) { if (used.length && o) o.trusted = used; return o; };
        let T = null;
        const selectClick = function (part) {
          if (!T) T = trustedTarget({ target: a.target }, "select {trusted:true}");
          const c = aimedClick(T, { probe: part, check: X.check }, "select");
          if (c.stop) return c.stop.gone ? null : c.stop;
          if (!c.out.ok) return { ok: false, hit: c.out.hit, el: c.out.el, error: "the trusted click on " + c.out.el + " did not land on it (hit: " + c.out.hit + "); nothing was picked" };
          used.push(part === X.option ? "option" : "control");
          return null;
        };
        // A tab its window doesn't show can't take a trusted click; its control's own
        // text box can take the editing command's trusted input instead (select_type).
        // So does a shown one whose menu a trusted click leaves shut (it opens on typing).
        let typed = false;
        if (X && !poll(t, X.open, 400, 50)) {
          const shown = isActive(t);
          if (shown) {
            const c = selectClick(X.control);
            if (c) return c;
          }
          if (!shown || !poll(t, X.open, 400, 50)) {
            const r = stepRead(t, X.type);
            if (r && r.none && !shown) throw new Error(notVisible("select {trusted:true}"));
            if (r && r.ok) { used.push("typed"); typed = true; }
            else if (!r || !r.none) return done(r);
          }
        }
        // a.short: give up early unless a.probe says a list or companion is there.
        // A pick step answering {settled} has found nothing more worth waiting for.
        let picked = poll(t, a.pick, a.short || a.wait || 2500, 50, true);
        if (!picked && a.short && readExec(t, a.probe) === true) picked = poll(t, a.pick, a.wait - a.short, 50, true);
        if (picked && picked.value.settled) picked = null;
        if (!picked && !a.missFinal) return done(readExec(t, a.miss));
        if (!picked) { const m = poll(t, a.miss, a.settle, 50); return m ? m.value : readExec(t, a.missFinal); }
        // A thrown pick never reaches the option click or the read: Node codes it.
        if (picked.value.ok === false || picked.value.__perch_error != null) return done(picked.value);
        const pressed = picked.value.picked;
        // A pick that doesn't show while the popup stays open gets a trusted click on the option.
        if (X && !typed && !poll(t, X.keep, 500, 50)) {
          const c = selectClick(X.option);
          if (c) return done(c);
        }
        const read = poll(t, a.read, 500, 50);
        const out = read ? read.value : readExec(t, a.readFinal);
        if (out && out.ok === false && typeof pressed === "string" && /^the page changed/.test(out.error)) out.pressed = pressed;
        return done(out);
      });
    },
    // Plain click: evalJs's one page call, which clicks unless the element opens
    // a new tab; that one goes through clickBlank.
    clickPage(a) {
      const at = {};
      let t = null, v;
      const q = quickExec(a.target, a.click, at);
      if (q) v = q.v;
      else { t = resolve(a.target); visibleGuard(t, "click"); v = exec(t, a.click); }
      let r = null;
      try { r = JSON.parse(String(v)); } catch (e) {}
      if (!r || !r.blank) return v;
      const W = t ? winOf(t) : at;
      return JSON.stringify(clickBlank(W, r.blank.href, function () { return JSON.parse(String(t ? exec(t, a.go) : at.run(a.go))); }));
    },
    // Plain click with readback: click (arming the pre-click text), then poll.
    click(a) {
      const t = pageTarget(a.target, "click");
      let r = stepRead(t, a.click);
      if (r && r.blank) r = clickBlank(winOf(t), r.blank.href, function () { return stepRead(t, a.go); });
      if (!r || r.ok !== true) return r;
      return Object.assign(r, readback(t, a));
    },
    trustedClick(a) {
      const T = trustedTarget(a);
      let W = null, before = null, href = null;
      const arm = function (A) {
        if (A && A.blank) { W = winOf(T.t); before = tabSet(W); href = A.blank.href; }
        return a.arm ? parseExec(T.t, a.arm) : null;
      };
      let out;
      if (a.x != null) {
        const home = T.background ? null : cursorAt();
        try {
          const f = parseExec(T.t, a.frames);
          const framed = pointOnFrame(T, a, f) || offPage(T, f, { x: a.x, y: a.y });
          if (framed) return framed;
          const bad = arm();
          if (threw(bad)) return armFault("click", bad);
          if (bad && bad.ok === false) return bad;
          if (T.background) skyClick(T.I, { x: a.x, y: a.y });
          else leftClick(T.I, { x: a.x, y: a.y });
          delay(0.05);
          const check = afterStep("click", function () { return readExec(T.t, a.check); });
          out = { ok: true, point: { x: a.x, y: a.y }, delivery: T.background ? "skylight" : "hid" };
          if (threw(check)) return Object.assign(out, { ok: false, error: checkFault("click", check) });
          if (check.hit === undefined) out.note = "the page changed after the click (it may have navigated), so whether it landed is unknown";
          else if (check.hit !== true) return Object.assign(out, { ok: false, hit: false, error: "no click reached the page at " + a.x + "," + a.y });
          else Object.assign(out, { hit: true }, check.el ? { el: check.el } : {});
        } finally {
          if (home) $.CGWarpMouseCursorPosition($.CGPointMake(home.x, home.y));
        }
      } else {
        const c = aimedClick(T, a, "click", arm);
        if (c.stop) return c.stop;
        out = c.out;
        if (before && out.ok) noteOpened(out, W, before, href);
        delete out.cancelled;
      }
      // The cursor is already home, so the settle wait doesn't hold it.
      return a.arm ? Object.assign(out, readback(T.t, a)) : out;
    },
    // The page snapshot and, in the same call, the frame walk. A walk that can't
    // run leaves the page rows and says why.
    snapshotFrames(a) {
      const t = resolve(a.target);
      visibleGuard(t, "accessibility_snapshot");
      const page = exec(t, a.js);
      const out = { page: page, tabId: handleOf(t) };
      let vp;
      try { const s = JSON.parse(String(page)), nl = s.indexOf("\n"); vp = JSON.parse(s.slice(2, nl < 0 ? s.length : nl)); } catch (e) { return out; }
      try {
        const W = frameWalk(frameTarget(t), vp);
        // The page rows already hold a walked same-origin frame's controls: drop the
        // rows whose own frame sits where one of those frames is (vp.fr, CSS px). A
        // frame nested inside one was never read by page JS, so its rows stay.
        const P = W.page, z = P ? P.w / (vp.iw || P.w) : 1;
        const walked = (P ? vp.fr || [] : []).map(function (r) { return { x: P.x + r[0] * z, y: P.y + r[1] * z, w: r[2] * z, h: r[3] * z }; });
        const near = function (a, b) { return !!a && Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2; };
        const rows = W.rows.filter(function (r) { return !walked.some(function (b) { return near(r.fr.box, b); }); });
        out.frames = rows.map(function (r) { return { role: r.role, name: r.name, url: r.url, up: r.up, ord: r.ord, flags: r.flags }; });
        if (W.truncated) out.truncated = true;
      } catch (e) {
        const m = String((e && e.message) || e), num = e && typeof e.errorNumber === "number" ? " (" + e.errorNumber + ")" : "";
        out.error = num && m.slice(-num.length) !== num ? m + num : m;
      }
      return out;
    },
    // Never trusts stored coordinates: walks the frames again, finds the row by
    // (frame URL, role, name, ordinal) and clicks its fresh center.
    frameClick(a) {
      const t = resolve(a.target);
      const tabId = handleOf(t), want = a.rows[tabId];
      const miss = { __perch_ref_miss: true, ref: a.ref };
      if (!want) return miss;
      const w = want.row, refuse = { ok: false, tabId: tabId, error: w.role + " " + JSON.stringify(w.name) + " is sign-in, challenge or password UI; hand it to the user" };
      // Before trustedTarget: raise:true takes the foreground there, and a refused click must not have taken it.
      if (w.handoff) return refuse;
      const T = trustedTarget(a, undefined, t);
      visibleGuard(T.t, "click");
      const vp = parseExec(T.t, a.probe);
      if (!vp || String(vp.url).split("#")[0] !== String(want.url).split("#")[0]) return miss;
      const row = frameWalk(T.I, vp).rows.filter(function (r) { return r.url === w.url && r.up.join("\n") === (w.up || []).join("\n") && r.role === w.role && r.name === w.name && r.ord === w.ord; })[0];
      if (!row) return miss;
      if (row.flags.indexOf("secure") >= 0) return refuse;
      if (row.flags.indexOf("offscreen") >= 0) return { ok: false, tabId: tabId, error: w.role + " " + JSON.stringify(w.name) + " is outside the visible page; scroll it into view and snapshot again" };
      const pt = { x: row.box.x + row.box.w / 2, y: row.box.y + row.box.h / 2 };
      if (!hitsRow(T.I, row, pt)) return { ok: false, tabId: tabId, error: w.role + " " + JSON.stringify(w.name) + " is covered at its center by something else (another frame or an overlay); nothing was clicked" };
      const before = frameState(row);
      const home = T.background ? null : cursorAt();
      try {
        if (T.background) skyClick(T.I, pt);
        else leftClick(T.I, pt);
      } finally {
        if (home) $.CGWarpMouseCursorPosition($.CGPointMake(home.x, home.y));
      }
      // Accessibility can trail the page (live: focus moved at once, a checkbox's
      // AXValue later), so read until something besides focus changes, up to
      // half a second.
      const same = function (s) { return JSON.stringify(Object.assign({}, s, { focused: 0 })) === JSON.stringify(Object.assign({}, before, { focused: 0 })); };
      let after, waited = 0;
      do { delay(0.05); waited += 50; after = frameState(row); } while (waited < 500 && same(after));
      return { ok: true, tabId: tabId, point: pt, aim: "ax", delivery: T.background ? "skylight" : "hid", before: before, after: after, hit: null };
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
        return Object.assign({ el: A.el, calibrated: A.calibrated, calibration: A.calibration, aim: A.aim, delivery: "hid" }, parseExec(T.t, a.check));
      } finally {
        $.CGWarpMouseCursorPosition($.CGPointMake(home.x, home.y));
      }
    },
    // The browser performs the key's real default; the page recorder says whether
    // a trusted keydown with that key arrived (polled: page timers are throttled).
    trustedPress(a) {
      const T = trustedTarget(a, "a background trusted press");
      const miss = keyFocusMiss(T.I, T.t.P, parseExec(T.t, a.probe));
      if (miss) throw new Error("tab_not_visible: a background trusted press needs the keyboard in the target's page: " + miss);
      const arm = parseExec(T.t, a.arm);
      if (threw(arm)) return armFault("press", arm);
      if (!arm || arm.ok === false || arm.__perch_ref_miss) return arm;
      skyKey(T.I, a.vk, a.uni, a.flags);
      const r = poll(T.t, a.check, 1000, 25);
      const check = r ? r.value : parseExec(T.t, a.final);
      if (threw(check)) return { ok: false, el: arm.el, key: a.key, delivery: "skylight", error: checkFault("press", check) };
      const out = Object.assign({ ok: check.hit === true, el: arm.el, key: a.key }, check, { delivery: "skylight" });
      if (check.hit === null) out.error = "no key reached the page; the browser's focus may be in its toolbar (a trusted click on the page brings it back)";
      return out;
    },
  };
}

// Timeout wording that marks a hang (page JS blocked, or its reply never came),
// shared by the messages and by the dialog probe's check.
export const HANG = {
  killed: "osascript gave up after",
  noReply: "page JS got no reply within ",
  failed: "page JS failed without a reply",
  ranNoReply: " ran but its result got no reply",
  noAnswer: "the page didn't answer",
  unanswered: "; the page stopped answering",
  noEvent: "the browser didn't answer an Apple Event in time",
};

export const JXA_PRELUDE = `(${jxaRuntime})(${JSON.stringify(BROWSERS)}, ${JSON.stringify(HANG)})`;
export const DAEMON_PRELUDE = JXA_PRELUDE + ";__perch.warm()";

export const ERR = {
  jsOff: "JavaScript-from-AppleEvents is off. Enable it: Chromium-family → View > Developer > Allow JavaScript from Apple Events. " +
    "Safari → Settings > Advanced > Show Develop menu, then Develop > Allow JavaScript from Apple Events.",
  automation: "Automation permission denied. Grant it in System Settings > Privacy & Security > Automation, " +
    "ticking the target browser under the controlling app (Claude Code / Terminal / iTerm).",
  timeout: (ms) => `timeout: ${HANG.killed} ${ms}ms: the tab is unreachable (hung page, or a tab its window doesn't show). Re-run list_tabs.`,
};

export function translatePermissionError(msg) {
  if (/Allow JavaScript from Apple Events|JavaScript through AppleScript is turned off|JavaScript from Apple events is turned off/i.test(msg)) return ERR.jsOff;
  if (/Not authorized to send Apple events|errAEEventNotPermitted|-1743/i.test(msg)) return ERR.automation;
  return null;
}

// AppleScript error numbers a browser call can fail with, by the coded message
// the caller gets instead of AppleScript's own wording.
const OSA_QUIT = "no_browser: the browser quit or isn't running; open it, then re-run list_tabs";
const OSA_GONE = "stale_tab: the browser couldn't reach the tab or window (closed, crashed or replaced mid-call); re-run list_tabs";
const OSA_CODES = {
  "-600": OSA_QUIT, "-609": OSA_QUIT, "-903": OSA_QUIT, "-10810": OSA_QUIT,
  "-1712": "timeout: " + HANG.noEvent + "; the call may have run, so check the page before retrying",
  "-1728": OSA_GONE, "-1719": OSA_GONE, "-1708": OSA_GONE, "-10000": OSA_GONE,
};
// Wordings seen without their number.
const OSA_WORDS = [[/Application isn't running/i, "-600"], [/Connection is invalid/i, "-609"], [/AppleEvent timed out/i, "-1712"]];
const CODED = /^(tab_not_visible|stale_tab|window_offscreen|no_browser|timeout|dialog_open|tab_not_scriptable|bad_url): /;
const EXITED = "osascript exited mid-call";

// A raw osascript failure as the caller sees it: a coded message, the permission
// wording, or AppleScript's own message. Its error number stays as a suffix.
export function codeOsaError(msg) {
  const m = / \((-\d+)\)$/.exec(msg);
  let num = m ? m[1] : null;
  const text = m ? msg.slice(0, m.index) : msg;
  // -2700 is a script's own throw, whose message is already the whole story.
  if (num === "-2700") return text;
  if (CODED.test(msg)) return msg;
  const perm = translatePermissionError(msg);
  if (perm) return perm;
  if (msg === EXITED) return "timeout: " + EXITED + "; the call may have run, so check the page before retrying";
  if (num == null) { const w = OSA_WORDS.find(([re]) => re.test(text)); if (w) num = w[1]; }
  if (num == null) return msg;
  return (OSA_CODES[num] || text) + ` (AppleScript ${num})`;
}

// One long-lived `osascript -l JavaScript` process per lane, running DAEMON_LOOP.
// A warm REPL runs a realistic script in ~25ms vs ~90ms cold, dominated by JXA
// bridge startup.
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
// back as a string in JXA, hence Number(). The Prohibited activation policy
// keeps the long-lived REPL out of the Dock, where it otherwise registers as a
// foreground app under the responsible app's name (e.g. "Claude").
const DAEMON_LOOP = `ObjC.import("Foundation");
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
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
    // Characters searched for result markers, over the daemon's life.
    this.scanned = 0;
  }
  // `token` names the job for a later abort().
  run(script, timeout, token) {
    if (this.disabled) return Promise.reject(Object.assign(new Error(this.disabled), { notSent: true }));
    return new Promise((resolve, reject) => {
      this.queue.push({ script, timeout, resolve, reject, token });
      this._drain();
    });
  }
  // Fails the running job with `err` as a timeout would, but only while the job
  // `token` names is still the one running: a late abort must not hit the next call.
  abort(err, token) {
    const job = this.current;
    if (!job || job.handshake || token === undefined || job.token !== token) return false;
    this.current = null;
    clearTimeout(job.timer);
    this.kill();
    job.reject(err);
    this._drain();
    return true;
  }
  // Spawns and handshakes ahead of the first call. It never throws: a spawn
  // failure leaves no process, so the next call spawns again; a handshake
  // timeout disables the daemon as it would on a first call.
  warm() {
    if (!this.disabled) this._drain(true);
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
  async _drain(warm = false) {
    if (this.current || (this.queue.length === 0 && !warm)) return;
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
      `catch(e){console.log("<<P:${id}:E:"+encodeURIComponent(((e&&e.message)?e.message:String(e))+(e&&typeof e.errorNumber==="number"?" ("+e.errorNumber+")":""))+">>");return}` +
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
      this.scanned += c.buffer.length - c.scan;
      const i = c.buffer.indexOf(c.prefix, c.scan);
      if (i < 0) { c.scan = Math.max(0, c.buffer.length - c.prefix.length); return; }
      c.start = i;
      c.scan = i + c.prefix.length + 2;
    }
    this.scanned += c.buffer.length - c.scan;
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
    if (c) { clearTimeout(c.timer); c.reject(new Error(EXITED)); }
    if (this.queue.length) this._drain();
  }
}

const JXA_DEFAULT_TIMEOUT = 30000;
// Tools that poll inside one call (wait, awaitPromise) pass their own timeout plus
// this margin so the outer kill never races the inner loop.
const JXA_OVERHEAD = 5000;

export const DAEMONS = process.env.PERCH_DAEMON === "0" ? {} : {
  fast: new OsaDaemon({ prelude: DAEMON_PRELUDE }),
  slow: new OsaDaemon({ prelude: DAEMON_PRELUDE }),
};

export async function jxa(script, { timeout = JXA_DEFAULT_TIMEOUT, lane = "fast", daemons = DAEMONS, oneShot = jxaOneShot, token } = {}) {
  const d = daemons[lane] || daemons.fast;
  if (d) {
    try { return await d.run(script, timeout, token); }
    catch (e) {
      if (!e.notSent) throw new Error(codeOsaError(e.message));
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
  // "execution error: Error: <msg> (-1728)" → "<msg> (-1728)", then coded
  return codeOsaError(msg.replace(/^.*?execution error: (?:Error: )?/s, ""));
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
  const tabId = args && args.target && args.target.tabId;
  const safari = typeof tabId === "string" && tabId.startsWith("safari:");
  if (safari) {
    let own = stampedHandles.has(tabId) || movedTo.has(tabId), foreign = null;
    if (!own) {
      const at = issueSeq.get(tabId);
      // Unknown to Node (a restart, a hand-built handle) it is trusted like a fresh
      // listing until a cap has forgotten a handle, since it may be that one.
      if (at == null) own = forgotHandle;
      else own = at < stampFloor || (foreign = stampsSince(tabId, at)) === null;
    }
    if (own) {
      const next = [];
      for (let h = movedTo.get(tabId); h && next.length < 10; h = movedTo.get(h)) next.push(h.slice(7));
      args = { ...args, target: { ...args.target, own: true, next, cnt: stampCounts.get(tabId) } };
    } else if (foreign && foreign.length) args = { ...args, target: { ...args.target, foreign } };
  }
  const call = `__perch.${fn}(${JSON.stringify(args)})`;
  let script = raw ? call : `JSON.stringify(${call})`;
  // The runtime's note (the stamp it wrote, a moved tab's handle, Safari windows'
  // tab counts) rides ahead of the result. Any call can issue a Safari handle.
  script = `(function(){__perch.takeNote();var r=${script},n=__perch.takeNote();return n?"${NOTE}"+JSON.stringify(n)+"${NOTE}"+(r==null?"":typeof r==="string"?r:JSON.stringify(r)):r})()`;
  let out = DIALOG_BLIND.has(fn) && !(args && args.clip)
    ? await jxa(script, { lane, timeout })
    : await watchDialogs(args && args.target ? args.target : {}, lane, (token) => jxa(script, { lane, timeout, token }));
  if (typeof out === "string" && out.startsWith(NOTE_MARK)) {
    const end = out.indexOf(NOTE_MARK, 1), n = JSON.parse(out.slice(1, end));
    out = out.slice(end + 1);
    if (n.s) {
      remember(stampedHandles, n.s);
      remember(stampSeq, n.s, ++stampClock);
      issueSeq.delete(n.s);
      issueSeq.delete(tabId);
    }
    const c = callNotes.getStore();
    // Counts wait for the result, which says which handles the call issued.
    if (n.c) {
      if (c) {
        Object.assign((c.counts ||= {}), n.c);
        if (n.s) (c.stamped ||= new Set()).add(n.s);
      } else if (n.s && n.c[n.s]) keepCounts({ [n.s]: n.c[n.s] }, () => true);
    }
    if (n.m) {
      if (n.m !== tabId) remember(movedTo, tabId, n.m);
      if (c) c.moved = n.m;
    }
  }
  return raw ? out : JSON.parse(out);
}

const NOTE = "\\u0001", NOTE_MARK = "\u0001";
// Safari handles perch has written on a page as its stamp: a page at their index
// without it is not taken on trust. A handle a listing just issued is dropped
// again, since the listing vouches for the tab at its index.
const stampedHandles = new Set();
// A handle -> the handle a call on it answered under after its tab moved; the
// page's stamp then names the newer one, which the older handle still accepts.
const movedTo = new Map();
// A Safari handle -> its window's [tabs at its URL, tabs in all] when perch last
// read them (a listing, new_tab, a pick). A handle that has stamped takes an
// unstamped page at its index only while these still match: a reload keeps them,
// a same-URL tab sliding in after its tab closed changes them.
const stampCounts = new Map();
export const STAMP_LIMITS = { counts: 20000, stamped: 5000 };
// Issues and stamps share one clock, so a stamp can be dated against an issue.
// issueSeq: a Safari handle a call's result issued and that hasn't stamped since.
// stampSeq: a Safari handle -> its latest stamp.
let stampClock = 0;
const issueSeq = new Map(), stampSeq = new Map();
// Past STAMP_LIMITS.stamped the oldest entries go (each collection is kept in
// last-use order), and the caps fail closed: once any handle is forgotten, one
// Node doesn't know is held to a stamped handle's rules, and a handle issued
// before the latest forgotten stamp (stampFloor) is too, since it can't be
// told which stamps came after it.
let forgotHandle = false, stampFloor = 0;
function remember(coll, k, v) {
  coll.delete(k);
  if (coll instanceof Set) coll.add(k); else coll.set(k, v);
  for (const [old, at] of coll.entries()) {
    if (coll.size <= STAMP_LIMITS.stamped) break;
    coll.delete(old);
    if (coll === stampSeq) stampFloor = at; else forgotHandle = true;
  }
}
// Raw ids of the handles that stamped a tab in `tabId`'s window at its URL after
// clock `since`: a tab they stamped is not the one the listing vouched for. null
// when there are too many to send, so the handle is held to the strict rules.
function stampsSince(tabId, since) {
  const [win, , ...rest] = tabId.slice(7).split("."), hash = rest.join(".");
  const out = [];
  for (const [h, at] of stampSeq) {
    if (at <= since || h === tabId) continue;
    const [w, , ...r] = h.slice(7).split(".");
    if (w !== win || r.join(".") !== hash) continue;
    if (out.push(h.slice(7)) > 20) return null;
  }
  return out;
}
// Only counts a call can vouch for are kept: those of a handle its result issued,
// or of the one its pick stamped (page JS proved the tab). Past the cap only the
// counts go, so a stamped handle is refused rather than trusted.
function keepCounts(counts, ok) {
  for (const h in counts) {
    if (!ok(h)) continue;
    if (stampCounts.size > STAMP_LIMITS.counts) stampCounts.clear();
    stampCounts.set(h, counts[h]);
  }
}
const callNotes = new AsyncLocalStorage();

// A page's alert/confirm/prompt blocks its JS, and with it our call, until the
// timeout. Once a call has been in flight DIALOG_PROBE_MS, a one-shot osascript
// (never queued behind the hung lane) looks for a dialog on the call's own target,
// again every DIALOG_REPROBE_MS; a hit aborts the hung job with dialog_open. A
// dialog it cannot tie to the target is ignored and the plain timeout stands.
// Without the daemon it looks once, when the call times out. Entries that never
// run page JS, and the dialog entries themselves, are not watched; a shot that
// crops to an element (a.clip) runs page JS and is.
const DIALOG_PROBE_MS = 1500, DIALOG_REPROBE_MS = 2000;
// Timeouts that may mean page JS was blocked: the REPL killed, or an execute
// whose reply never came. A wait, wait {quiet} or awaitPromise that ran out
// while the page answered its polls can't be a dialog and is not probed; one
// whose last poll went unanswered says so (HANG.unanswered) and is.
const HANG_PHRASES = Object.values(HANG);
const hung = (msg) => msg.startsWith("timeout: ") && HANG_PHRASES.some((p) => msg.includes(p));
const DIALOG_BLIND = new Set(["listTabs", "newTab", "closeTab", "activate", "shotGeom", "shot", "dialogs", "answerDialog"]);

const probeDialogs = async (target) => JSON.parse(await jxaOneShot(`JSON.stringify(__perch.dialogs(${JSON.stringify({ target })}))`, { timeout: 5000 }));

const dialogOpen = (d) => new Error(`dialog_open: a ${d.kind} (${JSON.stringify(String(d.message).slice(0, 200))}) is open and pauses the page; answer it with press {key:"Enter"|"Escape", dialog:true, target:{tabId}} (a string answers a prompt). The page JS stopped at the dialog and its result is lost; check the page after answering.`);

async function findDialog(target) {
  try { return (await deps.dialogs(target))[0] || null; } catch { return null; }
}

async function watchDialogs(target, lane, run) {
  const d = DAEMONS[lane] || DAEMONS.fast;
  const token = {};
  let timer = null, done = false;
  const probe = async () => {
    const hit = await findDialog(target);
    if (done) return;
    if (hit && d.abort(dialogOpen(hit), token)) return;
    timer = setTimeout(probe, DIALOG_REPROBE_MS);
  };
  if (d && typeof d.abort === "function") timer = setTimeout(probe, DIALOG_PROBE_MS);
  let err;
  try { return await run(token); }
  catch (e) { err = e; }
  finally { done = true; clearTimeout(timer); }
  const hit = hung(err.message) && await findDialog(target);
  throw hit ? dialogOpen(hit) : err;
}

// Page-side error shape, shared by the sync wrapper and the async kickoff.
const ERROR_SHAPE = `function(e){return {__perch_error:(e&&e.message)?e.message:String(e),__perch_error_name:(e&&e.name)||'Error',__perch_error_stack_head:(e&&e.stack)?String(e.stack).split('\\n').slice(0,2).join(' | ').slice(0,300):null}}`;

// The newline before `})` keeps a trailing `// comment` in user code from eating the wrapper.
export function buildEvalWrapper(js) {
  return `(function(){var __E=${ERROR_SHAPE};try{var __r=(function(){${js}\n})();return JSON.stringify(__r===undefined?null:__r)}catch(e){return JSON.stringify(__E(e))}})()`;
}

// AppleScript can't await, so async code stashes its outcome on window[key] and JXA polls it.
// A poll never deletes the slot: one that gave up waiting can still run later, and
// deleting there would read as a lost result. It lists the slot as read instead,
// and the next kick sweeps read slots, so the normal path adds no Apple Event.
const ASYNC_DONE = "window.__perch_async_done";
function buildAsyncKickoff(js, key) {
  const k = JSON.stringify(key);
  return `(function(){var __E=${ERROR_SHAPE};(${ASYNC_DONE}||[]).forEach(function(d){delete window[d]});${ASYNC_DONE}=[];window[${k}]=0;(async function(){try{var __r=await (async function(){${js}\n})();window[${k}]={value:__r===undefined?null:__r}}catch(e){window[${k}]=__E(e)}})();return "1"})()`;
}

function buildAsyncPoll(key) {
  const k = JSON.stringify(key);
  return `(function(){var v=window[${k}];if(v===undefined)return '{"__perch_gone":1}';if(v===0)return "null";var d=${ASYNC_DONE}=${ASYNC_DONE}||[];if(d.indexOf(${k})<0)d.push(${k});return JSON.stringify(v)})()`;
}

const parsePage = (raw) => { if (raw === "") return null; try { return JSON.parse(raw); } catch { return raw; } };

// ---- tools ----

export function shapeTabs(rows, { urlContains, titleContains, limit = 50 } = {}) {
  const has = (v, q) => v.toLowerCase().includes(String(q).toLowerCase());
  if (urlContains) rows = rows.filter((t) => has(t.url, urlContains));
  if (titleContains) rows = rows.filter((t) => has(t.title, titleContains));
  return { tabs: rows.slice(0, Math.max(0, limit)), total: rows.length };
}

// A browser list_tabs couldn't read, coded as for any call except that it is
// never stale_tab: a listing names no tab to go stale, and "re-run list_tabs"
// would only repeat the call. A failed or misunderstood event (-10000, -1708) is
// a browser too busy to answer, so a transient timeout.
function listFailure(f) {
  const msg = codeOsaError(f.error);
  if (!/^stale_tab: /.test(msg)) return msg;
  const num = / \((-\d+)\)$/.exec(f.error);
  return `timeout: ${f.app} did not answer the tab listing (busy, starting up or showing a dialog); wait a moment and try again, or pass app to list another browser` + (num ? ` (AppleScript ${num[1]})` : "");
}

async function listTabs(args = {}) {
  const { urlContains = null, titleContains = null, limit = 50 } = args;
  const r = await rt("listTabs", { app: args.app || null, urlContains, titleContains, limit });
  // A browser that couldn't be read fails the call when nothing else listed, so
  // "no tabs" always means none.
  if (r.failed && !r.rows.length && !r.more) throw new Error(listFailure(r.failed[0]));
  const out = shapeTabs(r.rows, args);
  out.total += r.more;
  if (r.failed) out.warning = r.failed.map((f) => `${f.app} not listed: ${listFailure(f)}`).join("; ");
  return out;
}

async function evalJs(script, target, { awaitPromise = false, timeout = 30000, tool = "eval_js" } = {}) {
  if (!awaitPromise) return parsePage(await rt("evalJs", { target, js: buildEvalWrapper(script), tool }, { raw: true }));
  const key = `__perch_async_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const r = await rt("evalAsync", { target, kick: buildAsyncKickoff(script, key), poll: buildAsyncPoll(key), timeout },
    { lane: "slow", timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD });
  return r && Object.hasOwn(r, "value") ? r.value : r;
}

async function wait(args = {}) {
  const { selector, readyState = "complete", expression, timeout = 10000, target, quiet } = args;
  if (quiet != null) return waitQuiet(args, timeout);
  const js = expression
    ? `(function(){try{var __r=(${expression});return JSON.stringify(__r===undefined?null:__r)}catch(e){return "null"}})()`
    : buildEvalWrapper(pageScript("wait_check", { selector, readyState }));
  const r = await rt("wait", { target, js, timeout, selector: expression ? undefined : selector }, { lane: "slow", timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD });
  return expression ? { ok: true, waited: r.waited, value: r.value } : { ok: true, waited: r.waited };
}

async function waitQuiet({ quiet, selector, expression, target }, timeout) {
  if (typeof quiet !== "number" || !(quiet > 0)) throw new Error("wait: `quiet` must be a positive number of ms");
  if (!(quiet < timeout)) throw new Error("wait: `quiet` must be shorter than `timeout`");
  if (selector != null || expression != null) throw new Error("wait: `quiet` takes no selector or expression");
  const A = { life: timeout };
  const arm = buildEvalWrapper(pageScript("wait_quiet_arm", A)), js = buildEvalWrapper(pageScript("wait_quiet", A));
  const r = await rt("wait", { target, arm, js, timeout, quiet }, { lane: "slow", timeout: Math.max(timeout, JXA_DEFAULT_TIMEOUT) + JXA_OVERHEAD });
  return { ok: true, waited: r.waited, quietFor: r.quietFor };
}

const NAV_TIMEOUT = 15000;

// The error names only the scheme: a data: url can be megabytes. A bare host
// gets a hint, never a guess at what was meant: http for a local host, which
// rarely serves https.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.(localhost|test)$/i;
const NOT_HOST = /^(javascript|data|vbscript|mailto|tel|blob|ws|wss|chrome|arc|edge|about|view-source|file|https?)$/i;
function checkUrl(tool, url) {
  const bad = (got) => new Error(`bad_url: ${tool} takes an absolute http(s) or file URL, or about:blank; got ${got}`);
  if (typeof url !== "string") throw bad(`a ${typeof url}`);
  const s = url.trim();
  if (/^about:blank$/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) {
    try { const u = new URL(s); if (/^https?:$/.test(u.protocol) && u.hostname) return s; } catch {}
  }
  if (/^file:\/\//i.test(s)) return s;
  // host:port reads as a scheme, so a bare host is tried first; a known scheme
  // (javascript:1) or a dotless name that isn't a local host is not one.
  const host = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d+)?(?=[/?#]|$)/i.exec(s);
  if (host && !NOT_HOST.test(host[1]) && (host[1].includes(".") || host[1][0] === "[" || LOCAL_HOST.test(host[1]))) {
    let hint = "";
    try { const h = new URL("http://" + host[0]).host; hint = `; pass ${LOCAL_HOST.test(new URL("http://" + h).hostname) ? "http" : "https"}://${h}`; } catch {}
    throw bad("no scheme" + hint);
  }
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(s);
  if (scheme) throw bad(scheme[0].slice(0, -1).toLowerCase());
  throw bad("no scheme");
}

// Some handles follow the page's URL, so navigate returns the tab's current one.
async function navigate(url, target, raise) {
  url = checkUrl("navigate", url);
  const r = await rt("navigate", { target, url, raise: !!raise, timeout: NAV_TIMEOUT }, { lane: "slow", timeout: NAV_TIMEOUT + JXA_OVERHEAD });
  const same = (x, y) => { try { return new URL(x).href === new URL(y).href; } catch { return x === y; } };
  const tab = r && r.tabId ? { tabId: r.tabId } : {};
  if (r && r.loadFailed) return { ok: false, error: `load_failed: ${url} did not load; the browser showed its error page`, ...tab };
  // A reload that settles on the url it started from is not a failure.
  if (r && r.stayed != null && !same(r.stayed, url)) {
    const blocked = /^file:/i.test(url) && /^file:/i.test(r.stayed) ? "; if the browser keeps pages from loading file: URLs, raise:true loads it from outside the page" : "";
    return { ok: false, error: `load_failed: the tab stayed on ${r.stayed}, as a download, a 204 or a load the page dropped leaves it${blocked}`, ...tab };
  }
  if (r && r.notCommitted != null) {
    return { ok: false, error: `timeout: ${url} had not committed after ${r.after ?? NAV_TIMEOUT}ms; the tab shows ${r.notCommitted}; it may still load, check before retrying`, ...tab };
  }
  // waited:false: the timeout ran out after the new document committed but before
  // it finished loading, with no check ever answered, or on a tab that can't be
  // checked (an arc: url, an Arc tab whose url can't be read yet).
  const committed = r && r.href != null ? r.href : url;
  const out = { ok: true, url: committed };
  if (!same(committed, url)) out.requested = url;
  out.waited = !!(r && r.waited);
  Object.assign(out, tab);
  if (r && r.warning) out.warning = r.warning;
  return out;
}

async function newTab(url, app) {
  return rt("newTab", { app: app || null, url: url == null ? "about:blank" : checkUrl("new_tab", url) });
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

async function closeTab({ tabId } = {}) {
  if (typeof tabId !== "string" || !tabId) throw new Error("close_tab requires `tabId`");
  return rt("closeTab", { target: { tabId } });
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
export const deps = { exec, dialogs: probeDialogs };

// The runtime's clipPixels, for a screencapture of W x H pixels.
function clipPixels(m, W, H) {
  const k = W / m.cw, px = (o, v) => k * (o + m.s * v);
  const x0 = Math.floor(px(m.ox, m.box.x0) + 1e-6), y0 = Math.floor(px(m.oy, m.box.y0) + 1e-6);
  const x1 = Math.ceil(px(m.ox, m.box.x1) - 1e-6), y1 = Math.ceil(px(m.oy, m.box.y1) - 1e-6);
  const x = Math.max(0, x0), y = Math.max(0, y0);
  return { x, y, w: Math.min(W, x1) - x, h: Math.min(H, y1) - y, cut: x0 < 0 || y0 < 0 || x1 > W || y1 > H };
}

async function screenshot(args = {}) {
  const { raise = false, target, format = "png", maxWidth = 1568, ref, selector } = args;
  const aimed = (ref != null && ref !== "") || (selector != null && selector !== "");
  const g = await rt("shot", aimed
    ? { target, raise, format, maxWidth, clip: pageFn("shot_clip", { ref, selector }), painted: pageFn("shot_painted", {}), restore: pageFn("shot_restore", {}) }
    : { target, raise, format, maxWidth });
  // The element's own outcome: a ref miss, no match, a page fault, nothing visible.
  if (aimed && (!g || g.windowNumber == null || g.ok === false)) return g;
  const ext = format === "jpeg" ? "jpg" : "png";
  // Both captures cover the CG bounds (titlebar included), not AppleScript's inner geom.
  const rect = g.cgBounds || g.geom;
  const meta = (image, clip = g.clip, clipped = g.clipped) => ({
    window: rect, image,
    ...(aimed && { clip, aim: g.aim }),
    ...(clipped && { clipped: true }),
    ...(g.warning && { warning: g.warning }),
  });
  if (g.data) return { __image: true, data: g.data, mimeType: ext === "jpg" ? "image/jpeg" : "image/png", meta: meta(g.image) };
  const base = join(tmpdir(), `perch-${process.pid}-${Date.now().toString(36)}`);
  const files = [`${base}.${ext}`];
  const quality = ext === "jpg" ? ["-s", "formatOptions", "80"] : [];
  try {
    // A missing CGWindowID is rejected by shotGeom: a screen-rect capture would
    // show the user's foreground app rather than a minimized browser window.
    await deps.exec("screencapture", ["-l", String(g.windowNumber), "-x", "-o", "-t", ext, files[0]]);
    let buf = await readFile(files[0]);
    let dims = imageDims(buf);
    let clip, clipped = g.clipped;
    if (g.map) {
      const c = dims && clipPixels(g.map, dims.w, dims.h);
      if (!c || !(c.w > 0 && c.h > 0)) throw new Error("screenshot: could not place the element in the window's capture; nothing was cropped");
      files.push(`${base}-c.${ext}`);
      await deps.exec("sips", ["--cropToHeightWidth", String(c.h), String(c.w), "--cropOffset", String(c.y), String(c.x), ...quality, files[0], "--out", files[1]]);
      buf = await readFile(files[1]);
      dims = imageDims(buf);
      clip = { x: c.x, y: c.y, w: c.w, h: c.h };
      clipped = clipped || c.cut;
    }
    if (maxWidth > 0 && dims && dims.w > maxWidth) {
      const src = files[files.length - 1];
      files.push(`${base}-s.${ext}`);
      // Best effort: if sips fails, the full-size capture still goes back.
      try {
        await deps.exec("sips", ["--resampleWidth", String(maxWidth), ...quality, src, "--out", files[files.length - 1]]);
        buf = await readFile(files[files.length - 1]);
        dims = imageDims(buf);
      } catch {}
    }
    return { __image: true, data: buf.toString("base64"), mimeType: ext === "jpg" ? "image/jpeg" : "image/png", meta: dims ? meta(dims, clip, clipped) : undefined };
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
// The window an element lives in: a same-origin frame's own, else this one.
// A frame document that lost its window throws rather than borrow this one.
function viewOf(el) {
  const d = el && el.ownerDocument;
  if (!d || d === document) return window;
  if (!d.defaultView) throw Object.assign(new Error("stale ref"), { name: "PerchStaleRef" });
  return d.defaultView;
}
// A same-origin frame that navigates or reloads leaves its old document alive,
// and the nodes a ref kept there still read isConnected: such a document is
// live only while a connected iframe still shows it, in this page or (up to 3
// frames deep) in a live same-origin frame.
function frameOf(d, root, depth) {
  for (const x of root.getElementsByTagName("iframe")) {
    let c = null;
    try { c = x.contentDocument; } catch (e) {}
    if (!c) continue;
    if (c === d) return x;
    const f = depth < 3 && frameOf(d, c, depth + 1);
    if (f) return f;
  }
  return null;
}
function liveDoc(d, depth) {
  if (d === document) return true;
  depth = depth || 1;
  const v = d && d.defaultView;
  if (!v || depth > 3) return false;
  let f = null;
  try { f = v.frameElement; } catch (e) {}
  if (f == null) f = frameOf(d, document, 1);
  if (!f || !f.isConnected) return false;
  try { if (f.contentDocument !== d) return false; } catch (e) { return false; }
  return liveDoc(f.ownerDocument, depth + 1);
}
function getComputedStyle(el, p) { return (el.ownerDocument === document ? window : viewOf(el)).getComputedStyle(el, p); }
// querySelectorAll over the document and every open shadow root, in document
// order: a shadow tree's matches follow its host. Closed roots stay unreachable.
function deepAll(sel, root) {
  const out = [];
  for (const el of (root || document).querySelectorAll("*")) {
    if (el.matches(sel)) out.push(el);
    if (el.shadowRoot) out.push.apply(out, deepAll(sel, el.shadowRoot));
  }
  return out;
}
// A <label>'s own words: not the control(s) it wraps, nor hidden text or a
// suggestion popup ("Loading", "No results") that some widgets keep inside it.
const LABEL_SKIP = "select, input, textarea, button, [role=listbox], [role=status], [role=alert], [aria-live], [class*=dropdown]";
function labelWords(l) {
  let s = "";
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1 && !c.hidden && !c.matches(LABEL_SKIP)) {
        const cs = getComputedStyle(c);
        if (cs.display !== "none" && cs.visibility !== "hidden") walk(c);
      }
    }
  })(l);
  return s;
}
function editable(el) { return !!el && (el.isContentEditable === true || (!!el.hasAttribute && el.hasAttribute("contenteditable") && attr(el, "contenteditable") !== "false")); }
function vis(el) {
  if (!el || el.hidden) return false;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
  const r = el.getBoundingClientRect();
  return !(r.width === 0 && r.height === 0);
}
// A text input or textarea placed where no one can see it: wholly above or left
// of the document, under aria-hidden, or (unless a combobox, whose input shrinks
// while empty) shrunk or clipped to a pixel. A 0x0 box is plain hidden, not a
// trap. Bots fill these; people never do.
// labelled: a visible label names it, so a pixel or clip is an sr-only custom
// input, not a trap.
function honeypot(el, labelled) {
  if (!el || !(el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(checkbox|radio|file|hidden)$/i.test(el.type || "")))) return false;
  if (el.closest("[aria-hidden=true]")) return true;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return false;
  const v = viewOf(el);
  if (r.right + (v.scrollX || 0) <= 0 || r.bottom + (v.scrollY || 0) <= 0) return true;
  if (labelled || attr(el, "role") === "combobox" || el.hasAttribute("aria-autocomplete")) return false;
  if (r.width <= 1 || r.height <= 1) return true;
  const m = /rect\(([-\d.]+)px,?\s*([-\d.]+)px,?\s*([-\d.]+)px,?\s*([-\d.]+)px/.exec(getComputedStyle(el).clip || "");
  return !!m && (m[2] - m[4] <= 1 || m[3] - m[1] <= 1);
}
// A honeypot, an untabbable field with autofill off, or one whose name says to
// leave it empty.
// Words may be joined by spaces, underscores or dashes (leave_blank, do-not-fill).
const LEAVE_BLANK = /(^|[^a-z0-9])(leave[ _-](this[ _-]|it[ _-])?(field[ _-])?(blank|empty)|do[ _-]not[ _-]fill)($|[^a-z0-9])/i;
// tabindex below 0 takes a field out of the tab order.
function untabbable(el) { return el.hasAttribute("tabindex") && el.tabIndex < 0; }
function trapLike(el, labelled) {
  return honeypot(el, labelled) || (attr(el, "tabindex") === "-1" && attr(el, "autocomplete") === "off")
    || LEAVE_BLANK.test(labelText(el) + " " + attr(el, "name"));
}
// A required field named by visible text (a <label>, or aria-labelledby) is one
// the form wants filled, so fill takes a pixel or clip on it for sr-only styling,
// unless it is untabbable or its label says to leave it blank.
function wanted(el) {
  if (!el || (!el.required && attr(el, "aria-required") !== "true")) return false;
  if (untabbable(el) || LEAVE_BLANK.test(labelText(el) + " " + attr(el, "name"))) return false;
  return (!!el.labels && Array.prototype.some.call(el.labels, vis))
    || attr(el, "aria-labelledby").split(/\s+/).some(function (id) { const t = id && el.ownerDocument.getElementById(id); return !!t && vis(t) && !!t.textContent.trim(); });
}
// vis(), plus a styled control's own input faded (opacity 0) or shrunk to a
// pixel inside a visible, sized box at most 3 levels up that contains it: a
// combobox input (react-select after a pick) or a custom checkbox or radio.
// A combobox's box must paint something besides the input (its value, a
// placeholder, an arrow). A plain faded input is a honeypot, not a control, and
// so is anything untabbable (tabindex=-1) or aria-hidden. display:none,
// visibility:hidden and a box that is itself hidden still hide it.
function fieldVis(el) {
  if (honeypot(el, wanted(el))) return false;
  if (vis(el)) return true;
  if (!el || el.hidden || el.tagName !== "INPUT") return false;
  const t = (el.type || "").toLowerCase();
  const check = /^(checkbox|radio)$/.test(t);
  if (!check && attr(el, "role") !== "combobox" && !el.hasAttribute("aria-autocomplete")) return false;
  if (untabbable(el) || el.closest("[aria-hidden=true]")) return false;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  for (let p = el.parentElement, i = 0; p && i < 3 && !/^(BODY|HTML)$/.test(p.tagName); p = p.parentElement, i++) {
    if (!vis(p)) continue;
    const b = p.getBoundingClientRect();
    if (b.width > 1 && b.height > 1 && r.left >= b.left - 1 && r.top >= b.top - 1 && r.right <= b.right + 1 && r.bottom <= b.bottom + 1 && (check || paints(p, el))) return true;
  }
  return false;
}
// Box p shows visible text or a visible element that doesn't wrap el.
function paints(p, el) {
  const tw = p.ownerDocument.createTreeWalker(p, 5);
  for (let k = 0; k < 60 && tw.nextNode(); k++) {
    const n = tw.currentNode;
    if (n.nodeType === 3) { if (n.nodeValue.trim() && vis(n.parentElement)) return true; }
    else if (n !== el && !n.contains(el) && vis(n)) return true;
  }
  return false;
}
// Strong label sources, in accessible-name precedence order.
function labelText(el) {
  const ids = attr(el, "aria-labelledby");
  if (ids) {
    const root = el.getRootNode().getElementById ? el.getRootNode() : document;
    const t = ids.split(/\s+/).map(function (id) { return textOf(root.getElementById(id)); }).join(" ");
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
const REVEAL_SKIP = /submit|apply|next|continue|save/i;
const REVEAL_TYPING = /\b(enter|type|write|paste|add|edit)\b|manual/i;
const FIELD_CTL = "input, select, textarea, button, [role=combobox], [role=textbox], [contenteditable]";
function isField(el) {
  if (el.tagName === "INPUT") return !/^(submit|button|image|reset|hidden)$/i.test(el.type);
  return /^(SELECT|TEXTAREA)$/.test(el.tagName) || /^(combobox|textbox)$/.test(attr(el, "role"));
}
// Text nodes joined by spaces, so "Question?<span>*</span>" reads "Question? *".
function sibText(sib) {
  const parts = [], tw = sib.ownerDocument.createTreeWalker(sib, 4);
  while (parts.length < 40 && tw.nextNode()) parts.push(tw.currentNode.nodeValue);
  return clip(parts.join(" "), 120);
}
// Question text laid out before an unlabeled field: the nearest earlier sibling
// of the field or of one of its 3 nearest ancestors, not crossing a list item,
// fieldset or form, and stopping at a sibling that holds a control (that text
// names the other control).
function nearText(el) {
  let n = el;
  for (let up = 0; up < 4 && n && !/^(LI|FIELDSET|FORM|BODY)$/.test(n.tagName); up++, n = n.parentElement) {
    let sib = n.previousElementSibling;
    for (let k = 0; sib && k < 3; k++, sib = sib.previousElementSibling) {
      if (sib.matches(FIELD_CTL) || sib.querySelector(FIELD_CTL)) return "";
      if (!vis(sib)) continue;
      const t = sibText(sib);
      if (t) return t;
    }
  }
  return "";
}
function accName(el) {
  let s = labelText(el) || (isField(el) ? nearText(el) : "") || attr(el, "placeholder") || attr(el, "alt");
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
function ident(el) { return role(el) + " " + JSON.stringify(accName(el)) + (fieldVis(el) ? "" : " hidden"); }
// The prototype setter reaches React-controlled fields whose instance setter is patched.
function setNativeValue(el, v) {
  const V = viewOf(el);
  const P = el.tagName === "TEXTAREA" ? V.HTMLTextAreaElement : el.tagName === "SELECT" ? V.HTMLSelectElement : V.HTMLInputElement;
  const d = Object.getOwnPropertyDescriptor(P.prototype, "value");
  if (d && d.set) d.set.call(el, v); else el.value = v;
}
// A form control the form leaves out of its submission: disabled itself or by a fieldset.
function unsent(el) {
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !!(el.disabled || el.closest("fieldset[disabled]"));
}
function unsentOut(el) { return { ok: false, el: ident(el), error: ident(el) + " is disabled; the form will not submit it" }; }
function fire(el, types) { types.forEach(function (t) { el.dispatchEvent(new Event(t, { bubbles: true })); }); }
// -> {el} or {out}, where out is the tool's return value (ref miss or no match).
function resolveEl(a, dflt) {
  if (a.ref) {
    const el = (window.__perch_refs || {})[a.ref];
    return el && el.isConnected && liveDoc(el.ownerDocument) ? { el: el } : { out: { __perch_ref_miss: true, ref: String(a.ref) } };
  }
  const sel = a.selector || dflt;
  if (!sel) return { el: null };
  let el;
  try { el = document.querySelector(sel) || deepAll(sel)[0]; } catch (e) { return { out: { ok: false, error: "bad selector: " + sel } }; }
  return el ? { el: el } : { out: { ok: false, error: "no element for selector " + sel } };
}
function isDisabled(el) { return el.disabled === true || attr(el, "aria-disabled") === "true"; }
const WORD_CH = /[\p{L}\p{N}_]/u;
// How well a pattern names s: 0 the whole name (whole matches the anchored
// pattern), 1 a match that starts and ends on word boundaries, 2 any other
// match, 3 none. re carries the "g" flag.
function nameTier(whole, re, s) {
  if (whole.test(s)) return 0;
  let best = 3;
  re.lastIndex = 0;
  for (let m; (m = re.exec(s)); ) {
    if (!m[0]) { re.lastIndex++; continue; }
    const a = m.index, b = a + m[0].length;
    const cutIn = WORD_CH.test(s[a - 1] || "") && WORD_CH.test(m[0][0]);
    const cutOut = WORD_CH.test(s[b] || "") && WORD_CH.test(m[0][m[0].length - 1]);
    best = Math.min(best, cutIn || cutOut ? 2 : 1);
  }
  return best;
}
`;

// Click targeting, shipped only with the scripts that click or hover by label.
const CLICK_LIB = String.raw`
const CLICKABLE = "button, a[href], [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=radio], [role=option], input[type=submit], input[type=button], input[type=reset], summary";
// The form control holding el when it is natively disabled: browsers drop clicks on it
// and its descendants. A disabled fieldset spares its first legend's controls; the
// walk covers engines whose :disabled skips fieldset inheritance.
function inertCtl(el) {
  const c = el.closest("button, input, select, textarea");
  if (!c) return null;
  try { if (c.disabled || c.matches(":disabled")) return c; } catch (e) {}
  for (let f = c.closest("fieldset[disabled]"); f; f = f.parentElement && f.parentElement.closest("fieldset[disabled]")) {
    const lg = Array.prototype.find.call(f.children, function (k) { return k.tagName === "LEGEND"; });
    if (!(lg && lg.contains(c))) return c;
  }
  return null;
}
function inertOut(c) { return { ok: false, el: ident(c), error: ident(c) + " is disabled; nothing was clicked" }; }
// The one control whose accessible name (or button value) best fits a.label_pattern:
// enabled and visible ones first, then by nameTier. A tie refuses rather than guess.
function clickableByLabel(a) {
  const whole = new RegExp("^(?:" + a.label_pattern + ")$", "i"), re = new RegExp(a.label_pattern, "gi");
  const tierOf = function (el) {
    const t = nameTier(whole, re, accName(el));
    return t && el.tagName === "INPUT" && el.value ? Math.min(t, nameTier(whole, re, clip(el.value, 120))) : t;
  };
  const rank = function (pool) {
    let tier = 3, hits = [];
    pool.forEach(function (el) {
      const t = tierOf(el);
      if (t < tier) { tier = t; hits = [el]; } else if (t === tier && t < 3) hits.push(el);
    });
    // A control inside another hit (a button in a link) is the same target.
    return hits.filter(function (el) { return !hits.some(function (o) { return o !== el && el.contains(o); }); });
  };
  const pat = "/" + a.label_pattern + "/i";
  let all = Array.from(document.querySelectorAll(CLICKABLE)), hits = [];
  for (let pass = 0; pass < 2 && !hits.length; pass++) {
    // Open shadow roots only when the light DOM has no enabled match.
    if (pass) all = deepAll(CLICKABLE);
    const on = all.filter(function (el) { return !isDisabled(el); });
    hits = rank(on.filter(vis));
    if (!hits.length) hits = rank(on);
  }
  if (hits.length === 1) return { el: hits[0] };
  if (hits.length > 1) return { out: { ok: false, error: "ambiguous: " + pat + " names " + hits.length + " controls equally; narrow it, or use a selector or ref", candidates: hits.slice(0, 8).map(ident) } };
  const off = rank(all.filter(isDisabled));
  if (off.length) return { out: { ok: false, error: pat + " matches only disabled: " + off.slice(0, 3).map(ident).join(", ") } };
  const names = [];
  all.filter(function (el) { return vis(el) && !isDisabled(el); }).forEach(function (el) { const n = accName(el); if (n && names.indexOf(n) < 0 && names.length < 8) names.push(n); });
  return { out: { ok: false, error: "no button or link matched " + pat, names: names } };
}
function resolveClick(a) { return a.label_pattern ? clickableByLabel(a) : resolveEl(a); }
`;
const TABBABLE_LIB = String.raw`
// Sequential focus order, approximated as DOM order of visible focusables.
function tabbables() {
  return Array.prototype.filter.call(document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]"), function (n) {
    return n.tabIndex >= 0 && !n.disabled && n.type !== "hidden" && vis(n);
  });
}
`;

const SELECT_LIB = String.raw`
// Curly quotes and dashes fold to ASCII, so typed text matches typographic options.
const norm = function (s) { return String(s || "").replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").trim().toLowerCase(); };
// Accents fold away for comparison only, so "Cordoba" matches "Córdoba".
const fold = function (s) { return String(s || "").normalize("NFD").replace(/\p{M}+/gu, ""); };
const wordsOf = function (s) { return String(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean); };
const reEsc = function (s) { return s.replace(/[.*+?^$(){}|[\]\\/]/g, "\\$&"); };
// Each of want's items equals one of have's, in the same order.
function inOrder(have, want) {
  let i = 0;
  for (const w of want) {
    while (i < have.length && have[i] !== w) i++;
    if (i++ >= have.length) return false;
  }
  return want.length > 0;
}
// The best tier's hits: exact text, then a whole-word hit, then a word prefix,
// then every typed word whole and in order; never mid-word. -> {hits, exact}
function matchTier(list, key, want) {
  want = fold(want);
  if (!want) return { hits: [], exact: false };
  const esc = reEsc(want), ws = wordsOf(want);
  const word = new RegExp("(?:^|[^\\p{L}\\p{N}])" + esc + "(?:$|[^\\p{L}\\p{N}])", "u");
  const pre = new RegExp("(?:^|[^\\p{L}\\p{N}])" + esc, "u");
  const tiers = [function (t) { return t === want; }, function (t) { return word.test(t); }, function (t) { return pre.test(t); },
    function (t) { return inOrder(wordsOf(t), ws); }];
  const keys = list.map(function (x) { return fold(key(x)); });
  for (let i = 0; i < tiers.length; i++) {
    const hits = list.filter(function (x, j) { return tiers[i](keys[j]); });
    if (hits.length) return { hits: hits, exact: i === 0 };
  }
  return { hits: [], exact: false };
}
// Ties go to the shortest.
function bestMatch(list, key, want) {
  const hits = matchTier(list, key, want).hits;
  return hits.length ? hits.sort(function (a, b) { return key(a).length - key(b).length; })[0] : null;
}
// -> {el} (the select or combobox), {group} (a radio group, only when groups,
// a function listing them, is given) or {out}. A select and a radio group both
// matching, or two radio groups, is ambiguous; among selects the first wins.
function findCtl(a, groups, only) {
  if (a.ref || a.selector) {
    const r = resolveEl(a);
    const g = r.el && groups && (r.el.closest(RADIO_OPT) || r.el.querySelector(RADIO_OPT)) && groupOf(r.el, groups());
    return g ? { group: g } : r;
  }
  const re = new RegExp(a.label_pattern, "i");
  const cands = Array.from(document.querySelectorAll("select, [role=combobox], [aria-haspopup=listbox], [aria-haspopup=dialog], [role=listbox]"));
  const hit = function (el) { return re.test(labelText(el)) || re.test(hintText(el)); };
  const el = cands.filter(vis).find(hit) || cands.find(hit);
  const gs = groups ? groups().filter(function (g) { return re.test(g.q); }) : [];
  const shownGs = gs.filter(function (g) { return g.shown; });
  const anyShown = (el && vis(el)) || shownGs.length > 0;
  const sel = el && (!anyShown || vis(el)) ? el : null;
  const pool = anyShown ? shownGs : gs;
  if ((sel ? 1 : 0) + pool.length > 1) {
    const c = (sel ? [ident(sel)] : []).concat(pool.map(function (g) { return "radiogroup " + JSON.stringify(clip(g.q, 80)); }));
    return { out: { ok: false, ambiguous: true, error: "several controls matched /" + a.label_pattern + "/i; give a more specific label_pattern", candidates: c.slice(0, 30) } };
  }
  if (sel) return { el: sel };
  if (pool.length) return { group: pool[0] };
  const out = { ok: false, error: "no " + (groups ? "select, combobox or radio group" : "select/combobox") + " matched /" + a.label_pattern + "/i" };
  if (only) out.absent = true;
  return { out: out };
}
function nativeOf(ctl) { return ctl.tagName === "SELECT" ? ctl : (ctl.querySelector && ctl.querySelector("select")) || null; }
// text may be an ordered preference list: a missing or disabled one moves on to
// the next, a tie stops there, and when all miss the first one's error says so.
function pickNative(nat, text) {
  if (unsent(nat)) return unsentOut(nat);
  const prefs = Array.isArray(text) ? text : [text];
  const opts = Array.from(nat.options);
  let first = null;
  for (let i = 0; i < prefs.length; i++) {
    const m = nativeMatch(nat, opts, prefs[i]);
    if (m.opt) return setNative(nat, opts, m.opt, i);
    if (m.out.ambiguous) { if (i) m.out.pref = i; return m.out; }
    if (!first) first = m.out;
  }
  if (Array.isArray(text)) {
    first.tried = prefs;
    if (!first.candidates) first.candidates = opts.slice(0, 30).map(function (o) { return clip(o.text, 60); });
  }
  return first;
}
// -> {opt} or {out}: the one enabled option text names, else why not.
function nativeMatch(nat, opts, text) {
  const w = norm(text);
  const on = function (o) { return !o.disabled && !(o.parentElement && o.parentElement.tagName === "OPTGROUP" && o.parentElement.disabled); };
  // Matching runs over every option so a disabled best match is named, never
  // traded for a weaker enabled one; an enabled twin of equal rank still wins.
  const offOut = function (hits) {
    return { ok: false, el: ident(nat), error: "option " + JSON.stringify(clip(hits[0].text, 60)) + " is disabled in " + ident(nat) + "; the form will not submit it",
      disabled: hits.slice(0, 5).map(function (o) { return clip(o.text, 60); }) };
  };
  const byValue = w ? opts.filter(function (o) { return norm(o.value) === w; }) : [];
  let opt = byValue.filter(on)[0];
  if (!opt && byValue.length) return { out: offOut(byValue) };
  if (!opt) {
    // Several equal hits short of exact are a tie, never settled by length or
    // order; of exact ones (equal once accents fold) the unfolded match goes first.
    const m = matchTier(opts, function (o) { return norm(o.text); }, w);
    const hits = m.hits.filter(on);
    if (m.hits.length && !hits.length) return { out: offOut(m.hits) };
    if (hits.length > 1 && !m.exact) {
      return { out: { ok: false, ambiguous: true, error: "several options matched " + JSON.stringify(String(text)) + " equally; give a more specific text",
        candidates: hits.slice(0, 30).map(function (o) { return clip(o.text, 60); }) } };
    }
    opt = hits.find(function (o) { return norm(o.text) === w; }) || hits[0];
  }
  return opt ? { opt: opt } : { out: { ok: false, error: "no matching option", candidates: opts.slice(0, 30).map(function (o) { return clip(o.text, 60); }) } };
}
function setNative(nat, opts, opt, pref) {
  const prior = nat.selectedIndex;
  // Setting .value selects the first option holding it, so a later twin goes by index.
  if (opts.some(function (o) { return o.index < opt.index && o.value === opt.value; })) {
    const d = Object.getOwnPropertyDescriptor(viewOf(nat).HTMLSelectElement.prototype, "selectedIndex");
    if (d && d.set) d.set.call(nat, opt.index); else nat.selectedIndex = opt.index;
  } else setNativeValue(nat, opt.value);
  fire(nat, ["input", "change"]);
  const shown = nat.options[nat.selectedIndex];
  if (shown === opt) return pref ? { ok: true, selected: clip(opt.text, 80), el: ident(nat), pref: pref } : { ok: true, selected: clip(opt.text, 80), el: ident(nat) };
  const kept = clip(shown ? shown.text : "", 80);
  return { ok: false, el: ident(nat), kept: kept, error: ident(nat) + " kept " + JSON.stringify(kept) + (nat.selectedIndex === prior
    ? " instead of " + JSON.stringify(clip(opt.text, 60)) + "; the page reverted the pick" : "; the page changed the pick to another option") };
}
// What the box shows as a whole, or "" while it shows a placeholder.
function shownWhole(box) { return !box || box.tagName === "INPUT" || box.querySelector("[class*=placeholder], [data-placeholder]") ? "" : norm(textOf(box)); }
`;

// What select's picker steps use beyond the matching that fill_fields shares.
const SELECT_PICK_LIB = String.raw`
// fill may pass an ordered preference list; the first is the one typed as a filter.
const wantL = Array.isArray(A.text) ? A.text.map(norm) : [norm(A.text)];
const wantN = wantL[0];
const wantT = String(Array.isArray(A.text) ? A.text[0] : A.text);
const OPT = "[role=option], [cmdk-item]";
const press = function (el) {
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (t) {
    const C = t.indexOf("pointer") === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new C(t, { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window }));
  });
};
// Presses target, then focuses el if the press didn't. A background tab moves
// focus but fires no focus event, and widgets that track focus from that event
// (react-select) then never open, so one is sent when none came.
const pressFocus = function (target, el) {
  const was = document.activeElement;
  let fired = false;
  const on = function () { fired = true; };
  el.addEventListener("focus", on);
  press(target);
  if (document.activeElement !== el && el.focus) el.focus();
  el.removeEventListener("focus", on);
  if (fired || was === el || document.activeElement !== el) return;
  el.dispatchEvent(new FocusEvent("focus"));
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
};
const pressEscape = function (el) { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true })); };
function mine(s, el) { return [s.ctl, s.input, s.box].some(function (m) { return m && (m === el || m.contains(el) || el.contains(m)); }); }
// cmdk writes data-disabled="false" on enabled items; Radix marks disabled ones with a bare data-disabled.
function optOff(o) { const d = o.getAttribute("data-disabled"); return attr(o, "aria-disabled") === "true" || d === "" || d === "true"; }
// The elements a control shows as chosen, each with its own text (a chip, a value
// span), never a placeholder or an icon.
function shownEls(box) {
  if (!box || box.tagName === "INPUT") return [];
  return [box].concat(Array.from(box.querySelectorAll("*"))).filter(function (el) {
    return !el.closest("svg, [class*=placeholder], [data-placeholder]") && vis(el) && ownText(el);
  });
}
function ownText(el) { return clip(Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return n.nodeValue; }).join(""), 80); }
function shownParts(box) {
  const out = [];
  shownEls(box).forEach(function (el) { const t = ownText(el); if (out.indexOf(t) < 0) out.push(t); });
  return out;
}
function commaParts(t) { return String(t || "").split(/[,;\n]/).map(function (x) { return norm(x); }).filter(Boolean); }
// A class word (split at -, _ and camelCase) naming a chip: badge, chip, tag, multi-value.
function chipLike(el) {
  return String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className || "").split(/\s+/).some(function (c) {
    const w = c.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[-_ ]+/);
    return w.some(function (x) { return /^(badge|chip|tag)$/.test(x); }) || w.join(" ").indexOf("multi value") >= 0;
  });
}
// Two or more value elements that are chips, or alike in tag and class under one
// parent; a label (text ending in ":", or the control's own label) is no value.
function multiBox(box, label) {
  if (!box || box.tagName === "INPUT") return false;
  const vals = shownEls(box).filter(function (el) { const t = norm(ownText(el)); return el !== box && !/:$/.test(t) && t !== norm(label); });
  if (vals.filter(chipLike).length > 1) return true;
  const seen = new Map();
  return vals.some(function (el) {
    const k = el.tagName + "." + el.className;
    const sibs = seen.get(el.parentElement) || [];
    if (sibs.indexOf(k) >= 0) return true;
    sibs.push(k); seen.set(el.parentElement, sibs);
    return false;
  });
}
function isMulti(s, opt) {
  return !!(s.multiBox || attr(s.ctl, "aria-multiselectable") === "true" || (opt && opt.closest("[aria-multiselectable=true]")) ||
    linkedLists(s).some(function (m) { return attr(m, "aria-multiselectable") === "true"; }));
}
// A picked item that already shows as chosen; pressing it again would toggle it off.
// A multi-select shows each choice apart; a single one shows the whole value.
function chosenAlready(s, opt, key) {
  if (attr(opt, "aria-checked") === "true" || attr(opt, "data-state") === "checked") return true;
  if (!s.multi) return (!!s.whole && s.whole === key) || (s.shown || []).some(function (t) { return norm(t) === key; });
  return (s.shown || []).some(function (t) { return norm(t) === key; }) || commaParts(s.whole).indexOf(key) >= 0;
}
// A list still loading, visible on or inside one of roots: aria-busy, a
// progressbar, a loading or spinner class, a Tailwind animate-spin or
// animate-pulse class word, text starting Loading/Searching/Fetching (an
// aria-live region's whole text too), or a role=status that is neither a
// no-results notice nor a live count ("3 results available"). A status asking
// for more characters counts as loading, since a debounced search may still
// replace it. Only elements that can carry a signal are queried, since a root
// may be a whole dialog.
function loadingIn(roots) {
  const none = /^(no (results?|options?|match(es|ing)?|items?|suggestions?)|nothing (found|matche[sd])|0 (results?|options?|matches|items?)|not found)\b/i;
  const count = /^\d+ (results?|options?|suggestions?|items?) (are )?available\b/i, word = /^(loading|searching|fetching)\b/i;
  const SIGNS = "[aria-busy=true], [role=progressbar], [role=status], [aria-live], [class*=load], [class*=spin], [class*=animate-]";
  const busy = function (e) {
    const cls = String(e.className && e.className.baseVal != null ? e.className.baseVal : e.className || "");
    const st = attr(e, "role") === "status" ? norm(textOf(e)) : "";
    return (attr(e, "aria-busy") === "true" || attr(e, "role") === "progressbar" || (st && !none.test(st) && !count.test(st)) ||
      /loading|spinner/i.test(cls) || cls.split(/\s+/).some(function (c) { return /^animate-(spin|pulse)$/.test(c.split(":").pop()); }) ||
      (e.hasAttribute("aria-live") && word.test(norm(textOf(e))))) && vis(e);
  };
  const said = function (r) {
    if (!/loading|searching|fetching/i.test(r.textContent)) return false;
    const w = document.createTreeWalker(r, 4);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (word.test(norm(n.nodeValue)) && vis(n.parentElement)) return true;
    return false;
  };
  return roots.some(function (r) {
    return !!r && r.isConnected && ((r.matches && r.matches(SIGNS) && busy(r)) || Array.prototype.some.call(r.querySelectorAll(SIGNS), busy) || said(r));
  });
}
// Still open: the control says so, or its own list still shows options.
function stillOpen(s) {
  return [s.ctl, s.input].some(function (e) { return attr(e, "aria-expanded") === "true"; }) || ownOptions(s).length > 0;
}
// Escape inside the open popup, where its own key handler listens (a document-level
// one hears it too): the focused element there, else its search box, else the control.
function escapeOwn(s) {
  const a = document.activeElement;
  const inPop = a && (linkedLists(s).some(function (m) { return m.contains(a); }) || (s.pop && s.pop.contains(a)));
  pressEscape(inPop ? a : s.filter && s.filter.isConnected ? s.filter : s.input || s.ctl);
}
// The lists a control names as its own: aria-controls/aria-owns targets, and
// react-select's listbox, whose id derives from its input id.
function linkedLists(s) {
  let ids = [];
  [s.ctl, s.input, s.box].forEach(function (el) { if (el) ids = ids.concat((attr(el, "aria-controls") + " " + attr(el, "aria-owns")).split(/\s+/)); });
  const rs = s.input && /^(react-select-.+)-input$/.exec(s.input.id);
  if (rs) ids.push(rs[1] + "-listbox");
  return ids.map(function (id, i) { return id && ids.indexOf(id) === i && byIdNear(id, s.input || s.ctl); }).filter(function (m) { return m && !mine(s, m); });
}
// Separate React roots can repeat an id; take the copy that shares the deepest
// ancestor with the control.
function byIdNear(id, near) {
  let all;
  try { all = document.querySelectorAll(typeof CSS !== "undefined" && CSS.escape ? "#" + CSS.escape(id) : '[id="' + id.replace(/["\\]/g, "\\$&") + '"]'); }
  catch (e) { all = Array.prototype.filter.call(document.querySelectorAll("[id]"), function (m) { return m.id === id; }); }
  if (all.length < 2 || !near) return document.getElementById(id);
  let best = null, depth = -1;
  Array.prototype.forEach.call(all, function (m) {
    let a = m.parentElement, d = 0;
    while (a && !a.contains(near)) a = a.parentElement;
    for (let p = a; p; p = p.parentElement) d++;
    if (d > depth) { depth = d; best = m; }
  });
  return best;
}
// The control's own options: its linked lists, else a list beside it in a wrapper
// that holds no other control, else options that appeared after select opened it.
// Never the rest of the page. Sets s.filter to a search box inside a linked popup.
function ownOptions(s) {
  const within = function (root) { return Array.from(root.querySelectorAll(OPT)).filter(vis); };
  if (attr(s.ctl, "role") === "listbox") return within(s.ctl);
  const lists = linkedLists(s);
  if (lists.length) {
    const opts = lists.reduce(function (out, m) { return out.concat(m.matches(OPT) ? [m] : within(m)); }, []);
    lists.forEach(function (m) { if (!s.input && !s.filter) s.filter = popSearch(m, lists, opts); });
    return opts;
  }
  const rs = s.input && /^(react-select-.+)-input$/.exec(s.input.id);
  if (rs) {
    const byId = within(document).filter(function (o) { return o.id.indexOf(rs[1] + "-option-") === 0; });
    if (byId.length) return byId;
  }
  for (let p = s.box.parentElement, i = 0; p && p !== document.body && i < 3; p = p.parentElement, i++) {
    const others = Array.from(p.querySelectorAll("select, input:not([type=hidden]), [role=combobox], [aria-haspopup]")).some(function (c) { return !mine(s, c) && !c.closest(OPT); });
    if (others) break;
    const o = within(p).filter(function (x) { return !mine(s, x); });
    if (o.length) return o;
  }
  if (!s.opened) return [];
  const fresh = within(document).filter(function (o) { return s.before.indexOf(o) < 0; });
  if (fresh.length && !s.pop) s.pop = fresh[0].closest("[data-radix-popper-content-wrapper], [cmdk-root], [role=dialog]");
  if (s.pop && !s.input && !s.filter) s.filter = popSearch(s.pop, [], fresh);
  return fresh;
}
// A popup's own search box, empty: cmdk's, one inside a Radix popper or cmdk root,
// or a combobox/searchbox naming the list select picks from (one of lists, or one
// holding opts). Never another field of a form.
function popSearch(root, lists, opts) {
  return Array.from(root.querySelectorAll("input")).find(function (i) {
    if (i.value || !vis(i)) return false;
    if (i.matches("[cmdk-input]") || i.closest("[data-radix-popper-content-wrapper], [cmdk-root]")) return true;
    if (!/^(combobox|searchbox)$/.test(attr(i, "role"))) return false;
    return attr(i, "aria-controls").split(/\s+/).some(function (id) {
      const m = id && document.getElementById(id);
      return m && (lists.indexOf(m) >= 0 || opts.some(function (o) { return m === o || m.contains(o); }));
    });
  }) || null;
}
`;

// Sets a checkbox, radio, or ARIA checkbox/radio/switch to a state through
// el.click(), so page handlers (React's included) run as for a user click.
const CHECK_LIB = String.raw`
const CHECKABLE = "input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch], [role=menuitemcheckbox]";
function isOn(el) { return el.tagName === "INPUT" ? !!el.checked : attr(el, "aria-checked") === "true"; }
// A box wholly above or left of the document that no visible, on-page label
// names (an sr-only input sits off-page under a label people see), or one
// trapLike flags. honeypot() leaves checkboxes and radios to this.
function offDoc(el) {
  const r = el.getBoundingClientRect(), v = viewOf(el);
  return !!(r.width || r.height) && (r.right + (v.scrollX || 0) <= 0 || r.bottom + (v.scrollY || 0) <= 0);
}
function checkTrap(el) {
  if (trapLike(el)) return true;
  if (!offDoc(el)) return false;
  const ls = Array.from(el.labels || []).concat(el.closest("label") || []);
  return !ls.some(labelSeen);
}
// A checkbox or radio hidden under a visible, on-page <label> it names: a styled
// box (display:none input, the label draws it), clicked like a shown one.
// Never an untabbable or aria-hidden input, nor one whose label is hidden,
// off-page, shrunk or clipped to a pixel, or under an ancestor faded to 0.
function labelSeen(l) {
  if (!vis(l) || offDoc(l) || l.closest("[aria-hidden=true]")) return false;
  const r = l.getBoundingClientRect();
  if (r.width <= 1 || r.height <= 1) return false;
  const m = /rect\(([-\d.]+)px,?\s*([-\d.]+)px,?\s*([-\d.]+)px,?\s*([-\d.]+)px/.exec(getComputedStyle(l).clip || "");
  if (m && (m[2] - m[4] <= 1 || m[3] - m[1] <= 1)) return false;
  for (let p = l.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) if (getComputedStyle(p).opacity === "0") return false;
  return true;
}
function labelShown(el) {
  if (el.tagName !== "INPUT" || !/^(checkbox|radio)$/i.test(el.type || "")) return false;
  if (untabbable(el) || el.closest("[aria-hidden=true]")) return false;
  return Array.prototype.some.call(el.labels || [], labelSeen);
}
// Best-named boxes for a.label_pattern: nameTier over accName, then over the
// hint one tier group lower; a box wrapping another hit is that same hit.
function checkByLabel(a, only) {
  const pat = "/" + a.label_pattern + "/i";
  const whole = new RegExp("^(?:" + a.label_pattern + ")$", "i"), re = new RegExp(a.label_pattern, "gi");
  const tierOf = function (x) {
    const t = nameTier(whole, re, accName(x));
    if (t < 3) return t;
    const h = hintText(x);
    return h ? 3 + nameTier(whole, re, h) : 6;
  };
  const rank = function (pool) {
    let tier = 6, hits = [];
    pool.forEach(function (x) { const t = tierOf(x); if (t < tier) { tier = t; hits = [x]; } else if (t === tier && t < 6) hits.push(x); });
    return hits.filter(function (x) { return !hits.some(function (o) { return o !== x && x.contains(o); }); });
  };
  const all = Array.from(document.querySelectorAll(CHECKABLE));
  const real = all.filter(function (x) { return !checkTrap(x); });
  const shown = rank(real.filter(function (x) { return fieldVis(x) || labelShown(x); }));
  if (shown.length === 1) return { el: shown[0] };
  if (shown.length > 1) {
    const candidates = shown.slice(0, 8).map(ident);
    return { out: only ? { ok: true, skipped: "ambiguous", candidates: candidates } : { ok: false, ambiguous: true, error: "several checkboxes/radios matched " + pat + " equally; narrow it, or use a selector or ref", candidates: candidates } };
  }
  if (only) {
    const trap = rank(all.filter(checkTrap))[0];
    return { out: !rank(real).length && trap ? { ok: true, skipped: "trap", el: ident(trap) } : { ok: true, skipped: "absent" } };
  }
  const hidden = rank(real)[0];
  if (hidden) { const id = ident(hidden); return { out: { ok: false, el: id, error: id + " matched " + pat + " but is hidden; use ref or selector if it is the one" } }; }
  const trap = rank(all.filter(checkTrap))[0];
  if (trap) { const id = ident(trap); return { out: { ok: false, el: id, error: id + " matched " + pat + " but it looks like a bot trap; leave it unchecked" } }; }
  return { out: { ok: false, error: "no checkbox/radio matched " + pat } };
}
// onLand(el) hears of a box that ends in the wanted state.
function checkOne(a, only, onLand) {
  const r = a.ref || a.selector ? resolveEl(a) : checkByLabel(a, only);
  if (r.out) return r.out;
  const el = r.el;
  if (!el.matches(CHECKABLE)) return { ok: false, error: ident(el) + " is not a checkbox or radio" };
  if (isDisabled(el) || el.closest("fieldset[disabled]")) return only ? { ok: true, kind: "check", el: ident(el), skipped: "disabled" } : { ok: false, kind: "check", el: ident(el), error: ident(el) + " is disabled; the form will not submit it" };
  const want = !!a.checked;
  const out = { ok: true, kind: "check", el: ident(el), checked: want };
  if (isOn(el) !== want) {
    if (!want && role(el) === "radio") return { ok: false, kind: "check", el: out.el, error: "a radio can't be unchecked; check another option" };
    el.click();
    if (isOn(el) !== want) return { ok: false, kind: "check", el: out.el, error: "state did not change after click", checked: isOn(el) };
  }
  if (onLand) onLand(el);
  return out;
}
// Radio groups, each asked by a question: a [role=radiogroup] (its accessible
// name), else a same-name radio set in one form (a fieldset legend or an
// aria-label(ledby) on an ancestor holding no other group's radios, else the
// nearest question text before it that is neither a control nor an option).
const RADIO_OPT = "input[type=radio], [role=radio]";
function radioGroups() {
  const out = [], taken = new Set(), sets = [];
  const outermost = function (opts) { return opts.filter(function (o) { return !opts.some(function (p) { return p !== o && p.contains(o); }); }); };
  Array.from(document.querySelectorAll("[role=radiogroup]")).forEach(function (box) {
    const opts = outermost(Array.from(box.querySelectorAll(RADIO_OPT)).filter(function (o) { return !taken.has(o); }));
    box.querySelectorAll(RADIO_OPT).forEach(function (o) { taken.add(o); });
    if (opts.length) out.push(radioGroup(box, opts));
  });
  Array.from(document.querySelectorAll("input[type=radio]")).forEach(function (r) {
    if (taken.has(r)) return;
    const scope = r.name ? r.form || document : r.closest("fieldset") || r;
    let s = sets.find(function (x) { return x.name === r.name && x.scope === scope; });
    if (!s) sets.push(s = { name: r.name, scope: scope, opts: [] });
    s.opts.push(r);
  });
  sets.forEach(function (s) {
    let box = s.opts[0].parentElement;
    while (box && !s.opts.every(function (o) { return box.contains(o); })) box = box.parentElement;
    out.push(radioGroup(box || document.body, s.opts));
  });
  return out;
}
function radioGroup(box, opts) {
  const names = opts.map(optName);
  const shown = opts.some(function (o) { return vis(o) || Array.from(o.labels || []).concat(o.closest("label") || []).some(vis); });
  return { box: box, opts: opts, names: names, shown: shown, q: groupQuestion(box, opts) };
}
function optName(o) {
  if (o.tagName !== "INPUT") return accName(o);
  const l = labelText(o);
  if (l) return l;
  const n = o.nextSibling;
  const t = !n ? "" : n.nodeType === 3 ? n.nodeValue : n.nodeType === 1 && !n.matches(FIELD_CTL) && !n.querySelector(FIELD_CTL) ? textOf(n) : "";
  return clip(t || o.value, 120);
}
function groupQuestion(box, opts) {
  const others = function (n) { return Array.prototype.some.call(n.querySelectorAll(RADIO_OPT), function (r) { return opts.indexOf(r) < 0 && !opts.some(function (o) { return o.contains(r); }); }); };
  for (let n = box, up = 0; n && up < 4 && n !== document.body && !others(n); n = n.parentElement, up++) {
    if (attr(n, "aria-labelledby") || attr(n, "aria-label")) { const t = labelText(n); if (t) return t; }
    if (n.tagName === "FIELDSET") {
      const lg = Array.prototype.find.call(n.children, function (c) { return c.tagName === "LEGEND"; });
      if (lg && textOf(lg).trim()) return clip(textOf(lg), 120);
    }
    if (n.tagName === "FORM") break;
  }
  const isOpt = function (el) {
    const f = el.tagName === "LABEL" && attr(el, "for") && document.getElementById(attr(el, "for"));
    return opts.some(function (o) { return el === o || el.contains(o) || f === o; });
  };
  let n = opts[0];
  while (n.parentElement && n.parentElement !== box) n = n.parentElement;
  for (let up = 0; n && up < 4 && !/^(FIELDSET|FORM|BODY)$/.test(n.tagName); up++, n = n.parentElement) {
    let sib = n.previousElementSibling;
    for (let k = 0; sib && k < 3; sib = sib.previousElementSibling) {
      if (isOpt(sib)) continue;
      k++;
      if (sib.matches(FIELD_CTL) || sib.querySelector(FIELD_CTL)) return "";
      if (!vis(sib)) continue;
      const t = sibText(sib);
      if (t) return t;
    }
  }
  return "";
}
// The group el is an option of, or the box of.
function groupOf(el, gs) {
  return gs.find(function (g) { return g.box === el || g.opts.some(function (o) { return o === el || o.contains(el); }); }) || null;
}
// Picks by select's match tiers, through the option's own click so page
// handlers run, then reads back which option the group shows checked.
// A preference list is tried in order before anything is clicked; a tie stops.
function pickRadio(g, text) {
  const el = "radiogroup " + JSON.stringify(clip(g.q, 80));
  const prefs = Array.isArray(text) ? text : [text];
  let m = null, p = 0;
  for (; p < prefs.length; p++) {
    m = matchTier(g.opts.map(function (o, i) { return i; }), function (i) { return norm(g.names[i]); }, norm(prefs[p]));
    if (m.hits.length) break;
  }
  if (p === prefs.length) p = 0;
  if (m.hits.length !== 1) {
    const out = { ok: false, kind: "radio", el: el, error: m.hits.length ? "several options matched " + JSON.stringify(String(prefs[p])) + " equally; give a more specific text" : "no matching option" };
    if (m.hits.length) out.ambiguous = true;
    if (m.hits.length && p) out.pref = p;
    out.candidates = g.names.slice(0, 30).map(function (n) { return clip(n, 60); });
    if (!m.hits.length && Array.isArray(text)) out.tried = prefs;
    return out;
  }
  const i = m.hits[0], o = g.opts[i];
  if (!isOn(o)) o.click();
  const on = g.opts.filter(isOn);
  if (on.length === 1 && on[0] === o) return p ? { ok: true, kind: "radio", selected: clip(g.names[i], 80), el: el, pref: p } : { ok: true, kind: "radio", selected: clip(g.names[i], 80), el: el };
  return { ok: false, kind: "radio", el: el, error: "clicked " + JSON.stringify(clip(g.names[i], 80)) + " but it did not stick; the group reverted it",
    selected: on.length ? clip(g.names[g.opts.indexOf(on[0])], 80) : null };
}
`;

// A typeahead keeps only a picked suggestion, often mirrored into a hidden
// input: typed text alone is cleared on blur or rejected on submit. fill types,
// then fill_ta_pick / fill_ta_read run polled from JXA, as select's phases do.
const TA_BOX_LIB = String.raw`
// The widget's own box: the highest ancestor (below the form) holding no other control.
function taRoot(el) {
  let root = el;
  for (let p = el.parentElement, i = 0; p && i < 4 && p.tagName !== "FORM" && p !== el.ownerDocument.body; p = p.parentElement, i++) {
    const others = Array.from(p.querySelectorAll("input:not([type=hidden]), select, textarea, button, [role=combobox]")).filter(function (x) { return x !== el; });
    if (others.length) break;
    root = p;
  }
  return root;
}
// A styled select's wrapper box (react-select and kin: "x__control", "x-control").
const ctlOf = function (el) { return el.parentElement && el.parentElement.closest('[class*="__control"], [class*="-control"]'); };
// What such a box shows as picked, unclipped: its single value (marked single), else its chips' labels.
function ctlParts(el) {
  const c = ctlOf(el);
  if (!c) return [];
  const sv = c.querySelector('[class*="single-value"], [class*="singleValue"]');
  if (sv) { const one = [textOf(sv)]; one.single = true; return one; }
  let chips = c.querySelectorAll('[class*="multi-value__label"], [class*="multiValue__label"]');
  if (!chips.length) chips = c.querySelectorAll('[class*="multi-value"]:not([class*="__"]), [class*="multiValue"]:not([class*="__"])');
  return Array.prototype.map.call(chips, textOf);
}
function shownValue(el) {
  const p = ctlParts(el);
  return p.single ? clip(p[0], 200) : clip(p.map(function (x) { return clip(x, 60); }).filter(Boolean).join(", "), 200);
}
const TA_POP = "[class*=dropdown], [class*=autocomplete], [class*=suggest], [class*=typeahead], [class*=menu], [role=listbox]";
function taParts(el) {
  const root = taRoot(el);
  return { comp: root === el ? null : root.querySelector("input[type=hidden]"), pop: root === el ? null : root.querySelector(TA_POP) };
}
function isTypeahead(el) {
  if (el.tagName !== "INPUT" || (el.type || "text").toLowerCase() !== "text" || /^(tel|numeric|decimal|email)$/.test(attr(el, "inputmode"))) return false;
  if (el.closest("[role=search]") || el.name === "q" || /search|query/i.test(el.name + " " + el.id + " " + attr(el, "placeholder"))) return false;
  if (role(el) === "combobox" || /^(list|both)$/.test(attr(el, "aria-autocomplete"))) return true;
  const t = taParts(el);
  return !!(t.comp && t.pop);
}
`;
// What a form still wants, for the snapshot header and fill {fields}' result.
const CENSUS_LIB = String.raw`
// vis(), plus inputs a stylesheet shrinks or fades to nothing while their
// widget stays on screen: a radio or checkbox behind its visible label, and a
// combobox input inside a visible select box (hidden after a pick, or a dummy).
function snapVis(el) {
  if (vis(el)) return true;
  if (el.tagName !== "INPUT" || el.hidden) return false;
  const t = (el.type || "").toLowerCase();
  const tick = t === "radio" || t === "checkbox";
  if (!tick && attr(el, "role") !== "combobox") return false;
  if (getComputedStyle(el).visibility === "hidden") return false;
  for (let p = el; p; p = p.parentElement) if (getComputedStyle(p).display === "none") return false;
  if (!tick) { const c = ctlOf(el); return !!c && vis(c); }
  const ls = el.labels ? Array.from(el.labels) : [];
  const wrap = el.closest("label");
  if (wrap) ls.push(wrap);
  return ls.some(vis);
}
// Typed text a typeahead has not taken: the hidden input in its own box, where
// a pick lands, is still empty.
function unpicked(el) {
  if (el.readOnly || !isTypeahead(el) || !el.value.trim() || !snapVis(el)) return false;
  const c = taParts(el).comp;
  return !!c && !c.value;
}
const FIELDS = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
function reqEmpty(el) {
  if (!el.required && attr(el, "aria-required") !== "true") return false;
  if (String(el.value || el.textContent || "").trim()) return unpicked(el);
  return !(el.tagName === "INPUT" && attr(el, "role") === "combobox" && shownValue(el));
}
// A file input is a field to fill too (through file_upload). An input that is
// both aria-hidden and out of the tab order is a widget's stand-in for native
// validation (react-select's required input), not a field of its own.
function census(f) {
  const fields = Array.from(f.querySelectorAll(FIELDS)).filter(function (el) {
    const t = (el.type || "text").toLowerCase();
    if (el.tagName === "INPUT" && t !== "file" && INPUT_SKIP.indexOf(t) >= 0) return false;
    return !(t !== "file" && attr(el, "aria-hidden") === "true" && attr(el, "tabindex") === "-1");
  });
  return { fields: fields, loose: fields.filter(unpicked), empty: fields.filter(reqEmpty) };
}
`;
const TYPEAHEAD_LIB = TA_BOX_LIB + String.raw`
// Typed with input events and no blur, so the widget runs its own lookup.
function taType(el, text) {
  if (el.focus) el.focus();
  setNativeValue(el, text);
  const key = text.slice(-1);
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: key }));
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: key }));
}
`;

// A typeahead's shown text and blur, for the scripts that read back or leave a pick.
const TA_UI_LIB = String.raw`
const taNorm = function (s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); };
// What the field shows: its text, else (an emptied react-select input) its
// control box's single value, else the box's whole text.
function taShown(el) {
  if (el.value) return el.value;
  const ctl = el.closest('.select__control, [class*="-control"], [class*="__control"]');
  return ctl ? shownValue(el) || textOf(ctl) : "";
}
// A background tab's blur() fires no events, so send them when the page lacks focus.
function taBlur(el) {
  const had = el.ownerDocument.activeElement === el;
  if (had) el.blur();
  if (!had || !el.ownerDocument.hasFocus()) { el.dispatchEvent(new FocusEvent("blur")); el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }
}
`;

// The typeahead's suggestions come only from its own lists (select's rule), else
// its box's popup; never the rest of the page, so an empty list means keep waiting.
const TA_PICK_LIB = TYPEAHEAD_LIB + TA_UI_LIB + SELECT_LIB + SELECT_PICK_LIB + String.raw`
function taScopes(s) {
  const own = linkedLists({ ctl: s.el, input: s.el, box: s.el });
  return own.length ? own : s.pop ? [s.pop] : [];
}
function taOptions(s) {
  const ITEM = "[role=option], li, [class*=option], [class*=item], [class*=result]";
  const shown = function (o) { return vis(o) && taNorm(o.textContent); };
  return taScopes(s).reduce(function (out, scope) {
    let opts = scope.matches("[role=option]") ? [scope] : Array.from(scope.querySelectorAll("[role=option]"));
    if (!opts.length) {
      opts = Array.from(scope.querySelectorAll(ITEM)).filter(function (o) { return !o.querySelector(ITEM); }).filter(shown);
      // A lone match can be the results wrapper ("results" in its class) around
      // plain item elements: its repeated children are the suggestions.
      const kids = opts.length === 1 ? Array.from(opts[0].children).filter(shown) : [];
      const texts = kids.map(function (k) { return taNorm(k.textContent); });
      if (kids.length > 1 && texts.every(function (t, i) { return texts.indexOf(t) === i; }) &&
          !opts[0].querySelector("input, select, textarea, button")) opts = kids;
    }
    return out.concat(opts.filter(shown));
  }, []);
}
// The options best matching text, most specific tier first: exact; each typed
// comma part equal to one of the option's parts, in order; a prefix of the whole
// option; a prefix of one of its words; every typed word whole and in order.
// Accents fold. -> {hits, exact}
function taMatch(opts, text) {
  const w = fold(taNorm(text));
  const parts = function (t) { return t.split(",").map(function (p) { return p.trim(); }).filter(Boolean); };
  const wp = parts(w), ws = wordsOf(w);
  const pre = new RegExp("(?:^|[^\\p{L}\\p{N}])" + reEsc(w), "u");
  const tiers = [function (t) { return t === w; }, function (t) { return inOrder(parts(t), wp); }, function (t) { return t.indexOf(w) === 0; },
    function (t) { return pre.test(t); }, function (t) { return inOrder(wordsOf(t), ws); }];
  const keys = w ? opts.map(function (o) { return fold(taNorm(o.textContent)); }) : [];
  if (w) for (let i = 0; i < tiers.length; i++) {
    const hits = opts.filter(function (o, j) { return tiers[i](keys[j]); });
    if (hits.length) return { hits: hits, exact: i === 0 };
  }
  return { hits: [], exact: false };
}
// What an emptied control box shows, folded as pickedN is: its value or each
// chip, else its whole text. chips: a multi-value box.
function taOwn(el) {
  const p = ctlParts(el);
  const ctl = el.closest('.select__control, [class*="-control"], [class*="__control"]');
  const out = (p.length ? p : [ctl ? textOf(ctl) : ""]).map(function (t) { return fold(taNorm(t)); });
  out.chips = p.length > 0 && !p.single;
  return out;
}
`;

// Embedded frames big enough to hold a form: visible iframes of at least
// 200x150 CSS px, in the page and (up to 3 frames deep) inside listed
// same-origin frames, largest first, at most 5, as {f, src, w, h, same, in, p}.
// src keeps only an http(s) URL's origin and path; same says page JS can read
// the frame's document (a cross-origin frame's reads null or throws); a nested
// entry's p is its parent entry and in that entry's index. A nested entry whose
// parent the cap cut is dropped, so in always names a listed entry.
const EMBED_LIB = String.raw`
function embeds() {
  const all = [];
  (function scan(doc, parent, depth) {
    for (const f of doc.getElementsByTagName("iframe")) {
      if (!vis(f)) continue;
      const r = f.getBoundingClientRect();
      if (r.width < 200 || r.height < 150) continue;
      let cd = null;
      try { cd = f.contentDocument; } catch (e) {}
      let src = f.hasAttribute("srcdoc") ? "about:srcdoc" : String(f.src || "about:blank");
      try { const u = new URL(src); if (/^https?:$/.test(u.protocol)) src = u.origin + u.pathname; } catch (e) {}
      const e = { f: f, src: clip(src, 150), w: Math.round(r.width), h: Math.round(r.height), same: !!cd, p: parent };
      all.push(e);
      if (cd && depth < 3) scan(cd, e, depth + 1);
    }
  })(document, null, 1);
  const cut = all.sort(function (a, b) { return b.w * b.h - a.w * a.h; }).slice(0, 5);
  const out = cut.filter(function (e) { for (let p = e.p; p; p = p.p) if (cut.indexOf(p) < 0) return false; return true; });
  out.forEach(function (e) { if (e.p) e.in = out.indexOf(e.p); });
  return out;
}
// For fill's label miss: where the field may live instead. The largest listed
// frame that is cross-origin or whose document holds a field (hasField): a
// fieldless same-origin wrapper never is.
function frameHint(hasField) {
  const list = embeds();
  const i = list.findIndex(function (e) { return !e.same || hasField(e.f.contentDocument); });
  if (i < 0) return "";
  const e = list[i];
  return e.same ? "; the page embeds a same-origin form frame: accessibility_snapshot lists its fields (frame=" + i + "); fill them by ref"
    : "; the page embeds a form frame at " + e.src + ": navigate or new_tab there";
}
`;

const FILL_LIB = TYPEAHEAD_LIB + EMBED_LIB + String.raw`
// Up to 2 visible, enabled buttons that may reveal a field fill found no match
// for, as ident-style lines under the name click {label_pattern} matches: named
// by re themselves, else sitting in a section whose question text matches
// (nearText, or an ancestor up to 4 levels, never the whole form). Submit-bar
// buttons are never listed. Among section matches, names that suggest typing
// ("Enter manually", "Write") come before attach/upload ones.
function revealers(re, nearHit) {
  const found = [];
  // A section ends below the page's main region and any ancestor holding a form
  // or more than 5 fields: text there names the whole page, not one field.
  const wide = new Map();
  const outside = function (p) {
    if (!wide.has(p)) {
      wide.set(p, /^(FORM|MAIN|BODY|HTML)$/.test(p.tagName) || attr(p, "role") === "main" || !!p.querySelector("form") ||
        p.querySelectorAll("input:not([type=hidden]), textarea, select, [contenteditable]").length > 5);
    }
    return wide.get(p);
  };
  Array.prototype.forEach.call(document.querySelectorAll("button, [role=button], a[href], input[type=button]"), function (el, i) {
    if (!vis(el) || isDisabled(el) || attr(el, "type").toLowerCase() === "submit") return;
    const name = accName(el);
    if (!name || REVEAL_SKIP.test(name)) return;
    let tier = re.test(name) ? 0 : re.test(nearText(el)) ? 1 : -1;
    for (let p = el.parentElement, d = 0; tier < 0 && d < 4 && p && !outside(p); d++, p = p.parentElement) if (nearHit(p)) tier = 1;
    if (tier < 0) return;
    found.push({ line: role(el) + " " + JSON.stringify(clip(name, 40)), rank: [tier, tier && !REVEAL_TYPING.test(name) ? 1 : 0, i] });
  });
  found.sort(function (x, y) { return x.rank[0] - y.rank[0] || x.rank[1] - y.rank[1] || x.rank[2] - y.rank[2]; });
  return found.slice(0, 2).map(function (f) { return f.line; });
}
// Masks reformat or drop a country code, so digits also count when one ends the other.
function sameNumber(s, text) {
  const d = String(s || "").replace(/\D/g, ""), t = String(text || "").replace(/\D/g, "");
  return d.length >= 7 && t.length >= 7 && (t.slice(-d.length) === d || d.slice(-t.length) === t);
}
// Whether v still holds text as setPlain accepts it on the first read.
function holdsText(v, text) {
  const norm = function (s) { return String(s || "").trim().replace(/\s+/g, " "); };
  return norm(v).indexOf(norm(text)) >= 0 || sameNumber(v, text);
}
// -> fill's result for one field {ref|selector|label_pattern, text}. only:
// write nothing to a field that is absent, a trap, ambiguous or already set.
// onLand(el, rich) hears of each field or editor root that took the text.
function fillOne(a, only, onLand) {
  const text = a.text;
  // Compare non-whitespace counts: rich editors normalize whitespace on the way in.
  const want = Math.floor(text.replace(/\s/g, "").length * 0.9);
  const sameNum = function (s) { return sameNumber(s, text); };
  const landed = function (s) {
    if (text === "") return String(s || "").trim() === "";
    return String(s || "").replace(/\s/g, "").length >= want || sameNum(s);
  };
  const isField = function (el) { return el.tagName === "TEXTAREA" || el.tagName === "INPUT"; };
  function isRich(el) {
    return !!el && (editable(el) || !!(el.classList && (el.classList.contains("fr-element") || el.classList.contains("ql-editor") || el.classList.contains("ProseMirror"))));
  }
  // Input types whose value the browser sanitizes on set: only the exact value
  // counts, and a miss names the format the type accepts.
  const FORMATS = { date: "YYYY-MM-DD", time: "HH:MM", "datetime-local": "YYYY-MM-DDTHH:MM", month: "YYYY-MM", week: "YYYY-Www", color: "#rrggbb", number: "", range: "" };
  const noSeconds = function (s) { return s.replace(/^(.*\d\d:\d\d):00(\.0+)?$/, "$1"); };
  function exact(t, v) {
    if (t === "number" && text === "" && v === "") return true;
    if (t === "number" || t === "range") return v.trim() !== "" && Number(v) === Number(text);
    if (t === "time" || t === "datetime-local") return noSeconds(v) === noSeconds(text);
    if (t === "color") return v.toLowerCase() === text.toLowerCase();
    return v === text;
  }
  function format(el, t) {
    if (FORMATS[t]) return FORMATS[t];
    let f = "a number";
    const lo = attr(el, "min"), hi = attr(el, "max"), step = attr(el, "step");
    if (lo && hi) f += " between " + lo + " and " + hi;
    else if (lo) f += " of at least " + lo;
    else if (hi) f += " of at most " + hi;
    if (step && step !== "any") f += " in steps of " + step;
    return f;
  }
  // -> true, false (not landed), or a miss result for a sanitizing type or a revert.
  function setPlain(el) {
    const prior = el.value;
    setNativeValue(el, text);
    fire(el, ["input", "change", "blur"]);
    const t = el.tagName === "INPUT" ? (el.type || "text").toLowerCase() : "";
    if (!Object.prototype.hasOwnProperty.call(FORMATS, t)) {
      const v = el.value;
      if (text === "") return v === "";
      const norm = function (s) { return s.trim().replace(/\s+/g, " "); };
      if (norm(v).indexOf(norm(text)) >= 0) return true;
      // Length and digit-suffix checks can't tell a revert from a landed value.
      if (v !== prior) return landed(v);
      // A mask that puts back the number it held, in its own format, holds the text.
      if (sameNum(v)) return true;
      return { ok: false, el: ident(el), kept: clip(v, 60), error: ident(el) + " kept its previous value " + JSON.stringify(clip(v, 60)) + " instead of the text; the page reverted the write" };
    }
    if (exact(t, el.value)) return true;
    const kept = clip(el.value, 60);
    return { ok: false, el: ident(el), kept: kept, error: ident(el) + " expects " + format(el, t) + "; the page kept " + JSON.stringify(kept) };
  }
  function startTypeahead(el) {
    const t = taParts(el);
    window.__perch_ta = { el: el, comp: t.comp, pop: t.pop, text: text, prior: el.value, priorComp: t.comp && t.comp.value };
    taType(el, text);
    return { pending: true };
  }
  function setRich(root) {
    root.focus();
    const doc = root.ownerDocument;
    // Build nodes rather than assigning innerHTML: an HTML-string sink trips
    // Trusted Types (require-trusted-types-for 'script') on Gmail-class pages.
    while (root.firstChild) root.removeChild(root.firstChild);
    text.split(/\n\n+/).forEach(function (para) {
      const block = doc.createElement("div");
      para.split("\n").forEach(function (line, i) {
        if (i) block.appendChild(doc.createElement("br"));
        block.appendChild(doc.createTextNode(line));
      });
      if (!block.childNodes.length) block.appendChild(doc.createElement("br"));
      root.appendChild(block);
    });
    ["input", "change", "blur"].forEach(function (t) { root.dispatchEvent(new InputEvent(t, { bubbles: true, inputType: "insertText", data: text })); });
    return landed(textOf(root));
  }
  function tryFill(el, host) {
    if (a.trusted) { window.__perch_ta = { el: el, held: true }; return { pending: true }; }
    if (isField(el) && text !== "" && isTypeahead(el)) return startTypeahead(el);
    if (isField(el)) {
      const r = setPlain(el);
      if (r !== true) return r || null;
      if (onLand) onLand(el, false);
      return { ok: true, kind: "plain", el: ident(el), len: el.value.length };
    }
    if (!isRich(el) || !setRich(el)) return null;
    if (onLand) onLand(el, true);
    return { ok: true, kind: "rich", el: ident(host || el), len: textOf(el).length };
  }
  // A typeahead holds only its pick (a companion's value or what its control
  // shows), never typed text alone.
  function held(el) {
    if (!isField(el)) return isRich(el) ? { kind: "rich", v: textOf(el).trim() } : null;
    if (!isTypeahead(el)) return { kind: "plain", v: el.value.trim() };
    const c = taParts(el).comp;
    return { kind: "typeahead", v: (c && c.value.trim()) || shownValue(el) };
  }
  function keep(el, host) {
    const h = only && held(el);
    return h && h.v ? { ok: true, kind: h.kind, skipped: "has value", el: ident(host || el), value: clip(h.v, 60) } : null;
  }
  function refuse(el) { return only ? { ok: true, skipped: "disabled", el: ident(el) } : unsentOut(el); }
  if (a.ref || a.selector) {
    const r = resolveEl(a);
    if (r.out) return r.out;
    if (unsent(r.el)) return refuse(r.el);
    const kept = keep(r.el);
    if (kept) return kept;
    const out = tryFill(r.el);
    if (!out) return { ok: false, error: ident(r.el) + " is not fillable or rejected the text" };
    if (out.ok === false) return out;
    if (!fieldVis(r.el)) out.hidden = true;
    if (a.selector) {
      const hits = Array.from(document.querySelectorAll(a.selector)).filter(fieldVis);
      if (hits.length > 1) out.ambiguous = hits.slice(0, 3).map(ident);
    }
    return out;
  }
  // Ranked search across every editable surface, so a visible field outranks a
  // hidden one and text never lands silently in the wrong element.
  const re = new RegExp(a.label_pattern, "i");
  const scored = [];
  // Fields share ancestors: test each ancestor's text once.
  const near = new Map();
  const nearHit = function (p) {
    if (!near.has(p)) near.set(p, re.test(p.textContent || ""));
    return near.get(p);
  };
  const EDITABLES = "textarea, input, [contenteditable], .fr-element, .ql-editor, .ProseMirror, .tox-edit-area iframe";
  const fillable = function (el) {
    if (el.tagName === "INPUT" && INPUT_SKIP.indexOf((el.type || "text").toLowerCase()) >= 0) return false;
    return !el.hasAttribute("contenteditable") || editable(el);
  };
  const inFrame = function (d) { try { return !!d && deepAll(EDITABLES, d).some(fillable); } catch (e) { return false; } };
  const crowd = new Map();
  const fieldsIn = function (p) {
    if (!crowd.has(p)) crowd.set(p, Array.prototype.filter.call(p.querySelectorAll(EDITABLES), fillable).length);
    return crowd.get(p);
  };
  // A placeholder names another field when it is a short name ("Name",
  // "Company name", "Enter your email") sharing no word with the pattern, not a
  // prompt for an answer ("Type your response", "Start typing..."). A prompt
  // word naming a field noun still names that field.
  const PROMPT = /\b(your|type|typing|enter|write|add|answer|response|here|something|optional)\b/i;
  const NOUN = /\b(name|e-?mail|phone|number|address|company|city|website|url)\b/i;
  const src = a.label_pattern.toLowerCase();
  const namesOther = function (ph) {
    const words = ph.trim().split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 4 || (PROMPT.test(ph) && !NOUN.test(ph)) || re.test(ph)) return false;
    return !words.some(function (w) { w = w.toLowerCase().replace(/[^a-z0-9]/g, ""); return w.length > 2 && src.indexOf(w) >= 0; });
  };
  // Surrounding text (an ancestor's, never the page body's) claims a field only
  // as its section label: never over the field's own label or a placeholder
  // naming another field, and in a container holding other fields only when it
  // is the text laid out just before the field (nearText). Fields passed over in
  // a small section are offered back as candidates.
  const passed = [];
  deepAll(EDITABLES).forEach(function (el) {
    if (!fillable(el)) return;
    const root = el.tagName === "IFRAME" ? el.contentDocument && el.contentDocument.body : el;
    if (!root) return;
    let s;
    const own = labelText(el), hint = hintText(el);
    if (re.test(own)) s = 100;
    else if (re.test(hint)) s = 40;
    else {
      let p = el, hit = false;
      for (let i = 0; i < 6 && p && !/^(BODY|HTML)$/.test(p.tagName); i++, p = p.parentElement) if (nearHit(p)) { hit = true; break; }
      if (!hit) return;
      if (p !== el && (own || namesOther(attr(el, "placeholder")) || (fieldsIn(p) > 1 && !re.test(nearText(el))))) {
        if (fieldsIn(p) <= 5) passed.push(el);
        return;
      }
      s = 10;
    }
    if (fieldVis(el)) s += vis(el) ? 20 : 10;
    if (!el.disabled && !el.readOnly) s += 10;
    scored.push({ el: el, root: root, s: s });
  });
  scored.sort(function (a, b) { return b.s - a.s; });
  if (only && !scored.length && !passed.length) return { ok: true, skipped: "absent" };
  if (!scored.length) {
    const miss = "no fillable field matched /" + a.label_pattern + "/i; it may appear ";
    const reveal = revealers(re, nearHit);
    const framed = !reveal.length && frameHint(inFrame);
    const out = framed ? { ok: false, error: "no fillable field matched /" + a.label_pattern + "/i" + framed }
      : !reveal.length ? { ok: false, error: miss + "only after clicking a button" }
      : { ok: false, error: miss + "after clicking one of reveal (click {label_pattern} it, then fill again)", reveal: reveal };
    if (passed.length) {
      out.error += "; candidates sit near matching text but carry other labels";
      out.candidates = passed.slice(0, 5).map(function (el) {
        const own = labelText(el) || attr(el, "placeholder") || attr(el, "name") || nearText(el);
        return role(el) + " " + JSON.stringify(clip(own, 120)) + (fieldVis(el) ? "" : " hidden");
      });
    }
    return out;
  }
  const shown = scored.filter(function (c) { return fieldVis(c.el); });
  if (!shown.length) {
    const el = ident(scored[0].el);
    if (scored.every(function (c) { return trapLike(c.el); })) return only ? { ok: true, skipped: "trap", el: el } : { ok: false, el: el, error: el + " matched /" + a.label_pattern + "/i but it looks like a bot trap; leave it empty" };
    const reveal = revealers(re, nearHit);
    const why = el + " matched /" + a.label_pattern + "/i but the field is hidden; ";
    const framed = !reveal.length && frameHint(inFrame);
    if (framed) return { ok: false, el: el, error: why + framed.slice(2) + ", or pass its ref or selector to fill it anyway" };
    return !reveal.length ? { ok: false, el: el, error: why + "it may show only after clicking a button, or pass its ref or selector to fill it anyway" }
      : { ok: false, el: el, error: why + "it may show after clicking one of reveal (click {label_pattern} it, then fill again)", reveal: reveal };
  }
  // A disabled winner refuses the fill; only an enabled field of equal score stands in.
  const best = shown.find(function (c) { return c.s === shown[0].s && !unsent(c.el); }) || shown[0];
  if (unsent(best.el)) return refuse(best.el);
  if (only) {
    // Two fields each named by their own label, neither favoured: guessing would
    // put the value in the wrong one.
    const tied = shown.filter(function (c) { return c.s >= 100 && c.s === best.s && (c === best || (!c.el.contains(best.el) && !best.el.contains(c.el))); });
    if (tied.length > 1) return { ok: true, skipped: "ambiguous", candidates: tied.slice(0, 3).map(function (c) { return ident(c.el); }) };
    const kept = keep(isField(best.el) ? best.el : best.root, best.el);
    if (kept) return kept;
  }
  const out = tryFill(isField(best.el) ? best.el : best.root, best.el);
  if (!out) return { ok: false, error: ident(best.el) + " did not accept the text" };
  if (out.ok === false) return out;
  const rivals = shown.filter(function (c) { return best.s - c.s <= 10 && c.s >= 50; });
  if (rivals.length > 1) out.ambiguous = rivals.slice(0, 3).map(function (c) { return ident(c.el); });
  return out;
}
`;

// Fields the page rejected, for the snapshot and click {readback}. A field is
// invalid when it (or, for a custom widget, the group or combobox around it)
// carries aria-invalid=true, or when it holds a value that fails its native
// constraints; an untouched blank required field is requiredEmpty, not invalid.
// The message comes from aria-errormessage, then an error-looking describedby
// target, then error text in the field's own box (never another field's), then
// the native validationMessage, then any other describedby text that is not the
// field's own label or placeholder.
const INVALID_LIB = String.raw`
const INV_CARRIER = "[role=group], [role=radiogroup], [role=combobox]";
const INV_OTHER = "input:not([type=hidden]), select, textarea, [role=combobox], [role=textbox], [role=radiogroup], [contenteditable]";
const invErrish = function (n) { return n.matches("[role=alert], [aria-live]:not([aria-live=off])") || /error|invalid|danger|feedback/i.test(attr(n, "class")); };
const invStandin = function (x) { return attr(x, "aria-hidden") === "true" && attr(x, "tabindex") === "-1"; };
function invNative(el) {
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || /^(checkbox|radio|file)$/i.test(el.type || "")) return false;
  return el.willValidate !== false && !!el.validity && !el.validity.valid && String(el.value || "") !== "";
}
// The element carrying aria-invalid for el (el itself, else the group or
// combobox around it; up only when asked), or el when it fails natively.
function invCarrier(el, up) {
  if (attr(el, "aria-invalid") === "true") return el;
  const w = up && el.parentElement && el.parentElement.closest(INV_CARRIER);
  if (w && attr(w, "aria-invalid") === "true") return w;
  return invNative(el) ? el : null;
}
// The highest ancestor (below the form, at most 5 up) holding no other field.
function invBox(el) {
  let box = el;
  for (let p = el.parentElement, i = 0; p && i < 5 && !/^(FORM|BODY|HTML)$/.test(p.tagName); p = p.parentElement, i++) {
    const other = Array.prototype.some.call(p.querySelectorAll(INV_OTHER), function (x) {
      return !el.contains(x) && !x.contains(el) && !invStandin(x) && !(el.type === "radio" && x.type === "radio" && x.name === el.name);
    });
    if (other) break;
    box = p;
  }
  return box;
}
function invMsg(el) {
  const root = el.getRootNode().getElementById ? el.getRootNode() : document;
  const own = [labelText(el), attr(el, "placeholder")].map(function (s) { return clip(s, 120); });
  const txt = function (n) { const t = n && vis(n) ? clip(textOf(n), 120) : ""; return t && own.indexOf(t) < 0 ? t : ""; };
  const byIds = function (k) { return attr(el, k).split(/\s+/).filter(Boolean).map(function (id) { return root.getElementById(id); }).filter(Boolean); };
  for (const n of byIds("aria-errormessage")) { const t = txt(n); if (t) return t; }
  const desc = byIds("aria-describedby");
  for (const n of desc) { if (invErrish(n) || n.querySelector("[role=alert], [class*=error], [class*=invalid]")) { const t = txt(n); if (t) return t; } }
  for (const n of invBox(el).querySelectorAll("*")) {
    if (n.contains(el) || desc.indexOf(n) >= 0 || n.matches(INV_OTHER) || !invErrish(n)) continue;
    const t = txt(n);
    if (t) return t;
  }
  if (invNative(el) && el.validationMessage) return clip(el.validationMessage, 120);
  for (const n of desc) { const t = txt(n); if (t) return t; }
  return "";
}
// Every rejected field in doc (the page's by default), outermost carrier only:
// [{el, name, msg}].
function invalidSet(doc) {
  doc = doc || document;
  const seen = [];
  const add = function (c) { if (c && seen.indexOf(c) < 0) seen.push(c); };
  doc.querySelectorAll("[aria-invalid=true]").forEach(function (c) {
    if (invStandin(c) || !(vis(c) || (c.parentElement && vis(c.parentElement) && getComputedStyle(c).display !== "none"))) return;
    add(c);
  });
  doc.querySelectorAll("input, textarea, select").forEach(function (el) { if (invNative(el) && vis(el)) add(el); });
  const outer = seen.filter(function (c) { return !seen.some(function (o) { return o !== c && o.contains(c); }); });
  outer.sort(function (a, b) { return a.compareDocumentPosition(b) & 2 ? 1 : -1; });
  return outer.map(function (c) {
    let name = "";
    if (/^(checkbox|radio)$/.test(role(c))) {
      const g = c.closest("[role=radiogroup], [role=group], fieldset");
      const lg = g && g.tagName === "FIELDSET" && g.querySelector("legend");
      name = g ? labelText(g) || (lg ? clip(textOf(lg), 120) : "") : "";
    }
    return { el: c, name: name || labelText(c) || ident(c), msg: invMsg(c) };
  });
}
`;

// Chrome's editing command emits a trusted input event in an inactive tab,
// including when its window has no on-screen CG entry. It needs no mouse
// event, tab selection, window geometry, or AppKit focus change. Replaces el's
// whole value with text ("" deletes it). -> {ok, focused, trusted, value}; ok
// only when the command ran, a trusted input reached el, and el holds exactly text.
const EDIT_LIB = String.raw`
function editType(el, text) {
  let trusted = false;
  const onInput = function (e) { if (e.target === el && e.isTrusted) trusted = true; };
  el.addEventListener("input", onInput, true);
  try {
    el.focus({ preventScroll: true });
    const doc = el.ownerDocument;
    if (doc.activeElement !== el) return { ok: false, focused: false, trusted: false, value: String(el.value || "") };
    if (el.select) el.select();
    const accepted = doc.execCommand(text ? "insertText" : "delete", false, text);
    const value = String(el.value || "");
    return { ok: accepted === true && trusted && value === text, focused: true, trusted: trusted, value: value };
  } finally { el.removeEventListener("input", onInput, true); }
}
// Withdraws text typed with editType the same way; a plain value write only if that fails.
function editClear(el) {
  if (el.value && !editType(el, "").ok && el.value) { setNativeValue(el, ""); fire(el, ["input"]); }
}
`;

// Page activity since the last poll, for click {readback} and wait {quiet}: DOM
// mutations anywhere (takeRecords too, since the observer's callback may not
// have run between polls) and completed fetch/XHR requests, as resource timing
// entries. A request still in flight shows only once it completes. rbWatch keeps
// the state on window[key]; one that is never read again stops its observer at
// the first mutation after `life` ms.
const QUIET_LIB = String.raw`
function rbNet() {
  try { return performance.getEntriesByType("resource").filter(function (e) { return e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest"; }).length; }
  catch (e) { return 0; }
}
// s.away: the page changed outside the clicked submit button (s.btn). class and
// style stay out, as hover, focus and animation flip them, and so do busy flags
// on the armed form scope (s.form) or inside it, which a posting form sets.
const RB_HOLD_ATTRS = /^(disabled|aria-disabled|aria-busy|readonly)$/;
function rbSeen(s, r) {
  s.mut += r.length;
  if (!s.btn || s.away) return;
  for (let i = 0; i < r.length; i++) {
    const m = r[i];
    if (m.type === "attributes" && (m.attributeName === "class" || m.attributeName === "style")) continue;
    if (m.type === "attributes" && RB_HOLD_ATTRS.test(m.attributeName) && s.form && s.form.contains(m.target)) continue;
    if (!s.btn.contains(m.target)) { s.away = true; return; }
  }
}
function rbBusy(s) {
  if (s.obs) rbSeen(s, s.obs.takeRecords());
  const act = s.mut + ":" + rbNet(), busy = act !== s.act;
  s.act = act;
  return busy;
}
function rbStop(s) { if (s && s.obs) s.obs.disconnect(); }
function rbWatch(s, key, life) {
  s.mut = 0; s.at = Date.now(); s.act = "0:" + rbNet();
  try {
    s.obs = new MutationObserver(function (r) {
      if (window[key] !== s || Date.now() - s.at > life) return s.obs.disconnect();
      rbSeen(s, r);
    });
    s.obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch (e) { s.obs = null; s.away = true; }
  window[key] = s;
}
`;

// A form's step indicator, "n/m" (or the current step's own text when it sits
// in no list), else null. Looks in the form and up to 2 ancestors, nearest
// first: aria-current=step, then a progressbar, then "Step 2 of 3" text.
const STEP_LIB = String.raw`
function stepRoots(scope) {
  const roots = [scope];
  for (let p = scope.parentElement, i = 0; p && i < 2 && !/^(BODY|HTML)$/.test(p.tagName); p = p.parentElement, i++) roots.push(p);
  return roots;
}
function stepOf(scope) {
  if (!scope || !scope.isConnected) return null;
  const roots = stepRoots(scope);
  for (const r of roots) {
    const cur = r.querySelector("[aria-current=step]");
    if (!cur) continue;
    const li = cur.closest("li, [role=listitem]");
    const list = li && li.parentElement;
    if (list) {
      const items = Array.prototype.filter.call(list.children, function (c) { return c.matches("li, [role=listitem]"); });
      return (items.indexOf(li) + 1) + "/" + items.length;
    }
    return clip(textOf(cur), 40) || null;
  }
  for (const r of roots) {
    const bar = r.querySelector("[role=progressbar][aria-valuenow][aria-valuemax]");
    if (bar) return attr(bar, "aria-valuenow") + "/" + attr(bar, "aria-valuemax");
  }
  for (const r of roots) {
    const m = /step\s+(\d+)\s+(?:of|de|\/)\s+(\d+)/i.exec(String(r.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200));
    if (m) return m[1] + "/" + m[2];
  }
  return null;
}
`;

// click {readback}: the pre-click text, state and url live on window.__perch_rb until read.
// The state catches toggles that change no text: ARIA flags, disabled and the
// checked/selected/value of controls on the element and its first 50
// descendants. Classes count only when they are state names (not hover, focus
// or animation ones) and still hold on the next poll, so transient effects
// don't pass for a change.
const READBACK_LIB = QUIET_LIB + INVALID_LIB + STEP_LIB + String.raw`
function rbText() { const n = document.querySelector(A.readback); return n ? clip(textOf(n), 300) : null; }
// noOff leaves out the disabled flags, which a form sets while it posts.
function rbSig(noOff) {
  const n = document.querySelector(A.readback);
  if (!n) return null;
  const els = [n].concat(Array.prototype.slice.call(n.querySelectorAll("*"), 0, 50));
  return els.map(function (el) {
    const f = ["aria-pressed", "aria-checked", "aria-selected", "aria-expanded"].map(function (k) { return el.getAttribute(k); });
    if (!noOff) f.push(!!el.disabled);
    if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") f.push(el.checked, el.type === "password" ? el.value.length : el.value);
    if (el.tagName === "OPTION") f.push(el.selected);
    return JSON.stringify(f);
  }).join("|");
}
function rbCls() {
  const n = document.querySelector(A.readback);
  if (!n) return null;
  const els = [n].concat(Array.prototype.slice.call(n.querySelectorAll("*"), 0, 50));
  return els.map(function (el) {
    return String(el.getAttribute("class") || "").split(/\s+/).filter(function (c) {
      return c && !/hover|focus|anim|transition|ripple|spin/i.test(c);
    }).sort().join(" ");
  }).join("|");
}
const RB_FIELDS = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select, [contenteditable]:not([contenteditable=false])";
const rbShown = function (n) { if (!n || !n.isConnected) return false; const b = n.getBoundingClientRect(); return b.width > 0 || b.height > 0; };
// The clicked element's form: its <form>, else a modal around it, else the
// nearest ancestor (at most 8 up, below body) holding 2 or more fields.
function rbScope(el) {
  const f = (el.form && el.form.tagName === "FORM" ? el.form : null) || el.closest("form") || el.closest("[role=dialog][aria-modal=true], dialog[open]");
  if (f) return f;
  for (let p = el.parentElement, i = 0; p && i < 8 && !/^(BODY|HTML)$/.test(p.tagName); p = p.parentElement, i++) {
    if (p.querySelectorAll(RB_FIELDS).length >= 2) return p;
  }
  return null;
}
// Visible alert and live-region texts that are not a field's own error: not
// inside a field, not a field's describedby/errormessage target, and not
// repeating an invalid field's message.
function rbAlerts(inv) {
  const own = new Set(), msgs = inv.map(function (c) { return c.msg; }).filter(Boolean);
  document.querySelectorAll("[aria-describedby], [aria-errormessage]").forEach(function (f) {
    (attr(f, "aria-describedby") + " " + attr(f, "aria-errormessage")).split(/\s+/).forEach(function (id) { if (id) own.add(id); });
  });
  const out = [];
  document.querySelectorAll("[role=alert], [aria-live=assertive], [aria-live=polite]").forEach(function (n) {
    if ((n.id && own.has(n.id)) || (n.parentElement && n.parentElement.closest(RB_FIELDS)) || !vis(n)) return;
    const t = clip(textOf(n), 140);
    if (t && msgs.indexOf(t) < 0 && out.indexOf(t) < 0) out.push(t);
  });
  return out;
}
// The scope and the fieldsets and fields in it that show a busy flag: aria-busy,
// disabled, aria-disabled or readonly.
function rbHeld(scope) {
  const els = [scope].concat(Array.prototype.slice.call(scope.querySelectorAll("fieldset, [aria-busy], [aria-disabled], " + RB_FIELDS)));
  return els.filter(function (el) {
    return attr(el, "aria-busy") === "true" || attr(el, "aria-disabled") === "true" || !!el.disabled || !!el.readOnly;
  });
}
const rbBtn = function (el) { return el && el.closest("button, input[type=submit], input[type=button], [role=button]"); };
// A control that submits: type=submit, or a typeless <button> in a form. Other
// buttons ("Same as mailing address") that disable fields have that as their outcome.
function rbSubmits(b) {
  if (!b || !/^submit$/i.test(b.type || "")) return false;
  return b.tagName === "INPUT" || b.hasAttribute("type") || !!b.form;
}
function rbArm(el) {
  let s;
  try { s = { text: rbText(), sig: rbSig(), sigOn: rbSig(true), cls: rbCls(), url: location.href, inv: invalidSet() }; }
  catch (e) { return { ok: false, error: "bad readback selector: " + A.readback }; }
  const scope = el ? rbScope(el) : null;
  if (scope && rbShown(scope)) {
    s.form = scope;
    s.step = stepOf(scope);
    s.alerts = rbAlerts(s.inv);
    const b = rbBtn(el);
    if (rbSubmits(b)) { s.held = rbHeld(scope); s.btn = b; s.btnText = textOf(b); s.btnOff = !!b.disabled; }
  }
  rbStop(window.__perch_rb);
  s.quiet = 0;
  s.calm = Date.now();
  rbWatch(s, "__perch_rb", 10000);
  return null;
}
`;

// file_upload's drop path. U is the upload's state, kept on window.__perch_up
// between calls: the DataTransfer, the zone, the input under watch and its
// MutationObserver, how often the file name was on the page before, and how
// many fetch/XHR requests had completed (resource timing) before the file was set.
const UPLOAD_LIB = String.raw`
const has = function (el) { return !!el.files && el.files.length === 1 && el.files[0].name === A.name; };
function nameCount(name) { return textOf(document.body).split(name).length - 1; }
function upNet() {
  try { return performance.getEntriesByType("resource").filter(function (e) { return e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest"; }).length; }
  catch (e) { return 0; }
}
function uploadSeen(name, U) {
  if (U.obs && U.obs.takeRecords().some(function (r) { return r.target !== U.input; })) U.moved = true;
  return U.moved || (U.net != null && upNet() > U.net) || deepAll("input[type=file]").some(function (el) { return el !== U.input && has(el); }) || nameCount(name) > U.names;
}
// Not every engine takes dataTransfer in a DragEvent init, so it is pinned on
// the event when it didn't stick.
function dropOn(U) {
  const b = U.zone.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, composed: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
  ["dragenter", "dragover", "drop"].forEach(function (t) {
    let ev;
    try { ev = new DragEvent(t, Object.assign({ dataTransfer: U.dt }, init)); } catch (e) { ev = new Event(t, init); }
    if (ev.dataTransfer !== U.dt) Object.defineProperty(ev, "dataTransfer", { value: U.dt });
    U.zone.dispatchEvent(ev);
  });
  const seen = uploadSeen(A.name, U);
  const r = { ok: seen, dropped: true, el: ident(U.zone), shown: seen };
  if (!seen) r.error = "nothing took the file dropped on " + r.el + ": no file name shown and no file input holds it";
  return r;
}
`;

// Clicks that open a new tab. blankHref: the absolute http(s) URL a link (not a
// download) or a form's submit button aimed at _blank opens by default, else
// null. watchOpen, for one synchronous click: the first window.open call's URL
// and whether the browser returned a window, and whether the click's default
// was cancelled.
// off() takes both hooks away (window.open goes back only if still ours).
// In Chromium page JS runs in an isolated world, so page handlers call their own
// window.open and only Safari's are seen.
const BLANK_LIB = String.raw`
function blankHref(el) {
  const a = el.closest("a[href]");
  if (a) return /^_blank$/i.test(a.getAttribute("target") || "") && /^https?:/i.test(a.href) && !a.hasAttribute("download") ? a.href : null;
  const b = el.closest("button, input");
  if (!b || !b.form || !/^(submit|image)$/i.test(b.type || "")) return null;
  const target = b.hasAttribute("formtarget") ? b.getAttribute("formtarget") : b.form.getAttribute("target");
  const url = b.hasAttribute("formaction") ? b.formAction : b.form.action;
  return /^_blank$/i.test(target || "") && /^https?:/i.test(url) ? url : null;
}
function watchOpen() {
  const st = { url: null, got: false, cancelled: false };
  const own = Object.prototype.hasOwnProperty.call(window, "open"), orig = window.open;
  const wrap = function (u) {
    const w = orig.apply(window, arguments);
    if (st.url == null) {
      try { st.url = new URL(u == null || u === "" ? "about:blank" : String(u), location.href).href; } catch (e) { st.url = String(u); }
      st.got = w != null;
    }
    return w;
  };
  const onClick = function (e) { st.cancelled = e.defaultPrevented; };
  window.open = wrap;
  window.addEventListener("click", onClick);
  st.off = function () {
    window.removeEventListener("click", onClick);
    if (window.open !== wrap) return;
    if (own) window.open = orig; else delete window.open;
  };
  return st;
}
`;

const CLICK_BODY = CLICK_LIB + String.raw`
const clickNow = function (el, blank) {
  if (A.readback) { const bad = rbArm(el); if (bad) return bad; }
  const w = watchOpen();
  try { el.click(); } finally { w.off(); }
  const out = { ok: true, el: ident(el) };
  if (blank && w.cancelled) out.cancelled = true;
  if (w.url != null && w.got) { out.opened = { url: w.url }; out.note = "list_tabs to find it"; }
  else if (w.url != null) { out.blocked = true; out.href = w.url; }
  return out;
};
const r = resolveClick(A);
if (r.out) return r.out;
const el = r.el, off = inertCtl(el);
if (off) return inertOut(off);
const href = A.probe && blankHref(el);
if (!href) return clickNow(el, false);
window.__perch_blank = { run: function () { return el.isConnected ? clickNow(el, true) : null; } };
return { ok: true, blank: { href: href } };
`;

// Trusted input: find the element, scroll it into view, estimate its screen
// point, and arm listeners: mousemove for calibration, mousedown for `hit`.
// Estimate: screen origin + browser chrome (outer - inner, assumed left and top)
// + the element's center. A hidden tab's screenX/outerWidth are stale, so it
// asks to retry until the tab is visible. An element that is or sits under an
// embedded frame is refused: frame controls take an fN ref.
const TRUSTED_PROBE_HEAD = CLICK_LIB + String.raw`
if (document.visibilityState === "hidden") return { ok: false, retry: "hidden" };
let el;
if (A.select) {
  // select {trusted}: the control select pressed, or the option it picked (gone once its list closed).
  const s = window.__perch_select;
  if (!s) return { ok: false, error: "select state lost (did the page navigate?)" };
  el = A.select === "option" ? s.optEl : s.openEl;
  if (A.select === "option" && !(el && el.isConnected && vis(el))) return { ok: false, gone: true };
} else if (A.ref || A.selector || !A.forFill) {
  const r = A.ref || A.selector ? resolveEl(A) : clickableByLabel(A);
  if (r.out) return r.out;
  el = r.el;
  const off = !A.forFill && inertCtl(el);
  if (off) return inertOut(off);
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
const FRAMED = " is or lies under an embedded frame; reach frame controls through accessibility_snapshot {frames:true} and click an fN ref with trusted:true";
const inFrame = function (e) { return !!(e && e.closest && e.closest("iframe, frame, object, embed")); };
if (inFrame(el)) return { ok: false, error: ident(el) + FRAMED };
// A same-origin frame's row: its box is in the frame's viewport, not the page's.
if (el.ownerDocument !== document) return { ok: false, error: ident(el) + " lies in an embedded frame, where trusted input can't aim; use it without trusted" };
try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (e) {}
const r = el.getBoundingClientRect();
if (!r.width || !r.height) return { ok: false, error: ident(el) + " has no size (hidden or offscreen)" };
const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
if (inFrame(document.elementFromPoint && document.elementFromPoint(cx, cy))) return { ok: false, error: ident(el) + FRAMED };
`;
// A click that opens a new tab also records whether the page cancelled it.
const TRUSTED_PROBE_TAIL = BLANK_LIB + String.raw`if (A.forFill && !A.background) { setNativeValue(el, ""); fire(el, ["input"]); }
const prev = window.__perch_trusted;
if (prev && prev.off) prev.off();
const st = window.__perch_trusted = { el: el, down: null, moves: [] };
const href = !A.forFill && !A.select ? blankHref(el) : null;
const onMove = function (e) { if (st.moves.length < 20) st.moves.push([e.clientX, e.clientY, e.screenX, e.screenY]); };
const onDown = function (e) { st.down = el === e.target || el.contains(e.target); window.removeEventListener("mousedown", onDown, true); };
const onClick = function (e) { st.cancelled = e.defaultPrevented; };
window.addEventListener("mousemove", onMove, true);
window.addEventListener("mousedown", onDown, true);
if (href) window.addEventListener("click", onClick);
st.off = function () { window.removeEventListener("mousemove", onMove, true); window.removeEventListener("mousedown", onDown, true); window.removeEventListener("click", onClick); };
return {
  ok: true,
  el: ident(el),
  blank: href ? { href: href } : undefined,
  x: window.screenX + (window.outerWidth - window.innerWidth) + cx,
  y: window.screenY + (window.outerHeight - window.innerHeight) + cy,
  cx: cx,
  cy: cy,
  iw: window.innerWidth,
  ih: window.innerHeight,
};`;

export const PAGE_SCRIPTS = {
  get_text: String.raw`
const r = resolveEl(A, A.html ? "html" : "body");
if (r.out) return r.out;
const s = A.html ? r.el.outerHTML : textOf(r.el);
if (A.offset === 0 && s.length <= A.maxChars) return s;
return s.slice(A.offset, A.offset + A.maxChars) + "\n[truncated: chars " + A.offset + "-" + Math.min(A.offset + A.maxChars, s.length) + " of " + s.length + "; pass offset/maxChars for the rest]";
`,

  // Line format: "# {header json}", then "<ref> <role> <json name> key=<json>... flags".
  snapshot: INVALID_LIB + STEP_LIB + TA_BOX_LIB + CENSUS_LIB + EMBED_LIB + String.raw`
const refs = {};
window.__perch_refs = refs;
const SEL = 'a[href], button, input:not([type=hidden]), textarea, select, [role], [tabindex]:not([tabindex="-1"]), h1, h2, h3, h4, h5, h6, [contenteditable]:not([contenteditable=false]), summary';
const roles = A.role == null ? null : [].concat(A.role);
const q = JSON.stringify;
const origin = location.origin;
// A query tests each line without its ref and keeps counting matches past max.
const re = A.query == null ? null : new RegExp(A.query, "i");
const lines = [];
// Judged as fill judges it: visible text excuses sr-only styling only on a
// field the form wants filled.
function decoy(el) { return trapLike(el, wanted(el)); }
function describe(el, r, name) {
  const tag = el.tagName;
  let line = r + " " + q(name);
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
  else if (r === "combobox" && tag === "INPUT") { const v = el.value ? clip(el.value, 200) : shownValue(el); if (v) kv("value", v); }
  if (r === "link") {
    let h = el.href || "";
    if (h.indexOf(origin + "/") === 0) h = h.slice(origin.length);
    kv("href", h.length > 150 ? h.slice(0, 150) + "…" : h);
  }
  if (el.required || attr(el, "aria-required") === "true") line += " required";
  if (el.checked || attr(el, "aria-checked") === "true") line += " checked";
  if (attr(el, "aria-pressed") === "true") line += " pressed";
  if (attr(el, "aria-selected") === "true") line += " selected";
  if (el.disabled) line += " disabled";
  if (attr(el, "aria-expanded") === "true") line += " expanded";
  if (unpicked(el)) line += " unpicked";
  if (invCarrier(el, false)) { line += " invalid"; const m = invMsg(el); if (m) kv("error", m); }
  return line;
}
// Same-origin frames' documents are walked after the page's own, their rows
// marked with the frame's index in the header's iframes.
const embedded = embeds();
const frameDocs = new Map();
embedded.forEach(function (e, i) { if (e.same && e.f.contentDocument) frameDocs.set(e.f.contentDocument, i); });
function frameTag(el) { return el.ownerDocument === document ? "" : " frame=" + frameDocs.get(el.ownerDocument); }
let n = 0, matched = 0, truncated = false;
function walk(root) {
  for (const el of deepAll(SEL, root)) {
    const r = role(el);
    if (roles && roles.indexOf(r) < 0) continue;
    if (!snapVis(el)) continue;
    if (!re && n >= A.max) { truncated = true; return; }
    const line = describe(el, r, accName(el)) + frameTag(el);
    if (re && !re.test(line)) continue;
    matched++;
    if (n >= A.max) { truncated = true; continue; }
    const ref = String(++n);
    refs[ref] = el;
    lines.push(ref + " " + line);
  }
}
// A frame counts as walked only when the cap left all its rows listed.
const walkedFrames = new Set();
walk(null);
frameDocs.forEach(function (i, d) { if (re || !truncated) walk(d); if (!truncated) walkedFrames.add(i); });
// The shown boxes around a hidden field, nearest first, up to one holding more
// than 5 fields: their label text names the field when nothing else does, and
// they hold the button that reveals it.
function sections(el) {
  const out = [];
  for (let p = el.parentElement, d = 0; p && d < 6 && !/^(FORM|MAIN|BODY|HTML)$/.test(p.tagName) && attr(p, "role") !== "main"; p = p.parentElement, d++) {
    if (p.querySelectorAll("input:not([type=hidden]), textarea, select, [contenteditable]").length > 5) break;
    if (vis(p)) out.push(p);
  }
  return out;
}
// A shown, enabled, non-submit button in the field's nearest section that has
// one: controlling the field first, then one suggesting typing ("Enter
// manually"), then one expanding something collapsed.
function revealer(el, secs) {
  for (const p of secs) {
    let best = null, rank = 3;
    for (const b of p.querySelectorAll("button, [role=button], input[type=button]")) {
      if (!vis(b) || isDisabled(b) || attr(b, "type").toLowerCase() === "submit") continue;
      const name = accName(b);
      if (!name || REVEAL_SKIP.test(name)) continue;
      const ctl = attr(b, "aria-controls").split(/\s+/).some(function (id) { const t = id && el.ownerDocument.getElementById(id); return !!t && t.contains(el); });
      const k = ctl ? 0 : REVEAL_TYPING.test(name) ? 1 : attr(b, "aria-expanded") === "false" ? 2 : 3;
      if (k < rank) { best = b; rank = k; }
    }
    if (best) return best;
  }
  return null;
}
// Rows for required-empty form fields no row shows, after the ordinary rows:
// at most 10, under the same role and query filters. A trap never gets one,
// nor a hidden twin of a shown field (a faded decoy, a mirror). One fill takes
// for shown (a faded combobox input in its painted box) is not flagged hidden.
function hiddenRows(cands) {
  const listed = new Map(), twins = new Set();
  for (const k in refs) { listed.set(refs[k], k); twins.add(role(refs[k]) + " " + accName(refs[k])); }
  let shown = 0;
  for (const el of cands) {
    if (shown >= 10) break;
    const r = role(el);
    if ((roles && roles.indexOf(r) < 0) || decoy(el)) continue;
    const secs = sections(el);
    let name = clip(labelText(el) || nearText(el) || attr(el, "placeholder"), 120);
    if (!name) for (const p of secs) { const t = clip(labelWords(p), 121); if (t && t.length <= 120) { name = clip(t, 80); break; } }
    if (!name) name = accName(el);
    if (twins.has(r + " " + name)) continue;
    const seen = fieldVis(el);
    const line = describe(el, r, name) + (seen ? "" : " hidden") + frameTag(el);
    if (re && !re.test(line)) continue;
    matched++;
    if (n >= A.max) { truncated = true; continue; }
    shown++;
    const ref = String(++n);
    refs[ref] = el;
    const b = seen ? null : revealer(el, secs);
    let bref = b && listed.get(b), bline = null;
    if (b && !bref && n < A.max) { bref = String(++n); refs[bref] = b; listed.set(b, bref); bline = bref + " " + describe(b, role(b), accName(b)) + frameTag(b); }
    lines.push(ref + " " + line + (bref ? " reveal=" + q(bref) : ""));
    if (bline) lines.push(bline);
  }
}
let form = null;
let forms = Array.from(document.querySelectorAll("form"));
frameDocs.forEach(function (i, d) { forms = forms.concat(Array.from(d.querySelectorAll("form"))); });
forms = forms.filter(vis);
if (forms.length) {
  let big = forms[0];
  forms.forEach(function (f) { if (f.querySelectorAll(FIELDS).length > big.querySelectorAll(FIELDS).length) big = f; });
  const c = census(big), loose = c.loose, empty = c.empty;
  form = { fields: c.fields.length, requiredEmpty: empty.length };
  if (loose.length) form.unpicked = loose.length;
  const inv = invalidSet(big.ownerDocument).filter(function (c) { return big.contains(c.el); }).length;
  if (inv) form.invalid = inv;
  const step = stepOf(big);
  if (step) form.step = step;
  const unseen = empty.filter(function (el) { return !snapVis(el); });
  if (unseen.length) hiddenRows(unseen);
}
const head = { url: location.href, title: document.title, ready: document.readyState, count: n };
// For the frame walk's page-area match; Node drops them from the header.
if (A.frames) {
  head.iw = innerWidth; head.ih = innerHeight;
  // Content boxes of the frames walked here, so the frame walk skips them.
  const fr = embedded.filter(function (e, i) { return walkedFrames.has(i); }).map(function (e) {
    const b = e.f.getBoundingClientRect();
    let x = b.left + (e.f.clientLeft || 0), y = b.top + (e.f.clientTop || 0);
    for (let p = e.p; p; p = p.p) { const q = p.f.getBoundingClientRect(); x += q.left + (p.f.clientLeft || 0); y += q.top + (p.f.clientTop || 0); }
    return [x, y, e.f.clientWidth || b.width, e.f.clientHeight || b.height];
  });
  if (fr.length) head.fr = fr;
}
if (re) head.matched = matched;
if (truncated) head.truncated = true;
let act = document.activeElement;
while (act && act.shadowRoot && act.shadowRoot.activeElement) act = act.shadowRoot.activeElement;
for (let inner; act && (inner = embedded.some(function (e) { return e.same && e.f === act; }) ? act.contentDocument : null) && inner.activeElement && inner.activeElement !== inner.body;) {
  act = inner.activeElement;
  while (act.shadowRoot && act.shadowRoot.activeElement) act = act.shadowRoot.activeElement;
}
if (act && act !== document.body && act !== document.documentElement) {
  let fr = null;
  for (const k in refs) if (refs[k] === act) { fr = k; break; }
  head.focus = fr || ident(act);
}
const dialogs = Array.from(document.querySelectorAll("[role=dialog], [aria-modal=true], dialog[open]")).filter(vis).slice(0, 5).map(accName);
if (dialogs.length) head.dialogs = dialogs;
if (form) head.form = form;
if (embedded.length) head.iframes = embedded.map(function (e) {
  const o = { src: e.src, w: e.w, h: e.h, same: e.same };
  if (e.p) o.in = e.in;
  return o;
});
return "# " + JSON.stringify(head) + (lines.length ? "\n" + lines.join("\n") : "");
`,

  fill: FILL_LIB + "return fillOne(A);",

  // null = keep polling; the best tier of taMatch. A.probe: is a pick worth
  // waiting longer for (a hidden companion, an open or non-empty list)?
  fill_ta_pick: TA_PICK_LIB + String.raw`
const s = window.__perch_ta;
if (!s) return { ok: false, kind: "typeahead", error: "fill state lost (did the page navigate?)" };
if (A.probe) return !!(s.comp || attr(s.el, "aria-expanded") === "true" || taScopes(s).some(function (r) { return vis(r) && taNorm(r.textContent); }));
const opts = taOptions(s);
const m = taMatch(opts, s.text);
// Several equal hits short of exact are a tie, never settled by list order.
const opt = m.hits.length === 1 || m.exact ? m.hits[0] : null;
if (!opt) {
  if (opts.length) { s.cands = opts.slice(0, 8).map(function (o) { return clip(o.textContent, 60); }); s.tied = m.hits.length > 1; }
  // A list unchanged for 8 polls (about 400ms, past a typical debounce that
  // shows a stale list) is settled, so the miss runs now ({settled}): a tie at
  // once, a list without a hit only once it changed from the first one seen
  // after typing, which may be the stale one. An empty list keeps waiting.
  const sig = opts.length ? opts.map(function (o) { return taNorm(o.textContent); }).join("\n") : null;
  if (!("sig0" in s)) s.sig0 = sig;
  if (sig !== s.sig0) s.answered = true;
  s.same = sig && sig === s.sig ? s.same + 1 : 0;
  s.sig = sig;
  return sig && s.same >= 8 && (s.tied || s.answered) ? { settled: true } : null;
}
s.picked = clip(textOf(opt), 80);
s.pickedN = fold(taNorm(textOf(opt)));
s.before = taNorm(taShown(s.el));
s.ownBefore = taOwn(s.el);
s.compBefore = s.comp ? s.comp.value : null;
s.openBefore = attr(s.el, "aria-expanded") === "true";
press(opt);
return { picked: s.picked };
`,

  // No pick. A widget that expects one (a hidden companion, its own suggestions
  // shown, or text cleared on blur) gets its prior value back; any other
  // combobox keeps the typed text. React clears on blur only after the blurring
  // script ends, so the blur and the read of the settled value are separate
  // polls; null = keep polling, and A.final keeps text that survived.
  fill_ta_miss: TA_PICK_LIB + String.raw`
const s = window.__perch_ta;
if (!s) return { ok: false, kind: "typeahead", error: "the page changed while the suggestions were read; not verified" };
const el = s.el;
if (!s.missed) {
  s.missed = true;
  const c = taOptions(s).slice(0, 8).map(function (o) { return clip(o.textContent, 60); });
  if (c.length) s.cands = c;
  if (!s.comp && !s.cands) { taBlur(el); return null; }
}
const kept = !s.comp && !s.cands && taNorm(el.value) === taNorm(s.text);
if (kept && !A.final) return null;
let out;
if (kept) out = { ok: true, kind: "plain", el: ident(el), len: el.value.length, note: "no suggestion was picked; the typed text stays" };
else {
  setNativeValue(el, s.prior);
  fire(el, ["input", "change"]);
  if (s.comp && s.comp.value !== s.priorComp) setNativeValue(s.comp, s.priorComp);
  out = { ok: false, kind: "typeahead", el: ident(el), error: s.tied
    ? "several suggestions matched " + JSON.stringify(s.text) + " equally; give a more specific text (the text was withdrawn)"
    : "no suggestion matched " + JSON.stringify(s.text) + "; the text was withdrawn" };
}
if (s.cands) out.candidates = s.cands;
if (s.tied && !out.ok) out.ambiguous = true;
return out;
`,

  // Once the pick shows (and any hidden companion holds it), blur once and
  // re-check, since these widgets clear unpicked text on blur. A.final reports.
  fill_ta_read: TA_PICK_LIB + String.raw`
const s = window.__perch_ta;
if (!s) return { ok: false, kind: "typeahead", error: "the page changed after the pick was pressed; not verified" };
const el = s.el;
const shown = taShown(el);
const v = taNorm(shown);
// Text the box holds may carry the pick among more. An emptied control's value,
// or one of its chips, must be the pick, or a new value that is the pick cut at
// a word end (its label without a region line), never the pick plus more; a
// chip it held before the press never counts.
const pk = s.pickedN;
const own = el.value ? [] : taOwn(el);
const shows = el.value ? fold(v).indexOf(pk) >= 0 : own.some(function (t) {
  const cut = !!t && pk.indexOf(t) === 0 && !/[\p{L}\p{N}]/u.test(pk.charAt(t.length));
  return (t === pk && !own.chips) || (cut && s.ownBefore.indexOf(t) < 0);
});
const seen = !!v && (shows || (!!el.value && v.indexOf(taNorm(s.text)) >= 0));
// The typed text still showing proves nothing unless the press moved something:
// the field, the hidden companion, or the widget's own list closing, which
// counts only once the field shows the picked option.
const compChanged = !!s.comp && s.comp.value !== s.compBefore;
const listGone = !taOptions(s).length || (s.openBefore && attr(el, "aria-expanded") === "false");
const moved = v !== s.before || compChanged || (listGone && shows);
// A companion that held this same value before (re-picking on an edit form)
// can't change, so the widget closing its list is the proof there.
const filled = !s.comp || (!!s.comp.value && (compChanged || listGone));
const good = seen && moved && filled;
if (!A.final && good && !s.blurred) {
  s.blurred = true;
  taBlur(el);
  return null;
}
if (!A.final && !good) return null;
const out = { ok: good, kind: "typeahead", el: ident(el), selected: s.picked, value: clip(shown, 120) };
if (!good) out.error = "picked " + JSON.stringify(s.picked) + " but " + (!seen ? "the field doesn't show it" : !filled ? (s.comp.value ? "the hidden field didn't change" : "the hidden field stayed empty") : "the field still shows only the typed text");
return out;
`,

  // A lookup that showed nothing for the full text gets A.query typed instead.
  // Matching still uses s.text, and a miss still puts back the first prior.
  fill_ta_retype: TYPEAHEAD_LIB + String.raw`
const s = window.__perch_ta;
if (!s) return { ok: false, kind: "typeahead", error: "fill state lost (did the page navigate?)" };
["missed", "cands", "tied", "sig0", "sig", "same", "answered", "blurred"].forEach(function (k) { delete s[k]; });
taType(s.el, A.query);
return { pending: true };
`,

  // One pass over A.fields from A.from. A custom combobox needs select's
  // JXA-polled phases, so the pass stops there with {defer: index} and Node
  // resumes after it.
  fill_fields: FILL_LIB + SELECT_LIB + CHECK_LIB + CENSUS_LIB + String.raw`
// What a select, combobox or radio group already shows as chosen, or "" for
// nothing or a placeholder ("Select...", a disabled or valueless option).
const PLACEHOLDERISH = /^[\s\-\u2013\u2014]*((please )?(select|choose|pick)\b.*)?$/i;
function chosen(c) {
  if (c.group) {
    const on = c.group.opts.filter(isOn)[0];
    return on ? c.group.names[c.group.opts.indexOf(on)] : "";
  }
  const nat = nativeOf(c.el);
  if (nat) {
    const o = nat.options[nat.selectedIndex];
    return !o || o.value === "" || o.disabled || (nat.selectedIndex === 0 && PLACEHOLDERISH.test(o.text)) ? "" : o.text.trim();
  }
  const ctl = c.el;
  if (ctl.tagName === "INPUT") {
    const comp = taParts(ctl).comp;
    return shownValue(ctl) || (comp && comp.value.trim() ? ctl.value.trim() || comp.value.trim() : "") || (ctl.readOnly ? ctl.value.trim() : "");
  }
  const box = ctl.closest('.select__control, [class*="-control"], [class*="__control"]') || ctl;
  const t = shownWhole(box) ? textOf(box).trim() : "";
  return PLACEHOLDERISH.test(t) ? "" : t;
}
// This batch's landed fields by index. A pass from 0 starts it over, keyed by a
// hash of the fields alone, so every pass of a batch is the same source every
// call and stays in the page's compile cache. A later pass that finds no record
// or another batch's is on another document, which it must not write to or
// vouch for. So is one an SPA routed away from (a new path, not just a hash),
// or whose first landed field's form left and none of the landed fields can be
// found again, as a re-render would keep them. The last pass re-reads them,
// since a later field's handler may clear or change one, as a country resets
// its state.
const fp = (function (s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + s.length; })(JSON.stringify(A.fields));
const href = location.href.split("#")[0];
let ff = window.__perch_ff;
if (!A.from) ff = window.__perch_ff = { fp: fp, items: {}, href: href };
else if (!ff || ff.fp !== fp || ff.href !== href || (ff.form && !ff.form.isConnected && !Object.keys(ff.items).some(function (k) { return ff.items[k].el.isConnected || twin(ff.items[k]); }))) return { gone: true, results: [] };
// A write pass after a deferred pick, which may have moved a single-page wizard
// to its next step. Not the re-read-only last pass: a batch ending on a step's
// last pick expects exactly that.
else if (A.from < A.fields.length && stepMoved((A.fields[A.from - 1].text != null ? window.__perch_ta : window.__perch_select) || {})) return { gone: true, results: [] };
const AFTER = " after a later field changed; fill it again";
// A framework re-render replaces a node but keeps its value: a disconnected
// field is looked up again by id, then by name in its form, then by the call's
// own label_pattern (a field's own label or hint; a select, combobox or radio
// group through findCtl; a box through checkByLabel), shown ones first.
function twin(it) {
  const k = it.key || {}, ok = function (x) { return !!x && x.isConnected && x !== it.el; };
  let x = k.id && document.getElementById(k.id);
  if (ok(x)) return { el: x };
  if (k.name && k.form && k.form.isConnected) {
    x = Array.prototype.find.call(k.form.elements, function (e) { return e.name === k.name && (!("value" in k) || e.value === k.value); });
    if (ok(x)) return { el: x };
  }
  const f = it.f;
  if (!f || f.ref || f.selector || !f.label_pattern) return null;
  if (f.checked != null) { const r = checkByLabel(f); return r.el ? { el: r.el } : null; }
  if (f.option != null) {
    const c = findCtl(f, radioGroups);
    if (c.group) { const i = c.group.names.indexOf(it.pick); return { el: c.group.opts[i >= 0 ? i : 0], group: c.group }; }
    const nat = c.el && nativeOf(c.el);
    return nat ? { el: nat } : null;
  }
  const re = new RegExp(f.label_pattern, "i");
  const all = Array.prototype.filter.call(document.querySelectorAll("textarea, input, [contenteditable]"), function (e) {
    return (e.tagName !== "INPUT" || INPUT_SKIP.indexOf((e.type || "text").toLowerCase()) < 0) && (!e.hasAttribute("contenteditable") || editable(e));
  });
  const hits = all.filter(function (e) { return re.test(labelText(e)); }).concat(all.filter(function (e) { return !re.test(labelText(e)) && re.test(hintText(e)); }));
  x = hits.filter(fieldVis)[0] || hits[0];
  return ok(x) ? { el: x } : null;
}
// The form moved to another step: every shown field this batch landed, and
// the control just picked, is now hidden, and one of them sits under a hidden
// ancestor holding other fields too. That ancestor is what tells a whole step
// from a control that collapsed into a chip or a lone conditional field. A
// field that left the document with no twin is drift's to report.
function stepMoved(x) {
  const S = [{ el: x.el || x.ctl }];
  for (const k in ff.items) if (ff.items[k].shown) S.push(ff.items[k]);
  let d = false;
  for (const it of S) {
    const e = it.el, t = twin(it), el = e && e.isConnected ? e : t && t.el;
    if ((t && fieldVis(t.el)) || (el && fieldVis(el))) return false;
    for (let p = el && el.parentElement; p && !d; p = p.parentElement) d = (p.hidden || getComputedStyle(p).display === "none") && p.querySelectorAll("input:not([type=hidden]),select,textarea").length > 1;
  }
  return d;
}
function drift(it, again) {
  let el = it.el;
  if (!el.isConnected) {
    const t = !again && twin(it);
    if (!t) return { ok: false, kind: it.kind, el: it.id, error: it.id + " was removed" + AFTER };
    const n = Object.assign({}, it, t);
    if (!t.group && it.group) {
      const g = radioGroups().find(function (x) { return x.opts.indexOf(t.el) >= 0; });
      if (!g) return { ok: false, kind: it.kind, el: it.id, error: it.id + " was removed" + AFTER };
      n.group = g;
    }
    return drift(n, true);
  }
  if ("checked" in it) {
    if (isOn(el) === it.checked) return null;
    return { ok: false, kind: it.kind, el: it.id, checked: !it.checked, error: it.id + (it.checked ? " was cleared" : ' changed to "checked"') + AFTER };
  }
  let now;
  if (it.group) {
    if (isOn(el)) return null;
    now = chosen({ group: it.group });
  } else if ("sel" in it) {
    now = chosen({ el: el });
    if (el.selectedIndex === it.sel && (now || !it.want)) return null;
  } else {
    now = it.rich ? textOf(el) : el.value;
    if (now.trim() && (now === it.want || holdsText(now, it.text))) return null;
  }
  const kept = clip(now, 60);
  return { ok: false, kind: it.kind, el: it.id, kept: kept, error: it.id + (kept ? " changed to " + JSON.stringify(kept) : " was cleared") + AFTER };
}
const results = [];
const stop = function (i) {
  const out = { results: results, defer: i };
  if (ff && Object.keys(ff.items).length) out.watch = true;
  return out;
};
for (let i = A.from || 0; i < A.fields.length; i++) {
  const f = A.fields[i];
  let o, kind, got = null;
  if (f.option != null) {
    kind = "select";
    const c = findCtl(f, radioGroups, A.only);
    const v = !c.out && A.only && chosen(c);
    if (c.out) o = c.out.absent ? { ok: true, skipped: "absent" } : c.out;
    else if (v) o = { ok: true, skipped: "has value", el: c.group ? "radiogroup " + JSON.stringify(clip(c.group.q, 80)) : ident(nativeOf(c.el) || c.el), value: clip(v, 60) };
    else if (c.group) {
      o = pickRadio(c.group, f.option);
      got = { el: c.group.opts.filter(isOn)[0], group: c.group };
    } else {
      const nat = nativeOf(c.el);
      if (!nat) return stop(i);
      o = A.only && unsent(nat) ? { ok: true, skipped: "disabled", el: ident(nat) } : pickNative(nat, f.option);
      got = { el: nat, sel: nat.selectedIndex, want: chosen({ el: nat }) };
    }
  } else if (f.checked != null) {
    kind = "check";
    o = checkOne(f, A.only, function (el) { got = { el: el, checked: !!f.checked }; });
  } else {
    kind = "text";
    o = fillOne(f, A.only, function (el, rich) { if (f.text !== "") got = { el: el, rich: rich, want: rich ? textOf(el) : el.value, text: f.text }; });
    if (o.pending) return stop(i);
  }
  if (o.__perch_ref_miss) o = { ok: false, error: "ref " + o.ref + " is stale or unknown; call accessibility_snapshot again" };
  if (!o.kind) o.kind = kind;
  if (ff && got && got.el && o.ok === true && !o.skipped) {
    const same = function (x) { return x.el === got.el || (!!x.group && !!got.group && x.group.opts[0] === got.group.opts[0]); };
    Object.keys(ff.items).forEach(function (k) { if (same(ff.items[k])) delete ff.items[k]; });
    got.id = o.el;
    got.kind = o.kind;
    got.f = f;
    got.key = { id: got.el.id, name: got.el.name, form: got.el.form };
    if (!("form" in ff)) ff.form = got.el.form || got.el.closest("form") || null;
    if (got.group) got.pick = chosen({ group: got.group });
    if (got.group || "checked" in got) got.key.value = got.el.value;
    got.shown = fieldVis(got.el);
    ff.items[i] = got;
    if (kind !== "text" && i < A.fields.length - 1 && stepMoved(got)) return { results: results.concat(o), gone: true, at: i };
  }
  results.push(o);
}
const recheck = {};
if (ff) Object.keys(ff.items).forEach(function (k) { const d = drift(ff.items[k]); if (d) recheck[k] = d; });
const out = { results: results };
if (Object.keys(recheck).length) out.recheck = recheck;
if (ff && ff.form && ff.form.isConnected) {
  const c = census(ff.form), form = out.form = { requiredEmpty: c.empty.length };
  if (c.loose.length) form.unpicked = c.loose.length;
  const left = c.fields.filter(function (el) { return c.empty.indexOf(el) >= 0 || c.loose.indexOf(el) >= 0; }).slice(0, 10).map(function (el) {
    const o = {}, name = clip(el.name, 120), label = accName(el);
    if (name) o.name = name;
    if (label) o.label = label;
    return o;
  });
  if (left.length) form.left = left;
}
return out;
`,

  // select runs in phases polled from JXA (runtime `select`), never with page
  // timers: Chrome throttles those to ~1/s in background tabs.
  select_start: TYPEAHEAD_LIB + SELECT_LIB + SELECT_PICK_LIB + String.raw`
const c = findCtl(A);
if (c.out) return c.out;
const ctl = c.el;
const nat = nativeOf(ctl);
if (nat) return pickNative(nat, A.text);
const input = ctl.tagName === "INPUT" ? ctl : ctl.querySelector && ctl.querySelector("input");
// Where the choice shows: react-select v5 puts role=combobox on an inner <input>
// that it empties after a pick, so read the surrounding control instead.
const wrap = ctl.closest && ctl.closest('.select__control, [class*="-control"], [class*="__control"]');
const box = wrap || (ctl.tagName === "INPUT" ? ctl.parentElement : ctl);
// A bare input's box is its parent, which may hold only its label: its value is in the input.
const shows = wrap || ctl.tagName !== "INPUT";
const s = { ctl: ctl, input: input, box: box, polls: 0, shown: shows ? shownParts(box) : [], whole: shows ? shownWhole(box) : "", multiBox: shows && multiBox(box, labelText(ctl)) };
// A text input's value and hidden companion go back after a miss: opening or
// closing a typeahead may clear the text it holds.
if (input && input.tagName === "INPUT") { s.prior = input.value; s.comp = taParts(input).comp; s.priorComp = s.comp && s.comp.value; }
// Other open menus would cover this one or grab its keys: Escape them first, but
// not a combobox inside this control's own popup (cmdk's search box).
const popups = [ctl, input].filter(Boolean).map(function (e) { return document.getElementById(attr(e, "aria-controls")); }).filter(Boolean);
document.querySelectorAll("[role=combobox][aria-expanded=true], [aria-haspopup][aria-expanded=true]").forEach(function (o) {
  if (mine(s, o) || popups.some(function (p) { return p.contains(o); })) return;
  pressEscape(o);
  if (document.activeElement === o && o.blur) o.blur();
});
s.before = Array.from(document.querySelectorAll(OPT)).filter(vis);
// A press on an open react-select closes it, so an open menu is used as is.
const open = [ctl, input].some(function (e) { return attr(e, "aria-expanded") === "true"; }) || ownOptions(s).length > 0;
if (!open) {
  // react-select and friends open on a left-button press with a view, on the control
  // wrapper. Pressed before focus: a React 18 control that sees its own focus event
  // only a microtask later takes a press right after focus() as unfocused.
  pressFocus(wrap || ctl, input || ctl);
  s.opened = true;
}
s.openEl = wrap || ctl;
window.__perch_select = s;
return { pending: true };
`,

  // null = keep polling. The unfiltered list is matched first; a filter is typed
  // only when that has no match (an async or virtualized list, or one that opens
  // on input), cut at the first punctuation so a strict filter can't empty it.
  select_pick: SELECT_LIB + SELECT_PICK_LIB + String.raw`
const s = window.__perch_select;
if (!s) return { ok: false, error: "select state lost (did the page navigate?)" };
s.polls++;
const all = ownOptions(s);
const opts = all.filter(function (o) { return !optOff(o); });
const texts = opts.map(textOf), keys = new Map();
opts.forEach(function (o, i) { keys.set(o, norm(texts[i])); });
if (!s.typed && opts.length) s.cands = texts.slice(0, 30).map(function (t) { return clip(t, 60); });
// Every preference is matched against the list as it is, in order, before any typing.
let opt = null;
wantL.some(function (w, i) { opt = bestMatch(opts, function (o) { return keys.get(o); }, w); s.pref = i; return !!opt; });
if (opt) {
  s.picked = clip(textOf(opt), 80);
  s.pickedN = keys.get(opt);
  s.optEl = opt;
  s.multi = isMulti(s, opt);
  if (chosenAlready(s, opt, s.pickedN)) s.already = true;
  else press(opt);
  return { picked: s.picked };
}
const box = s.input || s.filter;
// A disabled match short of exact settles only once no search box could still turn up an enabled one.
const offM = !s.typed && wantN ? matchTier(all.filter(optOff), function (o) { return norm(textOf(o)); }, wantN) : { hits: [] };
if (offM.hits.length) {
  s.disabled = clip(textOf(offM.hits.sort(function (a, b) { return textOf(a).length - textOf(b).length; })[0]), 60);
  if (offM.exact || !box) return { settled: true };
}
// A combobox that opens only on input events (Downshift) may have a toggle button
// naming the same list; pressed once the press on the control has had a poll to show.
if (s.opened && !all.length && !s.toggled && s.polls >= 2 && !stillOpen(s)) {
  const ids = [s.ctl, s.input].map(function (e) { return attr(e, "aria-controls"); }).filter(Boolean);
  const tog = ids.length && Array.from(document.querySelectorAll("button[aria-controls]")).find(function (b) { return b !== s.ctl && ids.indexOf(attr(b, "aria-controls")) >= 0; });
  if (tog) { press(tog); s.toggled = true; return null; }
}
// A miss settles ({settled}) once the list has held: text:"" after 3 polls; a
// no-match after 8 (about 400ms), and after a typed filter only once the list
// has changed since typing, so a debounce's stale list is not the answer. An
// empty list keeps waiting, unless the filter emptied a list that had options
// and it stays empty 8 polls with nothing loading; one empty before typing may
// be an async list.
const sig = opts.length ? Array.from(keys.values()).join("\n") : null;
s.same = sig && sig === s.sig ? s.same + 1 : 0;
s.sig = sig;
if (s.typed && sig !== s.typedSig) s.answered = true;
if (sig && s.same >= (wantN ? 8 : 3) && (!wantN || s.answered || !box)) return { settled: true };
if (s.typed && s.typedSig && !sig) {
  s.emptied = loadingIn([s.ctl, s.input, s.box, s.pop, s.listRoot].concat(linkedLists(s))) ? 0 : (s.emptied || 0) + 1;
  if (s.emptied >= 8) return { settled: true };
} else s.emptied = 0;
if (!s.typed && wantN && box && s.polls >= 4) {
  const q = wantT.trim().split(/[^\p{L}\p{N} ]/u)[0].trim() || wantT.trim();
  // Taken before typing: a list that re-renders on input detaches its options at once.
  if (opts.length) s.listRoot = opts[0].parentElement;
  if (box.focus) box.focus();
  setNativeValue(box, q);
  fire(box, ["input"]);
  s.typed = box;
  s.typedSig = sig;
}
return null;
`,

  // Candidates come from the control's own list, unfiltered when it was seen; the
  // typed filter is cleared and a menu select opened is closed again.
  select_miss: TYPEAHEAD_LIB + TA_UI_LIB + SELECT_LIB + SELECT_PICK_LIB + EDIT_LIB + String.raw`
const s = window.__perch_select;
if (!s) return { ok: false, error: "select state lost (did the page navigate?)" };
const now = ownOptions(s).filter(function (o) { return !optOff(o); }).slice(0, 30).map(function (o) { return clip(textOf(o), 60); });
const cands = s.cands || now;
if (s.typedTrusted) { editClear(s.typed); taBlur(s.typed); }
else if (s.typed) { setNativeValue(s.typed, ""); fire(s.typed, ["input"]); }
if (s.prior != null && s.input.value !== s.prior) { setNativeValue(s.input, s.prior); fire(s.input, ["input", "change"]); }
if (s.comp && s.comp.value !== s.priorComp) setNativeValue(s.comp, s.priorComp);
// Escape on a closed Downshift menu clears its selection, so only an open one gets it.
if (s.opened && stillOpen(s)) escapeOwn(s);
if (s.disabled) return { ok: false, error: "the matching option " + JSON.stringify(s.disabled) + " is disabled", candidates: cands };
if (!cands.length) return { ok: false, error: "the control's option list did not open or is empty" + (A.trusted ? "" : "; retry with select {trusted:true}"), candidates: [] };
const out = { ok: false, error: wantN ? "no option of this control matched" : "empty text: candidates lists this control's options", candidates: cands };
// For fill's preference list: a typed filter missed, so a later preference may still turn up.
if (s.typed && Array.isArray(A.text)) out.filtered = true;
return out;
`,

  // select {trusted}: whether the synthetic open showed the control's own list.
  select_open: SELECT_LIB + SELECT_PICK_LIB + String.raw`
const s = window.__perch_select;
return !!s && stillOpen(s);
`,

  // select {trusted} in a background tab, where no trusted click can open the menu:
  // types a filter into the control's own empty text box through the editing
  // command. The box is the control itself, its inner input, an input in its box,
  // or a search box in its linked popup; never one elsewhere. {none}: no such box.
  select_type: TYPEAHEAD_LIB + TA_UI_LIB + SELECT_LIB + SELECT_PICK_LIB + EDIT_LIB + String.raw`
const s = window.__perch_select;
if (!s) return { ok: false, error: "select state lost (did the page navigate?)" };
const lists = linkedLists(s);
const own = [s.input].concat(Array.from(s.box.querySelectorAll ? s.box.querySelectorAll("input") : []));
lists.forEach(function (m) { own.push.apply(own, Array.from(m.querySelectorAll("input"))); });
const el = own.find(function (i) {
  if (!i || i.tagName !== "INPUT" || !/^(text|search)$/.test((i.type || "text").toLowerCase()) || i.disabled || i.readOnly || i.value) return false;
  if (/^(tel|numeric|decimal|email)$/.test(attr(i, "inputmode"))) return false;
  if (lists.some(function (m) { return m.contains(i); })) return true;
  return !i.closest("[role=search]") && (s.ctl.contains(i) || s.box.contains(i));
});
if (!el) return { none: true };
// The option's text up to its first punctuation, so a strict filter can't empty the list.
const t = wantT.trim(), cut = t.split(/[,;(\/-]/)[0].trim().slice(0, 30);
const e = editType(el, cut.length >= 2 ? cut : t.slice(0, 30));
if (!e.ok) {
  editClear(el);
  taBlur(el);
  return { ok: false, error: "the picker ignored background typing", trusted: [] };
}
s.typed = el;
s.typedSig = null;
s.typedTrusted = true;
return { ok: true };
`,

  // Until the control shows the choice: null (keep polling); A.final reports anyway.
  // A.keep leaves an open popup alone, so a pick that didn't show can still be clicked.
  select_read: SELECT_LIB + SELECT_PICK_LIB + String.raw`
const s = window.__perch_select;
if (!s) return { ok: false, error: "the page changed after the pick was pressed; not verified" };
// A popup select opened and a pick left open (a multi-select) closes again.
if (s.opened && !s.closed && !A.keep) { s.closed = true; if (stillOpen(s)) escapeOwn(s); }
// An input's own value first: its wrapper may hold only its label.
const iv = (s.input && s.input.value) || "";
const has = function (t) { return s.multi ? norm(t).indexOf(s.pickedN) >= 0 : norm(t) === s.pickedN; };
const full = (iv && has(iv) ? iv : textOf(s.box)) || iv;
const parts = full === iv ? [] : shownParts(s.box);
const shown = clip(parts.length > 1 && !/[,;\n]/.test(full) ? parts.join(", ") : full, 120);
// A single value must equal the pick; one that grew from the prior value may be a
// multi-select without chips, so its newest element or comma part counts.
const now = norm(full);
const grew = !s.multi && s.whole && now !== s.whole && now.indexOf(s.whole) === 0;
const seen = has(full) || (!s.multi && parts.some(function (t) { return norm(t) === s.pickedN; })) || (grew && (commaParts(now.slice(s.whole.length)).indexOf(s.pickedN) >= 0 || parts.some(function (t) { return norm(t) === s.pickedN && s.shown.indexOf(t) < 0; })));
if (!seen && !A.final) return null;
const out = { ok: true, selected: s.picked, el: ident(s.ctl), value: shown };
if (s.pref) out.pref = s.pref;
if (!seen) out.unverified = true;
if (s.already) out.note = "already chosen; not pressed again, since a press would toggle it off";
return out;
`,

  // A.probe: a click that opens a new tab stops before clicking, keeping a
  // closure over its element that CLICK_BLANK_GO, the second pass, runs; the
  // runtime brackets that with reads of the window's tabs. Only a readback
  // click carries READBACK_LIB (click_readback).
  click: BLANK_LIB + CLICK_BODY,
  click_readback: READBACK_LIB + BLANK_LIB + CLICK_BODY,

  readback_arm: READBACK_LIB + String.raw`
return rbArm(A.probed && window.__perch_trusted ? window.__perch_trusted.el : null) || { ok: true };
`,

  // null (keep polling) until the text or url moved, or the page stayed quiet for
  // 10 polls; A.final settles for what's there.
  // No state means a new document: wait for it to show the element, or give up at final.
  readback_read: READBACK_LIB + String.raw`
const s = window.__perch_rb;
const text = rbText();
if (!s) {
  if (!A.final && (text == null || document.readyState === "loading")) return null;
  return { readback: text, changed: true, navigated: true, url: location.href };
}
const moved = location.href !== s.url;
// A class change must still be there on the next poll.
const cls = rbCls();
const clsMoved = cls !== s.cls && cls === s.clsSeen;
s.clsSeen = cls !== s.cls ? cls : null;
// Invalid fields added or reworded since arming end the wait, and so do cleared
// ones; a field matches its earlier self by element or, when re-rendered, by name.
const inv = invalidSet();
const same = function (p, c) { return p.el === c.el || p.name === c.name; };
const invNew = inv.filter(function (c) { return !s.inv.some(function (p) { return same(p, c) && p.msg === c.msg; }); });
const invGone = s.inv.some(function (p) { return !inv.some(function (c) { return same(p, c); }); });
// A busy flag the form scope didn't show at arm time: it is posting, so disabled
// flags that differ are not an outcome.
const held = !!s.held && s.form.isConnected && rbHeld(s.form).some(function (el) { return s.held.indexOf(el) < 0; });
const sigMoved = held ? rbSig(true) !== s.sigOn : rbSig() !== s.sig;
// The form's own outcome: gone, a new step, or a new alert or live-region text.
let form = null;
if (s.form) {
  form = {};
  if (!rbShown(s.form)) form.gone = true;
  else {
    const step = stepOf(s.form);
    if (s.step != null && step != null && step !== s.step) form.step = step;
    const fresh = rbAlerts(inv).filter(function (t) { return s.alerts.indexOf(t) < 0; });
    if (fresh.length) form.alert = clip(fresh.join(" | "), 140);
  }
  if (!Object.keys(form).length) form = null;
}
const changed = moved || text !== s.text || sigMoved || clsMoved || invNew.length > 0 || invGone || !!form;
// A submit button that only relabels or disables itself ("Submitting..."), or a
// form that newly shows a busy flag after one, is mid-flight, not an outcome: keep polling
// for one until the page settles. That holds whatever the readback is on, while
// nothing outside the button and those flags changed.
const busy = rbBusy(s);
const node = s.btn && s.btn.isConnected ? document.querySelector(A.readback) : null;
const onBtn = !!node && (node === s.btn || s.btn.contains(node));
const inFlight = !!s.btn && s.btn.isConnected && (onBtn || !s.away) && (textOf(s.btn) !== s.btnText || !!s.btn.disabled !== s.btnOff || held) && !moved && !clsMoved && !invNew.length && !invGone && !form;
// Ten polls in a row with no page activity (about 670ms live) settle it early.
// A hidden tab runs its timers about once a second, so there the quiet stretch
// must also last 1.2s of page time, long enough for one throttled tick to fire.
if (busy) { s.quiet = 0; s.calm = Date.now(); }
else s.quiet++;
const settled = s.quiet >= 10 && (document.visibilityState !== "hidden" || Date.now() - s.calm >= 1200);
if ((!changed || inFlight) && !A.final && !settled) return null;
rbStop(s);
delete window.__perch_rb;
const out = { readback: text, changed: changed };
if (moved) out.url = location.href;
if (invNew.length) {
  out.invalid = inv.slice(0, 5).map(function (c) { return clip(c.name + (c.msg ? ": " + c.msg : ""), 140); });
  if (inv.length > 5) out.invalidCount = inv.length;
}
if (form) out.form = form;
return out;
`,

  // Synthetic key events trigger no browser defaults, so the ones pages rely on are emulated.
  press: TABBABLE_LIB + String.raw`
const r = resolveEl(A);
if (r.out) return r.out;
if (r.el) r.el.focus();
const el = document.activeElement || document.body;
function send(type, t) {
  // Older handlers read the legacy keyCode/which. Chrome and Safari take them from the init, which
  // reaches the page's world; a property defined here would not, so it is only a fallback.
  const e = new KeyboardEvent(type, { key: A.key, code: A.code, keyCode: A.keyCode, which: A.keyCode, ctrlKey: A.ctrlKey, shiftKey: A.shiftKey, altKey: A.altKey, metaKey: A.metaKey, bubbles: true, cancelable: true, composed: true });
  if (e.keyCode !== A.keyCode) {
    Object.defineProperty(e, "keyCode", { get: function () { return A.keyCode; } });
    Object.defineProperty(e, "which", { get: function () { return A.keyCode; } });
  }
  return !t.dispatchEvent(e);
}
let prevented = send("keydown", el);
if (!prevented && (A.key.length === 1 || A.key === "Enter") && !A.ctrlKey && !A.metaKey) prevented = send("keypress", el);
if (!prevented && !A.ctrlKey && !A.metaKey && !A.altKey) {
  const ro = role(el);
  if (A.key === "Enter" && (ro === "button" || ro === "link")) el.click();
  else if (A.key === " " && /^(button|checkbox|radio)$/.test(ro)) el.click();
  else if (A.key === "Enter" && el.tagName === "INPUT" && el.form) {
    // Implicit submission clicks the form's default button when it has one.
    const b = el.form.querySelector("button:not([type]), [type=submit]");
    if (b) b.click(); else el.form.requestSubmit();
  } else if (A.key === "Tab") {
    const all = tabbables();
    const i = all.indexOf(el), n = all.length;
    if (n) all[A.shiftKey ? (i <= 0 ? n - 1 : i - 1) : (i + 1) % n].focus();
  }
}
const f = document.activeElement;
send("keyup", f || el);
return { ok: true, el: ident(el), prevented: prevented, focus: f && f !== document.body ? ident(f) : null };
`,

  // JS-driven hover menus listen for these; CSS :hover needs a real pointer.
  hover: CLICK_LIB + String.raw`
const r = resolveClick(A);
if (r.out) return r.out;
const b = r.el.getBoundingClientRect();
const at = { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, pointerType: "mouse", composed: true };
const P = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
[["pointerover", P, true], ["pointerenter", P, false], ["mouseover", MouseEvent, true], ["mouseenter", MouseEvent, false], ["pointermove", P, true], ["mousemove", MouseEvent, true]].forEach(function (s) {
  r.el.dispatchEvent(new s[1](s[0], Object.assign({ bubbles: s[2], cancelable: s[2] }, at)));
});
return { ok: true, el: ident(r.el) };
`,

  file_upload: UPLOAD_LIB + String.raw`
const isFile = function (el) { return el.tagName === "INPUT" && (el.type || "").toLowerCase() === "file"; };
const ext = "." + A.name.split(".").pop().toLowerCase(), mime = A.mime.toLowerCase();
function fits(el) {
  const acc = attr(el, "accept").toLowerCase().split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return !acc.length || acc.some(function (a) { return a === ext || a === mime || (/\/\*$/.test(a) && mime.indexOf(a.slice(0, -1)) === 0); });
}
const words = function (el) { return [labelText(el), attr(el, "aria-label"), attr(el, "name"), el.id].join(" ").replace(/[_-]/g, " "); };
// Accept fit first, then a resume/CV name; an autofill/parser input is someone else's field.
function score(el) {
  const w = words(el);
  return (fits(el) ? 4 : 0) + (/resume|résumé|\bcv\b|curriculum/i.test(w) ? 2 : 0) - (/auto ?fill|pars(e|er|ing)|import/i.test(w) ? 3 : 0);
}
const best = function (files) { return files.map(function (el, i) { return { el: el, s: score(el), i: i }; }).sort(function (a, b) { return b.s - a.s || a.i - b.i; })[0].el; };
// A zone's own file input: one inside it, else the only one within 3 ancestors.
function inputFor(z) {
  const inner = deepAll("input[type=file]", z);
  if (inner.length) return { input: best(inner), many: inner.length > 1 };
  for (let p = z.parentElement, k = 0; p && k < 3 && p !== document.body; p = p.parentElement, k++) {
    const f = p.querySelectorAll("input[type=file]");
    if (f.length === 1) return { input: f[0] };
    if (f.length > 1) break;
  }
  return {};
}
window.__perch_up = null;
let input = null, zone = null, many = false;
if (A.ref) {
  const r = resolveEl(A);
  if (r.out) return r.out;
  if (isFile(r.el)) input = r.el; else zone = r.el;
} else if (A.label_pattern) {
  const re = new RegExp(A.label_pattern, "i"), pat = "/" + A.label_pattern + "/i";
  const files = deepAll("input[type=file]").filter(function (el) { return re.test(words(el)); });
  if (files.length) { many = files.length > 1; input = best(files); }
  else {
    const hits = [];
    const add = function (el) { if (el && hits.indexOf(el) < 0 && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) && vis(el)) hits.push(el); };
    const tw = document.createTreeWalker(document.body, 4);
    while (tw.nextNode()) if (re.test(tw.currentNode.nodeValue)) add(tw.currentNode.parentElement);
    deepAll("[aria-label]").forEach(function (el) { if (re.test(attr(el, "aria-label"))) add(el); });
    if (!hits.length) return { ok: false, error: "no file input or drop zone matched " + pat };
    if (hits.length > 1) return { ok: false, ambiguous: true, error: "several elements matched " + pat + "; narrow it, or use a selector or ref", candidates: hits.slice(0, 8).map(ident) };
    zone = hits[0];
  }
} else {
  const sel = A.selector || "input[type=file]";
  let all;
  try { all = deepAll(sel); } catch (e) { return { ok: false, error: "bad selector: " + sel }; }
  if (!all.length) return { ok: false, error: "no element for selector " + sel + (A.selector ? "" : "; for a drop zone pass its selector, ref or label_pattern") };
  const files = all.filter(isFile);
  if (files.length) { many = files.length > 1; input = best(files); } else zone = all[0];
}
if (zone) { const f = inputFor(zone); input = f.input || null; many = many || !!f.many; }
const bin = atob(A.b64);
const arr = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
const file = new File([arr], A.name, { type: A.mime });
const dt = new DataTransfer();
dt.items.add(file);
const out = { ok: true, name: file.name, size: file.size, type: file.type };
const U = { dt: dt, zone: zone, input: null, obs: null, moved: false, names: 0 };
if (!input) { U.names = nameCount(A.name); window.__perch_up = U; return Object.assign(out, dropOn(U)); }
const who = ident(input) + (input.id ? " #" + input.id : "");
// A hidden input that no form submits may have no handler reading it; a change
// handler we can see, or any page change or completed fetch/XHR after change,
// counts as handled, else Node falls back to a drop.
const watch = !vis(input) && !(input.form && input.name) && typeof MutationObserver === "function";
// Change handlers readable from this world: an onchange property, or the props
// React (__reactProps$, __reactEventHandlers$ before 17) and Vue 3 (_vei) keep
// on the element. An isolated world sees none of them.
function heard(el) {
  if (typeof el.onchange === "function") return true;
  return Object.keys(el).some(function (k) {
    const v = el[k];
    return !!v && (/^__react(Props|EventHandlers)\$/.test(k) || k === "_vei") && typeof v.onChange === "function";
  });
}
if (watch) {
  U.names = nameCount(A.name);
  U.net = upNet();
  U.input = input;
  U.obs = new MutationObserver(function () {});
  U.obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
}
// CSS-hidden inputs reject .files assignment; unhide with !important, then restore.
const orig = { display: input.style.display, visibility: input.style.visibility, hidden: input.hidden };
input.hidden = false;
input.style.setProperty("display", "block", "important");
input.style.setProperty("visibility", "visible", "important");
input.files = dt.files;
const set = has(input);
let changed = false;
input.addEventListener("change", function () { changed = true; }, { once: true });
fire(input, ["change", "input", "blur"]);
setTimeout(function () { input.hidden = orig.hidden; input.style.display = orig.display; input.style.visibility = orig.visibility; }, 150);
if (many) { out.ambiguous = true; out.el = who; }
if (input.isConnected && has(input)) {
  if (watch) {
    if (!U.zone) for (let p = input.parentElement, k = 0; p && k < 3 && p !== document.body; p = p.parentElement, k++) if (vis(p)) { U.zone = p; break; }
    if (U.zone && !heard(input) && !uploadSeen(A.name, U)) { window.__perch_up = U; out.unwired = true; return out; }
    U.obs.disconnect();
  }
  return out;
}
if (U.obs) U.obs.disconnect();
if (!set || !changed) return Object.assign(out, { ok: false, error: "the input did not take the file: " + who });
// Sites often swap or empty the input once their change handler has the file.
if (!input.isConnected) out.detached = true; else out.cleared = true;
out.shown = deepAll("input[type=file]").some(has) || textOf(document.body).indexOf(A.name) >= 0;
return out;
`,

  // Polled from Node after a cleared/detached upload read shown:false: many sites
  // render the file name on a later tick. null keeps polling. A.up reads the
  // drop state file_upload left instead.
  file_upload_shown: UPLOAD_LIB + String.raw`
const U = window.__perch_up;
if (A.up) return (!!U && uploadSeen(A.name, U)) || null;
return deepAll("input[type=file]").some(has) || textOf(document.body).indexOf(A.name) >= 0 || null;
`,

  // The fallback for a hidden input nothing reacted to: empty it, drop on its zone.
  file_upload_drop: UPLOAD_LIB + String.raw`
const U = window.__perch_up;
if (!U || !U.zone || !U.zone.isConnected) return { ok: false, error: "the drop zone left the page" };
if (U.obs) { U.obs.disconnect(); U.obs = null; }
if (U.input && U.input.isConnected) U.input.files = new DataTransfer().files;
U.input = null;
return dropOn(U);
`,

  // Chrome runs this in an isolated world, whose console the page never calls. A
  // <script> patches the main world's console and relays entries as perch:console
  // events (DOM events cross worlds). If CSP blocks it, the local console is patched.
  console_start: String.raw`
const s = window.__perch_console;
if (s && s.installed) return { ok: true, already: true, count: s.entries.length };
const st = { entries: [], dropped: 0, installed: true, bridge: false, unhook: null };
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
// Runs in whichever world ends up patched; the returned function undoes it all.
function hooks(safe, emit) {
  const orig = {};
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    orig[level] = console[level];
    console[level] = function () {
      try {
        const parts = [];
        for (let i = 0; i < arguments.length; i++) parts.push(safe(arguments[i]));
        emit(level + ": " + parts.join(" "));
      } catch (e) {}
      return orig[level].apply(this, arguments);
    };
  });
  orig.assert = console.assert;
  console.assert = function (cond) {
    try {
      if (!cond) {
        const parts = [];
        for (let i = 1; i < arguments.length; i++) parts.push(safe(arguments[i]));
        emit("error: Assertion failed" + (parts.length ? ": " + parts.join(" ") : ""));
      }
    } catch (e) {}
    return orig.assert.apply(this, arguments);
  };
  const onError = function (ev) {
    try {
      // A failed <img>/<script> load fires on the element (a Node); script errors fire on window.
      if (ev.target && ev.target.nodeType) return;
      const er = ev.error;
      let text = String(ev.message || "").replace(/^Uncaught /, "");
      if (er && typeof er === "object" && er.name) text = er.name + ": " + (typeof er.message === "string" ? er.message : text);
      let loc = "";
      if (ev.filename) loc = " (" + [ev.filename].concat(ev.lineno ? [ev.lineno].concat(ev.colno ? [ev.colno] : []) : []).join(":") + ")";
      emit("error: " + safe("Uncaught " + text + loc));
    } catch (e) {}
  };
  const onRejection = function (ev) {
    try { emit("error: Unhandled rejection: " + safe(ev.reason)); } catch (e) {}
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return function () {
    for (const k in orig) console[k] = orig[k];
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
function mainWorld(safe, hooks) {
  if (window.__perchConsoleBridge) return;
  window.__perchConsoleBridge = true;
  const unhook = hooks(safe, function (entry) { document.dispatchEvent(new CustomEvent("perch:console", { detail: entry })); });
  const ping = function () { document.dispatchEvent(new CustomEvent("perch:console-pong")); };
  const stop = function () {
    unhook();
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
script.textContent = "(" + mainWorld + ")(" + safe + ", " + hooks + ");";
(document.head || document.documentElement).appendChild(script);
script.remove();
const pong = function () { st.bridge = true; };
document.addEventListener("perch:console-pong", pong);
document.dispatchEvent(new CustomEvent("perch:console-ping"));
document.removeEventListener("perch:console-pong", pong);
if (!st.bridge) st.unhook = hooks(safe, push);
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
if (s.unhook) s.unhook();
document.removeEventListener("perch:console", s.relay);
s.installed = false;
return { ok: true, entries: s.entries.splice(0) };
`,

  // Completed requests from Resource Timing, which the browser buffers on its own:
  // no patching, no start. The cursor lives on a global, so navigation resets both.
  // The buffer starts at the spec's 250 and is raised to 1000 on the first read; a
  // full buffer means the browser stopped recording.
  network_read: String.raw`
if (typeof performance.getEntriesByType !== "function") return { ok: false, error: "network: this browser has no Resource Timing" };
const st = window.__perch_net || (window.__perch_net = { seen: 0, cap: 250 });
const all = performance.getEntriesByType("resource");
if (all.length < st.seen) st.seen = 0;
const out = { ok: true, requests: [] };
if (all.length >= st.cap) out.full = true;
if (st.cap < 1000 && performance.setResourceTimingBufferSize) { performance.setResourceTimingBufferSize(1000); st.cap = 1000; }
function size(e) {
  const n = e.transferSize || 0;
  if (!n && e.decodedBodySize > 0) return "cache";
  return n < 1000 ? n + "B" : n < 1e6 ? (n / 1e3).toFixed(1) + "kB" : (n / 1e6).toFixed(1) + "MB";
}
for (const e of all.slice(st.seen, st.seen + 100)) {
  const url = e.name.length > 200 ? e.name.slice(0, 200) + "..." : e.name;
  out.requests.push((e.responseStatus || "-") + " " + e.initiatorType + " " + Math.round(e.duration) + "ms " + size(e) + " " + url);
}
st.seen += out.requests.length;
if (all.length > st.seen) out.more = all.length - st.seen;
return out;
`,

  trusted_probe: TRUSTED_PROBE_HEAD + TRUSTED_PROBE_TAIL,
  // fill's probe also records a typeahead (as trusted_fill_background does)
  // before the field is cleared, so the check can hand it to the pick.
  trusted_fill_probe: TYPEAHEAD_LIB + TRUSTED_PROBE_HEAD + String.raw`
if (A.forFill) {
  const ta = isTypeahead(el) && taParts(el);
  window.__perch_ta = ta ? { el: el, comp: ta.comp, pop: ta.pop, prior: el.value, priorComp: ta.comp && ta.comp.value } : null;
}
` + TRUSTED_PROBE_TAIL,

  // A click by point has no element to probe, so it takes the viewport rects of
  // the page's embedded frames, plus the page's own estimate of its screen origin
  // for when Accessibility can't place the page. It also arms trusted_check's
  // recorder: the first trusted mousedown and what it landed on.
  trusted_frames: String.raw`
const out = { iw: innerWidth, ih: innerHeight, ox: screenX + outerWidth - innerWidth, oy: screenY + outerHeight - innerHeight, rects: [] };
deepAll("iframe, frame, object, embed").forEach(function (f) {
  const r = f.getBoundingClientRect();
  if (r.width && r.height) out.rects.push([r.left, r.top, r.right, r.bottom]);
});
const prev = window.__perch_trusted;
if (prev && prev.off) prev.off();
const st = window.__perch_trusted = { down: null, moves: [] };
const onDown = function (e) {
  if (!e.isTrusted) return;
  const at = e.composedPath ? e.composedPath()[0] : e.target;
  st.down = true;
  st.at = at && at.nodeType === 1 ? ident(at) : null;
  window.removeEventListener("mousedown", onDown, true);
};
window.addEventListener("mousedown", onDown, true);
st.off = function () { window.removeEventListener("mousedown", onDown, true); };
return out;`,

  // Drains recorded mouse moves as [clientX, clientY, screenX, screenY]; null if none.
  // A.reset only clears them.
  trusted_cal: String.raw`
const st = window.__perch_trusted || {};
const moves = st.moves || [];
st.moves = [];
return A.reset || !moves.length ? null : { moves: moves };
`,

  // Background trusted fill through the editing command (EDIT_LIB).
  // A.held: the field a fill_fields pass resolved for a trusted entry and
  // held on __perch_ta, taken once. A plain one that lands joins that batch's
  // __perch_ff at A.at, so later passes recheck it as they do their own.
  trusted_fill_background: TYPEAHEAD_LIB + EDIT_LIB + String.raw`
let el;
if (A.held) {
  const h = window.__perch_ta;
  el = h && h.held && h.el;
  if (!el || !el.isConnected) return { ok: false, error: "the page changed before the trusted entry; not filled" };
  h.held = false;
} else if (A.ref || A.selector) {
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
if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return { ok: false, el: ident(el), error: "fill {trusted:true} supports plain inputs/textareas only" };
if (el.disabled || el.readOnly) return { ok: false, error: ident(el) + " is disabled or read-only" };
// A typeahead keeps only a picked suggestion: Node picks after the lookup.
const ta = isTypeahead(el) && taParts(el);
if (ta) window.__perch_ta = { el: el, comp: ta.comp, pop: ta.pop, text: A.text, prior: el.value, priorComp: ta.comp && ta.comp.value };
const e = editType(el, A.text);
if (!e.focused) return { ok: false, error: ident(el) + " did not accept focus" };
if (e.ok && ta) {
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: A.text.slice(-1) }));
  return { pending: true, trusted: true };
}
const ff = A.held && e.ok && window.__perch_ff;
if (ff) {
  for (const k in ff.items) if (ff.items[k].el === el) delete ff.items[k];
  ff.items[A.at] = { el: el, want: el.value, text: A.text, id: ident(el), kind: "plain", f: A.f, key: { id: el.id, name: el.name, form: el.form }, shown: vis(el) };
  if (!("form" in ff)) ff.form = el.form || el.closest("form");
}
return { ok: e.ok, trusted: e.trusted, value: e.value, el: ident(el), ...(e.ok ? {} : { error: "background editing did not produce the requested trusted input" }) };
`,

  // hit: the mousedown landed on the element (a click by point: on the page, at
  // `el`); null: no mousedown reached the page; missing: no recorder, a new document.
  trusted_check: String.raw`
const st = window.__perch_trusted || {};
if (st.off) st.off();
const out = { hit: st.down };
if (st.at) out.el = st.at;
if (st.cancelled) out.cancelled = true;
if (A.forFill && st.el) {
  const got = String(st.el.value || ""), text = A.text;
  const norm = function (s) { return s.replace(/\r\n/g, "\n").replace(/\s+/g, " "); };
  // A phone mask reformats or drops a country code (plain fill's rule).
  const d = got.replace(/\D/g, ""), t = text.replace(/\D/g, "");
  const masked = d.length >= 7 && t.length >= 7 && (t.slice(-d.length) === d || d.slice(-t.length) === t);
  out.len = got.length;
  out.ok = got === text || norm(got) === norm(text) || masked;
  if (!out.ok) out.error = "trusted typing left a different value (" + got.length + " chars: " + JSON.stringify(clip(got, 40)) + ")";
  // A typeahead keeps only a picked suggestion: Node picks next.
  const ta = window.__perch_ta;
  if (out.ok && ta && ta.el === st.el) {
    if (out.hit !== true) { out.ok = false; out.error = "the click did not reach " + ident(st.el) + ", so no suggestion can be picked"; }
    else { ta.text = text; return { hit: true, pending: true, trusted: true }; }
  }
}
return out;
`,

  // Focuses the ref/selector element (else keeps document.activeElement) and
  // records the first keydown and keyup the window sees.
  trusted_key_arm: TABBABLE_LIB + String.raw`
const framed = function (e) { return e && /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(e.tagName) ? { ok: false, error: ident(e) + " is an embedded frame; frames take only click {trusted:true}" } : null; };
let el = document.activeElement;
if (A.ref || A.selector) {
  const r = resolveEl(A);
  if (r.out) return r.out;
  el = r.el;
  if (framed(el)) return framed(el);
  el.focus({ preventScroll: true });
  if (el.getRootNode().activeElement !== el) return { ok: false, error: ident(el) + " did not accept focus" };
}
if (framed(el)) return framed(el);
// A real Tab past either end leaves the page for the browser's toolbar, where the
// next trusted key would act on the browser instead (Enter reloads the tab).
if (A.key === "Tab" && el) {
  const all = tabbables(), i = all.indexOf(el);
  if (i >= 0 && i === (A.shift ? 0 : all.length - 1)) return { ok: false, error: ident(el) + " is the page's " + (A.shift ? "first" : "last") + " focusable element; a real Tab would move focus into the browser's toolbar" };
}
const prev = window.__perch_key;
if (prev) prev.off();
const st = window.__perch_key = { want: A.key, down: null, up: null };
const rec = function (e) {
  const k = e.type === "keydown" ? "down" : "up";
  if (!st[k]) st[k] = { key: e.key, trusted: e.isTrusted };
};
window.addEventListener("keydown", rec, true);
window.addEventListener("keyup", rec, true);
st.off = function () { window.removeEventListener("keydown", rec, true); window.removeEventListener("keyup", rec, true); };
return { ok: true, el: el ? ident(el) : null };
`,

  // hit: a trusted keydown with the expected key; false: untrusted or another key;
  // null: no keydown reached the page. null (keep polling) until the keyup, unless A.final.
  trusted_key_check: String.raw`
const st = window.__perch_key;
if (!A.final && !(st && st.down && st.up)) return null;
if (st) { st.off(); delete window.__perch_key; }
const d = st && st.down;
const a = document.activeElement;
return { hit: d ? d.trusted === true && d.key === st.want : null, focus: a ? ident(a) : null };
`,

  // What a frame click needs from the page: its URL and viewport.
  viewport: "return { url: location.href, iw: innerWidth, ih: innerHeight };",

  // screenshot {ref|selector}: the element's client rect in view, scrolled the
  // least way in (a no-op when it is fully visible). One larger than the
  // viewport, or still clipped by a scrolling ancestor, is refused; the second
  // with restore:true, since the scroll already happened.
  // Every scroll position that can move (each ancestor's, across shadow roots,
  // and the window's) is kept on window.__perch_shot for shot_restore, and only
  // once the element is known to have a box. After a scroll, a hidden document
  // (a covered or minimized window) paints nothing, so the crop is refused for
  // the restore; a visible one counts two animation frames for shot_painted.
  shot_clip: String.raw`
const r = resolveEl(A);
if (r.out) return r.out;
const el = r.el;
if (el.ownerDocument !== document) return { ok: false, error: ident(el) + " lies in an embedded frame; screenshot without ref or selector" };
const b = el.getBoundingClientRect();
if (!b.width || !b.height) return { ok: false, error: ident(el) + " has no size (hidden or offscreen)" };
const iw = innerWidth, ih = innerHeight;
if (b.width > iw || b.height > ih) return { ok: false, error: "screenshot: the element is larger than the viewport (" + Math.round(b.width) + "x" + Math.round(b.height) + " CSS px in " + iw + "x" + ih + "); nothing was captured; screenshot without ref or selector" };
const els = [];
for (let n = el.parentNode; n; n = n.parentNode || n.host) if (n.nodeType === 1) els.push([n, n.scrollLeft, n.scrollTop]);
const st = window.__perch_shot = { els: els, x: window.scrollX, y: window.scrollY };
try { el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); } catch (e) {}
const c = el.getBoundingClientRect();
const moved = window.scrollX !== st.x || window.scrollY !== st.y || els.some(function (e) { return e[0].scrollLeft !== e[1] || e[0].scrollTop !== e[2]; });
// An ancestor that clips its overflow and still hides part of the element: the
// viewport would show that ancestor's other content where the element sits.
const cut = els.some(function (e) {
  const n = e[0];
  if (n === document.documentElement || n === document.body) return false;
  const cs = getComputedStyle(n);
  if (!/auto|scroll|hidden|clip/.test(cs.overflow + " " + cs.overflowX + " " + cs.overflowY)) return false;
  const a = n.getBoundingClientRect(), x0 = a.left + (n.clientLeft || 0), y0 = a.top + (n.clientTop || 0);
  return c.left < x0 - 1 || c.top < y0 - 1 || c.right > x0 + n.clientWidth + 1 || c.bottom > y0 + n.clientHeight + 1;
});
if (cut) return { ok: false, error: "screenshot: the element is clipped by a scrolling container; nothing was captured", restore: true };
if (moved) {
  if (document.visibilityState === "hidden") return { ok: false, unpainted: true, restore: true };
  st.painted = false;
  requestAnimationFrame(function () { requestAnimationFrame(function () { st.painted = true; }); });
}
return { ok: true, x: c.left, y: c.top, w: c.width, h: c.height, iw: iw, ih: ih, moved: moved };
`,
  shot_painted: String.raw`
const s = window.__perch_shot;
return { painted: !!(s && s.painted) };
`,
  // Puts back what shot_clip kept, instantly even under scroll-behavior: smooth.
  shot_restore: String.raw`
const s = window.__perch_shot;
window.__perch_shot = null;
if (!s) return { ok: false };
const to = function (n, x, y) {
  if (n.scrollLeft === x && n.scrollTop === y) return;
  try { n.scrollTo({ left: x, top: y, behavior: "instant" }); } catch (e) { n.scrollLeft = x; n.scrollTop = y; }
};
s.els.forEach(function (e) { to(e[0], e[1], e[2]); });
if (window.scrollX !== s.x || window.scrollY !== s.y) window.scrollTo({ left: s.x, top: s.y, behavior: "instant" });
return { ok: true };
`,

  // wait {quiet}: the arm drops any earlier wait's state and starts this one's;
  // each poll after it says whether the page was busy since the last, or, with
  // no state (a new document), arms again and answers fresh. Neither carries a
  // per-call value, so both stay in the page's compile cache.
  wait_quiet_arm: QUIET_LIB + String.raw`
rbStop(window.__perch_quiet);
rbWatch({}, "__perch_quiet", A.life);
return { fresh: true };
`,
  wait_quiet: QUIET_LIB + String.raw`
const s = window.__perch_quiet;
if (s) return { busy: rbBusy(s) };
rbWatch({}, "__perch_quiet", A.life);
return { fresh: true };
`,

  wait_check: String.raw`
const order = { loading: 0, interactive: 1, complete: 2 };
if (A.readyState && order[document.readyState] < order[A.readyState]) return false;
if (!A.selector) return true;
let el;
try { el = document.querySelector(A.selector); } catch (e) { return { bad: true }; }
return !!el;
`,
};

// Page scripts cross the Apple Event bridge on every call and every poll. They
// hold no backtick, block comment or line continuation, so no string spans a
// line and whole comment lines and indentation can go. Newlines stay, so ASI
// and trailing comments read as written.
function lean(s) {
  return s.split("\n").filter((l) => !/^\s*\/\//.test(l)).map((l) => l.trimStart()).filter(Boolean).join("\n");
}
const LEAN_PRELUDE = lean(PAGE_PRELUDE);
const LEAN_SCRIPTS = new Map(Object.entries(PAGE_SCRIPTS).map(([k, v]) => [k, lean(v)]));

export function pageScript(name, A) {
  return LEAN_PRELUDE + "\nconst A = " + JSON.stringify(A) + ";\n" + (name ? LEAN_SCRIPTS.get(name) : "");
}

export function validateLabelPattern(tool, p, param = "label_pattern") {
  try { new RegExp(p, "i"); } catch (e) { throw new Error(`${tool}: invalid ${param}: ${e.message}`); }
}

const runPage = (tool, name, A, target, opts = {}) => evalJs(pageScript(name, A), target, { tool, ...opts });

// ---- page tools ----

async function getText(args = {}) {
  const { selector, ref, html = false, target } = args;
  const maxChars = Math.max(1, Number(args.maxChars) || 20000);
  const offset = Math.max(0, Number(args.offset) || 0);
  return runPage("get_text", "get_text", { selector, ref, html, maxChars, offset }, target);
}

// Frame rows per tab handle, from that tab's last accessibility_snapshot
// {frames:true}. They live here: page JS can't see into cross-origin frames,
// and the runtime's REPLs respawn after a dialog abort or a timeout.
const frameRefs = new Map();
const FRAME_REFS_MAX = 50;
const FRAME_REF = /^f\d+$/;
function frameHost(url) {
  try { const u = new URL(url); return u.host || (u.protocol + u.pathname).slice(0, 60); } catch { return String(url).slice(0, 60); }
}

// Sign-in and challenge frames are the user's, and so is any frame without an
// http(s) URL (about:blank, srcdoc, script-written, no AXURL): challenges often
// run in those. The path matters only for google.com, which serves reCAPTCHA
// under /recaptcha beside ordinary embeds.
const HANDOFF_HOST = /^(accounts\.google\.com|(www\.)?recaptcha\.net|([^.]+\.)*hcaptcha\.com|challenges\.cloudflare\.com|appleid\.apple\.com|idmsa\.apple\.com|([^.]+\.)*arkoselabs\.com|login\.microsoftonline\.com|login\.live\.com|([^.]+\.)*captcha-delivery\.com|([^.]+\.)*awswaf\.com|([^.]+\.)*geetest\.com|([^.]+\.)*friendlycaptcha\.com)$/;
function handoffFrame(url) {
  let u;
  try { u = new URL(url); } catch { return true; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return true;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return HANDOFF_HOST.test(host) || (/^(www\.)?google\.com$/.test(host) && /^\/recaptcha(\/|$)/.test(u.pathname));
}
const handoffError = (w) => `${w.role} ${JSON.stringify(w.name)} is sign-in, challenge or password UI; hand it to the user`;

// Frame refs reach nothing but click {trusted:true}: no typing, reading or
// uploading into embedded frames.
function guardFrameRefs(name, args) {
  const refs = [args.ref].concat(Array.isArray(args.fields) ? args.fields.map((f) => f && f.ref) : []);
  if (!refs.some((r) => r != null && FRAME_REF.test(String(r)))) return;
  if (name !== "click" || args.trusted !== true) throw new Error(`${name}: frame refs need click {trusted:true}`);
}

// Why the frame walk didn't run, coded: the runtime's own reasons pass through,
// and a raw bridge or AppleScript failure never reaches the caller as is.
function codeFrameError(msg) {
  if (/^no page area: |^Accessibility permission required/.test(msg)) return msg;
  const coded = codeOsaError(msg);
  if (/^[a-z][a-z_]*: /.test(coded) || translatePermissionError(msg)) return coded;
  const num = / \((-\d+)\)$/.exec(msg);
  return "frames_unreadable: Accessibility could not read the page's frames; the page rows are unaffected, retry for frame rows" + (num ? ` (AppleScript ${num[1]})` : "");
}

async function accessibilitySnapshot(args = {}) {
  const { role = null, query = null, target, frames = false } = args;
  const max = args.max == null ? 500 : Math.max(0, Number(args.max) || 0);
  if (query != null) validateLabelPattern("accessibility_snapshot", query, "query");
  if (target && target.tabId != null) frameRefs.delete(String(target.tabId));
  if (frames !== true) return runPage("accessibility_snapshot", "snapshot", { max, role, query }, target);
  const r = await rt("snapshotFrames", { target, js: buildEvalWrapper(pageScript("snapshot", { max, role, query, frames: true })) });
  if (r.tabId) frameRefs.delete(r.tabId);
  const page = parsePage(r.page);
  if (typeof page !== "string" || !page.startsWith("# ")) return page;
  const nl = page.indexOf("\n");
  const head = JSON.parse(page.slice(2, nl < 0 ? page.length : nl));
  delete head.iw;
  delete head.ih;
  delete head.fr;
  const lines = [];
  if (r.error) head.frames = { error: codeFrameError(r.error) };
  else {
    const roles = role == null ? null : [].concat(role);
    const re = query == null ? null : new RegExp(query, "i");
    const rows = {};
    let truncated = !!r.truncated;
    for (const row of r.frames || []) {
      if (roles && !roles.includes(row.role)) continue;
      const up = row.up || [];
      const flags = [row.url].concat(up).some(handoffFrame) ? row.flags.concat("handoff") : row.flags;
      const line = `${row.role} ${JSON.stringify(row.name)} frame=${JSON.stringify(frameHost(row.url))}${flags.map((f) => " " + f).join("")}`;
      if (re && !re.test(line)) continue;
      if (lines.length >= max) { truncated = true; break; }
      const ref = "f" + (lines.length + 1);
      rows[ref] = { url: row.url, up, role: row.role, name: row.name, ord: row.ord, handoff: flags.includes("handoff") || flags.includes("secure") };
      lines.push(ref + " " + line);
    }
    head.frames = truncated ? { count: lines.length, truncated: true } : { count: lines.length };
    if (r.tabId) {
      frameRefs.set(r.tabId, { url: head.url, rows });
      if (frameRefs.size > FRAME_REFS_MAX) frameRefs.delete(frameRefs.keys().next().value);
    }
  }
  return ["# " + JSON.stringify(head) + (nl < 0 ? "" : page.slice(nl))].concat(lines).join("\n");
}

// The runtime resolves the target, so it gets this ref's row from every tab
// that has one and keeps the row stored under the tab it resolved.
async function frameClick({ ref, raise, target }) {
  const rows = {};
  for (const [h, e] of frameRefs) if (e.rows[ref]) rows[h] = { url: e.url, row: e.rows[ref] };
  if (!Object.keys(rows).length) return { __perch_ref_miss: true, ref };
  // Refused before the runtime raises anything; the runtime checks again for
  // a ref that also names an ordinary row in another tab.
  const all = Object.values(rows);
  if (all.every((e) => e.row.handoff)) return { ok: false, ref, frame: frameHost(all[0].row.url), error: handoffError(all[0].row) };
  const r = await rt("frameClick", { target, raise, ref, rows, probe: pageFn("viewport", {}) });
  if (!r || !rows[r.tabId]) return r;
  const { tabId, ...rest } = r;
  return { ok: rest.ok, ref, frame: frameHost(rows[tabId].row.url), ...rest };
}

async function consoleCapture(args = {}) {
  const { mode = "read", target } = args;
  if (!["start", "read", "stop", "network"].includes(mode)) throw new Error(`console_capture: unknown mode '${mode}' (expected start | read | stop | network)`);
  return runPage("console_capture", mode === "network" ? "network_read" : "console_" + mode, {}, target);
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

// `cap(abs, size)` sees the size from a stat before anything is read, and may throw.
async function readUserFile(p, encoding, cap) {
  const abs = p.startsWith("~")
    ? resolvePath(homedir(), p.slice(p.startsWith("~/") ? 2 : 1))
    : resolvePath(p);
  try {
    if (cap) cap(abs, (await stat(abs)).size);
    return { abs, data: await readFile(abs, encoding) };
  }
  catch (e) { throw e.cap ? e : new Error(`cannot read ${abs}: ${e.message}`); }
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
// A new-tab click's second pass: runs what the first pass kept, once.
export const CLICK_BLANK_GO = buildEvalWrapper(`const k = window.__perch_blank; window.__perch_blank = null;
return (k && k.run && k.run()) || { ok: false, error: "the page changed before the click; nothing was clicked" };`);

// How long click {readback} waits for the element's text or the url to change.
const READBACK_SETTLE = 2000;
const readbackSteps = (readback) => readback ? {
  read: pageFn("readback_read", { readback }),
  readFinal: pageFn("readback_read", { readback, final: true }),
  settle: READBACK_SETTLE,
} : {};

async function trustedClick({ ref, selector, label_pattern, x, y, raise, target, readback }) {
  if (!ref && !selector && !label_pattern && (x == null || y == null)) throw new Error("click {trusted:true} requires `ref`, `selector`, `label_pattern`, or both `x` and `y`");
  const probing = !!(ref || selector || label_pattern);
  return rt("trustedClick", {
    target, raise, x, y,
    probe: probing ? pageFn("trusted_probe", { ref, selector, label_pattern }) : null,
    frames: probing ? null : pageFn("trusted_frames", {}),
    cal: probing ? pageFn("trusted_cal", {}) : null,
    calReset: probing ? pageFn("trusted_cal", { reset: true }) : null,
    check: pageFn("trusted_check", {}),
    arm: readback ? pageFn("readback_arm", { readback, probed: probing }) : null,
    ...readbackSteps(readback),
  }, readback ? { lane: "slow" } : {});
}

// Background fields use the browser's trusted editing command; the explicit
// foreground route keeps the hardware-style keystrokes. Both verify the value.
async function trustedFill({ ref, selector, label_pattern, text, raise, target }) {
  if (!raise) return runPage("fill", "trusted_fill_background", { ref, selector, label_pattern, text }, target);
  return rt("trustedFill", {
    target, raise,
    probe: pageFn("trusted_fill_probe", { ref, selector, label_pattern, forFill: true, background: !raise }),
    cal: pageFn("trusted_cal", {}),
    calReset: pageFn("trusted_cal", { reset: true }),
    check: pageFn("trusted_check", { forFill: true, text }),
    chunks: chunkUtf16(text),
  });
}

// How long file_upload looks for the file name after the site took the file.
const UPLOAD_SHOWN_WAIT = 1000;
// The file crosses the bridge base64 in one script. A one-shot osascript takes
// that script as an argument, so without the daemons the kernel's ~1MB argument
// limit caps it (700KB grows to ~930KB).
const UPLOAD_MAX = 25 << 20, UPLOAD_MAX_ONESHOT = 700 << 10;
function uploadCap(abs, size) {
  const d = DAEMONS.fast;
  const daemon = !!d && !d.disabled;
  const max = daemon ? UPLOAD_MAX : UPLOAD_MAX_ONESHOT;
  if (size <= max) return;
  const mb = (n) => (n / (1 << 20)).toFixed(1) + "MB";
  const msg = daemon
    ? `file_upload: ${abs} is ${mb(size)}, over the 25MB cap`
    : `file_upload: ${abs} is ${Math.ceil(size / 1024)}KB, over the 700KB cap without the osascript daemon (PERCH_DAEMON=0 or it failed to start)`;
  throw Object.assign(new Error(msg), { cap: true });
}
async function uploadShown(target, name, up) {
  try {
    await rt("wait", { target, js: pageFn("file_upload_shown", { name, up }), timeout: UPLOAD_SHOWN_WAIT, interval: 50 }, { lane: "slow" });
    return true;
  } catch { return false; }
}
async function fileUpload(args = {}) {
  const { selector, ref, label_pattern, path, target } = args;
  if (!path) throw new Error("file_upload requires `path`");
  if (label_pattern != null) {
    if (ref || selector) throw new Error("file_upload: pass `label_pattern` alone, without `ref` or `selector`");
    validateLabelPattern("file_upload", label_pattern);
  }
  const { abs, data } = await readUserFile(path, undefined, uploadCap);
  const name = abs.split("/").pop();
  const mime = MIME_BY_EXT[name.split(".").pop().toLowerCase()] || "application/octet-stream";
  let r = await runPage("file_upload", "file_upload", { selector, ref, label_pattern, b64: data.toString("base64"), name, mime }, target);
  // A hidden input nothing reacted to within the wait gets a drop on its zone instead.
  if (r && r.unwired) {
    delete r.unwired;
    if (await uploadShown(target, name, true)) return r;
    const drop = await runPage("file_upload", "file_upload_drop", { name }, target);
    if (drop && drop.__perch_error != null) return drop;
    r = { ...r, ...drop };
  }
  if (!r || r.shown !== false || !(r.ok === true || r.dropped)) return r;
  // Best effort: an input already holds the file, so a failed poll leaves shown:false.
  // A drop nothing showed stays {ok:false}.
  if (await uploadShown(target, name, !!r.dropped)) {
    r.shown = true;
    if (r.dropped) { r.ok = true; delete r.error; }
  }
  return r;
}

async function click(args = {}) {
  const { ref = null, selector = null, label_pattern = null, x = null, y = null, trusted = false, raise = false, hover = false, target, readback = null } = args;
  if (readback != null && (typeof readback !== "string" || !readback.trim())) throw new Error("click: `readback` must be a CSS selector");
  if (hover && (trusted || readback || x != null || y != null)) throw new Error("click: hover is untrusted and element-only");
  if (label_pattern != null) {
    if (ref || selector || x != null || y != null) throw new Error("click: pass `label_pattern` alone, without `ref`, `selector` or `x`/`y`");
    validateLabelPattern("click", label_pattern);
  }
  if (trusted && ref != null && FRAME_REF.test(String(ref))) {
    if (readback) throw new Error("click: frame refs take no readback");
    return frameClick({ ref, raise, target });
  }
  if (trusted) return trustedClick({ ref, selector, label_pattern, x, y, raise, target, readback });
  if (!ref && !selector && !label_pattern) throw new Error("click requires `ref`, `selector`, or `label_pattern` (x/y is screen coords, trusted:true only)");
  const A = { ref, selector, label_pattern };
  if (hover) return runPage("click", "hover", A, target);
  const go = CLICK_BLANK_GO;
  if (!readback) return parsePage(await rt("clickPage", { target, click: pageFn("click", { ...A, probe: true }), go }, { raw: true }));
  return rt("click", { target, click: pageFn("click_readback", { ...A, probe: true, readback }), go, ...readbackSteps(readback) }, { lane: "slow" });
}

const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
for (let i = 1; i <= 12; i++) KEY_CODES["F" + i] = 111 + i;
// Virtual keycodes and the characters AppKit attaches (NS function-key range for
// arrows, Home/End, PageUp/PageDown, forward Delete and F-keys).
const VKEYS = {
  Enter: [36, "\r"], Escape: [53, "\u001b"], Tab: [48, "\t"], Backspace: [51, "\u007f"], Delete: [117, "\uF728"], Space: [49, " "],
  ArrowUp: [126, "\uF700"], ArrowDown: [125, "\uF701"], ArrowLeft: [123, "\uF702"], ArrowRight: [124, "\uF703"],
  Home: [115, "\uF729"], End: [119, "\uF72B"], PageUp: [116, "\uF72C"], PageDown: [121, "\uF72D"],
};
[122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111].forEach((vk, i) => { VKEYS["F" + (i + 1)] = [vk, String.fromCharCode(0xF704 + i)]; });
const MODIFIERS = { cmd: "metaKey", meta: "metaKey", ctrl: "ctrlKey", alt: "altKey", option: "altKey", shift: "shiftKey" };

// "cmd+shift+k" -> KeyboardEvent init fields. A trailing "+" is the key itself ("cmd++").
export function parseKey(chord) {
  const parts = String(chord ?? "").split(/\+(?=.)/);
  const name = parts.pop();
  const bad = () => new Error(`press: unknown key ${chord}`);
  const out = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
  for (const m of parts) {
    const k = MODIFIERS[m.toLowerCase()];
    if (!k) throw bad();
    out[k] = true;
  }
  const named = Object.keys(KEY_CODES).find((k) => k.toLowerCase() === name.toLowerCase());
  if (named) return { key: named === "Space" ? " " : named, code: named, keyCode: KEY_CODES[named], ...out };
  if (name.length !== 1) throw bad();
  const up = name.toUpperCase();
  const key = out.shiftKey ? up : name;
  if (/[A-Z]/.test(up)) return { key, code: "Key" + up, keyCode: up.charCodeAt(0), ...out };
  if (/[0-9]/.test(name)) return { key, code: "Digit" + name, keyCode: name.charCodeAt(0), ...out };
  return { key, code: "", keyCode: 0, ...out };
}

// Command/Control/Option chords are refused: posted for real they can fire
// browser menu shortcuts. Untrusted press covers chords at the page level.
async function trustedPress({ key, ref, selector, target }) {
  const k = parseKey(key);
  const v = VKEYS[k.code];
  if (!v || k.metaKey || k.ctrlKey || k.altKey) throw new Error("press: trusted takes a named key (Enter, Escape, Tab, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, F1-F12), optionally with shift");
  return rt("trustedPress", {
    target, key, vk: v[0], uni: v[1], flags: k.shiftKey ? 0x20000 : 0,
    probe: pageFn("viewport", {}),
    arm: pageFn("trusted_key_arm", { ref, selector, key: k.key, shift: k.shiftKey }),
    check: pageFn("trusted_key_check", {}),
    final: pageFn("trusted_key_check", { final: true }),
  });
}

// Enter accepts, Escape dismisses; a string is typed into a prompt before Enter.
async function answerDialog(args) {
  const { key, dialog, target } = args;
  if (key !== "Enter" && key !== "Escape") throw new Error('press {dialog}: key must be "Enter" (accept) or "Escape" (dismiss)');
  if (dialog !== true && !(typeof dialog === "string" && dialog)) throw new Error("press {dialog}: pass true, or the prompt's answer as a non-empty string");
  if (args.ref != null || args.selector != null || args.trusted) throw new Error("press {dialog} answers the browser's dialog; it takes no ref, selector or trusted");
  if (typeof dialog === "string" && key === "Escape") throw new Error("press {dialog}: a prompt's text goes with Enter; Escape dismisses it without text");
  if (!target || typeof target.tabId !== "string" || !target.tabId) throw new Error("press {dialog} requires `target.tabId` (from list_tabs), so it can never answer a dialog on a tab it was not aimed at");
  return rt("answerDialog", { key, text: typeof dialog === "string" ? dialog : undefined, target });
}

async function press(args = {}) {
  if (args.dialog != null) return answerDialog(args);
  const { key, ref = null, selector = null, trusted = false, target } = args;
  if (trusted) return trustedPress({ key, ref, selector, target });
  return runPage("press", "press", { ref, selector, ...parseKey(key) }, target);
}

const VALUE_KEYS = ["text", "checked", "option"];
const OPTION_PREFS = 10, FIELDS_FILE_MAX = 256 << 10;

function validateFields(fields) {
  if (!Array.isArray(fields) || !fields.length) throw new Error("fill: fields: empty; pass [{ref|selector|label_pattern, text|checked|option}]");
  fields.forEach((f, i) => {
    const at = `fill: fields[${i}]`;
    if (!f || (!f.ref && !f.selector && !f.label_pattern)) throw new Error(`${at} requires \`ref\`, \`selector\`, or \`label_pattern\``);
    if (VALUE_KEYS.filter((k) => f[k] != null).length !== 1) throw new Error(`${at} takes exactly one of \`text\`, \`checked\`, \`option\``);
    if (f.checked != null && typeof f.checked !== "boolean") throw new Error(`${at}: \`checked\` must be a boolean`);
    if (f.raise) throw new Error(`${at}: raise is not taken inside fields; fill that field alone with raise:true`);
    if (f.trusted != null && typeof f.trusted !== "boolean") throw new Error(`${at}: \`trusted\` must be a boolean`);
    if (f.trusted && f.text == null) throw new Error(`${at}: trusted takes \`text\`, not checked/option`);
    if (f.trusted && f.text === "") throw new Error(`${at}: clearing (text:"") does not take trusted`);
    if (Array.isArray(f.option)) {
      if (!f.option.length) throw new Error(`${at}: \`option\` list is empty`);
      if (f.option.some((o) => typeof o !== "string")) throw new Error(`${at}: \`option\` list takes only strings`);
      if (f.option.length > OPTION_PREFS) throw new Error(`${at}: \`option\` lists at most ${OPTION_PREFS} preferences`);
    }
    if (f.label_pattern) validateLabelPattern(at, f.label_pattern);
  });
}

// Native fields go in page passes; each custom combobox in between goes
// through `select`, so the whole form is one tool call and stays in order.
async function fillFields(fields, target, only) {
  validateFields(fields);
  const A = fields.map(({ ref, selector, label_pattern, text, checked, option, trusted }) =>
    ({ ref, selector, label_pattern, text: text == null ? text : String(text), checked, option: option == null ? option : Array.isArray(option) ? option.map(String) : String(option), ...(trusted ? { trusted } : {}) }));
  const results = [];
  const counts = () => {
    const skipped = results.filter((x) => x.skipped).length, unverified = results.filter((x) => x.unverified).length;
    return { ...(skipped ? { skipped } : {}), ...(unverified ? { unverified } : {}) };
  };
  // A failure after some fields landed ends the batch with them; before any
  // landed, it throws (or returns the page's error) as a single call would.
  let halted = null;
  const halt = (msg) => {
    const error = codeOsaError(String(msg));
    results.push({ ok: false, error });
    halted = { ok: false, results, error, ...counts() };
  };
  const step = async (fn) => {
    try { return await fn(); } catch (e) {
      if (!results.length) throw e;
      halt(e && e.message);
    }
  };
  const recheck = (r) => { for (const [i, x] of Object.entries(r.recheck || {})) if (results[i]) results[i] = x; };
  let watch = false, warning = null, form;
  // The document the earlier fields landed in is gone, so nothing proves they
  // survived; the ones that landed are flagged rather than failed.
  const changedAfter = (i) => {
    for (let k = 0; k < i; k++) if (results[k] && results[k].ok === true && !results[k].skipped) results[k].unverified = true;
    warning = `the page changed after fields[${i}]; earlier fields may have been cleared, check them`;
  };
  for (let from = 0; from < A.length;) {
    const r = await step(() => runPage("fill", "fill_fields", { fields: A, from, only: only || undefined }, target));
    if (halted) return halted;
    if (!r || !Array.isArray(r.results)) {
      if (!results.length) return scriptFault("fill", r);
      halt(r && r.__perch_error != null ? scriptFault("fill", r).error : "fill: the page pass returned no results");
      return halted;
    }
    if (r.gone) {
      const at = r.at != null ? r.at : from - 1;
      results.push(...r.results);
      changedAfter(at);
      for (let i = at + 1; i < A.length; i++) results.push({ ok: false, error: `the page changed after fields[${at}]; not filled` });
      return { ok: false, results, ...counts(), warning };
    }
    results.push(...r.results);
    recheck(r);
    watch = !!r.watch;
    form = r.form;
    if (r.defer == null) break;
    const f = A[r.defer];
    // A trusted entry types into the field this pass resolved and held, never
    // one trusted_fill_background finds by its own looser label match.
    const s = await step(async () => {
      if (!f.trusted) return f.text != null ? pickTypeahead(f.text, target) : selectPrefs(f, target);
      const t = await runPage("fill", "trusted_fill_background", { held: true, at: r.defer, f, text: f.text }, target);
      return t && t.pending ? { ...await pickSuggestion(target), trusted: true } : t;
    });
    if (halted) return halted;
    results.push(f.trusted ? { kind: "plain", ...pageFault(s, "plain", "fill") }
      : s && s.__perch_ref_miss ? { ok: false, kind: "select", error: `ref ${s.ref} is stale or unknown; call accessibility_snapshot again` }
      : { kind: "select", ...pageFault(s, "select") });
    from = r.defer + 1;
    // The combobox ended the batch, so no page pass has re-read the fields
    // before it. A navigated page has nothing to re-read; a re-read that failed
    // leaves the fields before the combobox unproven, and says so.
    if (from === A.length && watch) {
      let x, why = null;
      try { x = await runPage("fill", "fill_fields", { fields: A, from }, target); } catch (e) { why = (/^([a-z_]+):/.exec(codeOsaError(String(e && e.message))) || [0, "error"])[1]; }
      if (!why && (!x || typeof x !== "object" || x.__perch_error != null)) why = "page error";
      if (why) {
        for (let i = 0; i < A.length - 1; i++) if (results[i].ok === true && !results[i].skipped) results[i].unverified = true;
        warning = `the final re-read did not run (${why}); earlier fields are unverified`;
      } else if (x.gone) changedAfter(A.length - 1);
      else { recheck(x); form = x.form; }
    }
  }
  return { ok: results.every((x) => x.ok === true), results, ...counts(), ...(warning ? { warning } : {}), ...(form ? { form } : {}) };
}

// A custom combobox given a preference list: the open list is matched against
// every preference at once. Only a type-to-filter box that typed a preference
// and found nothing (a plain miss) moves on to the next one, with a fresh call.
async function selectPrefs(f, target) {
  const prefs = f.option;
  if (!Array.isArray(prefs)) return select({ ...f, text: prefs, target });
  let first = null;
  for (let i = 0; i < prefs.length; i++) {
    const r = await select({ ...f, target }, prefs.slice(i));
    if (!r || typeof r !== "object" || r.__perch_ref_miss) return r;
    const { filtered, pref = 0, ...out } = r;
    if (out.ok !== false) return i + pref ? { ...out, pref: i + pref } : out;
    if (!first) first = out;
    if (!filtered || out.error !== "no option of this control matched") return first === out ? { ...out, tried: prefs } : out;
  }
  return { ...first, tried: prefs };
}

async function readFieldsFile(p) {
  const at = "fill: fields_path:";
  if (typeof p !== "string" || !p) throw new Error(`${at} must be a file path`);
  let data;
  try {
    ({ data } = await readUserFile(p, "utf8", (abs, size) => {
      if (size > FIELDS_FILE_MAX) throw Object.assign(new Error(`${at} file too large (${Math.ceil(size / 1024)}KB, over ${FIELDS_FILE_MAX >> 10}KB)`), { cap: true });
    }));
  } catch (e) { throw e.cap ? e : new Error(`${at} ${e.message}`); }
  let fields;
  try { fields = JSON.parse(data); } catch (e) { throw new Error(`${at} bad JSON: ${e.message}`); }
  if (!Array.isArray(fields)) throw new Error(`${at} the top level must be an array of fields`);
  return fields;
}

async function fill(args = {}) {
  const { selector, label_pattern, ref, text, text_path, target, trusted = false, raise = false, fields_path, only_empty } = args;
  let { fields } = args;
  if (fields != null && fields_path != null) throw new Error("fill: pass `fields` OR `fields_path`, not both");
  if (only_empty && fields == null && fields_path == null) throw new Error("fill: only_empty takes `fields` or `fields_path`");
  if (fields != null || fields_path != null) {
    if (text != null || text_path != null || ref || selector || label_pattern) throw new Error("fill: pass `fields` OR a single field, not both");
    if (trusted || raise) throw new Error("fill: `fields` takes trusted per entry, and no raise");
    if (fields_path != null) fields = await readFieldsFile(fields_path);
    const r = await fillFields(fields, target, !!only_empty);
    if (r && Array.isArray(r.results)) r.results = r.results.map((x, i) => fields[i] && fields[i].text != null && !fields[i].trusted ? hintTrusted(x) : x);
    return r;
  }
  const { checked, option } = args;
  if (checked != null || option != null) {
    if (text != null || text_path != null) throw new Error("fill: checked/option takes no `text` or `text_path`");
    if (trusted || raise) throw new Error("fill: checked/option does not take trusted/raise");
    if (checked != null && option != null) throw new Error("fill: pass one of `checked` or `option`");
    if (checked != null && typeof checked !== "boolean") throw new Error("fill: `checked` must be a boolean");
    if (!ref && !selector && !label_pattern) throw new Error("fill requires `ref`, `selector`, or `label_pattern`");
    const r = await fillFields([{ ref, selector, label_pattern, checked, option }], target);
    return r && Array.isArray(r.results) ? r.results[0] : r;
  }
  if (text == null && !text_path) throw new Error("fill requires `text` or `text_path` (checked/option: use fields)");
  if (text != null && text_path) throw new Error("fill: pass `text` OR `text_path`, not both");
  if (!ref && !selector && !label_pattern) throw new Error("fill requires `ref`, `selector`, or `label_pattern`");
  if (label_pattern) validateLabelPattern("fill", label_pattern);
  const clear = text === "";
  if (clear && (trusted || raise)) throw new Error("fill: clearing (text:\"\") does not take trusted/raise");
  let body = text;
  if (text_path) ({ data: body } = await readUserFile(text_path, "utf8"));
  if (!clear && (!body || !String(body).trim())) throw new Error("fill: empty body");
  const r = trusted
    ? await trustedFill({ ref, selector, label_pattern, text: body, raise, target })
    : await runPage("fill", "fill", { ref, selector, label_pattern, text: body }, target);
  if (!r || !r.pending) return trusted ? r : hintTrusted(r);
  const out = { ...await (r.trusted ? pickSuggestion(target) : pickTypeahead(body, target).then(hintTrusted)), ...(r.trusted ? { trusted: true } : {}), ...(r.hit !== undefined ? { hit: r.hit } : {}), ...(r.delivery ? { delivery: r.delivery } : {}) };
  return r.ambiguous ? { ...out, ambiguous: r.ambiguous } : out;
}

// A perch page script that threw, by error name only: its message and stack
// are page internals the agent can't act on. eval_js's own errors never come here.
// PerchStaleRef is viewOf's; a page can forge the name, which only earns it a
// re-snapshot hint. A result carrying perch's `delivery` or `point` means the
// input went out before the fault, so the agent checks rather than retries.
const SENT_NOUN = { click: "click", press: "keys", fill: "text" };
function scriptFault(tool, r, args) {
  if (!r || typeof r !== "object" || r.__perch_error == null) return r;
  const n = r.__perch_error_name;
  const name = typeof n === "string" && /^[A-Za-z_$][\w$]{0,39}$/.test(n) ? n : "Error";
  if (name === "PerchStaleRef") {
    return args && args.ref != null ? { __perch_ref_miss: true, ref: String(args.ref) }
      : { ok: false, error: `${tool}: a ref's frame document is gone; call accessibility_snapshot again` };
  }
  const why = `${tool}: the page script failed on this page (${name}); `;
  if (r.delivery == null && r.point == null) return { ok: false, error: why + "nothing verified" };
  const p = r.point;
  return {
    ok: false,
    ...(p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { point: { x: p.x, y: p.y } } : {}),
    ...(r.delivery === "hid" || r.delivery === "skylight" ? { delivery: r.delivery } : {}),
    ...(typeof r.el === "string" ? { el: r.el } : {}),
    error: why + `the ${SENT_NOUN[tool] || "input"} was sent, outcome unverified`,
  };
}

// A picker phase that threw: a page change only when the phase saw its
// document go, else the neutral script fault.
function pageFault(r, kind, tool = kind === "typeahead" ? "fill" : kind) {
  if (!r || typeof r !== "object" || r.__perch_error == null) return r;
  if (r.gone) return { ok: false, kind, error: "the page changed while picking; not verified" };
  return { ok: false, kind, error: scriptFault(tool, r).error };
}

// The page has typed into a typeahead; its suggestions arrive asynchronously,
// so they are polled JXA-side through select's phases rather than page timers.
const pickSuggestion = async (target) => pageFault(await rt("select", {
  target, tool: "fill", wait: 3000,
  pick: pageFn("fill_ta_pick", {}), miss: pageFn("fill_ta_miss", {}), missFinal: pageFn("fill_ta_miss", { final: true }), settle: 300,
  read: pageFn("fill_ta_read", {}), readFinal: pageFn("fill_ta_read", { final: true }),
  short: 1000, probe: pageFn("fill_ta_pick", { probe: true }),
}, { lane: "slow" }), "typeahead");

// A shorter lookup query for text a lookup found nothing for: its first comma
// part, accents folded, cut to two words when long. null when it would type
// the same text again (case aside) or too little to look up.
export function taQuery(text) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  let q = norm(String(text || "").split(",")[0]).normalize("NFD").replace(/\p{M}+/gu, "");
  const words = q.split(" ");
  if (q.length > 20 || words.length > 3) q = words.slice(0, 2).join(" ");
  return q.length < 2 || q === norm(text) ? null : q;
}

// Only an empty or unopened list retries: suggestions that answered the full
// text without a hit, or a tie, are the site's answer.
async function pickTypeahead(text, target) {
  const r = await pickSuggestion(target);
  const query = r && r.ok === false && !r.candidates && !r.ambiguous && /^no suggestion matched/.test(r.error) ? taQuery(text) : null;
  if (!query) return r;
  const t = await runPage("fill", "fill_ta_retype", { query }, target);
  return { ...(t && t.pending ? await pickSuggestion(target) : pageFault(t, "typeahead")), query };
}

// Misses a page makes by ignoring synthetic input: no suggestion list ever
// appeared, or the field put its value back. Trusted typing may land either.
const TRUSTED_HINT = "; retry with fill {trusted:true}";
function hintTrusted(r) {
  if (!r || r.ok !== false || r.trusted || typeof r.error !== "string") return r;
  const noList = r.kind === "typeahead" && !r.candidates && !r.ambiguous && /^no suggestion matched/.test(r.error);
  return noList || r.error.endsWith("the page reverted the write") ? { ...r, error: r.error + TRUSTED_HINT } : r;
}

// prefs: fill's ordered option list, which the tool itself never takes.
async function select(args = {}, prefs = null) {
  const { ref = null, selector = null, label_pattern = null, trusted = false, target } = args;
  const text = prefs || args.text;
  if (text == null) throw new Error("select requires `text` (the option to choose)");
  if (!ref && !selector && !label_pattern) throw new Error("select requires `ref`, `selector`, or `label_pattern`");
  if (label_pattern) validateLabelPattern("select", label_pattern);
  const A = { ref, selector, label_pattern, text: prefs || String(text), ...(trusted ? { trusted: true } : {}) };
  const step = (name, extra = {}) => pageFn(name, { ...A, ...extra });
  return pageFault(await rt("select", {
    target,
    start: step("select_start"), pick: step("select_pick"), miss: step("select_miss"),
    read: step("select_read"), readFinal: step("select_read", { final: true }),
    ...(trusted ? { trusted: {
      open: step("select_open"), type: step("select_type"), keep: step("select_read", { keep: true }), check: pageFn("trusted_check", {}),
      control: pageFn("trusted_probe", { select: "control" }), option: pageFn("trusted_probe", { select: "option" }),
    } } : {}),
  }, { lane: "slow" }), "select");
}

// Shared guidance lives here once instead of in every tool description.
export const INSTRUCTIONS = `perch drives the user's own macOS browsers over AppleScript. Which browser a tab lives in is perch's concern, not the caller's.
Targeting: pass \`target: {tabId}\` with a tabId from list_tabs or new_tab; it works for every browser and survives other tabs opening and closing. With no target, tools use the active tab of the topmost browser window.
Elements: prefer \`ref\` (from accessibility_snapshot) over CSS \`selector\` over \`label_pattern\` (case-insensitive regex over label/aria-label/placeholder/name). Refs die on the next snapshot or navigation; a stale ref errors with a re-snapshot hint.
{ok:false, error} is a normal outcome (no match, value didn't land): read it rather than retrying blindly.
Errors start with a code: tab_not_visible (needs the tab its window shows: activate_tab, which takes focus, or retry later), stale_tab (re-run list_tabs), window_offscreen, no_browser, timeout, tab_not_scriptable (a browser-internal page; navigate first, with raise:true unless its window is in front), dialog_open (a JS alert/confirm/prompt is open: press {dialog}), bad_url (only http(s), file or about:blank). Only activate_tab and raise:true take focus.`;

// windowId and tabIndex still target (list_tabs rows without a tabId carry them) but stay unlisted.
const TARGET = { type: "object", properties: { tabId: { type: ["string", "number"] }, app: { type: "string" } } };
const REF = { type: "string" };
const SEL = { type: "string" };
const LABEL = { type: "string" };
const tool = (name, description, properties = {}, required) =>
  ({ name, description, inputSchema: { type: "object", properties, ...(required ? { required } : {}) } });

const TOOLS = [
  tool("list_tabs", "Open tabs as {tabs:[{app,tabId,url,title,active?}], total}. `active`: the tab its window shows; `total` counts matches before `limit`. Filter rather than dumping.", {
    app: { type: "string" },
    urlContains: { type: "string" },
    titleContains: { type: "string" },
    limit: { type: "number", description: "Default 50." },
  }),
  tool("new_tab", "Create an unselected tab in a running browser's window (default: the browser in use). May focus the browser; defer while the user works. Returns {app,tabId}.", {
    url: { type: "string", description: "http(s) or file URL; default about:blank." },
    app: { type: "string" },
  }),
  tool("activate_tab", "Bring the target tab and its window to the front.", { target: TARGET }),
  tool("close_tab", "Close the tab with this handle. Never closes a window's last tab and never changes focus.", { tabId: { type: "string" } }, ["tabId"]),
  tool("navigate", "Load a URL in the target tab and wait for the new page to finish loading. Where the page can't start the load itself (not http(s), page JS unavailable), it needs `raise:true`, which may bring the browser forward.", { url: { type: "string" }, raise: { type: "boolean" }, target: TARGET }, ["url"]),
  tool("eval_js", "Run JS in the tab as a function body; `return` a JSON-able value. Given both, `script_path` runs before `script`.", {
    script: { type: "string" },
    script_path: { type: "string", description: "Local .js file." },
    awaitPromise: { type: "boolean", description: "Await async code (30s cap)." },
    ref: { type: "string", description: "Binds `el` to this ref." },
    target: TARGET,
  }),
  tool("wait", "Wait until `selector` exists and `readyState` is reached, or until `expression` is truthy (returned as `value`), or `quiet`.", {
    selector: SEL,
    readyState: { type: "string", enum: ["loading", "interactive", "complete"], description: "Default complete." },
    expression: { type: "string" },
    quiet: { type: "number", description: "ms with no DOM change or fetch/XHR finishing: {ok,waited,quietFor}." },
    timeout: { type: "number", description: "ms, default 10000." },
    target: TARGET,
  }),
  tool("screenshot", "Capture the target window without raising it; the tab must be the one its window shows. Returns the image plus {window:{x,y,w,h}, image:{w,h}}; screenX = window.x + imageX * window.w / image.w. ref/selector (needs Accessibility): scroll it into view, crop to it (meta.clip).", {
    ref: REF,
    selector: SEL,
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
  tool("accessibility_snapshot", "Page outline: a `# {url,title,ready,count,focus,dialogs,form}` header, then one line per visible interactive element: `ref role \"name\" key=json… flags`.", {
    max: { type: "number", description: "Element cap, default 500; 0 = header only." },
    role: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "Only these roles (textbox, button…)." },
    query: { type: "string", description: "Keep lines matching this regex." },
    frames: { type: "boolean", description: "Add iframe controls from Accessibility as `fN` rows (the tab its window shows); fN takes only click {trusted:true}." },
    target: TARGET,
  }),
  tool("console_capture", "`start` records console.*, uncaught errors and rejections, `read` drains \"level: text\" lines, `stop` restores; navigation clears it. `network` drains finished requests as \"status type ms size url\" (Resource Timing, no start).", {
    mode: { type: "string", enum: ["start", "read", "stop", "network"], description: "Default read." },
    target: TARGET,
  }),
  tool("notify", "Show a macOS notification (appears as Script Editor).", {
    message: { type: "string" },
    title: { type: "string" },
    subtitle: { type: "string" },
    sound: { type: "string", description: "Default Glass." },
  }, ["message"]),
  tool("file_upload", "Put a local file on an <input type=file> without the bytes entering context. Of several matches it picks by accept, then a resume/CV name (ambiguous:true, el). A drop zone, or its hidden input nothing reads, gets a drop (dropped:true). detached/cleared: the site took the file. {ok:false}: hand off, don't retry.", {
    path: { type: "string" },
    ref: REF,
    selector: SEL,
    label_pattern: { type: "string", description: "Regex over a file input's label or a drop zone's text." },
    target: TARGET,
  }, ["path"]),
  tool("click", "Click by ref/selector/label_pattern (el.click(); ties refuse); `hover`: hover events instead. `trusted`: real click without focus (needs Accessibility), `raise:true` in the foreground; check `hit`. Screen `x`/`y`: trusted only.", {
    ref: REF,
    selector: SEL,
    label_pattern: LABEL,
    x: { type: "number" },
    y: { type: "number" },
    trusted: { type: "boolean" },
    raise: { type: "boolean" },
    readback: { type: "string", description: "CSS; its text once changed (2s cap; ~0.7s quiet, 1.2s hidden tab): {readback,changed,url?} +form outcome." },
    hover: { type: "boolean" },
    target: TARGET,
  }),
  tool("press", "Key or chord (Enter, Escape, Tab, ArrowDown, cmd+k) to ref/selector or the focused element; emulates Enter/Space/Tab defaults. `trusted`: real key events in the shown tab; check `hit`. `dialog`, with target.tabId: Enter/Escape answers its alert/confirm/prompt; a string fills it.", {
    key: { type: "string" },
    ref: REF,
    selector: SEL,
    trusted: { type: "boolean" },
    dialog: { type: ["boolean", "string"] },
    target: TARGET,
  }, ["key"]),
  tool("fill", "Fill inputs, textareas, rich editors, typeaheads (picks a suggestion); verifies it landed: {ok,kind,el,len}; empty `text` clears. `trusted`: trusted input, no key focus; `raise:true`: foreground keys.", {
    fields: { type: "array", description: "[{ref|selector|label_pattern, text|checked|option, trusted?}]; option may be a list, in order" },
    fields_path: { type: "string", description: "JSON file of fields." },
    only_empty: { type: "boolean", description: "skip absent/set fields" },
    text: { type: "string" },
    text_path: { type: "string", description: "Local file." },
    ref: REF,
    selector: SEL,
    label_pattern: LABEL,
    trusted: { type: "boolean" },
    raise: { type: "boolean" },
    target: TARGET,
  }),
  tool("select", "Choose an option in a native <select> or custom combobox (react-select, Downshift, cmdk), from that control's own list only, and read back what's shown. Exact text or value, then whole word, then word prefix. A miss returns the control's options as `candidates`; `text:\"\"` just lists them. `trusted`: a control that won't open gets a real click (shown tab) or trusted typing in its own box (other tabs); check `trusted`.", {
    text: { type: "string" },
    ref: REF,
    selector: SEL,
    label_pattern: LABEL,
    trusted: { type: "boolean" },
    target: TARGET,
  }, ["text"]),
];

export const SCHEMA_BUDGET = 9600;

export const HANDLERS = {
  list_tabs:     (a) => listTabs(a),
  new_tab:       (a) => newTab(a.url, a.app),
  activate_tab:  (a) => activateTab(a.target),
  close_tab:     (a) => closeTab(a),
  navigate:      (a) => navigate(a.url, a.target, a.raise),
  eval_js:       async (a) => evalJs(await composeEvalScript(a), a.target, { awaitPromise: a.awaitPromise }),
  wait:          (a) => wait(a),
  screenshot:    (a) => screenshot(a),
  get_text:      (a) => getText(a),
  accessibility_snapshot: (a) => accessibilitySnapshot(a),
  console_capture:        (a) => consoleCapture(a),
  notify:        (a) => notify(a),
  file_upload:   (a) => fileUpload(a),
  click:         (a) => click(a),
  press:         (a) => press(a),
  fill:          (a) => fill(a),
  select:        (a) => select(a),
};

// liveDoc and frameOf from the page library, for eval_js's ref check: a ref's
// document is the page's, or a same-origin frame's that its frame still shows.
const EVAL_LIVE_DOC = "function __perch_frame(d, root, depth) { for (const x of root.getElementsByTagName('iframe')) { let c = null; try { c = x.contentDocument; } catch (e) {} if (!c) continue; if (c === d) return x; const f = depth < 3 && __perch_frame(d, c, depth + 1); if (f) return f; } return null; }\n" +
  "function __perch_live(d, depth) { if (d === document) return true; const v = d && d.defaultView; if (!v || depth > 3) return false; let f = null; try { f = v.frameElement; } catch (e) {} if (f == null) f = __perch_frame(d, document, 1); if (!f || !f.isConnected) return false; try { if (f.contentDocument !== d) return false; } catch (e) { return false; } return __perch_live(f.ownerDocument, depth + 1); }\n";

// File first, then `script`, in one function body: one call can inject a library and read it back.
// With a ref, the body runs as a function of `el`, resolved in the same page
// call; the ref's JSON literal is the only part that varies between calls.
export async function composeEvalScript({ script, script_path, ref, awaitPromise } = {}) {
  let file = "";
  if (script_path) ({ data: file } = await readUserFile(script_path, "utf8"));
  if (!file && !script) throw new Error("eval_js requires `script` or `script_path`");
  const body = file && script ? file + "\n;\n" + script : file || script;
  if (ref == null || ref === "") return body;
  const k = JSON.stringify(String(ref));
  return `var __perch_el = (window.__perch_refs || {})[${k}];\n` + EVAL_LIVE_DOC +
    `if (!__perch_el || !__perch_el.isConnected || !__perch_live(__perch_el.ownerDocument, 1)) return { __perch_ref_miss: true, ref: ${k} };\n` +
    `return (${awaitPromise ? "async " : ""}function (el) {\n${body}\n}).call(this, __perch_el);`;
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

function issuedHandles(name, result) {
  if (!result || typeof result !== "object") return [];
  if (name === "list_tabs") return (result.tabs || []).map((t) => t.tabId);
  if (name === "click") return result.opened && result.opened.tabId ? [result.opened.tabId] : [];
  return name === "new_tab" || name === "navigate" ? [result.tabId] : [];
}

// A Safari tab found off its handle's index answers under its new handle, so the
// next call is a one-event hit again. eval_js's value is the page's own, so the
// note goes beside it.
const MOVED = "tab moved; tabId refreshed";
function withMoved(name, result, tabId) {
  const plain = result && typeof result === "object" && !Array.isArray(result) && !result.__image && !result.__perch_ref_miss && result.__perch_error === undefined;
  if (plain && name !== "eval_js") {
    // A result's own tabId (navigate's, after the URL changed) is already the current one.
    return formatResult({ ...result, tabId: result.tabId ?? tabId, moved: true, warning: result.warning ? `${result.warning}; ${MOVED}` : MOVED });
  }
  const out = formatResult(result);
  out.content.push({ type: "text", text: JSON.stringify({ tabId, moved: true, warning: MOVED }) });
  return out;
}

// Multi-step tools keep state on window globals between page calls (a typeahead
// pick, fill {fields}' record, select, click readback, upload, the armed target
// of click {trusted} and select {trusted}, press {trusted}'s key watch, wait
// {quiet}'s activity watch, screenshot {ref|selector}'s saved scroll positions), so two such calls on one tab run one at a time. Keyed by the target as given: untargeted calls
// share "default", and a targeted and an untargeted call on the same tab are
// not serialized (resolving the default tab first would cost Apple Events).
export const tabLocks = new Map();
export function withTabLock(key, fn) {
  const prev = tabLocks.get(key) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  tabLocks.set(key, tail);
  tail.then(() => { if (tabLocks.get(key) === tail) tabLocks.delete(key); });
  return run;
}
const LOCKED_TOOLS = new Set(["fill", "select", "file_upload"]);
const tabLockKey = (name, args) =>
  LOCKED_TOOLS.has(name) || (name === "click" && (args.readback || args.trusted)) ||
  (name === "press" && args.trusted) || (name === "wait" && args.quiet != null) ||
  (name === "screenshot" && (args.ref || args.selector))
    ? (args.target && args.target.tabId != null ? "tab:" + args.target.tabId : "default")
    : null;

export async function handleCall(name, args = {}) {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
  try {
    if (!handler) throw new Error(`unknown tool: ${name}`);
    guardFrameRefs(name, args);
    if (args.app != null) args = { ...args, app: matchApp(args.app) };
    if (args.target && args.target.app != null) args = { ...args, target: { ...args.target, app: matchApp(args.target.app) } };
    const note = {};
    const lockKey = tabLockKey(name, args);
    const call = () => callNotes.run(note, () => handler(args));
    let result = await (lockKey ? withTabLock(lockKey, call) : call());
    if (name !== "eval_js" && result && typeof result === "object" && !Array.isArray(result) && result.__perch_error != null) result = scriptFault(name, result, args);
    const issued = new Set(issuedHandles(name, result));
    if (note.counts) keepCounts(note.counts, (h) => issued.has(h) || (note.stamped && note.stamped.has(h)));
    for (const t of issued) {
      stampedHandles.delete(t);
      movedTo.delete(t);
      if (typeof t === "string" && t.startsWith("safari:")) remember(issueSeq, t, ++stampClock);
    }
    return note.moved ? withMoved(name, result, note.moved) : formatResult(result);
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
  // The daemons' pipes keep node alive, so a closed client would leave this
  // process and its osascript REPLs running for good.
  const shutdown = () => {
    for (const d of Object.values(DAEMONS)) { try { d.kill(); } catch {} }
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, shutdown);
  await server.connect(new StdioServerTransport());
  // Pays the JXA bridge startup now instead of on each lane's first call.
  for (const d of Object.values(DAEMONS)) d.warm();
}
