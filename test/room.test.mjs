// Room tabs (room:<name>:<targetId>): a rooms Chromium in its own VM, driven over
// its token-gated DevTools endpoint instead of Apple Events. Every call here runs
// against the fake endpoint; the isolate preload makes any Apple Event a failure.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleCall, rooms, roomsReset } from "../server.js";
import { makeRooms } from "./fakes/cdp-room.mjs";

let R;
function use(opts) {
  R = makeRooms(opts);
  roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  return R;
}
beforeEach(() => roomsReset());

const call = async (name, args) => {
  const r = await handleCall(name, args);
  assert.equal(r.isError, undefined, r.content[0].text);
  const c = r.content[0];
  if (c.type !== "text") return r;
  try { return JSON.parse(c.text); } catch { return c.text; }
};
const fails = async (name, args) => {
  const r = await handleCall(name, args);
  const text = r.content[0].text;
  if (r.isError) return text;
  const o = JSON.parse(text);
  assert.equal(o.ok, false, text);
  return o.error;
};
const tab = (id = "T0001", room = "jobs") => ({ tabId: `room:${room}:${id}` });

test("list_tabs {app:'room'} lists every room that is up, by room handle", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<title>A</title>" }, { url: "https://b.test/" }] }, figma: {}, off: {} }, down: ["off"] });
  const o = await call("list_tabs", { app: "room" });
  assert.deepEqual(o.tabs.map((t) => [t.app, t.tabId, t.url]), [
    ["room:jobs", "room:jobs:T0001", "https://a.test/"],
    ["room:jobs", "room:jobs:T0002", "https://b.test/"],
    ["room:figma", "room:figma:T0001", "https://a.test/"],
  ]);
  assert.equal(o.tabs[0].title, "A");
  assert.match(o.warning, /room:off not listed: no_browser: room 'off' is not up/);
});

test("list_tabs {app:'room:<name>'} lists one room", async () => {
  use({ rooms: { jobs: {}, figma: {} } });
  const o = await call("list_tabs", { app: "room:figma" });
  assert.deepEqual(o.tabs.map((t) => t.tabId), ["room:figma:T0001"]);
});

test("an unknown room or a room that is down is no_browser", async () => {
  use({ rooms: { jobs: {} }, down: ["jobs"] });
  assert.match(await fails("eval_js", { script: "return 1", target: tab() }), /^error: no_browser: room 'jobs' is not up/);
  assert.match(await fails("eval_js", { script: "return 1", target: tab("T0001", "nope") }), /^error: no_browser: no room 'nope'/);
});

test("eval_js runs in the room's page, in an isolated world, over one connection", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<h1>Hi</h1>" }] } } });
  assert.equal(await call("eval_js", { script: "return document.querySelector('h1').textContent", target: tab() }), "Hi");
  assert.equal(await call("eval_js", { script: "return 1 + 1", target: tab() }), 2);
  const room = R.room("jobs");
  assert.equal(room.connects, 1);
  const ev = room.log.filter((m) => m.method === "Runtime.evaluate");
  assert.ok(ev.every((m) => m.params.contextId != null && m.params.returnByValue === true));
  assert.equal(room.log.filter((m) => m.method === "Page.createIsolatedWorld").length, 1);
});

test("eval_js {awaitPromise} waits for the promise", async () => {
  use();
  assert.equal(await call("eval_js", { script: "return new Promise((r) => setTimeout(() => r('late'), 30))", awaitPromise: true, target: tab() }), "late");
});

test("a page script's error comes back as eval_js's error", async () => {
  use();
  assert.match(await fails("eval_js", { script: "throw new TypeError('boom')", target: tab() }), /boom/);
});

test("a stale room tab is stale_tab", async () => {
  use();
  assert.match(await fails("eval_js", { script: "return 1", target: tab("GONE") }), /^error: stale_tab: /);
});

