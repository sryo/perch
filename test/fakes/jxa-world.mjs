// A fake JXA world for running perch's jxaRuntime under node:vm: scriptable
// browsers, windows, tabs, per-tab page contexts, a CoreGraphics window list,
// and a fake clock. Every accessor counts its calls so tests can assert on
// Apple Event traffic. System Events throws: the runtime must never touch it.
// world.aeLog lists every Apple Event to a browser as [appName, key], and
// aeBy(app) its keys for one browser. With frameMs, an Apple Event to a browser
// returns at that browser's next frame boundary; each browser has its own phase,
// so events to different browsers overlap, as they do live. frameMs 0 (the
// default) leaves the clock alone.
import vm from "node:vm";

export function makeWorld({ browsers = [], cg = [], loadTicks = 0, linger = 0, frameMs = 0 } = {}) {
  const clock = { t: 1_000_000 };
  const state = { loadTicks, linger, ax: true, cursor: { x: 1, y: 2 }, warps: [], dialogs: [], axActions: [], shots: [], files: {}, imports: [], policies: [] };
  const cgEntries = cg.map((entry) => ({ ...entry }));
  const twinOf = (name) => (state.twins || []).find((x) => x.name === name);
  const posted = [];
  const counts = {}, geom = {};
  const aeLog = [];
  // Building a specifier is lazy in JXA, and running() asks LaunchServices: no Apple Event.
  const notAe = /^(win\.tabs|tabs\.byId|win\.activeTab|windows\[\d+\]\(.*\)|running\(.*\))$/;
  const phase = (app) => (browsers.findIndex((b) => b.name === app) * frameMs) / browsers.length;
  // state.aeFail = {errorNumber, message, key?, app?}: every Apple Event to a
  // browser (only `app`, only keys matching `key`) throws that AppleScript error,
  // as a browser that quit (-600), dropped its connection (-609) or timed out (-1712) would.
  // state.afterAe(app, key): a test's world change landing after that Apple
  // Event's reply and before the next event (the user opening or closing a tab or
  // window mid-read), so it runs as the next event starts.
  const ae = (app, k) => {
    if (state.afterAe && aeLog.length) state.afterAe(...aeLog[aeLog.length - 1]);
    const f = state.aeFail;
    if (f && (!f.key || f.key.test(k)) && (!f.app || f.app === app)) throw Object.assign(new Error(f.message), { errorNumber: f.errorNumber });
    aeLog.push([app, k]);
    if (frameMs > 0) { const p = phase(app); clock.t = p + (Math.floor((clock.t - p) / frameMs) + 1) * frameMs; }
  };
  const bump = (k, app) => {
    counts[k] = (counts[k] || 0) + 1;
    if (app != null && !notAe.test(k)) ae(app, k);
  };
  const log = [];
  // state.afterExecute(tabSpec) runs once, after the next page script returns:
  // a world change (a tab closing) that lands between two page calls.
  const afterExecute = (spec) => {
    const f = state.afterExecute;
    if (f) { state.afterExecute = null; f(spec); }
  };
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

  // `go` is the tab's navigation, reached from page JS by location.assign.
  function makePage(url, go) {
    const page = { url, ticks: state.loadTicks };
    const win = {};
    page.ctx = vm.createContext(win, { microtaskMode: "afterEvaluate" });
    vm.runInContext("window = globalThis; document = { get readyState() { return __ready(); } };", page.ctx);
    page.ctx.__ready = () => (page.ticks-- > 0 ? "loading" : "complete");
    // state.errorPage (a RegExp): a matching URL commits the browser's error page,
    // whose document is state.errorHref (Chrome's chrome-error://chromewebdata/ by
    // default) while the tab shows the URL.
    const href = state.errorPage && state.errorPage.test(url) ? state.errorHref || "chrome-error://chromewebdata/" : url;
    page.ctx.location = {
      href,
      get protocol() { return this.href.slice(0, this.href.indexOf(":") + 1); },
      assign: (u) => go(/^[a-z]+:/i.test(u) ? u : new URL(u, page.url).href, "page"),
    };
    page.ctx.URL = URL;
    // __busy(ms): the script holds the page's thread that long (see tab.execute).
    page.ctx.__busy = (ms) => { page.busy = (page.busy || 0) + ms; };
    return page;
  }

  function makeTab(spec, b, w) {
    // The page lives on the spec, so one spec listed in several windows is one tab
    // shown in each, as Arc does for windows on the same space.
    const mk = (u) => makePage(u, (x, via) => go(x, via));
    if (!spec._page) spec._page = mk(spec.url || "about:blank");
    const tab = {
      spec,
      get page() { return spec._page; },
      set page(p) { spec._page = p; },
      get _active() { return w.spec.active === w.tabs.indexOf(tab); },
    };
    // A closed tab's specifier names nothing: every read and command fails.
    const present = () => winsByApp[b.name].some((x) => x.tabs.includes(tab));
    const fn = (name, get) => Object.defineProperty(tab, name, { get: () => { bump(`tab.${name}`, b.name); if (!present()) throw gone(); return get; }, configurable: true });
    fn("id", () => spec.id);
    fn("title", () => spec.title || "");
    fn("name", () => spec.title || "");
    // Chrome's dictionary has no tab `index` (it throws); Safari's does.
    fn("index", () => { if (b.kind === "chrome") throw new Error("Can't get object."); return w.tabs.indexOf(tab) + 1; });
    // A navigation set with state.commitMs commits on the clock, not on executes.
    const settle = () => {
      if (tab.pending && tab.pending.at != null && clock.t >= tab.pending.at) { tab.page = mk(tab.pending.url); tab.pending = null; }
    };
    fn("loading", () => { settle(); return !!tab.pending || tab.page.ticks > 0; });
    // A pending load shows its url while the old document still answers, as live
    // Canary does for a page-started one. Safari reports a blank tab's URL as null.
    tab.shownUrl = () => { const u = tab.pending ? tab.pending.url : tab.page.url; return b.kind === "safari" && u === "about:blank" ? null : u; };
    Object.defineProperty(tab, "url", {
      get: () => () => {
        bump("tab.url", b.name);
        if (!present()) throw gone();
        // state.arcSlowUrl = {throws, reads}: a new Arc tab's url() first throws, then
        // keeps showing arc://newtab until `reads` more reads, then the set URL commits.
        if (tab.slow) {
          if (tab.slow.throws > 0) { tab.slow.throws--; throw new Error("Can't get object."); }
          if (tab.slow.target != null && --tab.slow.reads <= 0) { tab.page = mk(tab.slow.target); tab.slow = null; }
        }
        return tab.shownUrl();
      },
      set: (u) => {
        bump("tab.url=", b.name);
        if (!present()) throw gone();
        if (tab.slow) { tab.slow.target = u; return; }
        go(u, "url");
      },
    });
    // Logs ["navigate", browser, url] for a url set through AppleScript and
    // ["assign", browser, url] for one the page started.
    function go(u, via) {
      log.push([via === "page" ? "assign" : "navigate", b.name, u]);
      // state.redirects ({asked: final}): the server sends the load elsewhere.
      if (state.redirects && state.redirects[u]) u = state.redirects[u];
      // A fragment-only change keeps the document, as browsers do.
      const cur = new URL(tab.page.url), next = new URL(u, tab.page.url);
      if (next.hash && next.href.split("#")[0] === cur.href.split("#")[0]) { tab.page.url = next.href; tab.page.ctx.location.href = next.href; return; }
      // A download or a 204 never replaces the document, and loading settles.
      if (state.noContent && state.noContent.test(u)) return;
      // The old document keeps answering (readyState 'complete') for state.linger
      // executes after the url is set, before the new one replaces it.
      if (state.commitMs > 0) tab.pending = { url: u, n: Infinity, at: clock.t + state.commitMs };
      else if (state.linger > 0) tab.pending = { url: u, n: state.linger };
      else tab.page = mk(u);
    }
    // `ae.timeoutMs` is the caller's Apple Event timeout; plain JXA commands have
    // none, so an unanswered one blocks for the 2-minute default.
    tab.execute = ({ javascript }, ae = {}) => {
      bump("tab.execute", b.name);
      if (!present()) throw gone();
      // state.onExecute(tabSpec) runs as each page script is sent: a world change
      // (another window raised) that lands while page JS goes unanswered.
      if (state.onExecute) state.onExecute(spec, javascript);
      if (b.kind === "arc" && !tab._active) throw new Error("HANG: Arc background execute");
      if (b.kind === "arc" && /^arc:/.test(tab.page.url)) throw new Error("HANG: Arc internal page execute");
      // Chromium runs no page JS on its own pages (chrome://newtab, settings).
      if (b.kind === "chrome" && /^(chrome|edge|brave):/.test(tab.page.url)) { state.internalExecs = (state.internalExecs || 0) + 1; throw new Error("Chromium internal page execute"); }
      const limit = ae.timeoutMs ?? 120000, sent = clock.t;
      const unanswered = () => {
        clock.t = sent + limit;
        return Object.assign(new Error("AppleEvent timed out."), { errorNumber: -1712 });
      };
      // An execute sent while an earlier script still holds the page's thread waits for it.
      // state.lateRun: one that gives up waiting still runs once the thread frees.
      if (tab.busyUntil > clock.t) {
        if (tab.busyUntil - clock.t >= limit) {
          if (state.lateRun) (tab.queued = tab.queued || []).push(javascript);
          throw unanswered();
        }
        clock.t = tab.busyUntil;
      }
      if (tab.queued && tab.busyUntil <= clock.t) {
        const q = tab.queued;
        tab.queued = null;
        q.forEach((js) => { spec.dom ? spec.dom.eval(js) : vm.runInContext(js, tab.page.ctx); });
      }
      settle();
      if (tab.pending && tab.pending.n-- <= 0) { tab.page = mk(tab.pending.url); tab.pending = null; }
      // state.dropWhilePending: Chrome never replies to an execute that lands while
      // a navigation replaces the document; the navigation commits meanwhile.
      if (state.dropWhilePending && tab.pending) { const e = unanswered(); tab.page = mk(tab.pending.url); tab.pending = null; throw e; }
      // state.hung: the page never answers at all (a busy loop, a modal dialog).
      if (state.hung) throw unanswered();
      // state.hangIf(js): only the scripts it picks go unanswered: true before they
      // run, "ran" after.
      const hang = state.hangIf ? state.hangIf(javascript) : false;
      if (hang === true) throw unanswered();
      // state.jsOff: the browser's "Allow JavaScript from Apple Events" is off.
      if (state.jsOff) throw new Error("Executing JavaScript through AppleScript is turned off.");
      // A JS dialog pauses its own tab's page: a dialog's `blocks` is that tab's id.
      // Browser prompts that only look like one (permission, FedCM, passkey) omit it.
      const paused = () => state.dialogs.some((d) => d.blocks != null && String(d.blocks) === String(spec.id));
      if (paused()) throw unanswered();
      // spec.dom: a happy-dom Window standing in for the page.
      const before = tab.pending, ran = tab.page;
      ran.busy = 0;
      const r = spec.dom ? spec.dom.eval(javascript) : vm.runInContext(javascript, tab.page.ctx);
      // A dialog the script itself opened (alert() in a click handler) stops it before it replies.
      if (paused() || hang === "ran") throw unanswered();
      // A script busy past the caller's timeout ran, but its reply never arrives.
      if (ran.busy) {
        tab.busyUntil = clock.t + ran.busy;
        if (tab.busyUntil - sent >= limit) throw unanswered();
        clock.t = tab.busyUntil;
      }
      // state.dropAfterAssign: the reply to the execute that started a navigation is lost.
      if (state.dropAfterAssign && tab.pending && tab.pending !== before) throw unanswered();
      // state.failAfterRun: the next script runs, then the execute fails at once
      // with an error that says nothing about whether it ran.
      if (state.failAfterRun) { state.failAfterRun = false; throw new Error("Some other AppleScript error."); }
      afterExecute(spec);
      return b.kind === "arc" ? JSON.stringify(r) : r;
    };
    tab.select = () => { bump("tab.select", b.name); w.spec.active = w.tabs.indexOf(tab); };
    // Closing removes the tab; a window keeps showing the same tab, or its neighbour.
    tab.close = () => {
      bump("tab.close", b.name);
      const i = w.tabs.indexOf(tab);
      if (i < 0) throw gone();
      const shown = w.tabs[w.spec.active];
      w.tabs.splice(i, 1);
      w.spec.active = shown && shown !== tab ? w.tabs.indexOf(shown) : Math.min(i, w.tabs.length - 1);
      log.push(["close", b.name, spec.id ?? spec.url]);
    };
    return tab;
  }

  function makeWindow(spec, b) {
    const w = { spec, tabs: [] };
    spec.tabs.forEach((t) => w.tabs.push(makeTab(t, b, w)));
    const coll = new Proxy([], {
      get(_, k) {
        if (k === "length") { bump("tabs.length", b.name); return w.tabs.length; }
        if (k === "url") return () => { bump("tabs.url()", b.name); return w.tabs.map((t) => t.shownUrl()); };
        if (k === "title" || k === "name") return () => { bump("tabs.title()", b.name); return w.tabs.map((t) => t.spec.title || ""); };
        if (k === "id") return () => { bump("tabs.id()", b.name); if (state.tabIdsFail) throw new Error("Can't get object."); return w.tabs.map((t) => t.spec.id); };
        if (k === "location") return () => { bump("tabs.location()", b.name); return w.tabs.map((t) => t.spec.location || "unpinned"); };
        if (k === "byId") return (id) => { bump("tabs.byId", b.name); return w.tabs.find((t) => String(t.spec.id) === String(id)) || missing; };
        if (k === "index") return () => w.tabs.map((_, i) => i + 1);
        if (k === "push") return (t) => {
          // Arc's `make new tab` rejects about: and data: URLs (they can be set afterwards).
          if (b.kind === "arc" && /^(about|data):/.test(t.url)) throw new Error("Please provide a valid URL property for the make new tab command.");
          // b.dropOnCreate: the browser accepts `make new tab` and silently makes nothing.
          if (b.dropOnCreate) return;
          const tab = makeTab({ url: t.url, id: "new" + w.tabs.length }, b, w);
          if (b.kind === "arc" && state.arcSlowUrl && /^arc:/.test(t.url)) tab.slow = { ...state.arcSlowUrl, target: null }; w.tabs.push(tab); log.push(["newTab", b.name, t.url]);
          // b.selectOnCreate: the browser shows the tab it just made. b.raiseOnCreate:
          // it also brings its windows to the front.
          if (b.selectOnCreate) w.spec.active = w.tabs.length - 1;
          const i = b.raiseOnCreate ? cgEntries.findIndex((entry) => entry.owner === b.name) : -1;
          if (i > 0) cgEntries.unshift(cgEntries.splice(i, 1)[0]);
        };
        if (/^\d+$/.test(String(k))) return w.tabs[Number(k)];
        return undefined;
      },
    });
    const win = {};
    Object.defineProperty(win, "tabs", { get: () => { bump("win.tabs", b.name); return coll; } });
    Object.defineProperty(win, "id", { get: () => () => { bump("win.id()", b.name); if (spec.idFails) throw new Error("Can't get object."); return spec.id; } });
    win.name = () => { bump("win.name()", b.name); return spec.name ?? (w.tabs[spec.active]?.spec.title || ""); };
    // Arc: the sidebar order of the active space (spec.sidebar ids), Favorites excluded.
    Object.defineProperty(win, "activeSpace", { get: () => {
      if (b.kind !== "arc") throw new Error("Can't get object.");
      const side = spec.sidebar || w.tabs.filter((t) => t.spec.location !== "topApp").map((t) => t.spec.id);
      return { tabs: { id: () => { bump("space.tabs.id()", b.name); return side.slice(); } } };
    } });
    // Raising a window reorders the app's window list, like the real `index = 1`.
    Object.defineProperty(win, "index", { set: (v) => {
      bump("win.index=", b.name);
      spec.raised = v === 1;
      if (v === 1) { const all = winsByApp[b.name]; all.splice(all.indexOf(w), 1); all.unshift(w); }
    } });
    // Chrome Canary and Safari answer `bounds`; live, Canary fails `position`
    // ("Can't convert types") and Arc has neither. Each read, failed or not, costs
    // an Apple Event; `geom` counts them apart so other budgets stay as they are.
    win.position = () => { geom.position = (geom.position || 0) + 1; ae(b.name, "win.position()"); throw new Error("Can't convert types."); };
    win.size = () => { geom.size = (geom.size || 0) + 1; ae(b.name, "win.size()"); throw new Error("Can't convert types."); };
    win.bounds = () => { geom.bounds = (geom.bounds || 0) + 1; ae(b.name, "win.bounds()"); if (b.kind === "arc") throw new Error("no bounds"); return { x: spec.x ?? 0, y: spec.y ?? 0, width: spec.w ?? 800, height: spec.h ?? 600 }; };
    Object.defineProperty(win, "activeTabIndex", {
      get: () => () => { bump("win.activeTabIndex()", b.name); if (b.kind !== "chrome") throw new Error("Can't convert types"); return spec.active + 1; },
      set: (v) => { bump("win.activeTabIndex=", b.name); spec.active = v - 1; },
    });
    Object.defineProperty(win, "activeTab", {
      get: () => {
        bump("win.activeTab", b.name);
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
        index: () => { bump("win.currentTab.index()", b.name); if (b.kind !== "safari") throw new Error("Can't convert types"); return spec.active + 1; },
        __specifier: true,
      }),
      set: (t) => { bump("win.currentTab=", b.name); if (b.kind !== "safari") throw new Error("Can't convert types"); spec.active = w.tabs.indexOf(t); },
    });
    w.win = win;
    return w;
  }

  const apps = {};
  const winsByApp = {};
  const nsString = (str) => ({
    js: str,
    dataUsingEncoding: (enc) => (enc === 0x94000100 ? { length: str.length * 2, bytes: str } : null),
    // A text file in state.files; a request the capture helper watches for is queued.
    writeToFileAtomicallyEncodingError: (path) => { state.files[path] = { text: str }; helperSaw(path); return true; },
  });
  const specifier = (resolveWin) => new Proxy({}, {
    get: (_, k) => { const w = resolveWin(); if (!w) throw gone(); const v = w[k]; return typeof v === "function" && !v.__specifier ? v.bind(w) : v; },
    set: (_, k, v) => { resolveWin()[k] = v; return true; },
  });
  for (const b of browsers) {
    const wins = (b.windows || []).map((ws) => makeWindow(ws, b));
    winsByApp[b.name] = wins;
    const a = {
      running: () => { bump(`running(${b.name})`, b.name); return b.running !== false; },
      activate: () => {
        bump(`activate(${b.name})`, b.name); log.push(["activate", b.name]);
        // Another app can keep the front (a modal, a full-screen space).
        if (state.activateFails) return;
        const i = cgEntries.findIndex((entry) => entry.owner === b.name);
        if (i > 0) cgEntries.unshift(cgEntries.splice(i, 1)[0]);
      },
      doJavaScript: (js, { in: tab }) => {
        bump("doJavaScript", b.name);
        if (tab && tab.__specifier) tab = tab();
        if (!tab || !winsByApp[b.name].some((x) => x.tabs.includes(tab))) throw gone();
        // Live on macOS 27.2 Safari runs JS in any tab; state.safariCurrentOnly
        // models versions that only run it in the window's current tab.
        if (state.safariCurrentOnly && !tab._active) throw new Error("Safari: tab is not current");
        const r = tab.spec.dom ? tab.spec.dom.eval(js) : vm.runInContext(js, tab.page.ctx);
        afterExecute(tab.spec);
        return r;
      },
      Tab: (props) => props,
      Window: () => ({ make: () => wins.push(makeWindow({ id: 999, active: 0, tabs: [] }, b)) }),
      Document: () => ({ make: () => wins.push(makeWindow({ id: 999, active: 0, tabs: [] }, b)) }),
    };
    a.windows = new Proxy([], {
      get(_, k) {
        if (k === "length") { bump(`windows.length(${b.name})`, b.name); return wins.length; }
        // JXA specifiers are lazy: windows[k] means "whatever is k-th when used".
        if (/^\d+$/.test(String(k))) {
          bump(`windows[${k}](${b.name})`, b.name);
          return specifier(() => wins[Number(k)] && wins[Number(k)].win);
        }
        if (k === "byId") return (id) => specifier(() => { const w = wins.find((x) => String(x.spec.id) === String(id)); return w && w.win; });
        if (k === "id") return () => { bump(`windows.id()(${b.name})`, b.name); return wins.map((w) => w.spec.id); };
        if (k === "name") return () => { bump(`windows.name()(${b.name})`, b.name); return wins.map((w) => w.spec.name ?? (w.tabs[w.spec.active]?.spec.title || "")); };
        // Every window's elements in one event (nested arrays, one per window); counted like a per-window bulk read.
        if (k === "tabs") return {
          url: () => { bump("tabs.url()", b.name); return wins.map((w) => w.tabs.map((t) => t.shownUrl())); },
          title: () => { bump("tabs.title()", b.name); return wins.map((w) => w.tabs.map((t) => t.spec.title || "")); },
          name: () => { bump("tabs.title()", b.name); return wins.map((w) => w.tabs.map((t) => t.spec.title || "")); },
          id: () => { bump("tabs.id()", b.name); return wins.map((w) => w.tabs.map((t) => t.spec.id)); },
          location: () => { bump("tabs.location()", b.name); return wins.map((w) => w.tabs.map((t) => t.spec.location || "unpinned")); },
        };
        // Arc: a window showing no tab reads as null here, though its own activeTab.id() throws.
        if (k === "activeTab") return { id: () => { bump(`windows.activeTab.id()(${b.name})`, b.name); if (b.kind !== "arc" || state.arcBulkFails) throw new Error("Can't convert types"); return wins.map((w) => (w.tabs[w.spec.active] ? w.tabs[w.spec.active].spec.id : null)); } };
        if (k === "activeSpace") return { tabs: { id: () => { bump("space.tabs.id()", b.name); if (b.kind !== "arc") throw new Error("Can't get object."); return wins.map((w) => w.spec.sidebar || w.tabs.filter((t) => t.spec.location !== "topApp").map((t) => t.spec.id)); } } };
        if (k === "activeTabIndex") return () => { bump(`windows.activeTabIndex()(${b.name})`, b.name); if (b.kind !== "chrome") throw new Error("Can't convert types"); return wins.map((w) => w.spec.active + 1); };
        if (k === "currentTab") return { index: () => { bump(`windows.currentTab.index()(${b.name})`, b.name); if (b.kind !== "safari") throw new Error("Can't convert types"); return wins.map((w) => w.spec.active + 1); } };
        return undefined;
      },
    });
    apps[b.name] = a;
  }

  // NSAppleScript understands one shape: the runtime's bounded execute, a handler
  // `on perch_exec(js, ms) / with timeout of (ms / 1000) seconds / tell application
  // "A" to execute tab id "T" of window id "W" javascript js / end timeout / end
  // perch_exec`, where the tab may instead be `active tab` (the one the window
  // shows) and the window `window N` (1-based, front first),
  // called by a subroutine Apple Event whose direct object is the list {js, ms}.
  // state.compiles counts compilations (a live compile costs about as much as the
  // execute), apart from `counts`, which the Apple Event budgets sum.
  const asString = String.raw`"((?:[^"\\]|\\.)*)"`;
  const asHandler = new RegExp(String.raw`^on perch_exec\(js, ms\)\nwith timeout of \(ms / 1000\) seconds\ntell application ${asString} to execute (?:tab id ${asString}|active tab) of window (?:id ${asString}|(\d+)) javascript js\nend timeout\nend perch_exec$`);
  const unquote = (s) => s.replace(/\\(.)/g, "$1");
  state.compiles = 0;
  function appleScript(src) {
    let m = null;
    const compile = () => {
      if (m) return true;
      state.compiles++;
      m = asHandler.exec(src);
      if (!m) throw new Error("fake NSAppleScript: unsupported source " + JSON.stringify(src));
      return true;
    };
    return {
      // state.compileFails: the handler doesn't compile, so the bounded execute fails fast.
      compileAndReturnError: () => !state.compileFails && compile(),
      executeAppleEventError: (ev, err) => {
        compile();
        const P = ev.params;
        if (ev.cls !== 0x61736372 || ev.id !== 0x70736272 || P[0x736e616d].s !== "perch_exec") throw new Error("fake NSAppleScript: not a perch_exec call");
        const [jsD, msD] = P[0x2d2d2d2d].items;
        return runAppleScript(m, jsD.s, msD.n, err);
      },
    };
  }
  // A failure returns nil; the error Ref is left holding a value that throws when
  // read, since live osascript segfaults reading it after a timeout.
  function runAppleScript(m, js, ms, err) {
    bump("NSAppleScript");
    const [appName, tabId, winId, winIndex] = m.slice(1).map((x) => x == null ? x : unquote(x));
    const nil = () => {
      Object.defineProperty(err, 0, { get: () => { state.segv = true; throw new Error("SEGV: read a freed error Ref"); } });
      return { isNil: () => true };
    };
    // A second instance of the app (state.twins) takes AppleScript's by-name
    // `tell`; it has none of the user's tabs, so the execute fails at once.
    if (twinOf(appName)) return nil();
    const wins = winsByApp[appName] || [];
    const w = winIndex != null ? wins[Number(winIndex) - 1] : wins.find((x) => String(x.spec.id) === winId);
    // No tab id: `active tab of window N`, the tab that window shows.
    const tab = w && (tabId == null ? w.tabs[w.spec.active] : w.tabs.find((x) => String(x.spec.id) === tabId));
    if (!tab) return nil();
    try {
      const r = tab.execute({ javascript: js }, { timeoutMs: ms });
      return { isNil: () => false, stringValue: r == null ? r : String(r) };
    } catch (e) {
      return nil();
    }
  }
  // NSAppleEventDescriptor, enough to build that subroutine event.
  const aeDesc = {
    appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID: (cls, id) => {
      const ev = { cls, id, params: {} };
      ev.setParamDescriptorForKeyword = (d, k) => { ev.params[k] = d; };
      return ev;
    },
    get nullDescriptor() { return { null: true }; },
    get listDescriptor() {
      const l = { items: [] };
      l.insertDescriptorAtIndex = (d, i) => { l.items[i - 1] = d; };
      return l;
    },
    descriptorWithString: (s) => ({ s: String(s) }),
    descriptorWithInt32: (n) => ({ n }),
  };

  const axList = (items) => ({ count: items.length, objectAtIndex: (i) => items[i] });
  // AXValue's bridge only offers its description, e.g. "{value = x:917.000000 y:57.000000 ...}".
  const axPoint = (x, y) => ({ description: `<AXValue 0x1> {value = x:${x.toFixed(6)} y:${y.toFixed(6)} type = kAXValueCGPointType}` });
  const axSize = (w, h) => ({ description: `<AXValue 0x2> {value = w:${w.toFixed(6)} h:${h.toFixed(6)} type = kAXValueCGSizeType}` });
  const dialogFrame = (d) => d.frame || { x: 175, y: 120, w: 450, h: 160 };
  function axAttr(el, name) {
    if (el.role === "AXApplication") {
      if (name !== "AXWindows") return undefined;
      return axList(cgEntries.filter((c) => c.pid === el.pid && c.ax).map((c) => ({ role: "AXWindow", subrole: "AXStandardWindow", c }))
        .concat(state.dialogs.filter((d) => d.pid === el.pid).map((d) => ({ role: "AXWindow", subrole: "AXUnknown", d }))));
    }
    const box = el.role === "AXWindow" ? (el.c && (el.c.axFrame || el.c)) || (el.d && !el.inner ? dialogFrame(el.d) : null) : el.box;
    if (name === "AXRole") return el.role;
    if (name === "AXSubrole") return el.subrole;
    if (name === "AXTitle") return el.c ? el.c.axTitle : el.title;
    if (name === "AXValue") return el.role === "AXTextField" ? el.d.value || "" : el.value;
    // A dialog `{pid, texts, buttons, field?}`, shaped as Chrome Canary showed it
    // live: a window (subrole AXUnknown) holding another, holding a group with
    // subrole AXApplicationDialog. In it the origin line (texts[0]) is a heading,
    // the message lines are static texts (a prompt's are its field's title), then
    // the prompt's field and the buttons. Other shapes: `secure` makes the field a
    // secure one, `fields: n` repeats it, `noHeading` turns the origin line into
    // plain text, `controls: [{role, subrole?, title?}]` adds other elements
    // before the buttons, `tail` after them. `blocks` names the tab whose page it pauses. `parent` is the CGWindowID of the browser window the dialog is a
    // child of; without one it has no CG entry. `frame` is its AX frame, `cgFrame`
    // its CG one when they differ.
    if (el.d && el.role === "AXWindow" && name === "AXChildren") {
      const d = el.d;
      if (!el.inner) return axList([{ role: "AXButton", subrole: "AXCloseButton", title: "close" }, { role: "AXWindow", subrole: "AXUnknown", d, inner: true }]);
      // A prompt's message is its field's title, not a static text.
      const lines = d.field != null ? [] : d.texts.slice(d.noHeading ? 0 : 1);
      const kids = (d.noHeading ? [] : [{ role: "AXHeading", title: d.texts[0] }]).concat(lines.map((value) => ({ role: "AXGroup", kids: [{ role: "AXStaticText", value }] })));
      if (d.field != null) {
        for (let i = 0; i < (d.fields || 1); i++) kids.push({ role: "AXTextField", subrole: d.secure ? "AXSecureTextField" : undefined, title: d.texts.slice(1).join(" "), d });
      }
      (d.controls || []).forEach((c) => kids.push({ ...c }));
      d.buttons.forEach((title) => kids.push({ role: "AXButton", title, d, kids: [{ role: "AXStaticText", value: title }] }));
      (d.tail || []).forEach((c) => kids.push({ ...c }));
      return axList([{ role: "AXGroup", subrole: "AXApplicationDialog", d, kids: [{ role: "AXGroup", kids }] }]);
    }
    if (name === "AXPosition") return box ? axPoint(box.x, box.y) : undefined;
    if (name === "AXSize") return box ? axSize(box.w, box.h) : undefined;
    if (name === "AXChildren") {
      if (el.role === "AXWindow") return axList([{ role: "AXToolbar" }, { role: "AXGroup", kids: el.c.ax.web.map((box) => ({ role: "AXWebArea", box })) }]);
      // A page's own role=dialog also maps to AXApplicationDialog; it is not a JS dialog.
      if (el.role === "AXWebArea") return axList([{ role: "AXStaticText" }, { role: "AXGroup", subrole: "AXApplicationDialog", kids: [{ role: "AXStaticText", value: "Page modal" }, { role: "AXButton", title: "Close" }, { role: "AXButton", title: "Save" }] }]);
      return axList(el.kids || []);
    }
    return undefined;
  }

  // Nested frames: a web area box's optional `frames: [{url, box, kids, frames}]`
  // adds frame web areas after the area's own children. A kid is
  // `{role, subrole, title, description, value, enabled, expanded, focused, box}`,
  // read live, so a test can change it between calls. undefined: not a frame part.
  const frameKid = (k) => ({ role: k.role, fk: k, box: k.box });
  function frameAttr(el, name) {
    const fr = el.fr;
    if (name === "AXChildren" && el.role === "AXWebArea" && (fr || (el.box && el.box.frames))) {
      const own = fr ? (fr.kids || []).map(frameKid) : (() => { const l = axAttr(el, name); return Array.from({ length: l.count }, (_, i) => l.objectAtIndex(i)); })();
      return axList(own.concat(((fr || el.box).frames || []).map((f) => ({ role: "AXWebArea", fr: f, box: f.box }))));
    }
    if (fr && name === "AXURL") return { absoluteString: fr.url };
    if (!el.fk) return undefined;
    const k = el.fk;
    const v = { AXRole: k.role, AXSubrole: k.subrole, AXTitle: k.title, AXDescription: k.description, AXValue: k.value,
      AXEnabled: k.enabled, AXExpanded: k.expanded, AXFocused: k.focused,
      AXPosition: axPoint(k.box.x, k.box.y), AXSize: axSize(k.box.w, k.box.h), AXChildren: axList([]) }[name];
    return v === undefined ? null : v;
  }

  // Keyboard focus: `state.focus = { window: {x,y,w,h}, chain: [{role, box?}, ...] }`
  // is the application's AXFocusedWindow (by frame) and its AXFocusedUIElement,
  // chain[0], whose AXParent is chain[1], and so on up. No `state.focus`: neither
  // attribute answers. undefined: not a focus part.
  function focusAttr(el, name) {
    const f = state.focus;
    if (el.role === "AXApplication" && (name === "AXFocusedWindow" || name === "AXFocusedUIElement")) {
      if (!f) return null;
      if (name === "AXFocusedWindow") return { role: "AXWindow", fo: { box: f.window } };
      return { role: f.chain[0].role, fo: { chain: f.chain, i: 0, box: f.chain[0].box } };
    }
    if (!el.fo) return undefined;
    const o = el.fo, up = o.chain && o.chain[o.i + 1];
    const v = { AXRole: el.role,
      AXPosition: o.box && axPoint(o.box.x, o.box.y), AXSize: o.box && axSize(o.box.w, o.box.h),
      AXParent: up && { role: up.role, fo: { chain: o.chain, i: o.i + 1, box: up.box } } }[name];
    return v == null ? null : v;
  }

  // Hit testing: the element Accessibility finds at a screen point in the pid's
  // windows, front to back. A dialog's child window comes first, then each CG
  // entry with `ax`: inside a web area box the deepest frame holding the point,
  // and in it a kid holding it; elsewhere in the window, its toolbar. Each hit
  // carries its `parent` chain up to the window. `state.hitFail` makes the hit
  // test itself fail (kAXErrorCannotComplete); `state.unbound` lists symbols
  // bindFunction can't bind.
  function hitAt(pid, x, y) {
    const inBox = (b) => !!b && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
    const link = (chain) => { chain.forEach((el, i) => { el.parent = chain[i + 1] || null; }); return chain[0]; };
    const d = state.dialogs.find((d) => d.pid === pid && inBox(dialogFrame(d)));
    if (d) return link([{ role: "AXButton", title: d.buttons[0] }, { role: "AXGroup" }, { role: "AXWindow", subrole: "AXUnknown" }]);
    for (const c of cgEntries) {
      if (c.pid !== pid || !c.ax || !inBox(c.axFrame || c)) continue;
      const win = { role: "AXWindow", subrole: "AXStandardWindow", c };
      const web = c.ax.web.find(inBox);
      if (!web) return link([{ role: "AXButton", title: "Reload" }, { role: "AXToolbar" }, win]);
      const chain = [{ role: "AXWebArea", box: web }, { role: "AXGroup" }, win];
      for (let fs = web.frames || [], f; (f = fs.filter((g) => inBox(g.box)).pop()); fs = f.frames || []) chain.unshift({ role: "AXWebArea", fr: f, box: f.box });
      const kid = ((chain[0].fr && chain[0].fr.kids) || []).filter((k) => inBox(k.box)).pop();
      chain.unshift(kid ? frameKid(kid) : { role: "AXStaticText" });
      return link(chain);
    }
    return null;
  }

  // state.twins: [{name, bundle, pid, policy?}], second instances of a browser.
  // Every process is a regular app (activation policy 0) except a twin, which
  // defaults to 2 (prohibited: a headless instance, no Dock icon).
  // state.countFails: the instance count read throws. state.policies records
  // this process's own setActivationPolicy calls, state.sharedApp its
  // NSApplication.sharedApplication reads (either would register it as an app).
  const appKit = {
    NSRunningApplication: {
      runningApplicationsWithBundleIdentifier: (bundle) => {
        if (state.countFails) throw new Error("count read failed");
        return { count: 1 + (state.twins || []).filter((x) => x.bundle === bundle).length };
      },
      runningApplicationWithProcessIdentifier: (pid) => {
        const x = (state.twins || []).find((y) => y.pid === pid);
        return { isNil: () => false, activationPolicy: x ? x.policy ?? 2 : 0 };
      },
    },
    // state.screenScale: every screen's backing scale (default state.shotScale, or 2).
    NSScreen: { get screens() { const k = state.screenScale ?? state.shotScale ?? 2; return { count: 1, objectAtIndex: () => ({ backingScaleFactor: k }) }; } },
    NSApplication: { get sharedApplication() { state.sharedApp = (state.sharedApp || 0) + 1; return { setActivationPolicy: (p) => { state.policies.push(p); return true; } }; } },
  };
  // The capture helper, an osascript NSTask running the runtime's shotHelper.
  // state.helper (an object) makes it available: without it the capture lock is
  // held by another perch server, so flock fails and screencapture takes every
  // shot. A request written to its `<prefix>.req` is served
  // state.helper.ms (default 20) later by the runtime's own helperServe, which
  // captures with CGWindowListCreateImage; state.helper.stall: never served;
  // state.helper.exits: the helper ends at launch, unserved. state.helpers
  // records each launch as {args, killed}. state.lockFile: the lock file made.
  const helpers = [];
  let pendingReq = null;
  const helperOf = (path) => helpers.find((h) => h.alive && path === h.prefix + ".req");
  const helperSaw = (path) => { const h = helperOf(path); if (h) pendingReq = { h, path, at: clock.t }; };
  const helperServe = () => {
    const p = pendingReq;
    if (!p || !p.h.alive || state.helper.stall || clock.t < p.at + (state.helper.ms ?? 20)) return;
    pendingReq = null;
    const f = state.files[p.path];
    delete state.files[p.path];
    if (!f) return;
    const q = JSON.parse(f.text);
    const r = sandbox.__perch.helperServe(q);
    state.files[q.out] = { text: JSON.stringify(r) };
  };
  const fakeHelper = (task) => {
    const h = { args: task.arguments.slice(), alive: !state.helper.exits, killed: false, filesAtLaunch: Object.keys(state.files) };
    h.prefix = /shotHelper\("([^"]+)", \d+\)$/.exec(h.args[3])[1];
    helpers.push(h);
    (state.helpers = state.helpers || []).push(h);
    return h;
  };
  // screencapture as an NSTask: it runs on the fake clock and writes its image
  // when done; a terminated one writes nothing.
  const tasks = {};
  const perRun = (v, i) => (Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v);
  const fakeTask = () => {
    let shot = null, doneAt = null;
    const task = {
      executableURL: null, arguments: null, standardOutput: null, standardError: null, terminationStatus: 0,
      launchAndReturnError: () => {
        if (task.executableURL.path === "/usr/bin/osascript") {
          bump("helper");
          const h = fakeHelper(task);
          task.processIdentifier = 4100 + helpers.length;
          tasks[task.processIdentifier] = task;
          task.helper = h;
          return true;
        }
        bump("screencapture");
        if (state.captureThrows) throw new Error("launch failed");
        const args = task.arguments, wid = Number(args[args.indexOf("-l") + 1]);
        shot = { args: [task.executableURL.path, ...args], wid, type: args[args.indexOf("-t") + 1], axBefore: counts.AX || 0, run: state.shots.length };
        state.shots.push(shot);
        doneAt = clock.t + (perRun(state.captureMs, shot.run) ?? 0);
        return true;
      },
      processIdentifier: 3131,
      get isRunning() {
        if (task.helper) return task.helper.alive;
        if (shot.killed || clock.t < doneAt) return !shot.killed;
        if (!shot.written) {
          shot.written = true;
          task.terminationStatus = perRun(state.captureExit, shot.run) ?? 0;
          const c = cgEntries.find((e) => (e.wid ?? 1) === shot.wid);
          const s = state.shotScale ?? 2;
          const file = c && !perRun(state.shotEmpty, shot.run) ? { w: (c.w ?? 800) * s, h: (c.h ?? 600) * s, shot } : { w: 0, h: 0, shot };
          if (perRun(state.unreadable, shot.run)) file.unreadable = true;
          state.files[shot.args[shot.args.length - 1]] = file;
        }
        return false;
      },
      get terminate() { if (task.helper) { task.helper.alive = false; task.helper.killed = true; return undefined; } shot.termed = true; if (!state.ignoreTerm) { shot.killed = true; task.terminationStatus = 15; } return undefined; },
    };
    tasks[task.processIdentifier] = task;
    task.shot = () => shot;
    return task;
  };
  const sandbox = {
    Ref: () => [],
    Application: (name) => {
      bump(`Application(${name})`);
      if (name === "System Events") throw new Error("SE touched");
      if (!apps[name]) throw new Error("Application can't be found.");
      return apps[name];
    },
    delay: (s) => { (state.delays = state.delays || []).push(s); clock.t += Math.round(s * 1000); },
    Date: { now: () => clock.t },
    ObjC: {
      // AppKit's classes exist only once it is imported, as in real osascript.
      import: (name) => { state.imports.push(name); if (name === "AppKit") Object.assign(sandbox.$, appKit); },
      castRefToObject: (x) => x,
      deepUnwrap: (x) => { bump("deepUnwrap"); return x; },
      unwrap: (x) => x,
      bindFunction: (name) => { if ((state.unbound || []).includes(name)) throw new Error("symbol not found: " + name); },
    },
    // JXA's `$` is callable (`$()` is a nil pointer) and carries the bridged symbols.
    // $(jsString) bridges to an NSString; only real UTF-16LE (0x94000100) encodes.
    $: Object.assign((str) => (str === undefined ? null : Array.isArray(str) ? str.slice() : nsString(str)), {
      // CoreGraphics / AppKit stand-ins for trusted input: events are recorded, not posted.
      CGPointMake: (x, y) => ({ x, y }),
      dlopen: () => ({}),
      NSMakeRange: (location, length) => ({ location, length }),
      NSMutableData: { dataWithLength: makeData },
      memset: (bytes, value, len) => { bytes.fill(value, 0, len); return bytes; },
      CGEventCreateMouseEvent: (_s, type, pt) => ({ kind: "mouse", type, pt, fields: {} }),
      CGEventSourceCreate: () => ({}),
      CGEventCreateKeyboardEvent: (_s, vk, down) => ({ kind: "key", vk, down, fields: {} }),
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
      NSAppleScript: { alloc: { initWithSource: (src) => appleScript(src) } },
      NSAppleEventDescriptor: aeDesc,
      AXIsProcessTrusted: () => state.ax,
      // Accessibility tree: a CG entry's `ax: { web: [{x,y,w,h}, ...] }` lists the
      // window's web areas (the page, and a side panel's). No `ax`: nothing matches.
      AXUIElementCreateApplication: (pid) => ({ role: "AXApplication", pid }),
      // An entry's `axFrame` is its AX window's frame when it differs from CG's;
      // `axWid` is the CGWindowID its AX window reports (unreadable without one),
      // `axTitle` that window's AXTitle.
      _AXUIElementGetWindow: (el, out) => {
        bump("AX");
        if (!el.c || el.c.axWid == null) return -25205;
        out[0] = el.c.axWid;
        return 0;
      },
      AXUIElementCopyAttributeValue: (el, name, out) => {
        bump("AX");
        // state.axMs: each attribute read takes that long (a browser slow to answer Accessibility).
        if (state.axMs) clock.t += state.axMs;
        // A closed dialog's elements are gone: kAXErrorInvalidUIElement.
        if (el.d && !state.dialogs.includes(el.d)) return -25202;
        // A kid removed from its frame is gone, like a closed dialog's elements.
        if (el.fk && el.fk.gone) return -25202;
        // state.axThrow: reading a frame's web area throws it, as a bridge failure would.
        if (el.fr && state.axThrow) throw state.axThrow;
        if (name.js === "AXParent" && el.parent !== undefined) {
          if (!el.parent) return -25205;
          out[0] = el.parent;
          return 0;
        }
        let f = focusAttr(el, name.js);
        if (f === undefined) f = frameAttr(el, name.js);
        const v = f === undefined ? axAttr(el, name.js) : f === null ? undefined : f;
        if (v === undefined) return -25205; // kAXErrorAttributeUnsupported
        out[0] = v;
        return 0;
      },
      // Dialog answers are recorded; an AXPress on a dialog's button closes it
      // unless the dialog is `sticky`.
      AXUIElementPerformAction: (el, action) => {
        bump("AXAction");
        state.axActions.push({ role: el.role, title: el.title, action: action.js });
        if (el.role === "AXButton" && action.js === "AXPress" && el.d && !el.d.sticky) {
          el.d.answer = el.title;
          state.dialogs.splice(state.dialogs.indexOf(el.d), 1);
          if (state.onAxPress) state.onAxPress(el);
        }
        return 0;
      },
      AXUIElementSetAttributeValue: (el, name, value) => {
        bump("AXSet");
        if (el.role !== "AXTextField" || name.js !== "AXValue") return -25205;
        el.d.value = value.js;
        return 0;
      },
      AXUIElementCopyElementAtPosition: (el, x, y, out) => {
        bump("AX");
        if (state.hitFail) return -25204; // kAXErrorCannotComplete
        const hit = el.role === "AXApplication" ? hitAt(el.pid, x, y) : null;
        if (!hit) return -25212; // kAXErrorNoValue
        out[0] = hit;
        return 0;
      },
      // Two element refs are equal when they name the same window or web area.
      CFEqual: (a, b) => a === b || (!!a && !!b && a.role === b.role && ((!!a.box && a.box === b.box) || (!!a.c && a.c === b.c))),
      AXIsProcessTrustedWithOptions: () => state.ax,
      kCFBooleanFalse: false,
      kAXTrustedCheckOptionPrompt: "prompt",
      // Screen capture: the runtime runs screencapture (an NSTask), which writes a
      // CG entry's pixels at state.shotScale (default 2, a Retina display) times
      // its frame to its file, or an empty image for a window not in the list or
      // with state.shotEmpty. state.capture false: no Screen Recording grant. Each
      // capture is recorded in state.shots as {args, wid}, plus `crop` (the pixel
      // rect cut from it), `scaled` (the bitmap context it was drawn into),
      // `encoded` ({type, props, w, h}) and `killed` (it was terminated).
      // state.captureThrows: the launch throws. state.captureMs: each capture
      // takes that long; Infinity never finishes. state.captureExit: the run
      // exits with that status, its file still written. state.unreadable: the
      // file is written but won't load. Each of captureMs, captureExit,
      // shotEmpty and unreadable may be an array, one entry per run in order,
      // the last repeating; state.shots[i].run is that index. state.ignoreTerm: SIGTERM is ignored,
      // only SIGKILL (recorded in state.sigkills) stops it. state.files holds
      // what is written and not yet removed.
      CGPreflightScreenCaptureAccess: () => { bump("CGPreflight"); return state.capture !== false; },
      CGRectMake: (x, y, w, h) => ({ x, y, w, h }),
      // Only the capture helper calls it: a CG entry's pixels at state.shotScale,
      // recorded in state.shots as {cg: wid}.
      CGWindowListCreateImage: (_rect, _opt, wid) => {
        bump("CGWindowListCreateImage");
        const shot = { cg: wid, run: state.shots.length };
        state.shots.push(shot);
        const c = cgEntries.find((e) => (e.wid ?? 1) === wid), s = state.shotScale ?? 2;
        return c && !perRun(state.shotEmpty, shot.run) ? { w: (c.w ?? 800) * s, h: (c.h ?? 600) * s, shot } : { w: 0, h: 0, shot };
      },
      CGRectNull: { null: true },
      // The capture lock: held by another perch server unless state.helper is set.
      NSFileHandle: {
        fileHandleWithNullDevice: { nullDevice: true },
        fileHandleForUpdatingAtPath: (path) => (path === state.lockFile ? { isNil: () => false, fileDescriptor: 7, closeFile: undefined } : null),
      },
      flock: (fd, op) => { bump("flock"); (state.flocks = state.flocks || []).push(op); return op & 2 && !state.helper ? -1 : 0; },
      getppid: () => { bump("getppid"); return state.ppid ?? 555; },
      access: (path) => { if (state.helper) helperServe(); return path in state.files || path === state.lockFile ? 0 : -1; },
      NSString: { stringWithString: (str) => nsString(str), stringWithContentsOfFileEncodingError: (path) => {
        const f = state.files[path];
        return f && f.text != null ? { isNil: () => false, js: f.text } : { isNil: () => true };
      } },
      NSTemporaryDirectory: () => nsString("/tmp/fake/"),
      NSProcessInfo: { processInfo: { processIdentifier: 555 } },
      NSURL: { fileURLWithPath: (path) => ({ path }) },
      // A file's bytes: a PNG or TIFF header naming the image's size.
      NSData: { dataWithContentsOfFile: (path) => {
        const f = state.files[path];
        if (!f) return { isNil: () => true, length: 0 };
        const bytes = Buffer.alloc(33);
        if (f.shot.type === "png") { bytes.writeUInt32BE(0x89504e47, 0); bytes.writeUInt32BE(f.w, 16); bytes.writeUInt32BE(f.h, 20); }
        else bytes.writeUInt32BE(0x49492a00, 0);
        return { isNil: () => false, length: bytes.length, base64EncodedStringWithOptions: () => ({ js: bytes.toString("base64") }) };
      } },
      NSTask: { alloc: { get init() { return fakeTask(); } } },
      kill: (pid, sig) => { (state.sigkills = state.sigkills || []).push([pid, sig]); const t = tasks[pid]; if (t && sig === 9) { t.shot().killed = true; t.terminationStatus = 9; } return 0; },
      NSFileManager: { defaultManager: {
        removeItemAtPathError: (path) => { const had = path in state.files; delete state.files[path]; return had; },
        fileExistsAtPath: (path) => { if (state.helper) helperServe(); return path in state.files || path === state.lockFile; },
        createFileAtPathContentsAttributes: (path) => { state.lockFile = path; return true; },
        moveItemAtPathToPathError: (from, to) => { if (!(from in state.files)) return false; state.files[to] = state.files[from]; delete state.files[from]; return true; },
      } },
      // A crop keeps the pixels inside the image; the rect is recorded as shot.crop.
      CGImageCreateWithImageInRect: (img, r) => {
        img.shot.crop = { x: r.x, y: r.y, w: r.w, h: r.h };
        const w = Math.max(0, Math.min(img.w, r.x + r.w) - Math.max(0, r.x)), h = Math.max(0, Math.min(img.h, r.y + r.h) - Math.max(0, r.y));
        return w && h ? { w, h, shot: img.shot } : null;
      },
      CGImageGetWidth: (img) => (img ? img.w : 0),
      CGImageGetHeight: (img) => (img ? img.h : 0),
      CGImageGetColorSpace: () => ({ colorSpace: "image" }),
      CGColorSpaceCreateDeviceRGB: () => ({ colorSpace: "rgb" }),
      CGBitmapContextCreate: (_data, w, h, bpc, bpr, space, info) => ({ w, h, bpc, bpr, space, info }),
      CGContextSetInterpolationQuality: (ctx, q) => { ctx.quality = q; },
      CGContextDrawImage: (ctx, rect, img) => { ctx.rect = rect; ctx.img = img; img.shot.scaled = ctx; },
      CGBitmapContextCreateImage: (ctx) => (ctx.img && !state.scaleFail ? { w: ctx.w, h: ctx.h, shot: ctx.img.shot } : { w: 0, h: 0 }),
      NSBitmapImageFileTypeJPEG: 3,
      NSBitmapImageFileTypePNG: 4,
      NSBitmapImageRep: { imageRepWithContentsOfFile: (path) => (state.files[path] ? (state.files[path].unreadable ? { isNil: () => true } : { isNil: () => false, CGImage: state.files[path] }) : null), alloc: { initWithCGImage: (img) => ({
        representationUsingTypeProperties: (type, props) => {
          img.shot.encoded = { type, props: props ? JSON.parse(JSON.stringify(props.js)) : null, w: img.w, h: img.h };
          const bytes = Buffer.alloc(33);
          if (type === 4) { bytes.writeUInt32BE(0x89504e47, 0); bytes.writeUInt32BE(img.w, 16); bytes.writeUInt32BE(img.h, 20); }
          else Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, img.h >> 8, img.h & 255, img.w >> 8, img.w & 255]).copy(bytes);
          return { length: bytes.length, base64EncodedStringWithOptions: () => ({ js: bytes.toString("base64") }) };
        },
      }) } },
      CGWindowListCopyWindowInfo: () => {
        bump("CGWindowList");
        // state.onCgList(): a test's hook as the window list is read (time spent resolving).
        if (state.onCgList) state.onCgList();
        // A dialog's child window sits directly above its parent window.
        const rows = [];
        for (const e of cgEntries) {
          for (const d of state.dialogs) {
            if (d.parent != null && d.parent === e.wid) rows.push({ owner: e.owner, pid: d.pid, wid: d.wid ?? 900 + state.dialogs.indexOf(d), ...(d.cgFrame || dialogFrame(d)) });
          }
          rows.push(e);
        }
        return rows.map((e) => ({
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
    ctx, counts, geom, log, clock, apps, posted, cg: cgEntries, aeLog,
    aeBy: (app) => aeLog.filter(([a]) => a === app).map(([, k]) => k),
    // Reorder a window's tabs in place: tabs[w] is the live list the runtime reads.
    tabsOf: (name, w) => winsByApp[name][w].tabs,
    winSpec: (name, w) => winsByApp[name][w].spec,
    // The browser opens a tab by itself (a link's target, a popup), costing no
    // Apple Event; `select` shows it, as some browsers do.
    openTab: (name, w, url, { select = false } = {}) => {
      const W = winsByApp[name][w], id = "pop" + W.tabs.length;
      W.tabs.push(makeTab({ url, id }, browsers.find((b) => b.name === name), W));
      if (select) W.spec.active = W.tabs.length - 1;
      log.push(["opened", name, url]);
      return id;
    },
    // The user closes tab t of window w, or the whole window, with no Apple Event.
    closeTab: (name, w, t) => { const W = winsByApp[name][w]; W.tabs.splice(t, 1); W.spec.active = Math.min(W.spec.active, W.tabs.length - 1); },
    closeWindow: (name, w) => { winsByApp[name].splice(w, 1); },
    // The user opens a window in front of the others.
    openWindow: (name, spec) => { winsByApp[name].unshift(makeWindow(spec, browsers.find((b) => b.name === name))); },
    reset() { for (const o of [counts, geom]) for (const k of Object.keys(o)) delete o[k]; log.length = 0; aeLog.length = 0; },
    state,
    page: (name, w, t) => winsByApp[name][w].tabs[t].page.ctx,
    run: (src) => vm.runInContext(src, ctx),
    // A daemon stand-in with the real daemon's result contract, errorNumber suffix included.
    daemon: {
      run: async (script) => {
        let r;
        try { r = vm.runInContext(script, ctx); }
        catch (e) { throw new Error((e && e.message ? e.message : String(e)) + (e && typeof e.errorNumber === "number" ? " (" + e.errorNumber + ")" : "")); }
        return r == null ? "" : typeof r === "string" ? r : JSON.stringify(r);
      },
    },
  };
}
