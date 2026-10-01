// list_tabs across several browsers. Live, an Apple Event returns at its
// browser's next display frame and each browser keeps its own phase, so taking
// turns between browsers overlaps their frames. These tests pin the turn order,
// the wall time on the fake world's frame clock, and that the rows and total
// never change for it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const canary = (windows) => ({ name: "Google Chrome Canary", kind: "chrome", windows });
const arc = (windows) => ({ name: "Arc", kind: "arc", windows });
const safari = (windows) => ({ name: "Safari", kind: "safari", windows });
const tabs = (n, p = "t") => Array.from({ length: n }, (_, i) => ({ url: `https://${p}${i}.test/`, title: `${p}${i}`, id: `${p}${i}` }));

let world;
function install(spec) {
  world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
const list = async (args) => {
  const r = await handleCall("list_tabs", args);
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};

beforeEach(() => { world = null; });

const three = () => ({
  browsers: [
    canary([{ id: 1, active: 1, tabs: tabs(3, "c") }, { id: 2, active: 0, tabs: tabs(2, "d") }]),
    arc([{ id: "W1", active: 0, tabs: tabs(3, "a") }]),
    safari([{ id: 3, active: 0, tabs: tabs(2, "s") }]),
  ],
  cg: [{ owner: "Google Chrome Canary" }, { owner: "Arc" }, { owner: "Safari" }],
});

test("list_tabs takes turns between browsers: one read each before any browser's second", async () => {
  install(three());
  const o = await list({});
  assert.equal(o.total, 10);
  assert.deepEqual(world.aeLog.slice(0, 3).map(([app]) => app), ["Google Chrome Canary", "Arc", "Safari"]);
  assert.deepEqual(world.aeLog.slice(3, 6).map(([app]) => app), ["Google Chrome Canary", "Arc", "Safari"]);
  // Each browser still costs what it costs alone.
  assert.equal(world.aeBy("Google Chrome Canary").length, 4);
  assert.equal(world.aeBy("Arc").length, 6);
  assert.equal(world.aeBy("Safari").length, 4);
});

test("list_tabs over three browsers takes about as long as the slowest one alone", async () => {
  const frameMs = 16;
  install({ ...three(), frameMs });
  const t0 = world.clock.t;
  const o = await list({ limit: 10000 });
  assert.equal(o.total, 10);
  const took = world.clock.t - t0;
  // Arc alone is six frames; one after another, the three take fourteen.
  assert.ok(took < 8 * frameMs, `took ${took}ms, ${(took / frameMs).toFixed(1)} frames`);
});

test("browsers whose bulk reads fail are walked window by window, still taking turns, each in its own place", async () => {
  const spec = () => ({
    browsers: [canary([{ id: 1, active: 1, tabs: tabs(3, "c") }, { id: 2, active: 0, tabs: tabs(2, "d") }]), arc([{ id: "W1", active: 1, tabs: tabs(2, "a") }])],
    cg: [{ owner: "Google Chrome Canary" }, { owner: "Arc" }],
  });
  install(spec());
  const bulk = await list({});
  install(spec());
  world.state.arcBulkFails = true;
  const a = world.apps["Google Chrome Canary"], W = a.windows;
  a.windows = new Proxy(W, { get: (_, k) => (k === "activeTabIndex" ? () => { world.aeLog.push(["Google Chrome Canary", "windows.activeTabIndex()"]); throw new Error("Can't convert types"); } : W[k]) });
  const walked = await list({});
  assert.deepEqual(walked, bulk);
  assert.deepEqual(walked.tabs.map((t) => t.app), [...Array(5).fill("Google Chrome Canary"), ...Array(2).fill("Arc")]);
  // One event per browser per turn, until the one with fewer events is done.
  const apps = world.aeLog.map(([app]) => app);
  const last = apps[apps.length - 1];
  let end = apps.length;
  while (apps[end - 1] === last) end--;
  assert.ok(apps.length > 20, apps.join());
  for (let i = 1; i < end; i++) assert.notEqual(apps[i], apps[i - 1], `event ${i}: ${apps.join()}`);
});

test("Arc windows sharing tabs count each tab once toward the limit", async () => {
  const shared = tabs(2, "a");
  install({
    browsers: [arc([{ id: "W1", active: 0, tabs: shared }, { id: "W2", active: 1, tabs: shared }]), safari([{ id: 3, active: 0, tabs: tabs(2, "s") }])],
    cg: [{ owner: "Arc" }, { owner: "Safari" }],
  });
  // Four Arc urls match, but they are two tabs, so Safari's first tab still shows.
  const o = await list({ urlContains: ".test", limit: 3 });
  assert.deepEqual(o.tabs.map((t) => t.url), ["https://a0.test/", "https://a1.test/", "https://s0.test/"]);
  assert.equal(o.total, 4);
});

test("once a browser is listed, its rows decide the limit, even with both filters set", async () => {
  install({
    browsers: [canary([{ id: 1, active: 0, tabs: tabs(3, "c") }]), arc([{ id: "W1", active: 0, tabs: tabs(3, "c") }])],
    cg: [{ owner: "Google Chrome Canary" }, { owner: "Arc" }],
  });
  const o = await list({ urlContains: "c", titleContains: "c", limit: 1 });
  assert.equal(o.total, 6);
  // Urls, titles and ids: Arc stops at what counting takes once Canary's rows are in.
  assert.deepEqual(world.aeBy("Arc"), ["tabs.url()", "tabs.title()", "tabs.id()"]);
});

test("a limit filled by the first browser leaves the others counted, not listed", async () => {
  install(three());
  const o = await list({ limit: 2 });
  assert.equal(o.total, 10);
  assert.deepEqual(o.tabs.map((t) => t.url), ["https://c0.test/", "https://c1.test/"]);
  assert.equal(world.aeBy("Arc").length, 1, world.aeBy("Arc").join());
  assert.equal(world.aeBy("Safari").length, 1, world.aeBy("Safari").join());
});

// A seeded PRNG, so a failure names a world that can be replayed.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NAMES = ["Google Chrome", "Google Chrome Canary", "Arc", "Safari"];
const KINDS = { "Google Chrome": "chrome", "Google Chrome Canary": "chrome", Arc: "arc", Safari: "safari" };

function randomWorld(r) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const names = NAMES.filter(() => r() < 0.6);
  let n = 0;
  const tab = () => ({ url: `https://${pick("abc")}${Math.floor(r() * 4)}.test/`, title: pick(["Alpha", "beta", "Gamma", "delta", ""]), id: `t${n++}`, location: pick(["topApp", "pinned", "unpinned", "unpinned"]) });
  const browsers = names.map((name) => {
    const kind = KINDS[name], windows = [];
    const count = Math.floor(r() * 4);
    for (let w = 0; w < count; w++) {
      const prev = windows[windows.length - 1];
      const shared = kind === "arc" && prev && r() < 0.4;
      const ts = shared ? prev.tabs : Array.from({ length: kind === "arc" ? Math.floor(r() * 4) : 1 + Math.floor(r() * 4) }, tab);
      const active = ts.length ? (kind === "arc" && r() < 0.2 ? null : Math.floor(r() * ts.length)) : null;
      windows.push({ id: `${kind}${w}`, active, tabs: ts });
    }
    return { name, kind, windows };
  });
  const onScreen = names.filter(() => r() < 0.7).sort(() => r() - 0.5);
  const order = onScreen.concat(NAMES.filter((x) => names.includes(x) && !onScreen.includes(x)));
  const args = { urlContains: pick([null, null, "a", "b1", ".test", "zz"]), titleContains: pick([null, null, "al", "TA", "x"]), limit: Math.floor(r() * 9) };
  return { spec: { browsers, cg: onScreen.map((owner) => ({ owner })) }, order, args };
}

