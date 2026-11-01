// Room tabs (room:<name>:<targetId>): a rooms Chromium in its own VM, driven over
// its token-gated DevTools endpoint instead of Apple Events. Every call here runs
// against the fake endpoint; the isolate preload makes any Apple Event a failure.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleCall, rooms, roomsReset, roomHint, JXA_PRELUDE, DAEMONS } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
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
const tab = (id = "T0001", room = "work") => ({ tabId: `room:${room}:${id}` });

test("list_tabs {app:'room'} lists every room that is up, by room handle", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<title>A</title>" }, { url: "https://b.test/" }] }, figma: {}, off: {} }, down: ["off"] });
  const o = await call("list_tabs", { app: "room" });
  assert.deepEqual(o.tabs.map((t) => [t.app, t.tabId, t.url]), [
    ["room:work", "room:work:T0001", "https://a.test/"],
    ["room:work", "room:work:T0002", "https://b.test/"],
    ["room:figma", "room:figma:T0001", "https://a.test/"],
  ]);
  assert.equal(o.tabs[0].title, "A");
  assert.match(o.warning, /room:off not listed: no_browser: room 'off' is not up/);
});

test("list_tabs {app:'room:<name>'} lists one room", async () => {
  use({ rooms: { work: {}, figma: {} } });
  const o = await call("list_tabs", { app: "room:figma" });
  assert.deepEqual(o.tabs.map((t) => t.tabId), ["room:figma:T0001"]);
});

test("an unknown room or a room that is down is no_browser", async () => {
  use({ rooms: { work: {} }, down: ["work"] });
  assert.match(await fails("eval_js", { script: "return 1", target: tab() }), /^error: no_browser: room 'work' is not up/);
  assert.match(await fails("eval_js", { script: "return 1", target: tab("T0001", "nope") }), /^error: no_browser: no room 'nope'/);
});

test("eval_js runs in the room's page, in an isolated world, over one connection", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<h1>Hi</h1>" }] } } });
  assert.equal(await call("eval_js", { script: "return document.querySelector('h1').textContent", target: tab() }), "Hi");
  assert.equal(await call("eval_js", { script: "return 1 + 1", target: tab() }), 2);
  const room = R.room("work");
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
  use({ rooms: { work: { sites: { "https://b.test/x": "<p id=p>B</p>" } } } });
  const o = await call("navigate", { url: "https://b.test/x", target: tab() });
  assert.deepEqual([o.ok, o.url, o.waited], [true, "https://b.test/x", true]);
  assert.equal(await call("eval_js", { script: "return document.getElementById('p').textContent", target: tab() }), "B");
});

test("room navigation to a login path is a pending user handoff and notifies", async () => {
  use({ rooms: { work: { sites: { "https://a.test/login": "<h1>Sign in</h1><input type=password>" } } } });
  const notices = [];
  rooms.notify = async (a) => { notices.push(a); return { ok: true }; };
  const o = await call("navigate", { url: "https://a.test/login", target: tab() });
  assert.equal(o.ok, false);
  assert.match(o.error, /^signed_out: /);
  assert.deepEqual(o.handoff, { status: "pending", room: "work", reason: "login_path", command: "rooms signin work https://a.test/login" });
  assert.match(notices[0].message, /rooms signin work/);
});

