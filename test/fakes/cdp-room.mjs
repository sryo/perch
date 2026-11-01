// A fake rooms install: a rooms.json under a temp ROOMS_HOME, and per room a fake
// DevTools endpoint (fetch for /json/version, a WebSocket class) whose page
// targets are happy-dom pages from helpers/page.mjs. Runtime.evaluate runs the
// expression in the page; Input.* dispatches trusted events at the element under
// the point (data-rect boxes; the last match in document order wins) or the focused
// element. Page.navigate loads `sites[url]` (html) as a fresh page. A dialog
// opened with room.dialog(targetId, ...) blocks Runtime.evaluate until handled.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../scripts/temp-dirs.mjs";
import { page } from "../helpers/page.mjs";

const TOKEN = "ab".repeat(24);

export function makeRooms({ rooms = { work: {} }, down = [] } = {}) {
  const home = tempDir("perch-rooms-");
  const reg = { version: 1, rooms: {} };
  const byPort = new Map();
  let port = 9300;
  for (const [name, spec] of Object.entries(rooms)) {
    reg.rooms[name] = { name, profile: join(home, "profiles", name), sites: spec.registeredSites || [], cdp: { host: "127.0.0.1", port, token: TOKEN } };
    byPort.set(port, new FakeRoom(name, spec, down.includes(name)));
    port++;
  }
  writeFileSync(join(home, "rooms.json"), JSON.stringify(reg));
  const fetch = async (url) => {
    const u = new URL(url);
    const room = byPort.get(Number(u.port));
    if (!room || room.down) throw new TypeError("fetch failed");
    if (!u.pathname.startsWith(`/${TOKEN}/`)) return { ok: false, status: 401, json: async () => ({}) };
    if (u.pathname.endsWith("/json/version")) return { ok: true, status: 200, json: async () => ({ Browser: "Chrome/156", webSocketDebuggerUrl: `ws://127.0.0.1:${u.port}/${TOKEN}/devtools/browser/b` }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const all = [...byPort.values()];
  const WebSocket = class {
    constructor(url) {
      const u = new URL(url);
      this.room = byPort.get(Number(u.port));
      this.room.sockets.push(this);
      this.room.connects++;
      setTimeout(() => (this.room.down ? this.onerror?.({ message: "refused" }) : this.onopen?.()), 0);
    }
    send(raw) { this.room.handle(this, JSON.parse(raw)); }
    close() { this.closed = true; setTimeout(() => this.onclose?.(), 0); }
  };
  return { home, fetch, WebSocket, room: (name) => all.find((r) => r.name === name) };
}

class FakeRoom {
  constructor(name, { tabs = [{ url: "https://a.test/", html: "" }], sites = {} } = {}, down = false) {
    this.name = name;
    this.down = down;
    this.sites = sites;
    this.targets = new Map();
    this.sessions = new Map();
    this.sockets = [];
    this.log = [];
    this.connects = 0;
    this.n = 0;
    this.shown = null;
    for (const t of tabs) this.open(t.url, t.html, t.id);
  }
  open(url, html, id) {
    const targetId = id || `T${String(++this.n).padStart(4, "0")}`;
    const dom = url === "about:blank" ? page("", { url: "about:blank" }) : page(html ?? this.sites[url] ?? "", { url });
    this.targets.set(targetId, { url, title: dom.document.title, dom, dialog: null, worlds: 0 });
    if (!this.shown) this.shown = targetId;
    return targetId;
  }
  // A page's alert/confirm/prompt, as the browser shows it: evaluate blocks until it is answered.
  dialog(targetId, type, message) {
    const t = this.targets.get(targetId);
    t.dialog = { type, message, waiting: [] };
    this.event("Page.javascriptDialogOpening", { type, message, url: t.url }, this.sessionOf(targetId));
  }
  sessionOf(targetId) { for (const [s, t] of this.sessions) if (t === targetId) return s; return undefined; }
  reply(ws, msg) { setTimeout(() => ws.onmessage?.({ data: JSON.stringify(msg) }), 0); }
  event(method, params, sessionId) { for (const ws of this.sockets) if (!ws.closed) this.reply(ws, { method, params, ...(sessionId ? { sessionId } : {}) }); }
  hitAt(dom, x, y) {
    let hit = null;
    for (const el of dom.document.body.querySelectorAll("*")) {
      const b = el.getBoundingClientRect();
      if (b.width && x >= b.left && x < b.right && y >= b.top && y < b.bottom) hit = el;
    }
    return hit || dom.document.body;
  }
  trusted(dom, el, type, init = {}) {
    const C = type.startsWith("key") ? dom.KeyboardEvent : type === "input" ? dom.InputEvent : dom.MouseEvent;
    const ev = new C(type, { bubbles: true, cancelable: true, composed: true, ...init });
    Object.defineProperty(ev, "isTrusted", { value: true });
    el.dispatchEvent(ev);
    return ev;
  }
  handle(ws, { id, method, params = {}, sessionId }) {
    this.log.push({ method, params, sessionId });
    const ok = (result = {}) => this.reply(ws, { id, result });
    const err = (message) => this.reply(ws, { id, error: { code: -32000, message } });
    const t = sessionId ? this.targets.get(this.sessions.get(sessionId)) : null;
    if (sessionId && !t) return err("Session with given id not found.");
    switch (method) {
      case "Target.getTargets": return ok({ targetInfos: [...this.targets].map(([targetId, x]) => ({ targetId, type: "page", url: x.dom.location.href, title: x.dom.document.title, attached: false })) });
      case "Target.createTarget": { const targetId = this.open(params.url); if (!params.background) this.shown = targetId; return ok({ targetId }); }
      case "Target.closeTarget": {
        if (!this.targets.delete(params.targetId)) return err("No target with given id found");
        const s = this.sessionOf(params.targetId);
        if (s) { this.sessions.delete(s); this.event("Target.detachedFromTarget", { sessionId: s, targetId: params.targetId }); }
        return ok({ success: true });
      }
      case "Target.activateTarget": this.shown = params.targetId; return ok();
      case "Target.attachToTarget": {
        if (!this.targets.has(params.targetId)) return err("No target with given id found");
        const s = `S${++this.n}`;
        this.sessions.set(s, params.targetId);
        return ok({ sessionId: s });
      }
      case "Page.enable": case "Runtime.enable": case "Browser.setDownloadBehavior": return ok();
      case "Page.getFrameTree": return ok({ frameTree: { frame: { id: "F-" + this.sessions.get(sessionId), url: t.dom.location.href } } });
      case "Page.createIsolatedWorld": t.worlds++; return ok({ executionContextId: 100 + t.worlds });
      case "Page.navigate": {
        if (t.dialog) return; // blocked, like the page
        if (this.sites[params.url] == null && !params.url.startsWith("about:")) return ok({ frameId: "F", loaderId: "L", errorText: "net::ERR_NAME_NOT_RESOLVED" });
        const next = page(this.sites[params.url] ?? "", { url: params.url });
        t.dom = next; t.url = params.url; t.worlds = 0;
        const loaderId = "L" + ++this.n;
        this.event("Page.frameNavigated", { frame: { id: "F-" + sessionId, url: params.url, loaderId } }, sessionId);
        return ok({ frameId: "F", loaderId });
      }
      case "Page.handleJavaScriptDialog": {
        if (!t.dialog) return err("No dialog is showing");
        const d = t.dialog; t.dialog = null;
        t.answered = { accept: params.accept, promptText: params.promptText };
        this.event("Page.javascriptDialogClosed", { result: params.accept, userInput: params.promptText || "" }, sessionId);
        for (const run of d.waiting) run();
        return ok();
      }
      case "Page.captureScreenshot": {
        // A 2x1 PNG's header is enough for perch's imageDims.
        const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(params.clip ? Math.round(params.clip.width) : 1440, 16); png.writeUInt32BE(params.clip ? Math.round(params.clip.height) : 900, 20);
        this.shot = params;
        return ok({ data: png.toString("base64") });
      }
      case "Runtime.evaluate": {
        if (params.contextId != null && params.contextId !== 100 + t.worlds) return err("Cannot find context with specified id");
        const run = () => {
          let value;
          try { value = t.dom.eval(params.expression); } catch (e) { return this.reply(ws, { id, result: { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: String(e) } } } }); }
          if (params.awaitPromise && value && typeof value.then === "function") return value.then((v) => this.reply(ws, { id, result: { result: { type: typeof v, value: v } } }));
          this.reply(ws, { id, result: { result: { type: typeof value, value } } });
        };
        if (t.dialog) return t.dialog.waiting.push(run);
        return run();
      }
      case "Input.dispatchMouseEvent": {
        // Chrome's order: the pointer event first; a cancelled pointerdown suppresses
        // the mouse events of that press, but the click still fires.
        const map = { mousePressed: "mousedown", mouseReleased: "mouseup", mouseMoved: "mousemove" };
        const el = this.hitAt(t.dom, params.x, params.y);
        const at = { clientX: params.x, clientY: params.y, button: 0 };
        const pointer = this.trusted(t.dom, el, map[params.type].replace("mouse", "pointer"), at);
        if (params.type === "mousePressed") t.suppressed = pointer.defaultPrevented;
        if (!(t.suppressed && params.type !== "mouseMoved")) this.trusted(t.dom, el, map[params.type], at);
        if (params.type === "mousePressed" && typeof el.focus === "function") el.focus();
        if (params.type === "mouseReleased") this.trusted(t.dom, el, "click", { clientX: params.x, clientY: params.y });
        return ok();
      }
      case "Input.insertText": {
        const el = t.dom.document.activeElement;
        if (el && "value" in el) { el.value += params.text; this.trusted(t.dom, el, "input", { data: params.text, inputType: "insertText" }); }
        return ok();
      }
      case "Input.dispatchKeyEvent": {
        const el = t.dom.document.activeElement || t.dom.document.body;
        this.trusted(t.dom, el, params.type === "keyUp" ? "keyup" : "keydown", { key: params.key, code: params.code, keyCode: params.windowsVirtualKeyCode });
        return ok();
      }
      default: return err(`'${method}' wasn't found`);
    }
  }
}