test("list_tabs rows and total match one full listing per browser, in random worlds", async () => {
  const has = (v, q) => !q || v.toLowerCase().includes(q.toLowerCase());
  for (let seed = 1; seed <= 300; seed++) {
    const { spec, order, args } = randomWorld(rng(seed));
    install(spec);
    const alone = [];
    for (const app of order) alone.push(...(await list({ app, limit: 10000 })).tabs);
    const want = alone.filter((t) => has(t.url, args.urlContains) && has(t.title, args.titleContains));
    install(spec);
    const full = await list({ ...args, limit: 10000 });
    assert.deepEqual(full, { tabs: want, total: want.length }, `seed ${seed} full ${JSON.stringify(args)}`);
    install(spec);
    const cut = await list(args);
    assert.deepEqual(cut, { tabs: want.slice(0, args.limit), total: want.length }, `seed ${seed} ${JSON.stringify(args)}`);
  }
});

// The user opens and closes tabs and windows while list_tabs reads, and each
// bulk read is its own Apple Event, so the lists can disagree. A browser whose
// lists don't line up window by window, tab by tab, is walked window by window
// instead: never a throw, never a handle on another tab's url.
const midRead = (app, key, change) => {
  let done = false;
  world.state.afterAe = (a, k) => { if (!done && a === app && k === key) { done = true; change(); } };
};
const rowsAreTabs = (o) => {
  for (const t of o.tabs) if (t.tabId && t.tabId.startsWith("canary:")) assert.equal(t.url, `https://${t.tabId.slice(7)}.test/`, JSON.stringify(t));
  for (const t of o.tabs) if (t.title && t.app !== "Safari") assert.equal(t.url, `https://${t.title}.test/`, JSON.stringify(t));
};

