// A new_tab that would answer needs_focus (no grant, the user at the Mac, no
// browser named) opens somewhere that takes no focus instead: a room registered
// for the URL's origin, then a loft window, then any room. The result adds
// `routed` and a `note`. A named browser, loft:false, from and label keep
// needs_focus; so does a call with no route left. Only a route that made nothing
// (no_browser) is followed by the next one.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JXA_PRELUDE, DAEMONS, handleCall, focus, loft, rooms, roomsReset } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { makeRooms } from "./fakes/cdp-room.mjs";
import { tempDir } from "../scripts/temp-dirs.mjs";

const RECT = { x: 4000, y: 0, w: 1440, h: 900 };
const LOFT_DISPLAY = { id: 77, ...RECT, vendor: 0x6c66, product: 0x7466 };
const SIZED = { id: 81, x: -1280, y: 0, w: 1280, h: 800, vendor: 0x6c66, product: 0x7466 };
const FAKE_LOFT = join(import.meta.dirname, "fakes", "fake-loft.mjs");
const win = (p) => ({ id: 1, active: 0, tabs: [{ url: `https://${p}.test/`, title: p, id: p }] });

let world, home, R, loftLog;
const holder = () => writeFileSync(join(home, "holder.json"), JSON.stringify({ pid: process.pid, cmd: "osascript -l JavaScript holder.js", displayId: 77, ...RECT, started: "2026-11-09T10:00:00Z" }));
function install({ safari = true } = {}) {
  const browsers = [{ name: "Google Chrome", kind: "chrome", windows: [win("u")] }];
  if (safari) browsers.push({ name: "Safari", kind: "safari", windows: [win("s")] });
  world = makeWorld({ browsers, cg: [{ owner: "Terminal" }, ...browsers.map((b) => ({ owner: b.name }))] });
  world.state.displays = [LOFT_DISPLAY, SIZED];
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
}
function useRooms(opts) {
  R = makeRooms(opts);
  roomsReset({ home: R.home, fetch: R.fetch, WebSocket: R.WebSocket });
}
const call = async (args) => {
  const r = await handleCall("new_tab", args);
  const t = r.content[0].text;
  let o = t; try { o = JSON.parse(t); } catch {}
  return { r, t, o };
};
const made = () => world.log.filter(([k]) => k === "makeWindow").map(([, app]) => app);
const activations = () => Object.keys(world.counts).filter((k) => /^activate\(/.test(k));
const loftRuns = () => readFileSync(loftLog, "utf8").trim().split("\n").filter(Boolean);

beforeEach((t) => {
  home = tempDir("perch-route-", t);
  process.env.LOFT_HOME = home;
  loftLog = join(home, "loft.log");
  writeFileSync(loftLog, "");
  process.env.LOFT_BIN = join(home, "no-such-loft");
  process.env.FAKE_LOFT_LOG = loftLog;
  delete process.env.FAKE_LOFT;
  roomsReset({ home: join(home, "rooms") });
  focus.granted = false;
  loft.wins.clear();
  loft.owned.clear();
  loft.winLoft.clear();
  loft.safari = { launch: async () => {} };
  install();
});
afterEach(() => { focus.granted = true; });

test("with the loft up, the tab opens on it, in a browser that takes no focus", async () => {
  holder();
  const { r, o } = await call({ url: "https://job.test/" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.deepEqual(Object.keys(o).sort(), ["app", "note", "routed", "tabId"]);
  assert.equal(o.app, "Safari");
  assert.equal(o.routed, "loft");
  assert.match(o.tabId, /^safari:/);
  assert.match(o.note, /hasn't allowed focus; Safari has its own sign-ins/);
  assert.deepEqual(made(), ["Safari"]);
  assert.deepEqual(activations(), []);
  assert.deepEqual(loftRuns(), [], "the loft that is up is used");
});

test("with no loft up, perch makes one at 1280x800", async () => {
  process.env.LOFT_BIN = FAKE_LOFT;
  const { r, o } = await call({ url: "http://localhost:3000/" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.routed, "loft");
  assert.equal(o.loft, "loft-1");
  assert.deepEqual(loftRuns(), [`up 1280x800 --new --owner ${process.pid} --json`]);
  assert.deepEqual(activations(), []);
});

test("a room registered for the url's origin comes before the loft", async () => {
  holder();
  useRooms({ rooms: { work: {}, mail: { registeredSites: [{ origin: "https://mail.test" }] } } });
  const { r, o } = await call({ url: "https://mail.test/inbox" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.app, "room:mail");
  assert.equal(o.routed, "room:mail");
  assert.match(o.tabId, /^room:mail:/);
  assert.match(o.note, /hasn't allowed focus; the room has its own sign-ins/);
  assert.deepEqual(made(), []);
  assert.deepEqual(world.aeLog, []);
});

// The loft would open it in Safari, which has none of the user's sign-ins: for a site a
// room is signed in to, that page is a dead end, so nothing opens and the error says how
// to get the room back.
test("a registered room that is down is not replaced by a signed-out Safari window on the loft", async () => {
  holder();
  useRooms({ rooms: { mail: { registeredSites: [{ origin: "https://mail.test" }] } }, down: ["mail"] });
  rooms.cli = "rooms";
  const { r, t } = await call({ url: "https://mail.test/inbox" });
  assert.equal(r.isError, true, t);
  assert.match(t, /^error: needs_focus: .*No other place took it: room:mail \(room 'mail' is not up; start it: rooms up mail\); no loft \(Google Chrome would have come to the front, and the user hasn't allowed focus, and Safari, which wouldn't, has none of the user's sign-ins; room:mail is signed in to mail\.test, so open it there: new_tab \{url, app:"room:mail"\}\)/);
  assert.deepEqual(made(), []);
  // A site no room is signed in to still opens on the loft.
  const other = await call({ url: "https://job.test/" });
  assert.equal(other.o.routed, "loft");
});

test("with no loft to be had, an http(s) url opens in a room", async () => {
  useRooms({ rooms: { work: {} } });
  const { r, o } = await call({ url: "https://job.test/" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.routed, "room:work");
  assert.deepEqual(world.aeLog, []);
});

test("a file, localhost or blank tab never goes to a room", async () => {
  useRooms({ rooms: { work: { registeredSites: [{ origin: "http://localhost:3000" }] } } });
  for (const url of ["file:///tmp/p.html", "http://localhost:3000/", "http://127.0.0.1:8080/x", "http://[::1]/", "http://app.localhost/", "about:blank", undefined]) {
    const { r, t } = await call({ url });
    assert.equal(r.isError, true, String(url));
    assert.match(t, /^error: needs_focus: /, String(url));
  }
  assert.equal(R.room("work").connects, 0);
});

test("no route left is needs_focus, saying what was tried, with nothing sent", async () => {
  const { r, t } = await call({ url: "https://job.test/" });
  assert.equal(r.isError, true);
  assert.match(t, /^error: needs_focus: new_tab would bring the browser to the front/);
  assert.match(t, /No other place took it: no loft \(.*needs loft installed/);
  assert.match(t, /allow it when perch asks/);
  assert.deepEqual(world.aeLog, []);
});

test("a named browser and loft:false are not routed", async () => {
  holder();
  useRooms({ rooms: { work: {} } });
  for (const args of [{ app: "Google Chrome", url: "https://job.test/" }, { url: "https://job.test/", loft: false }]) {
    const { t } = await call(args);
    assert.match(t, /^error: needs_focus: /, JSON.stringify(args));
  }
  assert.deepEqual(made(), []);
  assert.deepEqual(world.aeLog, []);
  assert.equal(R.room("work").connects, 0);
});

test("a bad url is bad_url before any route", async () => {
  holder();
  const { t } = await call({ url: "javascript:alert(1)" });
  assert.match(t, /^error: bad_url: /);
  assert.deepEqual(made(), []);
});

test("a loft that can't take the window is followed by a room", async () => {
  holder();
  useRooms({ rooms: { work: {} } });
  // A hidden Safari paints nothing: no_browser, nothing made.
  world.state.pids = { "com.apple.Safari": [4242] };
  world.state.hidden = [4242];
  const { r, o } = await call({ url: "https://job.test/" });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.routed, "room:work");
  assert.deepEqual(made(), []);
});

test("with the grant, the tab opens in the user's browser as before", async () => {
  holder();
  focus.granted = true;
  const { o } = await call({ url: "https://job.test/" });
  assert.equal(o.app, "Google Chrome");
  assert.equal(o.routed, undefined);
  assert.equal(o.note, undefined);
});