test("navigate loads the url and reports the committed one", async () => {
  use({ rooms: { jobs: { sites: { "https://b.test/x": "<p id=p>B</p>" } } } });
  const o = await call("navigate", { url: "https://b.test/x", target: tab() });
  assert.deepEqual([o.ok, o.url, o.waited], [true, "https://b.test/x", true]);
  assert.equal(await call("eval_js", { script: "return document.getElementById('p').textContent", target: tab() }), "B");
});

test("room navigation to a login path is a pending user handoff and notifies", async () => {
  use({ rooms: { jobs: { sites: { "https://a.test/login": "<h1>Sign in</h1><input type=password>" } } } });
  const notices = [];
  rooms.notify = async (a) => { notices.push(a); return { ok: true }; };
  const o = await call("navigate", { url: "https://a.test/login", target: tab() });
  assert.equal(o.ok, false);
  assert.match(o.error, /^signed_out: /);
  assert.deepEqual(o.handoff, { status: "pending", room: "jobs", reason: "login_path", command: "rooms view jobs --signin https://a.test/login" });
  assert.match(notices[0].message, /rooms view jobs/);
});

test("room navigation with a visible password field or challenge frame needs the user", async () => {
  use({ rooms: { jobs: { sites: {
    "https://a.test/account": "<h1>Account</h1><input type=password>",
    "https://a.test/apply": "<h1>Apply</h1><iframe src='https://www.google.com/recaptcha/api2/anchor'></iframe>",
  } } } });
  const notices = [];
  rooms.notify = async (a) => { notices.push(a); return { ok: true }; };
  const signIn = await call("navigate", { url: "https://a.test/account", target: tab() });
  assert.equal(signIn.ok, false);
  assert.equal(signIn.handoff.reason, "password_field");
  const challenge = await call("navigate", { url: "https://a.test/apply", target: tab() });
  assert.equal(challenge.ok, false);
  assert.match(challenge.error, /^challenge: /);
  assert.equal(challenge.handoff.reason, "challenge_frame");
  assert.equal(notices.length, 2);
});

test("room navigation obeys the site's registered signed-out pattern", async () => {
  use({ rooms: { jobs: {
    registeredSites: [{ origin: "https://a.test", url: "https://a.test/", signedOut: "/session-expired" }],
    sites: { "https://a.test/session-expired": "<h1>Session expired</h1>" },
  } } });
  rooms.notify = async () => ({ ok: true });
  const o = await call("navigate", { url: "https://a.test/session-expired", target: tab() });
  assert.equal(o.ok, false);
  assert.equal(o.handoff.reason, "login_path");
});

test("navigate to a url that fails to load is load_failed", async () => {
  use();
  assert.match(await fails("navigate", { url: "https://nowhere.test/", target: tab() }), /^load_failed: /);
});

test("new_tab opens a background tab in the room, close_tab closes it, and the last tab stays", async () => {
  use();
  const o = await call("new_tab", { app: "room:jobs", url: "about:blank" });
  assert.deepEqual([o.app, o.tabId], ["room:jobs", "room:jobs:T0002"]);
  const created = R.room("jobs").log.find((m) => m.method === "Target.createTarget");
  assert.equal(created.params.background, true);
  assert.deepEqual(await call("close_tab", { tabId: o.tabId }), { ok: true, closed: o.tabId });
  assert.match(await fails("close_tab", { tabId: "room:jobs:T0001" }), /last tab/);
});

test("click with readback reports what changed", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<button id=b>Save</button><p id=s>Idle</p>" }] } } });
  await call("eval_js", { script: "document.getElementById('b').addEventListener('click', () => setTimeout(() => { document.getElementById('s').textContent = 'Saved'; }, 20)); return 1", target: tab() });
  const o = await call("click", { selector: "#b", readback: "#s", target: tab() });
  assert.equal(o.ok, true);
  assert.match(JSON.stringify(o), /Saved/);
});

test("fill sets a field and reads it back", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<label for=n>Name</label><input id=n>" }] } } });
  const o = await call("fill", { selector: "#n", text: "Mateo", target: tab() });
  assert.equal(o.ok, true);
  assert.equal(await call("eval_js", { script: "return document.getElementById('n').value", target: tab() }), "Mateo");
});

