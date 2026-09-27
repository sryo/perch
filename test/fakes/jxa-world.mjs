// A fake JXA world for running perch's jxaRuntime under node:vm: scriptable
// browsers, windows, tabs, per-tab page contexts, a CoreGraphics window list,
// and a fake clock. Every accessor counts its calls so tests can assert on
// Apple Event traffic. System Events throws: the runtime must never touch it.
import vm from "node:vm";

export function makeWorld({ browsers = [], cg = [], loadTicks = 0 } = {}) {
  const clock = { t: 1_000_000 };
  const state = { loadTicks, ax: true, cursor: { x: 1, y: 2 }, warps: [] };
  const cgEntries = cg.map((entry) => ({ ...entry }));
  const posted = [];
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const log = [];
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
    fn("loading", () => false);
    Object.defineProperty(tab, "url", {
      get: () => () => tab.page.url,
      set: (u) => {
        bump("tab.url=");
        log.push(["navigate", b.name, u]);
        // A fragment-only change keeps the document, as browsers do.
        const cur = new URL(tab.page.url), next = new URL(u, tab.page.url);
        if (next.hash && next.href.split("#")[0] === cur.href.split("#")[0]) { tab.page.url = next.href; tab.page.ctx.location.href = next.href; return; }
        tab.page = makePage(u);
      },
    });
    tab.execute = ({ javascript }) => {
      bump("tab.execute");
      if (b.kind === "arc" && !tab._active) throw new Error("HANG: Arc background execute");
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
        if (k === "url") return () => { bump("tabs.url()"); return w.tabs.map((t) => t.page.url); };
        if (k === "title" || k === "name") return () => { bump("tabs.title()"); return w.tabs.map((t) => t.spec.title || ""); };
        if (k === "id") return () => { bump("tabs.id()"); return w.tabs.map((t) => t.spec.id); };
        if (k === "location") return () => { bump("tabs.location()"); return w.tabs.map((t) => t.spec.location || "unpinned"); };
        if (k === "byId") return (id) => { bump("tabs.byId"); return w.tabs.find((t) => String(t.spec.id) === String(id)); };
        if (k === "index") return () => w.tabs.map((_, i) => i + 1);
        if (k === "push") return (t) => { const tab = makeTab({ url: t.url, id: "new" + w.tabs.length }, b, w); w.tabs.push(tab); log.push(["newTab", b.name, t.url]); };
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
      get: () => () => { if (b.kind !== "safari") throw new Error("Can't convert types"); return w.tabs[spec.active]; },
      set: (t) => { bump("win.currentTab="); if (b.kind !== "safari") throw new Error("Can't convert types"); spec.active = w.tabs.indexOf(t); },
    });
    w.win = win;
    return w;
  }

  const apps = {};
  const winsByApp = {};
  const nsString = (str) => ({ dataUsingEncoding: (enc) => (enc === 0x94000100 ? { length: str.length * 2, bytes: str } : null) });
  const specifier = (resolveWin) => new Proxy({}, {
    get: (_, k) => { const w = resolveWin(); const v = w[k]; return typeof v === "function" ? v.bind(w) : v; },
    set: (_, k, v) => { resolveWin()[k] = v; return true; },
  });
  for (const b of browsers) {
    const wins = (b.windows || []).map((ws) => makeWindow(ws, b));
    winsByApp[b.name] = wins;
    const a = {
      running: () => { bump(`running(${b.name})`); return b.running !== false; },
      activate: () => {
        bump(`activate(${b.name})`); log.push(["activate", b.name]);
        const i = cgEntries.findIndex((entry) => entry.owner === b.name);
        if (i > 0) cgEntries.unshift(cgEntries.splice(i, 1)[0]);
      },
      doJavaScript: (js, { in: tab }) => {
        bump("doJavaScript");
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
          if (!wins[Number(k)]) return undefined;
          return specifier(() => wins[Number(k)] && wins[Number(k)].win);
        }
        if (k === "byId") return (id) => specifier(() => { const w = wins.find((x) => String(x.spec.id) === String(id)); return w && w.win; });
        if (k === "id") return () => wins.map((w) => w.spec.id);
        if (k === "name") return () => wins.map((w) => w.win.name());
        return undefined;
      },
    });
    apps[b.name] = a;
  }

  const sandbox = {
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