test("room navigation with a visible password field or challenge frame needs the user", async () => {
  use({ rooms: { work: { sites: {
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
  use({ rooms: { work: {
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

test("new_tab opens a background tab in its own room window (so it keeps rendering frames), close_tab closes it, and the last tab stays", async () => {
  use();
  const o = await call("new_tab", { app: "room:work", url: "about:blank" });
  assert.deepEqual([o.app, o.tabId], ["room:work", "room:work:T0002"]);
  const created = R.room("work").log.find((m) => m.method === "Target.createTarget");
  assert.equal(created.params.background, true);
  assert.equal(created.params.newWindow, true);
  assert.deepEqual(await call("close_tab", { tabId: o.tabId }), { ok: true, closed: o.tabId });
  assert.match(await fails("close_tab", { tabId: "room:work:T0001" }), /last tab/);
});

test("click with readback reports what changed", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<button id=b data-rect='10,20,100,40'>Save</button><p id=s>Idle</p>" }] } } });
  await call("eval_js", { script: "document.getElementById('b').addEventListener('click', () => setTimeout(() => { document.getElementById('s').textContent = 'Saved'; }, 20)); return 1", target: tab() });
  const o = await call("click", { selector: "#b", readback: "#s", target: tab() });
  assert.equal(o.ok, true);
  assert.match(JSON.stringify(o), /Saved/);
});

test("fill sets a field and reads it back", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<label for=n>Name</label><input id=n>" }] } } });
  const o = await call("fill", { selector: "#n", text: "Mateo", target: tab() });
  assert.equal(o.ok, true);
  assert.equal(await call("eval_js", { script: "return document.getElementById('n').value", target: tab() }), "Mateo");
});

test("click {trusted} is a CDP mouse press at the element's center: trusted, no OS input", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<button id=b data-rect='10,20,100,40'>Go</button>" }] } } });
  await call("eval_js", { script: "window.got = null; document.getElementById('b').addEventListener('click', (e) => { window.got = e.isTrusted; }); return 1", target: tab() });
  const o = await call("click", { selector: "#b", trusted: true, target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.hit, true);
  assert.equal(o.delivery, "cdp");
  assert.deepEqual(o.point, { x: 60, y: 40 });
  assert.equal(await call("eval_js", { script: "return window.got", target: tab() }), true);
  const mouse = R.room("work").log.filter((m) => m.method === "Input.dispatchMouseEvent").map((m) => [m.params.type, m.params.x, m.params.y]);
  assert.deepEqual(mouse, [["mouseMoved", 60, 40], ["mousePressed", 60, 40], ["mouseReleased", 60, 40]]);
});

test("click {trusted, x, y} in a room takes page (CSS) coordinates", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<button id=b data-rect='10,20,100,40'>Go</button>" }] } } });
  const o = await call("click", { x: 15, y: 25, trusted: true, target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.hit, true);
});

test("fill {trusted, raise} types with CDP insertText", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<input id=n data-rect='0,0,200,30'>" }] } } });
  const o = await call("fill", { selector: "#n", text: "héllo 🙂", trusted: true, raise: true, target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(await call("eval_js", { script: "return document.getElementById('n').value", target: tab() }), "héllo 🙂");
  assert.ok(R.room("work").log.some((m) => m.method === "Input.insertText" && m.params.text === "héllo 🙂"));
});

test("press {trusted} sends a CDP key to the page", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<input id=n>" }] } } });
  const o = await call("press", { key: "Enter", selector: "#n", trusted: true, target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.delivery, "cdp");
  const keys = R.room("work").log.filter((m) => m.method === "Input.dispatchKeyEvent").map((m) => [m.params.type, m.params.key]);
  assert.deepEqual(keys, [["keyDown", "Enter"], ["keyUp", "Enter"]]);
});

test("select picks a native option", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<label for=c>Country</label><select id=c><option>Chile</option><option>Uruguay</option></select>" }] } } });
  const o = await call("select", { selector: "#c", text: "Uruguay", target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(await call("eval_js", { script: "return document.getElementById('c').value", target: tab() }), "Uruguay");
});

test("accessibility_snapshot and get_text read the room's page", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<h1>Jobs</h1><button>Apply</button>" }] } } });
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
  assert.equal(R.room("work").shot.format, "png");
});

test("screenshot {selector} clips to the element", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<div id=d data-rect='10,20,300,100'>x</div>" }] } } });
  const r = await handleCall("screenshot", { selector: "#d", target: tab() });
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  assert.deepEqual(R.room("work").shot.clip, { x: 10, y: 20, width: 300, height: 100, scale: 1 });
});

test("an open dialog fails calls with dialog_open, and press {dialog} answers it", async () => {
  use();
  await call("eval_js", { script: "return 1", target: tab() });
  R.room("work").dialog("T0001", "confirm", "Leave?");
  await new Promise((r) => setTimeout(r, 5));
  assert.match(await fails("eval_js", { script: "return 1", target: tab() }), /^error: dialog_open: .*confirm.*Leave\?/);
  const o = await call("press", { key: "Enter", dialog: true, target: tab() });
  assert.deepEqual([o.ok, o.dialog, o.answer], [true, "confirm", "accept"]);
  assert.equal(await call("eval_js", { script: "return 2", target: tab() }), 2);
});

test("a navigation drops the isolated world; the next call makes a new one", async () => {
  use({ rooms: { work: { sites: { "https://b.test/": "<p>b</p>" } } } });
  await call("eval_js", { script: "return 1", target: tab() });
  await call("navigate", { url: "https://b.test/", target: tab() });
  assert.equal(await call("eval_js", { script: "return location.host", target: tab() }), "b.test");
});

test("activate_tab shows the tab inside the room only", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/" }, { url: "https://b.test/" }] } } });
  assert.deepEqual(await call("activate_tab", { target: tab("T0002") }), { ok: true });
  assert.equal(R.room("work").shown, "T0002");
});

test("rooms.home follows ROOMS_HOME", () => {
  assert.equal(typeof rooms.home, "string");
});

test("a trusted click on a link that navigates reports the press it landed", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<a id=l href='https://b.test/' data-rect='0,0,80,20'>Next</a>" }], sites: { "https://b.test/": "<p>b</p>" } } } });
  // The fake browser follows the link on click: a fresh document, as a real navigation leaves.
  await call("eval_js", { script: "document.getElementById('l').addEventListener('click', (e) => { if (e.isTrusted) window.__go = 1; }); return 1", target: tab() });
  const room = R.room("work");
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
  const ev = R.room("work").log.filter((m) => m.method === "Runtime.evaluate");
  assert.equal(ev.length, 3);
  assert.ok(ev.every((m) => m.params.contextId == null && m.params.awaitPromise === true));
  assert.ok(!ev.some((m) => m.params.expression.includes("createElement(\"script\")")), "no script injection");
  const err = await handleCall("eval_js", { script: "throw new RangeError('nope')", world: "main", target: tab() });
  assert.match(err.content[0].text, /nope/);
});

test("press chords carry CDP modifiers, type no text, and cmd is ctrl in a room", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<input id=n>" }] } } });
  const keys = () => R.room("work").log.filter((m) => m.method === "Input.dispatchKeyEvent").map((m) => m.params);
  await call("press", { key: "ctrl+shift+k", selector: "#n", trusted: true, target: tab() });
  let k = keys();
  assert.equal(k[0].modifiers, 10);
  assert.equal(k[0].text, undefined);
  assert.equal(k[0].type, "rawKeyDown");
  R.room("work").log.length = 0;
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

test("a lease left by an exited process frees the tab at once", async () => {
  const R = makeRooms();
  const other = await import(`../server.js?exited-room-lease=${Date.now()}`);
  roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  other.roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  await call("eval_js", { script: "return 1", target: tab() });
  const dir = join(R.home, "run", "leases");
  const path = join(dir, readdirSync(dir).find((x) => x.endsWith(".json")));
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  for (const active of [false, true]) {
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), owner: "gone", pid: exited, active, last: Date.now() }));
    const got = await other.handleCall("eval_js", { script: "return 2", target: tab() });
    assert.equal(got.content[0].text, "2", `active:${active}`);
  }
});

test("a lease whose pid went to a process started after its last call frees the tab", async () => {
  const R = makeRooms();
  const other = await import(`../server.js?reused-room-lease=${Date.now()}`);
  roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  other.roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  await call("eval_js", { script: "return 1", target: tab() });
  const dir = join(R.home, "run", "leases");
  const path = join(dir, readdirSync(dir).find((x) => x.endsWith(".json")));
  const before = Date.now() - process.uptime() * 1000 - 3600000;
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), owner: "gone", pid: process.pid, active: true, last: before }));
  const rows = await other.handleCall("list_tabs", { app: "room:work" });
  assert.doesNotMatch(rows.content[0].text, /"holder"/);
  const got = await other.handleCall("eval_js", { script: "return 2", target: tab() });
  assert.equal(got.content[0].text, "2");
});