test("a Chromium tab closing between the url and id reads lists the tabs still open", async () => {
  install({ browsers: [canary([{ id: 1, active: 0, tabs: tabs(3, "c") }, { id: 2, active: 0, tabs: tabs(2, "d") }])], cg: [{ owner: "Google Chrome Canary" }] });
  midRead("Google Chrome Canary", "tabs.url()", () => world.closeTab("Google Chrome Canary", 0, 1));
  const o = await list({});
  assert.deepEqual(o.tabs.map((t) => t.url), ["https://c0.test/", "https://c2.test/", "https://d0.test/", "https://d1.test/"]);
  assert.equal(o.total, 4);
  rowsAreTabs(o);
});

test("a Chromium tab opening between the title and id reads never pairs a handle with another tab's url", async () => {
  install({ browsers: [canary([{ id: 1, active: 0, tabs: tabs(3, "c") }])], cg: [{ owner: "Google Chrome Canary" }] });
  midRead("Google Chrome Canary", "tabs.title()", () => {
    world.openTab("Google Chrome Canary", 0, "https://pop3.test/");
    const T = world.tabsOf("Google Chrome Canary", 0);
    T.unshift(T.pop());
    T[0].spec.title = "pop3"; T[0].spec.id = "pop3";
  });
  const o = await list({});
  assert.deepEqual(o.tabs.map((t) => t.url), ["https://pop3.test/", "https://c0.test/", "https://c1.test/", "https://c2.test/"]);
  rowsAreTabs(o);
});

test("a Chromium window opening or closing between bulk reads never throws", async () => {
  for (const key of ["tabs.url()", "tabs.title()", "tabs.id()"]) {
    for (const change of ["open", "close"]) {
      install({ browsers: [canary([{ id: 1, active: 0, tabs: tabs(3, "c") }, { id: 2, active: 1, tabs: tabs(2, "d") }])], cg: [{ owner: "Google Chrome Canary" }] });
      midRead("Google Chrome Canary", key, () => change === "open"
        ? world.openWindow("Google Chrome Canary", { id: 7, active: 0, tabs: tabs(1, "e") })
        : world.closeWindow("Google Chrome Canary", 0));
      const o = await list({});
      const want = change === "open" ? ["e0", "c0", "c1", "c2", "d0", "d1"] : ["d0", "d1"];
      assert.deepEqual(o.tabs.map((t) => t.title), want, `${change} after ${key}`);
      rowsAreTabs(o);
    }
  }
});

test("a Safari tab closing between the url and title reads keeps titles on their own tabs", async () => {
  install({ browsers: [safari([{ id: 3, active: 0, tabs: tabs(3, "s") }])], cg: [{ owner: "Safari" }] });
  midRead("Safari", "tabs.url()", () => world.closeTab("Safari", 0, 0));
  const o = await list({});
  assert.deepEqual(o.tabs.map((t) => [t.url, t.title]), [["https://s1.test/", "s1"], ["https://s2.test/", "s2"]]);
});

