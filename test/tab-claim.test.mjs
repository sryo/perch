// A browser tab perch opened (new_tab, a loft tab, a popup of one) is its server's:
// another agent's call on it is tab_held before any Apple Event, list_tabs says whose
// it is, close_tab lets it go. A claim holds only while it can prove the tab is the
// one it opened: its server alive, the same browser process (Chromium ids repeat
// after a restart), and a call within tabClaims.idleMs. A sweep closes a claimed tab
// nobody called for tabClaims.closeMs (its own server's, or one whose server is gone),
// only when it can prove the tab is untouched: the same browser process, not shown in
// its window, the URL perch last saw, not the window's last tab. Otherwise it lets the
// claim go and leaves the tab. Loft tabs are loftIdle's.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JXA_PRELUDE, DAEMONS, handleCall, roomsReset, tabClaims, tabClaimSweep } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { tempDir } from "../scripts/temp-dirs.mjs";

const NOT_FETCH = async () => { throw new Error("no rooms here"); };
const DEAD = spawnSync(process.execPath, ["-e", ""]).pid;
let world, home, other;
const chrome = (windows) => ({ name: "Google Chrome", kind: "chrome", windows });
const safari = (windows) => ({ name: "Safari", kind: "safari", windows });
const userWin = () => ({ id: 1, active: 0, tabs: [{ url: "https://user.test/", title: "mine", id: "u0" }] });

function install(spec, srv) {
  world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  for (const s of srv) { s.DAEMONS.fast = world.daemon; s.DAEMONS.slow = world.daemon; }
  world.reset();
}
const parse = (r) => { const t = r.content.find((c) => c.type === "text")?.text; try { return JSON.parse(t); } catch { return t; } };
const on = (srv) => async (name, args) => { const r = await srv.handleCall(name, args); return { r, o: parse(r) }; };
const me = on({ handleCall });
const claimFiles = () => { try { return readdirSync(join(home, "run", "tabs")).filter((f) => f.endsWith(".json")); } catch { return []; } };

beforeEach(async (t) => {
  home = tempDir("perch-claims-", t);
  other = await import(`../server.js?claims=${Date.now()}${Math.random()}`);
  roomsReset({ home, fetch: NOT_FETCH, client: 4100001, ancestors: () => [4100001] });
  other.roomsReset({ home, fetch: NOT_FETCH, client: 4100002, ancestors: () => [4100002] });
  other.focus.granted = true;
  for (const s of [tabClaims, other.tabClaims]) Object.assign(s, { idleMs: 15 * 60000, closeMs: 3600000 });
  install({ browsers: [chrome([userWin()])], cg: [{ owner: "Google Chrome", pid: process.pid }] }, [{ DAEMONS }, other]);
});