test("a lease transfer releases a key left down by the previous server", async () => {
  const shared = makeRooms({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<input id=n>" }] } } });
  const other = await import(`../server.js?room-key-recovery=${Date.now()}`);
  roomsReset({ home: shared.home, fetch: shared.fetch, WebSocket: shared.WebSocket });
  other.roomsReset({ home: shared.home, fetch: shared.fetch, WebSocket: shared.WebSocket });
  const room = shared.room("work"), original = room.handle.bind(room);
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
  assert.equal(lease.stuck.type, "key");
  writeFileSync(path, JSON.stringify({ ...lease, last: Date.now() - 6000 }));
  const got = await other.handleCall("eval_js", { script: "return 3", target: tab() });
  assert.equal(got.content[0].text, "3");
  assert.equal(room.log.filter((x) => x.method === "Input.dispatchKeyEvent" && x.params.type === "keyUp").length, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).stuck, null);
});

test("a lease transfer releases a mouse button left down by the previous server", async () => {
  const shared = makeRooms({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<button id=b data-rect='0,0,80,30'>Go</button>" }] } } });
  const other = await import(`../server.js?room-mouse-recovery=${Date.now()}`);
  roomsReset({ home: shared.home, fetch: shared.fetch, WebSocket: shared.WebSocket });
  other.roomsReset({ home: shared.home, fetch: shared.fetch, WebSocket: shared.WebSocket });
  const room = shared.room("work"), original = room.handle.bind(room);
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
  assert.equal(lease.stuck.type, "mouse");
  writeFileSync(path, JSON.stringify({ ...lease, last: Date.now() - 6000 }));
  const got = await other.handleCall("eval_js", { script: "return 4", target: tab() });
  assert.equal(got.content[0].text, "4");
  assert.equal(room.log.filter((x) => x.method === "Input.dispatchMouseEvent" && x.params.type === "mouseReleased").length, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).stuck, null);
});

test("clicking a cross-origin iframe opens its src in a room tab, but a challenge frame is handed off", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: `
    <iframe id=job src="https://forms.example/acme/apply"></iframe>
    <iframe id=challenge src="https://www.google.com/recaptcha/api2/anchor"></iframe>` }] } } });
  const opened = await call("click", { selector: "#job", target: tab() });
  assert.equal(opened.ok, true);
  assert.equal(opened.opened.url, "https://forms.example/acme/apply");
  assert.match(opened.opened.tabId, /^room:work:/);
  assert.equal((await call("list_tabs", { app: "room" })).tabs.find((t) => t.tabId === opened.opened.tabId).mine, true);
  assert.equal(R.room("work").log.filter((x) => x.method === "Input.dispatchMouseEvent").length, 0);
  const denied = await call("click", { selector: "#challenge", target: tab() });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /hand it to the user/);
  assert.equal(R.room("work").targets.size, 2);
});