test("a list whose lists line up costs no extra Apple Event", async () => {
  install({ browsers: [canary([{ id: 1, active: 0, tabs: tabs(3, "c") }]), safari([{ id: 3, active: 0, tabs: tabs(2, "s") }])], cg: [{ owner: "Google Chrome Canary" }, { owner: "Safari" }] });
  await list({});
  assert.equal(world.aeBy("Google Chrome Canary").length, 4);
  assert.equal(world.aeBy("Safari").length, 4);
});

test("the window walk re-reads a window whose tabs change between its reads", async () => {
  for (const [nth, tries] of [[2, 1], [2, 2]]) {
    install({ browsers: [canary([{ id: 1, active: 0, tabs: tabs(3, "c") }, { id: 2, active: 0, tabs: tabs(2, "d") }])], cg: [{ owner: "Google Chrome Canary" }] });
    const a = world.apps["Google Chrome Canary"], W = a.windows;
    a.windows = new Proxy(W, { get: (_, k) => (k === "activeTabIndex" ? () => { world.aeLog.push(["Google Chrome Canary", "windows.activeTabIndex()"]); throw new Error("Can't convert types"); } : W[k]) });
    // The walk's url read of the first window is the second url read; the change
    // lands after it, and again after the re-read when tries is 2.
    let urls = 0, left = tries;
    world.state.afterAe = (app, k) => {
      if (k !== "tabs.url()" || ++urls < nth || !left) return;
      left--;
      world.closeTab("Google Chrome Canary", 0, 0);
    };
    const o = await list({});
    rowsAreTabs(o);
    // A window still changing after one re-read is left out rather than misread.
    assert.deepEqual(o.tabs.map((t) => t.title), tries === 1 ? ["c1", "c2", "d0", "d1"] : ["d0", "d1"], `tries ${tries}`);
  }
});

test("an Arc tab closing between the title and location reads keeps pinned marks on their own tabs", async () => {
  const ts = tabs(3, "a");
  ts[2].location = "pinned";
  install({ browsers: [arc([{ id: "W1", active: 0, tabs: ts }])], cg: [{ owner: "Arc" }] });
  midRead("Arc", "tabs.title()", () => world.closeTab("Arc", 0, 0));
  const o = await list({});
  assert.deepEqual(o.tabs.map((t) => [t.title, !!t.pinned]), [["a1", false], ["a2", true]]);
});

test("list_tabs never throws and never pairs a row with another tab's data while tabs and windows come and go, in random worlds", async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const { spec, args } = randomWorld(r);
    // Titles that name their own url, so a row read across a change shows it.
    for (const b of spec.browsers) for (const w of b.windows) for (const t of w.tabs) t.title = t.id;
    for (const b of spec.browsers) for (const w of b.windows) w.tabs.forEach((t) => { t.url = `https://${t.id}.test/`; });
    install(spec);
    const names = spec.browsers.map((b) => b.name);
    let changes = 0;
    world.state.afterAe = (app) => {
      if (changes > 3 || r() > 0.3 || !names.includes(app)) return;
      changes++;
      const live = (() => { try { return world.tabsOf(app, 0); } catch { return null; } })();
      const roll = r();
      if (roll < 0.4 && live && live.length) world.closeTab(app, 0, Math.floor(r() * live.length));
      else if (roll < 0.7 && live) { const id = `n-${seed}-${changes}`; world.openTab(app, 0, `https://${id}.test/`); Object.assign(live[live.length - 1].spec, { id, title: id }); }
      else if (roll < 0.85 && live) world.closeWindow(app, 0);
      else world.openWindow(app, { id: `nw${changes}`, active: 0, tabs: [{ id: `nw-${seed}-${changes}`, url: `https://nw-${seed}-${changes}.test/`, title: `nw-${seed}-${changes}` }] });
    };
    const res = await handleCall("list_tabs", { ...args, limit: 10000 });
    assert.equal(res.isError, undefined, `seed ${seed}: ${res.content[0].text}`);
    const o = JSON.parse(res.content[0].text);
    for (const t of o.tabs) if (t.title) assert.equal(t.url, `https://${t.title}.test/`, `seed ${seed}: ${JSON.stringify(t)}`);
    for (const t of o.tabs) if (t.tabId && !t.tabId.startsWith("safari:")) assert.equal(t.tabId.slice(t.tabId.indexOf(":") + 1), t.title, `seed ${seed}: ${JSON.stringify(t)}`);
  }
});