test("click {trusted} is a CDP mouse press at the element's center: trusted, no OS input", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<button id=b data-rect='10,20,100,40'>Go</button>" }] } } });
  await call("eval_js", { script: "window.got = null; document.getElementById('b').addEventListener('click', (e) => { window.got = e.isTrusted; }); return 1", target: tab() });
  const o = await call("click", { selector: "#b", trusted: true, target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.hit, true);
  assert.equal(o.delivery, "cdp");
  assert.deepEqual(o.point, { x: 60, y: 40 });
  assert.equal(await call("eval_js", { script: "return window.got", target: tab() }), true);
  const mouse = R.room("jobs").log.filter((m) => m.method === "Input.dispatchMouseEvent").map((m) => [m.params.type, m.params.x, m.params.y]);
  assert.deepEqual(mouse, [["mouseMoved", 60, 40], ["mousePressed", 60, 40], ["mouseReleased", 60, 40]]);
});

test("click {trusted, x, y} in a room takes page (CSS) coordinates", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<button id=b data-rect='10,20,100,40'>Go</button>" }] } } });
  const o = await call("click", { x: 15, y: 25, trusted: true, target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.hit, true);
});

test("fill {trusted, raise} types with CDP insertText", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<input id=n data-rect='0,0,200,30'>" }] } } });
  const o = await call("fill", { selector: "#n", text: "héllo 🙂", trusted: true, raise: true, target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(await call("eval_js", { script: "return document.getElementById('n').value", target: tab() }), "héllo 🙂");
  assert.ok(R.room("jobs").log.some((m) => m.method === "Input.insertText" && m.params.text === "héllo 🙂"));
});

test("press {trusted} sends a CDP key to the page", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<input id=n>" }] } } });
  const o = await call("press", { key: "Enter", selector: "#n", trusted: true, target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.delivery, "cdp");
  const keys = R.room("jobs").log.filter((m) => m.method === "Input.dispatchKeyEvent").map((m) => [m.params.type, m.params.key]);
  assert.deepEqual(keys, [["keyDown", "Enter"], ["keyUp", "Enter"]]);
});

test("select picks a native option", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<label for=c>Country</label><select id=c><option>Chile</option><option>Uruguay</option></select>" }] } } });
  const o = await call("select", { selector: "#c", text: "Uruguay", target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(await call("eval_js", { script: "return document.getElementById('c').value", target: tab() }), "Uruguay");
});

test("accessibility_snapshot and get_text read the room's page", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<h1>Jobs</h1><button>Apply</button>" }] } } });
  const r = await handleCall("accessibility_snapshot", { target: tab() });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /button "Apply"/);
  const f = await handleCall("accessibility_snapshot", { target: tab(), frames: true });
  assert.equal(f.isError, undefined, f.content[0].text);
  assert.match(f.content[0].text, /button "Apply"/);
  const t = await handleCall("get_text", { target: tab() });
  assert.match(t.content[0].text, /Jobs/);
});

test("screenshot captures the room's tab over CDP", async () => {
  use();
  const r = await handleCall("screenshot", { target: tab() });
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  const img = r.content.find((c) => c.type === "image");
  assert.equal(img.mimeType, "image/png");
  assert.equal(R.room("jobs").shot.format, "png");
});

test("screenshot {selector} clips to the element", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<div id=d data-rect='10,20,300,100'>x</div>" }] } } });
  const r = await handleCall("screenshot", { selector: "#d", target: tab() });
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  assert.deepEqual(R.room("jobs").shot.clip, { x: 10, y: 20, width: 300, height: 100, scale: 1 });
});

