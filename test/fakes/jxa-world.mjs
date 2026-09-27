// A fake JXA world for running perch's jxaRuntime under node:vm: scriptable
// browsers, windows, tabs, per-tab page contexts, a CoreGraphics window list,
// and a fake clock. Every accessor counts its calls so tests can assert on
// Apple Event traffic. System Events throws: the runtime must never touch it.
import vm from "node:vm";

export function makeWorld({ browsers = [], cg = [], loadTicks = 0, linger = 0 } = {}) {
  const clock = { t: 1_000_000 };
  const state = { loadTicks, linger, ax: true, cursor: { x: 1, y: 2 }, warps: [] };
  const cgEntries = cg.map((entry) => ({ ...entry }));
  const posted = [];
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const log = [];
  // What JXA throws when a specifier resolves to nothing (errAENoSuchObject).
  const gone = () => Object.assign(new Error("Can't get object."), { errorNumber: -1728 });
  const missing = new Proxy({}, { get: () => { throw gone(); } });
  const makeData = (len) => {
    const bytes = Buffer.alloc(len);
    return {
      mutableBytes: bytes,
      bytes,
      get length() { return bytes.length; },
      replaceBytesInRangeWithBytesLength: (range, source, count) => {
        Buffer.from(source).copy(bytes, range.location, 0, count);
      },
    };
  };

  function makePage(url) {
    const page = { url, ticks: state.loadTicks };
    const win = {};
    page.ctx = vm.createContext(win, { microtaskMode: "afterEvaluate" });
    vm.runInContext("window = globalThis; document = { get readyState() { return __ready(); } };", page.ctx);
    page.ctx.__ready = () => (page.ticks-- > 0 ? "loading" : "complete");
    page.ctx.location = { href: url };
    page.ctx.URL = URL;
    return page;
  }

  function makeTab(spec, b, w) {
    // The page lives on the spec, so one spec listed in several windows is one tab
    // shown in each, as Arc does for windows on the same space.
    if (!spec._page) spec._page = makePage(spec.url || "about:blank");
    const tab = {
      spec,
      get page() { return spec._page; },
      set page(p) { spec._page = p; },
      get _active() { return w.spec.active === w.tabs.indexOf(tab); },
    };
    const fn = (name, get) => Object.defineProperty(tab, name, { get: () => { bump(`tab.${name}`); return get; }, configurable: true });
    fn("id", () => spec.id);
    fn("title", () => spec.title || "");
    fn("name", () => spec.title || "");
    // Chrome's dictionary has no tab `index` (it throws); Safari's does.
    fn("index", () => { if (b.kind === "chrome") throw new Error("Can't get object."); return w.tabs.indexOf(tab) + 1; });
    // A navigation set with state.commitMs commits on the clock, not on executes.
    const settle = () => {
      if (tab.pending && tab.pending.at != null && clock.t >= tab.pending.at) { tab.page = makePage(tab.pending.url); tab.pending = null; }
    };
    fn("loading", () => { settle(); return !!tab.pending || tab.page.ticks > 0; });
    // Safari reports a blank tab's URL as null, not "about:blank".
    tab.shownUrl = () => { const u = tab.pending ? tab.pending.url : tab.page.url; return b.kind === "safari" && u === "about:blank" ? null : u; };
    Object.defineProperty(tab, "url", {
      get: () => () => {
        bump("tab.url");
        // state.arcSlowUrl = {throws, reads}: a new Arc tab's url() first throws, then
        // keeps showing arc://newtab until `reads` more reads, then the set URL commits.
        if (tab.slow) {
          if (tab.slow.throws > 0) { tab.slow.throws--; throw new Error("Can't get object."); }
          if (tab.slow.target != null && --tab.slow.reads <= 0) { tab.page = makePage(tab.slow.target); tab.slow = null; }
        }
        return tab.shownUrl();
      },
      set: (u) => {
        bump("tab.url=");
        if (tab.slow) { tab.slow.target = u; return; }
        log.push(["navigate", b.name, u]);
        // A fragment-only change keeps the document, as browsers do.
        const cur = new URL(tab.page.url), next = new URL(u, tab.page.url);
        if (next.hash && next.href.split("#")[0] === cur.href.split("#")[0]) { tab.page.url = next.href; tab.page.ctx.location.href = next.href; return; }
        // A download or a 204 never replaces the document, and loading settles.
        if (state.noContent && state.noContent.test(u)) return;
        // The old document keeps answering (readyState 'complete') for state.linger
        // executes after the url is set, before the new one replaces it.
        if (state.commitMs > 0) tab.pending = { url: u, n: Infinity, at: clock.t + state.commitMs };
        else if (state.linger > 0) tab.pending = { url: u, n: state.linger };
        else tab.page = makePage(u);
      },
    });
    // `ae.timeoutMs` is the caller's Apple Event timeout; plain JXA commands have
    // none, so an unanswered one blocks for the 2-minute default.
    tab.execute = ({ javascript }, ae = {}) => {
      bump("tab.execute");
      if (b.kind === "arc" && !tab._active) throw new Error("HANG: Arc background execute");
      if (b.kind === "arc" && /^arc:/.test(tab.page.url)) throw new Error("HANG: Arc internal page execute");
      settle();
      if (tab.pending && tab.pending.n-- <= 0) { tab.page = makePage(tab.pending.url); tab.pending = null; }
      const unanswered = () => {
        clock.t += ae.timeoutMs ?? 120000;
        return Object.assign(new Error("AppleEvent timed out."), { errorNumber: -1712 });
      };
      // state.dropWhilePending: Chrome never replies to an execute that lands while
      // a navigation replaces the document; the navigation commits meanwhile.
      if (state.dropWhilePending && tab.pending) { const e = unanswered(); tab.page = makePage(tab.pending.url); tab.pending = null; throw e; }
      // state.hung: the page never answers at all (a busy loop, a modal dialog).
      if (state.hung) throw unanswered();
      // spec.dom: a happy-dom Window standing in for the page.
      const r = spec.dom ? spec.dom.eval(javascript) : vm.runInContext(javascript, tab.page.ctx);
      return b.kind === "arc" ? JSON.stringify(r) : r;
    };
    tab.select = () => { bump("tab.select"); w.spec.active = w.tabs.indexOf(tab); };
    return tab;
  }

  function makeWindow(spec, b) {
    const w = { spec, tabs: [] };
    spec.tabs.forEach((t) => w.tabs.push(makeTab(t, b, w)));
    const coll = new Proxy([], {
      get(_, k) {
        if (k === "length") { bump("tabs.length"); return w.tabs.length; }
        if (k === "url") return () => { bump("tabs.url()"); return w.tabs.map((t) => t.shownUrl()); };
        if (k === "title" || k === "name") return () => { bump("tabs.title()"); return w.tabs.map((t) => t.spec.title || ""); };
        if (k === "id") return () => { bump("tabs.id()"); if (state.tabIdsFail) throw new Error("Can't get object."); return w.tabs.map((t) => t.spec.id); };
        if (k === "location") return () => { bump("tabs.location()"); return w.tabs.map((t) => t.spec.location || "unpinned"); };
        if (k === "byId") return (id) => { bump("tabs.byId"); return w.tabs.find((t) => String(t.spec.id) === String(id)) || missing; };
        if (k === "index") return () => w.tabs.map((_, i) => i + 1);
        if (k === "push") return (t) => {
          // Arc's `make new tab` rejects about: and data: URLs (they can be set afterwards).
          if (b.kind === "arc" && /^(about|data):/.test(t.url)) throw new Error("Please provide a valid URL property for the make new tab command.");
          const tab = makeTab({ url: t.url, id: "new" + w.tabs.length }, b, w);
          if (b.kind === "arc" && state.arcSlowUrl && /^arc:/.test(t.url)) tab.slow = { ...state.arcSlowUrl, target: null }; w.tabs.push(tab); log.push(["newTab", b.name, t.url]); };
        if (/^\d+$/.test(String(k))) return w.tabs[Number(k)];
        return undefined;
      },
    });
    const win = {};
    Object.defineProperty(win, "tabs", { get: () => { bump("win.tabs"); return coll; } });
    Object.defineProperty(win, "id", { get: () => () => { bump("win.id()"); return spec.id; } });
    win.name = () => spec.name ?? (w.tabs[spec.active]?.spec.title || "");
    // Arc: the sidebar order of the active space (spec.sidebar ids), Favorites excluded.
    Object.defineProperty(win, "activeSpace", { get: () => {
      if (b.kind !== "arc") throw new Error("Can't get object.");
      const side = spec.sidebar || w.tabs.filter((t) => t.spec.location !== "topApp").map((t) => t.spec.id);
      return { tabs: { id: () => { bump("space.tabs.id()"); return side.slice(); } } };
    } });
    // Raising a window reorders the app's window list, like the real `index = 1`.
    Object.defineProperty(win, "index", { set: (v) => {
      bump("win.index=");
      spec.raised = v === 1;
      if (v === 1) { const all = winsByApp[b.name]; all.splice(all.indexOf(w), 1); all.unshift(w); }
    } });
    win.position = () => { if (b.kind !== "chrome") throw new Error("no position"); return [spec.x ?? 0, spec.y ?? 0]; };
    win.size = () => { if (b.kind !== "chrome") throw new Error("no size"); return [spec.w ?? 800, spec.h ?? 600]; };
    win.bounds = () => { if (b.kind !== "safari") throw new Error("no bounds"); return { x: spec.x ?? 0, y: spec.y ?? 0, width: spec.w ?? 800, height: spec.h ?? 600 }; };
    Object.defineProperty(win, "activeTabIndex", {
      get: () => () => { bump("win.activeTabIndex()"); if (b.kind !== "chrome") throw new Error("Can't convert types"); return spec.active + 1; },
      set: (v) => { bump("win.activeTabIndex="); spec.active = v - 1; },
    });
    Object.defineProperty(win, "activeTab", {
      get: () => {
        bump("win.activeTab");
        if (b.kind === "safari") throw new Error("no activeTab");
        // A fresh Arc window shows no tab; its activeTab can't be read.
        if (spec.active == null || !w.tabs[spec.active]) return { id: () => { throw new Error("Can't get object."); } };
        return w.tabs[spec.active];
      },
      set: () => { throw new Error("Access not authorized"); },
    });
    Object.defineProperty(win, "currentTab", {
      // Called, it fetches the tab; uncalled, it is a specifier (`currentTab.index()`).
      get: () => Object.assign(() => { if (b.kind !== "safari") throw new Error("Can't convert types"); return w.tabs[spec.active]; }, {
        index: () => { bump("win.currentTab.index()"); if (b.kind !== "safari") throw new Error("Can't convert types"); return spec.active + 1; },
        __specifier: true,
      }),
      set: (t) => { bump("win.currentTab="); if (b.kind !== "safari") throw new Error("Can't convert types"); spec.active = w.tabs.indexOf(t); },
    });
    w.win = win;
    return w;
  }

  const apps = {};
  const winsByApp = {};
  const nsString = (str) => ({ dataUsingEncoding: (enc) => (enc === 0x94000100 ? { length: str.length * 2, bytes: str } : null) });
  const specifier = (resolveWin) => new Proxy({}, {
    get: (_, k) => { const w = resolveWin(); if (!w) throw gone(); const v = w[k]; return typeof v === "function" && !v.__specifier ? v.bind(w) : v; },
    set: (_, k, v) => { resolveWin()[k] = v; return true; },
  });
  for (const b of browsers) {
    const wins = (b.windows || []).map((ws) => makeWindow(ws, b));
    winsByApp[b.name] = wins;
    const a = {
      running: () => { bump(`running(${b.name})`); return b.running !== false; },
      activate: () => {
        bump(`activate(${b.name})`); log.push(["activate", b.name]);
        // Another app can keep the front (a modal, a full-screen space).
        if (state.activateFails) return;
        const i = cgEntries.findIndex((entry) => entry.owner === b.name);
        if (i > 0) cgEntries.unshift(cgEntries.splice(i, 1)[0]);
      },
      doJavaScript: (js, { in: tab }) => {
        bump("doJavaScript");
        if (tab && tab.__specifier) tab = tab();
        if (!tab) throw gone();
        // Safari only runs JS in the window's current tab.
        if (!tab._active) throw new Error("Safari: tab is not current");
        return vm.runInContext(js, tab.page.ctx);
      },
      Tab: (props) => props,
      Window: () => ({ make: () => wins.push(makeWindow({ id: 999, active: 0, tabs: [] }, b)) }),
      Document: () => ({ make: () => wins.push(makeWindow({ id: 999, active: 0, tabs: [] }, b)) }),
    };
    a.windows = new Proxy([], {
      get(_, k) {
        if (k === "length") { bump(`windows.length(${b.name})`); return wins.length; }
        // JXA specifiers are lazy: windows[k] means "whatever is k-th when used".
        if (/^\d+$/.test(String(k))) {
          bump(`windows[${k}](${b.name})`);
          return specifier(() => wins[Number(k)] && wins[Number(k)].win);
        }
        if (k === "byId") return (id) => specifier(() => { const w = wins.find((x) => String(x.spec.id) === String(id)); return w && w.win; });
        if (k === "id") return () => { bump(`windows.id()(${b.name})`); return wins.map((w) => w.spec.id); };
        if (k === "name") return () => wins.map((w) => w.win.name());
        // Every window's elements in one event (nested arrays, one per window); counted like a per-window bulk read.
        if (k === "tabs") return {
          url: () => { bump("tabs.url()"); return wins.map((w) => w.tabs.map((t) => t.shownUrl())); },
          title: () => { bump("tabs.title()"); return wins.map((w) => w.tabs.map((t) => t.spec.title || "")); },
          name: () => { bump("tabs.title()"); return wins.map((w) => w.tabs.map((t) => t.spec.title || "")); },
          id: () => { bump("tabs.id()"); return wins.map((w) => w.tabs.map((t) => t.spec.id)); },
        };
        if (k === "activeTabIndex") return () => { bump(`windows.activeTabIndex()(${b.name})`); if (b.kind !== "chrome") throw new Error("Can't convert types"); return wins.map((w) => w.spec.active + 1); };
        if (k === "currentTab") return { index: () => { bump(`windows.currentTab.index()(${b.name})`); if (b.kind !== "safari") throw new Error("Can't convert types"); return wins.map((w) => w.spec.active + 1); } };
        return undefined;
      },
    });
    apps[b.name] = a;
  }

  // NSAppleScript understands one shape: the runtime's bounded execute,
  // `with timeout of S seconds / tell application "A" to execute tab id "T" of
  // window id "W" javascript "JS" / end timeout`.
  const asString = String.raw`"((?:[^"\\]|\\.)*)"`;
  const asExecute = new RegExp(String.raw`^with timeout of ([\d.]+) seconds\ntell application ${asString} to execute tab id ${asString} of window id ${asString} javascript ${asString}\nend timeout$`);
  const unquote = (s) => s.replace(/\\(.)/g, "$1");
  // A failure returns nil; the error Ref is left holding a value that throws when
  // read, since live osascript segfaults reading it after a timeout.
  function runAppleScript(src, err) {
    bump("NSAppleScript");
    const m = asExecute.exec(src);
    if (!m) throw new Error("fake NSAppleScript: unsupported source " + JSON.stringify(src));
    const [secs, appName, tabId, winId, js] = [Number(m[1]), ...m.slice(2).map(unquote)];
    const nil = () => {
      Object.defineProperty(err, 0, { get: () => { state.segv = true; throw new Error("SEGV: read a freed error Ref"); } });
      return { isNil: () => true };
    };
    const w = (winsByApp[appName] || []).find((x) => String(x.spec.id) === winId);
    const tab = w && w.tabs.find((x) => String(x.spec.id) === tabId);
    if (!tab) return nil();
    try {
      const r = tab.execute({ javascript: js }, { timeoutMs: secs * 1000 });
      return { isNil: () => false, stringValue: r == null ? r : String(r) };
    } catch (e) {
      return nil();
    }
  }

  const sandbox = {
    Ref: () => [],
    Application: (name) => {
      bump(`Application(${name})`);
      if (name === "System Events") throw new Error("SE touched");
      if (!apps[name]) throw new Error("Application can't be found.");
      return apps[name];
    },
    delay: (s) => { clock.t += Math.round(s * 1000); },
    Date: { now: () => clock.t },
    ObjC: {
      import: () => {},
      castRefToObject: (x) => x,
      deepUnwrap: (x) => { bump("deepUnwrap"); return x; },
      unwrap: (x) => x,
      bindFunction: () => {},
    },
    // JXA's `$` is callable (`$()` is a nil pointer) and carries the bridged symbols.
    // $(jsString) bridges to an NSString; only real UTF-16LE (0x94000100) encodes.
    $: Object.assign((str) => (str === undefined ? null : nsString(str)), {
      // CoreGraphics / AppKit stand-ins for trusted input: events are recorded, not posted.
      CGPointMake: (x, y) => ({ x, y }),
      dlopen: () => ({}),
      NSMakeRange: (location, length) => ({ location, length }),
      NSMutableData: { dataWithLength: makeData },
      memset: (bytes, value, len) => { bytes.fill(value, 0, len); return bytes; },
      CGEventCreateMouseEvent: (_s, type, pt) => ({ kind: "mouse", type, pt, fields: {} }),
      CGEventSourceCreate: () => ({}),
      CGEventCreateKeyboardEvent: (_s, _k, down) => ({ kind: "key", down, fields: {} }),
      CGEventSetIntegerValueField: (e, f, v) => { e.fields[f] = v; },
      SLEventSetIntegerValueField: (e, f, v) => { e.fields[f] = v; },
      CGEventSetDoubleValueField: (e, f, v) => { e.fields[f] = v; },
      CGEventSetFlags: (e, flags) => { e.flags = flags; },
      CGEventKeyboardSetUnicodeString: (e, len, bytes) => { e.text = bytes; e.len = len; },
      CGEventSetWindowLocation: (e, x, y) => { e.windowPoint = { x, y }; },
      SLEventPostToPid: (pid, e) => {
        posted.push({ via: "skylight", pid, ...e });
        if (state.onPost) state.onPost(e);
        return 0;
      },
      GetProcessForPID: (pid, psn) => { psn.writeUInt32LE(pid, 4); return 0; },
      _SLPSGetFrontProcess: (psn) => { psn.writeUInt32LE(cgEntries[0]?.pid ?? 100, 4); return 0; },
      SLPSPostEventRecordTo: (psn, bytes) => {
        log.push(["SLPSPostEventRecordTo", Buffer.from(psn), Buffer.from(bytes)]);
        return 0;
      },
      CGEventPostToPid: (pid, e) => { posted.push({ via: "pid", pid, ...e }); if (state.onPost) state.onPost(e); },
      CGEventPost: (tap, e) => {
        posted.push({ via: tap === 0 ? "hid" : "tap" + tap, ...e });
        if (e.kind === "mouse") state.cursor = e.pt;
        if (state.onPost) state.onPost(e);
      },
      CGEventCreate: () => ({ kind: "probe", fields: {} }),
      CGEventGetLocation: () => ({ ...state.cursor }),
      CGWarpMouseCursorPosition: (pt) => { state.cursor = { x: pt.x, y: pt.y }; state.warps.push({ x: pt.x, y: pt.y }); },
      NSDictionary: { dictionaryWithObjectForKey: () => ({}) },
      NSAppleScript: { alloc: { initWithSource: (src) => ({ executeAndReturnError: (err) => runAppleScript(src, err) }) } },
      NSString: { stringWithString: (str) => nsString(str) },
      AXIsProcessTrusted: () => state.ax,
      AXIsProcessTrustedWithOptions: () => state.ax,
      kCFBooleanFalse: false,
      kAXTrustedCheckOptionPrompt: "prompt",
      CGWindowListCopyWindowInfo: () => {
        bump("CGWindowList");
        return cgEntries.map((e) => ({
          kCGWindowLayer: e.layer ?? 0,
          kCGWindowOwnerName: e.owner,
          kCGWindowOwnerPID: e.pid ?? 100,
          kCGWindowNumber: e.wid ?? 1,
          kCGWindowName: e.name ?? "",
          kCGWindowBounds: { X: e.x ?? 0, Y: e.y ?? 0, Width: e.w ?? 800, Height: e.h ?? 600 },
        }));
      },
    }),
    JSON,
    Math,
    String,
    Error,
  };
  const ctx = vm.createContext(sandbox);
  return {
    ctx, counts, log, clock, apps, posted,
    // Reorder a window's tabs in place: tabs[w] is the live list the runtime reads.
    tabsOf: (name, w) => winsByApp[name][w].tabs,
    winSpec: (name, w) => winsByApp[name][w].spec,
    reset() { for (const k of Object.keys(counts)) delete counts[k]; log.length = 0; },
    state,
    page: (name, w, t) => winsByApp[name][w].tabs[t].page.ctx,
    run: (src) => vm.runInContext(src, ctx),
    // A daemon stand-in with the real daemon's result contract.
    daemon: {
      run: async (script) => {
        const r = vm.runInContext(script, ctx);
        return r == null ? "" : typeof r === "string" ? r : JSON.stringify(r);
      },
    },
  };
}
