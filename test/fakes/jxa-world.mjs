// A fake JXA world for running perch's jxaRuntime under node:vm: scriptable
// browsers, windows, tabs, per-tab page contexts, a CoreGraphics window list,
// and a fake clock. Every accessor counts its calls so tests can assert on
// Apple Event traffic. System Events throws: the runtime must never touch it.
import vm from "node:vm";

export function makeWorld({ browsers = [], cg = [], loadTicks = 0 } = {}) {
  const clock = { t: 1_000_000 };
  const state = { loadTicks };
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const log = [];

  function makePage(url) {
    const page = { url, ticks: state.loadTicks };
    const win = {};
    page.ctx = vm.createContext(win, { microtaskMode: "afterEvaluate" });
    vm.runInContext("window = globalThis; document = { get readyState() { return __ready(); } };", page.ctx);
    page.ctx.__ready = () => (page.ticks-- > 0 ? "loading" : "complete");
    return page;
  }

  function makeTab(spec, b, w) {
    const tab = {
      spec,
      page: makePage(spec.url || "about:blank"),
      get _active() { return w.spec.active === w.tabs.indexOf(tab); },
    };
    const fn = (name, get) => Object.defineProperty(tab, name, { get: () => { bump(`tab.${name}`); return get; }, configurable: true });
    fn("id", () => spec.id);
    fn("title", () => spec.title || "");
    fn("name", () => spec.title || "");
    fn("index", () => w.tabs.indexOf(tab) + 1);
    fn("loading", () => false);
    Object.defineProperty(tab, "url", {
      get: () => () => tab.page.url,
      set: (u) => { bump("tab.url="); log.push(["navigate", b.name, u]); tab.page = makePage(u); },
    });
    tab.execute = ({ javascript }) => {
      bump("tab.execute");
      if (b.kind === "arc" && !tab._active) throw new Error("HANG: Arc background execute");
      const r = vm.runInContext(javascript, tab.page.ctx);
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
        if (k === "index") return () => w.tabs.map((_, i) => i + 1);
        if (k === "push") return (t) => { const tab = makeTab({ url: t.url, id: "new" + w.tabs.length }, b, w); w.tabs.push(tab); log.push(["newTab", b.name, t.url]); };
        if (/^\d+$/.test(String(k))) return w.tabs[Number(k)];
        return undefined;
      },
    });
    const win = {};
    Object.defineProperty(win, "tabs", { get: () => { bump("win.tabs"); return coll; } });
    Object.defineProperty(win, "id", { get: () => () => { bump("win.id()"); return spec.id; } });
    Object.defineProperty(win, "index", { set: (v) => { bump("win.index="); spec.raised = v === 1; } });
    Object.defineProperty(win, "activeTabIndex", {
      get: () => () => { bump("win.activeTabIndex()"); if (b.kind !== "chrome") throw new Error("Can't convert types"); return spec.active + 1; },
      set: (v) => { bump("win.activeTabIndex="); spec.active = v - 1; },
    });
    Object.defineProperty(win, "activeTab", {
      get: () => { bump("win.activeTab"); if (b.kind !== "arc") throw new Error("no activeTab"); return w.tabs[spec.active]; },
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
  for (const b of browsers) {
    const wins = (b.windows || []).map((ws) => makeWindow(ws, b));
    winsByApp[b.name] = wins;
    const a = {
      running: () => { bump(`running(${b.name})`); return b.running !== false; },
      activate: () => { bump(`activate(${b.name})`); log.push(["activate", b.name]); },
      doJavaScript: (js, { in: tab }) => {
        bump("doJavaScript");
        return vm.runInContext(js, tab.page.ctx);
      },
      Tab: (props) => props,
      Window: () => ({ make: () => wins.push(makeWindow({ id: 999, active: 0, tabs: [] }, b)) }),
      Document: () => ({ make: () => wins.push(makeWindow({ id: 999, active: 0, tabs: [] }, b)) }),
    };
    a.windows = new Proxy([], {
      get(_, k) {
        if (k === "length") { bump(`windows.length(${b.name})`); return wins.length; }
        if (/^\d+$/.test(String(k))) { bump(`windows[${k}](${b.name})`); return wins[Number(k)] && wins[Number(k)].win; }
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
    },
    $: {
      CGWindowListCopyWindowInfo: () => {
        bump("CGWindowList");
        return cg.map((e) => ({
          kCGWindowLayer: e.layer ?? 0,
          kCGWindowOwnerName: e.owner,
          kCGWindowOwnerPID: e.pid ?? 100,
          kCGWindowNumber: e.wid ?? 1,
          kCGWindowBounds: { X: e.x ?? 0, Y: e.y ?? 0, Width: e.w ?? 800, Height: e.h ?? 600 },
        }));
      },
    },
    JSON,
    Math,
    String,
    Error,
  };
  const ctx = vm.createContext(sandbox);
  return {
    ctx, counts, log, clock, apps,
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