test("a scoped room download allows one click, then denies later downloads", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<button id=d>Download</button>" }] } } });
  const result = await call("click", { selector: "#d", download: true, trusted: false, target: tab() });
  assert.equal(result.ok, false, "a click with no saved file is not verified as a download");
  assert.match(result.error, /no download started/);
  const behavior = R.room("work").log.filter((x) => x.method === "Browser.setDownloadBehavior").map((x) => x.params.behavior);
  assert.deepEqual(behavior, ["deny", "allowAndName", "deny"], "deny on connect, allow for the click, deny after");
  assert.equal(R.room("work").log.filter((x) => x.method === "Target.activateTarget").length, 0);
});

test("a room download lands under the suggested name in the room's host folder, numbered when taken", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<button id=d>Download</button>" }] } } });
  const room = R.room("work");
  const dir = join(R.home, "downloads", "work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.pdf"), "old");
  const pending = call("click", { selector: "#d", download: true, target: tab() });
  while (!room.log.some((x) => x.params?.behavior === "allowAndName")) await new Promise((r) => setTimeout(r, 10));
  room.event("Browser.downloadWillBegin", { guid: "g1", suggestedFilename: "report.pdf", url: "https://a.test/report.pdf" });
  writeFileSync(join(dir, "g1"), "%PDF-1.7");
  room.event("Browser.downloadProgress", { guid: "g1", state: "completed", receivedBytes: 8, totalBytes: 8 });
  const o = await pending;
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(o.download, { file: join(dir, "report (1).pdf"), bytes: 8 });
  assert.equal(readFileSync(join(dir, "report.pdf"), "utf8"), "old");
  assert.deepEqual(readdirSync(dir).sort(), ["report (1).pdf", "report.pdf"]);
  assert.equal(room.log.filter((x) => x.method === "Browser.setDownloadBehavior").at(-1).params.behavior, "deny");
});