test("an open dialog fails calls with dialog_open, and press {dialog} answers it", async () => {
  use();
  await call("eval_js", { script: "return 1", target: tab() });
  R.room("jobs").dialog("T0001", "confirm", "Leave?");
  await new Promise((r) => setTimeout(r, 5));
  assert.match(await fails("eval_js", { script: "return 1", target: tab() }), /^error: dialog_open: .*confirm.*Leave\?/);
  const o = await call("press", { key: "Enter", dialog: true, target: tab() });
  assert.deepEqual([o.ok, o.dialog, o.answer], [true, "confirm", "accept"]);
  assert.equal(await call("eval_js", { script: "return 2", target: tab() }), 2);
});

test("a navigation drops the isolated world; the next call makes a new one", async () => {
  use({ rooms: { jobs: { sites: { "https://b.test/": "<p>b</p>" } } } });
  await call("eval_js", { script: "return 1", target: tab() });
  await call("navigate", { url: "https://b.test/", target: tab() });
  assert.equal(await call("eval_js", { script: "return location.host", target: tab() }), "b.test");
});

test("activate_tab shows the tab inside the room only", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/" }, { url: "https://b.test/" }] } } });
  assert.deepEqual(await call("activate_tab", { target: tab("T0002") }), { ok: true });
  assert.equal(R.room("jobs").shown, "T0002");
});

test("rooms.home follows ROOMS_HOME", () => {
  assert.equal(typeof rooms.home, "string");
});

test("a trusted click on a link that navigates reports the press it landed", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<a id=l href='https://b.test/' data-rect='0,0,80,20'>Next</a>" }], sites: { "https://b.test/": "<p>b</p>" } } } });
  // The fake browser follows the link on click: a fresh document, as a real navigation leaves.
  await call("eval_js", { script: "document.getElementById('l').addEventListener('click', (e) => { if (e.isTrusted) window.__go = 1; }); return 1", target: tab() });
  const room = R.room("jobs");
  const orig = room.handle.bind(room);
  room.handle = (ws, msg) => {
    orig(ws, msg);
    if (msg.method === "Input.dispatchMouseEvent" && msg.params.type === "mouseReleased") {
      const t = room.targets.get("T0001");
      if (t.dom.eval("window.__go")) room.handle(ws, { id: -1, method: "Page.navigate", params: { url: "https://b.test/" }, sessionId: room.sessionOf("T0001") });
    }
  };
  const o = await call("click", { selector: "#l", trusted: true, target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.hit, true);
  assert.match(o.note, /navigated/);
});

test("eval_js {world:'main'} and {awaitPromise} evaluate in one CDP call, main in the page's own world", async () => {
  use();
  await call("eval_js", { script: "window.pageGlobal = 7; return 1", world: "main", target: tab() });
  assert.equal(await call("eval_js", { script: "return window.pageGlobal", world: "main", target: tab() }), 7);
  assert.equal(await call("eval_js", { script: "return await new Promise((r) => setTimeout(() => r(window.pageGlobal), 10))", world: "main", awaitPromise: true, target: tab() }), 7);
  const ev = R.room("jobs").log.filter((m) => m.method === "Runtime.evaluate");
  assert.equal(ev.length, 3);
  assert.ok(ev.every((m) => m.params.contextId == null && m.params.awaitPromise === true));
  assert.ok(!ev.some((m) => m.params.expression.includes("createElement(\"script\")")), "no script injection");
  const err = await handleCall("eval_js", { script: "throw new RangeError('nope')", world: "main", target: tab() });
  assert.match(err.content[0].text, /nope/);
});