test("a tab new_tab opened is tab_held for another server, before any Apple Event, and its own server keeps using it", async () => {
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  assert.equal(tab.__pid, undefined, "the browser pid stays inside perch");
  assert.equal(claimFiles().length, 1);
  world.reset();
  const { r, o } = await on(other)("eval_js", { script: "return 1", target: { tabId: tab.tabId } });
  assert.equal(r.isError, true);
  assert.match(o, /^error: tab_held: another agent's tab \(perch pid \d+ opened it\); open your own with new_tab$/);
  assert.deepEqual(world.aeLog, [], "refused before any Apple Event");
  const closed = await on(other)("close_tab", { tabId: tab.tabId });
  assert.match(closed.o, /^error: tab_held/);
  assert.equal((await me("navigate", { url: "https://a.test/2", target: { tabId: tab.tabId } })).r.isError, undefined);
});

test("list_tabs marks a claimed row mine for its server and names the holder for others", async () => {
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  const mine = (await me("list_tabs", {})).o.tabs;
  assert.deepEqual(mine.find((x) => x.tabId === tab.tabId).mine, true);
  assert.equal(mine.find((x) => x.url === "https://user.test/").holder, undefined, "the user's tab has no holder");
  const theirs = (await on(other)("list_tabs", {})).o.tabs.find((x) => x.tabId === tab.tabId);
  assert.equal(theirs.mine, undefined);
  assert.equal(theirs.holder, `pid ${process.pid}`);
});

test("a helper the same agent runs (its client among the helper's ancestors) shares the tab", async () => {
  other.roomsReset({ home, fetch: NOT_FETCH, client: 4100009, ancestors: () => [4100009, 4100001] });
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  assert.equal((await on(other)("eval_js", { script: "return 2", target: { tabId: tab.tabId } })).o, 2);
});

test("a claim stops holding when the browser restarted, the server died, or it went idle", async () => {
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  const file = join(home, "run", "tabs", claimFiles()[0]);
  const c = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(c.browser, process.pid);
  const freed = async (patch, why) => {
    writeFileSync(file, JSON.stringify({ ...c, ...patch }));
    const { r } = await on(other)("eval_js", { script: "return 1", target: { tabId: tab.tabId } });
    assert.equal(r.isError, undefined, why);
  };
  await freed({ browser: DEAD }, "a new browser process can reuse the tab id for one of the user's tabs");
  await freed({ pid: DEAD }, "its server exited");
  await freed({ last: Date.now() - 16 * 60000 }, "no call for longer than the idle window");
});

test("close_tab lets the claim go", async () => {
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  assert.equal(claimFiles().length, 1);
  assert.equal((await me("close_tab", { tabId: tab.tabId })).o.ok, true);
  assert.deepEqual(claimFiles(), []);
});

test("a tab the user had is nobody's: any server can drive it", async () => {
  const user = (await me("list_tabs", {})).o.tabs.find((x) => x.url === "https://user.test/").tabId;
  assert.equal((await on(other)("eval_js", { script: "return 3", target: { tabId: user } })).o, 3);
  assert.deepEqual(claimFiles(), []);
});

test("a home perch can't write leaves new_tab working, with nothing held", async () => {
  roomsReset({ home: "/nonexistent/perch-test-rooms", fetch: NOT_FETCH, client: 4100001, ancestors: () => [4100001] });
  const { r, o: tab } = await me("new_tab", { url: "https://a.test/" });
  assert.equal(r.isError, undefined);
  other.roomsReset({ home: "/nonexistent/perch-test-rooms", fetch: NOT_FETCH, client: 4100002, ancestors: () => [4100002] });
  assert.equal((await on(other)("eval_js", { script: "return 4", target: { tabId: tab.tabId } })).o, 4);
});

test("a Safari handle that changes with navigate carries its claim", async () => {
  install({ browsers: [safari([{ id: 5, active: 0, tabs: [{ url: "https://user.test/", id: "s0" }] }])], cg: [{ owner: "Safari", pid: process.pid }] }, [{ DAEMONS }, other]);
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  const { o: nav } = await me("navigate", { url: "https://b.test/", target: { tabId: tab.tabId } });
  assert.notEqual(nav.tabId, tab.tabId, "a Safari handle hashes its URL");
  assert.equal(claimFiles().length, 1);
  const held = await on(other)("eval_js", { script: "return 1", target: { tabId: nav.tabId } });
  assert.match(held.o, /^error: tab_held/);
});

test("a tab a claimed tab's click opened is claimed too; one the user's tab opened is not", async () => {
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  world.openTab("Google Chrome", 0, "https://pop.test/", { select: false });
  const popup = (await me("list_tabs", {})).o.tabs.find((x) => x.url === "https://pop.test/").tabId;
  // The click itself is click-new-tab.test.mjs's; here only what perch does with its `opened`.
  tabClaims.opened(tab.tabId, popup);
  assert.match((await on(other)("eval_js", { script: "return 1", target: { tabId: popup } })).o, /^error: tab_held/);
  const user = (await me("list_tabs", {})).o.tabs.find((x) => x.url === "https://user.test/").tabId;
  world.openTab("Google Chrome", 0, "https://pop2.test/", { select: false });
  const pop2 = (await me("list_tabs", {})).o.tabs.find((x) => x.url === "https://pop2.test/").tabId;
  tabClaims.opened(user, pop2);
  assert.equal((await on(other)("eval_js", { script: "return 5", target: { tabId: pop2 } })).o, 5);
  assert.ok(existsSync(join(home, "run", "tabs")));
});

const claimOf = (tabId) => {
  for (const f of claimFiles()) { const c = JSON.parse(readFileSync(join(home, "run", "tabs", f), "utf8")); if (c.tabId === tabId) return { f: join(home, "run", "tabs", f), c }; }
  return null;
};
const age = (tabId, ms, patch = {}) => { const { f, c } = claimOf(tabId); writeFileSync(f, JSON.stringify({ ...c, last: Date.now() - ms, ...patch })); };
const HOUR = 3600000;
const noFocus = () => {
  assert.ok(!world.log.some(([k]) => k === "activate"));
  for (const k of ["tab.select", "win.activeTabIndex=", "win.currentTab=", "win.index="]) assert.equal(world.counts[k], undefined, k);
};
const urlsNow = () => world.tabsOf("Google Chrome", 0).map((t) => t.shownUrl());

test("the sweep closes its own tab nobody called for closeMs, and nothing else", async () => {
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  await tabClaimSweep();
  assert.deepEqual(urlsNow(), ["https://user.test/", "https://a.test/"], "a fresh claim stays");
  age(tab.tabId, HOUR + 1000);
  world.reset();
  await tabClaimSweep();
  assert.deepEqual(urlsNow(), ["https://user.test/"]);
  assert.deepEqual(claimFiles(), []);
  noFocus();
});

test("the sweep keeps a tab the user may have taken: shown, navigated, or the window's last", async () => {
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  world.winSpec("Google Chrome", 0).active = 1;
  age(tab.tabId, HOUR + 1000);
  await tabClaimSweep();
  assert.deepEqual(urlsNow(), ["https://user.test/", "https://a.test/"], "shown in its window");
  assert.deepEqual(claimFiles(), [], "and no longer perch's");
  world.winSpec("Google Chrome", 0).active = 0;
  const { o: t2 } = await me("new_tab", { url: "https://b.test/" });
  world.tabsOf("Google Chrome", 0)[2].page.url = "https://b.test/elsewhere";
  age(t2.tabId, HOUR + 1000);
  await tabClaimSweep();
  assert.equal(urlsNow().length, 3, "its URL isn't the one perch last saw");
  assert.deepEqual(claimFiles(), []);
});

test("the sweep closes a dead server's tab once idle, and drops a claim from a browser that quit with no Apple Event", async () => {
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  age(tab.tabId, 5 * 60000, { pid: DEAD });
  await other.tabClaimSweep();
  assert.equal(urlsNow().length, 2, "an orphan waits out closeMs too");
  age(tab.tabId, HOUR + 1000, { pid: DEAD });
  await other.tabClaimSweep();
  assert.deepEqual(urlsNow(), ["https://user.test/"]);
  const { o: t2 } = await me("new_tab", { url: "https://b.test/" });
  age(t2.tabId, HOUR + 1000, { browser: DEAD });
  world.reset();
  await tabClaimSweep();
  assert.deepEqual(world.aeLog, []);
  assert.deepEqual(claimFiles(), []);
  assert.equal(urlsNow().length, 2);
});

test("a tab whose hold lapsed is adopted by the agent that uses it next, so its first owner's sweep leaves it", async () => {
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  age(tab.tabId, 20 * 60000);
  assert.equal((await on(other)("eval_js", { script: "return 6", target: { tabId: tab.tabId } })).o, 6);
  assert.equal(claimOf(tab.tabId).c.pid, process.pid);
  assert.notEqual(claimOf(tab.tabId).c.client, 4100001, "the other server's now");
  assert.match((await me("eval_js", { script: "return 1", target: { tabId: tab.tabId } })).o, /^error: tab_held/);
  age(tab.tabId, HOUR + 1000);
  await tabClaimSweep();
  assert.equal(urlsNow().length, 2, "a live server's tab is its own to sweep");
});

test("closeMs 0 never closes", async () => {
  tabClaims.closeMs = 0;
  const { o: tab } = await me("new_tab", { url: "https://a.test/" });
  age(tab.tabId, 100 * HOUR);
  await tabClaimSweep();
  assert.equal(urlsNow().length, 2);
});