test("download is refused off a room tab", async () => {
  assert.match(await fails("click", { selector: "#d", download: true, target: { tabId: "chrome:1:2" } }), /download` is for room tabs/);
});

test("new_tab {from} reopens a browser tab's URL in a room", async () => {
  const world = makeWorld({ browsers: [{ name: "Google Chrome Canary", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: [{ url: "https://a.test/x", title: "X", id: "c1" }] }] }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  use({ rooms: { work: { sites: { "https://a.test/x": "<h1>X</h1>" } } } });
  const from = (await call("list_tabs", { app: "canary" })).tabs[0].tabId;
  const o = await call("new_tab", { from, app: "room:work" });
  assert.equal(o.app, "room:work");
  assert.match(o.tabId, /^room:work:/);
  assert.equal(o.from, from);
  assert.equal(o.url, "https://a.test/x");
  assert.match(await fails("new_tab", { from, app: "canary" }), /takes app:"room:<name>"/);
  const moved = await call("new_tab", { from, app: "room:work", label: "moved" });
  assert.deepEqual([moved.tabId, moved.url], ["room:work:moved", "https://a.test/x"]);
  assert.match(await fails("new_tab", { app: "canary", label: "x" }), /bad_args: new_tab label claims a room tab/);
});

test("a browser error that needs the user's window suggests a room, the URL's own first", () => {
  use({ rooms: { work: { registeredSites: [] }, mail: { registeredSites: [{ origin: "https://a.test" }] } } });
  assert.match(roomHint("window_offscreen: minimized", { url: "https://a.test/p" }), /new_tab \{from, app:"room:mail"\}/);
  assert.match(roomHint("tab_not_visible: hidden", {}), /room:work.*\(rooms: work, mail\)/);
  assert.equal(roomHint("stale_tab: gone", {}), "stale_tab: gone");
  assert.equal(roomHint("window_offscreen: x", { target: tab() }), "window_offscreen: x");
});

test("a room click is trusted by default; trusted:false falls back to el.click()", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<button id=b data-rect='10,20,100,40'>Open</button><p id=s>0</p>" }] } } });
  await call("eval_js", { script: "document.getElementById('b').addEventListener('click', (e) => { if (e.isTrusted) document.getElementById('s').textContent = 'opened'; }); return 1", target: tab() });
  const o = await call("click", { selector: "#b", target: tab() });
  assert.equal(o.delivery, "cdp", JSON.stringify(o));
  assert.equal(await call("eval_js", { script: "return document.getElementById('s').textContent", target: tab() }), "opened");
  const before = R.room("work").log.filter((m) => m.method === "Input.dispatchMouseEvent").length;
  await call("click", { selector: "#b", trusted: false, target: tab() });
  assert.equal(R.room("work").log.filter((m) => m.method === "Input.dispatchMouseEvent").length, before);
});

test("new_tab in a room hands out its unused blank tab once, then opens new ones", async () => {
  use({ rooms: { work: { tabs: [{ url: "about:blank", html: "" }, { url: "https://a.test/", html: "" }] } } });
  const first = await call("new_tab", { app: "room:work" });
  assert.deepEqual(first, { app: "room:work", tabId: "room:work:T0001", reused: true });
  const second = await call("new_tab", { app: "room:work" });
  assert.equal(second.reused, undefined);
  assert.equal(R.room("work").log.filter((m) => m.method === "Target.createTarget").length, 1);
});

test("a trusted room click counts a press the page cancels at pointerdown", async () => {
  use({ rooms: { work: { tabs: [{ url: "https://a.test/files", html: "<div id=card role=button aria-label='Plan, Design file' data-rect='10,20,200,120'>Plan</div>" }] } } });
  await call("eval_js", { script: "const c = document.getElementById('card'); c.addEventListener('pointerdown', (e) => e.preventDefault()); c.addEventListener('click', () => history.pushState(null, '', '/design/plan')); return 1", target: tab() });
  const o = await call("click", { selector: "#card", target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.hit, true);
  assert.equal(await call("eval_js", { script: "return location.pathname", target: tab() }), "/design/plan");
});

// rooms spells this pattern too (DEFAULT_SIGNED_OUT in rooms/rooms.mjs, pinned by its
// test/contract.test.mjs); change both together.
test("the room sign-in path pattern is the one rooms checks sites with", async () => {
  const { ROOM_LOGIN_PATH } = await import("../server.js");
  assert.equal(ROOM_LOGIN_PATH.source, "(^|\\/)(login|log-in|signin|sign-in|sign_in|auth|session\\/new)([\\/?#]|$)");
  assert.equal(ROOM_LOGIN_PATH.flags, "i");
});

test("a tab the user is driving in rooms view is held by the user, and perch says so", async () => {
  const R = makeRooms();
  roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  const { createHash } = await import("node:crypto");
  const { mkdirSync } = await import("node:fs");
  const dir = join(R.home, "run", "leases");
  mkdirSync(dir, { recursive: true });
  const t = tab();
  writeFileSync(join(dir, createHash("sha256").update(t.tabId).digest("hex") + ".json"), JSON.stringify({ owner: "user", pid: process.pid, last: Date.now(), active: true, stuck: null, since: new Date().toISOString() }));
  const denied = await handleCall("eval_js", { script: "return 1", target: t });
  assert.match(denied.content[0].text, /tab_held: room tab held by the user in rooms view/);
});

const twoServers = async (opts, tag) => {
  const R = makeRooms(opts);
  const other = await import(`../server.js?${tag}=${Date.now()}`);
  roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  other.roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
  return { R, other, leases: () => readdirSync(join(R.home, "run", "leases")).filter((x) => x.endsWith(".json")) };
};

test("a tab new_tab makes is leased before navigate, so another server's new_tab can't hand it out", async () => {
  const { other } = await twoServers({}, "created-room-lease");
  const mine = await call("new_tab", { app: "room:work" });
  const theirs = JSON.parse((await other.handleCall("new_tab", { app: "room:work" })).content[0].text);
  assert.notEqual(theirs.tabId, mine.tabId);
  const denied = await other.handleCall("navigate", { url: "https://b.test/", target: { tabId: mine.tabId } });
  assert.match(denied.content[0].text, /tab_held/);
});

test("close_tab deletes the tab's lease file", async () => {
  const { leases } = await twoServers({}, "close-room-lease");
  const o = await call("new_tab", { app: "room:work" });
  await call("eval_js", { script: "return 1", target: { tabId: o.tabId } });
  await call("eval_js", { script: "return 1", target: tab() });
  assert.equal(leases().length, 2);
  await call("close_tab", { tabId: o.tabId });
  assert.equal(leases().length, 1);
});

test("a foreign snapshot, screenshot or get_text is tab_held and leaves the holder's refs alive", async () => {
  const { other } = await twoServers({ rooms: { work: { tabs: [{ url: "https://a.test/", html: "<button onclick=\"this.textContent='done'\">Apply</button>" }] } } }, "read-room-lease");
  const snap = (await handleCall("accessibility_snapshot", { target: tab() })).content[0].text;
  const ref = /^(\S+) button "Apply"/m.exec(snap)[1];
  for (const [name, args] of [["accessibility_snapshot", {}], ["screenshot", {}], ["get_text", {}]]) {
    const r = await other.handleCall(name, { ...args, target: tab() });
    assert.match(r.content[0].text, /tab_held/, name);
  }
  const o = await call("click", { ref, target: tab() });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(await call("eval_js", { script: "return document.querySelector('button').textContent", target: tab() }), "done");
});

// Claims: new_tab's tab stays its server's past the lease's idle window; a label makes it one
// agent's (subagents share a server), and the label handle is the only way in.
const claimDir = (R) => join(R.home, "run", "claims");
const ageLeases = (R) => {
  const dir = join(R.home, "run", "leases");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) writeFileSync(join(dir, f), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, f), "utf8")), last: Date.now() - 6000 }));
};
const text = async (srv, name, args) => (await srv.handleCall(name, args)).content[0].text;

test("new_tab {label} claims a room tab under room:<name>:<label>, past the lease's idle window", async () => {
  const { R, other } = await twoServers({}, "label-claim");
  const o = await call("new_tab", { app: "room:work", label: "checkout" });
  assert.deepEqual(o, { app: "room:work", tabId: "room:work:checkout" });
  assert.equal(await call("eval_js", { script: "return 1", target: { tabId: o.tabId } }), 1);
  ageLeases(R);
  assert.match(await text(other, "eval_js", { script: "return 2", target: { tabId: o.tabId } }), /tab_held: room tab claimed as checkout by pid \d+/);
  assert.match(await text(other, "eval_js", { script: "return 2", target: tab("T0002") }), /tab_held: room tab claimed as checkout/);
  const row = (await call("list_tabs", { app: "room" })).tabs.find((t) => t.tabId === o.tabId);
  assert.deepEqual([row.holder, row.mine], ["checkout", true]);
  const theirs = JSON.parse(await text(other, "list_tabs", { app: "room" })).tabs.find((t) => t.tabId === o.tabId);
  assert.deepEqual([theirs.holder, theirs.mine], ["checkout", undefined]);
});

test("a labeled tab refuses its raw targetId on its own server too, so two subagents stay apart", async () => {
  use({ rooms: { work: { sites: { "https://b.test/x": "<p>B</p>" } } } });
  const a = await call("new_tab", { app: "room:work", label: "a1" });
  const b = await call("new_tab", { app: "room:work", label: "a2" });
  assert.notEqual(a.tabId, b.tabId);
  assert.match(await fails("eval_js", { script: "return 1", target: tab("T0002") }), /tab_held: room tab claimed as a1/);
  assert.equal(await call("eval_js", { script: "return 2", target: { tabId: b.tabId } }), 2);
  assert.equal((await call("navigate", { url: "https://b.test/x", target: { tabId: a.tabId } })).ok, true);
  assert.deepEqual(await call("close_tab", { tabId: a.tabId }), { ok: true, closed: a.tabId });
});

test("new_tab with a label already claimed gives its server the same tab back, and another server tab_held", async () => {
  const { other } = await twoServers({}, "label-again");
  const o = await call("new_tab", { app: "room:work", label: "x" });
  assert.deepEqual(await call("new_tab", { app: "room:work", label: "x" }), { ...o, reused: true });
  assert.match(await text(other, "new_tab", { app: "room:work", label: "x" }), /tab_held: room tab claimed as x/);
  assert.match(await fails("new_tab", { app: "room:work", label: "Bad Label" }), /bad_args: .*label/);
});

test("an unlabeled new_tab's tab stays its server's past the idle window", async () => {
  const { R, other } = await twoServers({}, "plain-claim");
  const o = await call("new_tab", { app: "room:work" });
  ageLeases(R);
  assert.match(await text(other, "eval_js", { script: "return 2", target: { tabId: o.tabId } }), /tab_held: room tab claimed by pid \d+/);
  assert.equal(await call("eval_js", { script: "return 1", target: { tabId: o.tabId } }), 1);
  const row = (await call("list_tabs", { app: "room" })).tabs.find((t) => t.tabId === o.tabId);
  assert.deepEqual([row.holder, row.mine], [`pid ${process.pid}`, true]);
});

test("a claim lapses after its idle cap, and a dead server's claim and lease are reaped", async () => {
  const { R, other, leases } = await twoServers({}, "claim-reap");
  const o = await call("new_tab", { app: "room:work", label: "x" });
  const file = join(claimDir(R), readdirSync(claimDir(R))[0]);
  const claim = JSON.parse(readFileSync(file, "utf8"));
  ageLeases(R);
  writeFileSync(file, JSON.stringify({ ...claim, last: Date.now() - 16 * 60000 }));
  assert.equal(await text(other, "eval_js", { script: "return 2", target: tab("T0002") }), "2");
  await call("eval_js", { script: "return 1", target: tab() });
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(file, JSON.stringify({ ...claim, pid: exited, owner: "gone" }));
  for (const f of leases()) writeFileSync(join(R.home, "run", "leases", f), JSON.stringify({ ...JSON.parse(readFileSync(join(R.home, "run", "leases", f), "utf8")), pid: exited, owner: "gone" }));
  await call("list_tabs", { app: "room" });
  assert.deepEqual([readdirSync(claimDir(R)).length, leases().length], [0, 0]);
  assert.equal(JSON.parse(await text(other, "new_tab", { app: "room:work", label: "x" })).tabId, o.tabId);
});

test("a dead server's label is taken over with its tab, and close_tab {target} ends a claim", async () => {
  const { R, other } = await twoServers({}, "label-takeover");
  const o = await call("new_tab", { app: "room:work", label: "x" });
  const file = join(claimDir(R), readdirSync(claimDir(R))[0]);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), pid: spawnSync(process.execPath, ["-e", ""]).pid, owner: "gone" }));
  ageLeases(R);
  assert.deepEqual(JSON.parse(await text(other, "new_tab", { app: "room:work", label: "x" })), { ...o, reused: true });
  assert.deepEqual(JSON.parse(await text(other, "close_tab", { target: { tabId: o.tabId } })), { ok: true, closed: o.tabId });
  assert.equal(readdirSync(claimDir(R)).length, 0);
  assert.match(await text(other, "eval_js", { script: "return 1", target: { tabId: o.tabId } }), /stale_tab: .*x/);
});