test("press chords carry CDP modifiers, type no text, and cmd is ctrl in a room", async () => {
  use({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<input id=n>" }] } } });
  const keys = () => R.room("jobs").log.filter((m) => m.method === "Input.dispatchKeyEvent").map((m) => m.params);
  await call("press", { key: "ctrl+shift+k", selector: "#n", trusted: true, target: tab() });
  let k = keys();
  assert.equal(k[0].modifiers, 10);
  assert.equal(k[0].text, undefined);
  assert.equal(k[0].type, "rawKeyDown");
  R.room("jobs").log.length = 0;
  await call("press", { key: "cmd+a", selector: "#n", trusted: true, target: tab() });
  k = keys();
  assert.equal(k[0].modifiers, 2);
  assert.equal(k[0].text, undefined);
});

test("two perch server copies gate one room tab until its five-second lease expires", async () => {
  const R = makeRooms();
  const other = await import(`../server.js?second-room-lease=${Date.now()}`);
  roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  other.roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  await call("eval_js", { script: "return 1", target: tab() });
  const denied = await other.handleCall("eval_js", { script: "return 2", target: tab() });
  assert.match(denied.content[0].text, /tab_held: .*pid \d+/);
  const dir = join(R.home, "run", "leases");
  const path = join(dir, readdirSync(dir).find((x) => x.endsWith(".json")));
  const lease = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...lease, last: Date.now() - 6000 }));
  const got = await other.handleCall("eval_js", { script: "return 2", target: tab() });
  assert.equal(got.content[0].text, "2");
});

test("a lease transfer releases a key left down by the previous server", async () => {
  const shared = makeRooms({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<input id=n>" }] } } });
  const other = await import(`../server.js?room-key-recovery=${Date.now()}`);
  roomsReset({ home: shared.home, fetch: shared.fetch, WebSocket: shared.WebSocket });
  other.roomsReset({ home: shared.home, fetch: shared.fetch, WebSocket: shared.WebSocket });
  const room = shared.room("jobs"), original = room.handle.bind(room);
  let failed = false;
  room.handle = (ws, msg) => {
    if (!failed && msg.method === "Input.dispatchKeyEvent" && msg.params.type === "keyUp") {
      failed = true;
      room.reply(ws, { id: msg.id, error: { code: -32000, message: "key-up reply failed" } });
    } else original(ws, msg);
  };
  const first = await handleCall("press", { key: "Enter", selector: "#n", trusted: true, target: tab() });
  assert.equal(first.isError, true);
  const dir = join(shared.home, "run", "leases");
  const path = join(dir, readdirSync(dir).find((x) => x.endsWith(".json")));
  const lease = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(lease.held.type, "key");
  writeFileSync(path, JSON.stringify({ ...lease, last: Date.now() - 6000 }));
  const got = await other.handleCall("eval_js", { script: "return 3", target: tab() });
  assert.equal(got.content[0].text, "3");
  assert.equal(room.log.filter((x) => x.method === "Input.dispatchKeyEvent" && x.params.type === "keyUp").length, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).held, null);
});

test("a lease transfer releases a mouse button left down by the previous server", async () => {
  const shared = makeRooms({ rooms: { jobs: { tabs: [{ url: "https://a.test/", html: "<button id=b data-rect='0,0,80,30'>Go</button>" }] } } });
  const other = await import(`../server.js?room-mouse-recovery=${Date.now()}`);
  roomsReset({ home: shared.home, fetch: shared.fetch, WebSocket: shared.WebSocket });
  other.roomsReset({ home: shared.home, fetch: shared.fetch, WebSocket: shared.WebSocket });
  const room = shared.room("jobs"), original = room.handle.bind(room);
  let failed = false;
  room.handle = (ws, msg) => {
    if (!failed && msg.method === "Input.dispatchMouseEvent" && msg.params.type === "mouseReleased") {
      failed = true;
      room.reply(ws, { id: msg.id, error: { code: -32000, message: "mouse-up reply failed" } });
    } else original(ws, msg);
  };
  const first = await handleCall("click", { selector: "#b", trusted: true, target: tab() });
  assert.equal(first.isError, true);
  const dir = join(shared.home, "run", "leases");
  const path = join(dir, readdirSync(dir).find((x) => x.endsWith(".json")));
  const lease = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(lease.held.type, "mouse");
  writeFileSync(path, JSON.stringify({ ...lease, last: Date.now() - 6000 }));
  const got = await other.handleCall("eval_js", { script: "return 4", target: tab() });
  assert.equal(got.content[0].text, "4");
  assert.equal(room.log.filter((x) => x.method === "Input.dispatchMouseEvent" && x.params.type === "mouseReleased").length, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).held, null);
});
