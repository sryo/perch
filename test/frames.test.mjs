// Controls inside iframes, read from the Accessibility tree: accessibility_snapshot
// {frames:true} lists them as fN rows, and click {ref:"fN", trusted:true} re-walks
// the frames, matches the row again and clicks its fresh Accessibility center.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

// A background Chrome window at y=57; the page area starts 100pt down, 56pt in.
const AREA = { x: 56, y: 157, w: 598, h: 500 };

function frameWorld() {
  const dom = page(`<button id=b>Go</button>`, { url: "https://shop.test/checkout" });
  const other = page(`<button>Other</button>`, { url: "https://other.test/" });
  for (const w of [dom, other]) {
    Object.defineProperty(w, "innerWidth", { value: 598, configurable: true });
    Object.defineProperty(w, "innerHeight", { value: 500, configurable: true });
  }
  const pay = { url: "https://js.pay.example/v3/card?session=s3cret", box: { x: 100, y: 300, w: 400, h: 150 }, kids: [
    { role: "AXTextField", subrole: "AXSecureTextField", description: "Card number", value: "4242424242424242", box: { x: 110, y: 310, w: 200, h: 30 } },
    { role: "AXTextField", title: "ZIP", value: "94103", box: { x: 320, y: 310, w: 100, h: 30 } },
    { role: "AXCheckBox", title: "Save card", value: 1, box: { x: 110, y: 350, w: 20, h: 20 } },
    { role: "AXButton", title: "Pay", box: { x: 110, y: 390, w: 100, h: 40 } },
    { role: "AXButton", title: "Pay", enabled: false, box: { x: 220, y: 390, w: 100, h: 40 } },
    { role: "AXPopUpButton", title: "Country", expanded: true, box: { x: 330, y: 390, w: 100, h: 40 } },
    { role: "AXStaticText", value: "Card ending 4242", box: { x: 110, y: 440, w: 100, h: 10 } },
  ] };
  const widget = { url: "https://widget.example/embed", box: { x: 100, y: 600, w: 400, h: 300 }, kids: [
    { role: "AXLink", title: "Help", box: { x: 110, y: 610, w: 50, h: 20 } },
    { role: "AXButton", title: "Below", box: { x: 110, y: 700, w: 80, h: 30 } },
  ] };
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [
      { url: "https://shop.test/checkout", id: "t", dom },
      { url: "https://other.test/", id: "u", dom: other },
    ] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ ...AREA, frames: [pay, widget] }] } }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return { world, dom, pay, widget };
}

const text = (r) => r.content[0].text;
const head = (s) => JSON.parse(s.split("\n")[0].slice(2));
const frameLines = (s) => s.split("\n").slice(1).filter((l) => /^f\d+ /.test(l));
// A server renumbers a ref it showed before, so rows across fresh pages compare without it.
const unref = (l) => l.replace(/^\d+ /, "");
const snap = async (args = {}) => {
  const r = await handleCall("accessibility_snapshot", { frames: true, ...args });
  assert.equal(r.isError, undefined, text(r));
  return text(r);
};
const presses = (world) => world.posted.filter((e) => e.type === 1 && e.pt.x >= 0).map((e) => e.pt);
const click = async (args) => {
  const r = await handleCall("click", { trusted: true, ...args });
  return { r, t: text(r), o: (() => { try { return JSON.parse(text(r)); } catch { return null; } })() };
};

const ALL = [
  `f1 textbox "Card number" frame="js.pay.example" secure`,
  `f2 textbox "ZIP" frame="js.pay.example"`,
  `f3 checkbox "Save card" frame="js.pay.example" checked`,
  `f4 button "Pay" frame="js.pay.example"`,
  `f5 button "Pay" frame="js.pay.example" disabled`,
  `f6 combobox "Country" frame="js.pay.example" expanded`,
  `f7 link "Help" frame="widget.example"`,
  `f8 button "Below" frame="widget.example" offscreen`,
];

test("the default snapshot has no frame rows, no frames header and does no Accessibility work", async () => {
  const { world } = frameWorld();
  const r = await handleCall("accessibility_snapshot", {});
  const s = text(r);
  assert.deepEqual(frameLines(s), []);
  const h = head(s);
  assert.equal(h.frames, undefined);
  assert.equal(h.iw, undefined);
  assert.equal(h.ih, undefined);
  assert.equal(world.counts.AX, undefined);
});

test("frames:true lists frame controls after the page rows, with the frame host and flags but never values", async () => {
  const { world } = frameWorld();
  const s = await snap();
  const lines = s.split("\n").slice(1);
  assert.deepEqual(unref(lines[0]), `button "Go"`);
  assert.deepEqual(frameLines(s), ALL);
  const h = head(s);
  assert.deepEqual(h.frames, { count: 8 });
  assert.equal(h.iw, undefined, "the viewport size stays private");
  assert.equal(h.ih, undefined);
  assert.equal(h.count, 1);
  // No field value, no static text, no page-level controls, no frame path or query.
  for (const leak of ["4242", "94103", "s3cret", "/v3/card", "Page modal", "Close", "Save\""]) assert.ok(!s.includes(leak), leak);
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
  assert.deepEqual(world.posted, []);
});

test("frame rows follow role, query and max", async () => {
  frameWorld();
  assert.deepEqual(frameLines(await snap({ role: "button" })), [
    `f1 button "Pay" frame="js.pay.example"`,
    `f2 button "Pay" frame="js.pay.example" disabled`,
    `f3 button "Below" frame="widget.example" offscreen`,
  ]);
  assert.deepEqual(frameLines(await snap({ role: ["link", "checkbox"] })), [`f1 checkbox "Save card" frame="js.pay.example" checked`, `f2 link "Help" frame="widget.example"`]);
  const q = await snap({ query: "widget\\.example" });
  assert.deepEqual(frameLines(q), [`f1 link "Help" frame="widget.example"`, `f2 button "Below" frame="widget.example" offscreen`]);
  assert.deepEqual(head(q).frames, { count: 2 });
  assert.deepEqual(frameLines(await snap({ query: "^f1 " })), [], "query tests the line without its ref");
  const capped = await snap({ max: 3 });
  assert.deepEqual(frameLines(capped), ALL.slice(0, 3));
  assert.deepEqual(head(capped).frames, { count: 3, truncated: true });
});

test("when the frame walk can't run, the page rows still come back with frames:{error}", async () => {
  for (const [name, arrange, args, want] of [
    ["no Accessibility", (w) => { w.state.ax = false; }, {}, /Accessibility permission required/],
    ["a tab its window doesn't show", null, { target: { tabId: "chrome:u" } }, /^tab_not_visible:/],
  ]) {
    const { world } = frameWorld();
    if (arrange) arrange(world);
    const s = await snap(args);
    assert.match(head(s).frames.error, want, name);
    assert.equal(s.split("\n").length, 2, name);
    assert.match(s.split("\n")[1], /^\d+ button "(Go|Other)"$/, name);
    assert.deepEqual(world.posted, [], name);
  }
});

test("a minimized window (no CGWindowID) gives frames:{error:window_offscreen} beside the page rows", async () => {
  // Minimized: the window has no on-screen CG entry.
  const dom = page(`<button id=b>Go</button>`, { url: "https://shop.test/checkout" });
  Object.defineProperty(dom, "innerWidth", { value: 598, configurable: true });
  Object.defineProperty(dom, "innerHeight", { value: 500, configurable: true });
  const bare = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "https://shop.test/checkout", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }],
  });
  bare.run(JXA_PRELUDE);
  DAEMONS.fast = bare.daemon;
  DAEMONS.slow = bare.daemon;
  const s = await snap();
  assert.match(head(s).frames.error, /^window_offscreen:/);
  assert.equal(unref(s.split("\n")[1]), `button "Go"`);
});

test("click on a frame ref posts one routed click at the element's Accessibility center", async () => {
  const { world } = frameWorld();
  await snap();
  world.reset();
  const { r, o } = await click({ ref: "f4" });
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(o, {
    ok: true, ref: "f4", frame: "js.pay.example", point: { x: 160, y: 410 }, aim: "ax", delivery: "skylight",
    before: { role: "button", name: "Pay", focused: false }, after: { role: "button", name: "Pay", focused: false }, hit: null,
  });
  assert.deepEqual(presses(world), [{ x: 160, y: 410 }]);
  assert.ok(world.posted.every((e) => e.via === "skylight" && e.pid === 4242));
  // Posted window-local, inside the window and the page area.
  const down = world.posted.filter((e) => e.type === 1 && e.pt.x >= 0)[0];
  assert.deepEqual(down.windowPoint, { x: 160, y: 410 - 57 });
  assert.equal(world.counts["activate(Google Chrome)"], undefined);
  assert.deepEqual(world.state.warps, [], "the cursor never moved");
});

test("the click reads the element again after posting: a checkbox's state shows in before/after", async () => {
  const { world, pay } = frameWorld();
  await snap();
  world.state.onPost = (e) => { if (e.type === 2 && e.pt.x >= 0) pay.kids[2].value = 0; };
  const { o } = await click({ ref: "f3" });
  assert.equal(o.ok, true);
  assert.deepEqual(o.before, { role: "checkbox", name: "Save card", checked: true, focused: false });
  assert.deepEqual(o.after, { role: "checkbox", name: "Save card", checked: false, focused: false });
});

// Live, Chrome's Accessibility tree showed a frame checkbox's new state a little
// after the page did, so `after` is read until it changes, within a bound.
test("after waits for Accessibility to catch up with a slow state change", async () => {
  const { world, pay } = frameWorld();
  await snap();
  let at = null;
  // Focus lands at once (live, it did), the checked state later.
  world.state.onPost = (e) => { if (e.type === 2 && e.pt.x >= 0) { at = world.clock.t; pay.kids[2].focused = true; } };
  Object.defineProperty(pay.kids[2], "value", { get: () => (at != null && world.clock.t - at >= 250 ? 0 : 1), configurable: true });
  const { o } = await click({ ref: "f3" });
  assert.equal(o.before.checked, true);
  assert.equal(o.after.checked, false);
  assert.equal(o.after.focused, true);
});

test("after is re-read every 50ms, so a quick change returns without a longer wait", async () => {
  const { world, pay } = frameWorld();
  await snap();
  let at = null;
  world.state.onPost = (e) => { if (e.type === 2 && e.pt.x >= 0) at = world.clock.t; };
  Object.defineProperty(pay.kids[2], "value", { get: () => (at != null && world.clock.t - at >= 30 ? 0 : 1), configurable: true });
  const { o } = await click({ ref: "f3" });
  assert.equal(o.after.checked, false);
  assert.ok(world.clock.t - at <= 60, `returned ${world.clock.t - at}ms after the click`);
});

test("after gives up waiting within half a second when nothing changes", async () => {
  const { world } = frameWorld();
  await snap();
  const t0 = world.clock.t;
  const { o } = await click({ ref: "f4" });
  assert.deepEqual(o.after, o.before);
  // The routed click itself spends about 120ms of the clock.
  assert.ok(world.clock.t - t0 <= 700, `waited ${world.clock.t - t0}ms`);
});

// Live, Chrome gave a frame checkbox an empty-string AXValue whether or not it
// was checked, so a state perch can't read is null, never false.
test("a checkbox whose AXValue is not a number reports checked:null, not false", async () => {
  const { pay } = frameWorld();
  pay.kids[2].value = "";
  const s = await snap();
  assert.ok(frameLines(s).includes(`f3 checkbox "Save card" frame="js.pay.example"`), s);
  const { o } = await click({ ref: "f3" });
  assert.equal(o.before.checked, null);
  assert.equal(o.after.checked, null);
});

test("the click uses the element's fresh position, never the one from the snapshot", async () => {
  const { world, pay } = frameWorld();
  await snap();
  pay.kids[3].box = { x: 120, y: 400, w: 100, h: 40 };
  const { o } = await click({ ref: "f4" });
  assert.deepEqual(o.point, { x: 170, y: 420 });
  assert.deepEqual(presses(world), [{ x: 170, y: 420 }]);
});

test("a same-name control is matched by its order in its frame", async () => {
  const { world, pay } = frameWorld();
  await snap();
  const { o } = await click({ ref: "f5" });
  assert.deepEqual(o.point, { x: 270, y: 410 });
  // With the first Pay gone, the second Pay is now the first: f5 is stale.
  await snap();
  pay.kids[3].gone = true;
  pay.kids.splice(3, 1);
  world.posted.length = 0;
  const { r, t } = await click({ ref: "f5" });
  assert.equal(r.isError, true);
  assert.match(t, /ref f5 is stale.*accessibility_snapshot/);
  assert.deepEqual(world.posted, []);
});

test("a frame ref is stale when its row, its frame's URL or the page's URL changed", async () => {
  for (const [name, change] of [
    ["row gone", ({ pay }) => { pay.kids.splice(1, 1); }],
    ["frame navigated", ({ pay }) => { pay.url = "https://js.pay.example/v3/other"; }],
    ["page navigated", ({ dom }) => { dom.history.pushState({}, "", "/next"); }],
  ]) {
    const w = frameWorld();
    await snap();
    change(w);
    w.world.reset();
    const { r, t } = await click({ ref: "f2" });
    assert.equal(r.isError, true, name);
    assert.match(t, /ref f2 is stale.*accessibility_snapshot/, name);
    assert.deepEqual(w.world.posted, [], name);
  }
});

test("a frame ref dies on the tab's next snapshot and is unknown in another tab", async () => {
  const { world } = frameWorld();
  await snap();
  await handleCall("accessibility_snapshot", { target: { tabId: "chrome:t" } });
  assert.match((await click({ ref: "f1" })).t, /ref f1 is stale/);
  await snap();
  world.winSpec("Google Chrome", 0).active = 1;
  // The other tab is now the one its window shows; its handle has no frame rows.
  assert.match((await click({ ref: "f4" })).t, /ref f4 is stale/);
  assert.match((await click({ ref: "f4", target: { tabId: "chrome:u" } })).t, /ref f4 is stale/);
  assert.deepEqual(world.posted, []);
});

test("a frame click needs the tab its window shows", async () => {
  const { world } = frameWorld();
  await snap({ target: { tabId: "chrome:t" } });
  world.winSpec("Google Chrome", 0).active = 1;
  const { r, t } = await click({ ref: "f4", target: { tabId: "chrome:t" } });
  assert.equal(r.isError, true);
  assert.match(t, /^error: tab_not_visible:/);
  assert.deepEqual(world.posted, []);
});

test("an offscreen frame row is refused with a hint to scroll", async () => {
  const { world } = frameWorld();
  await snap();
  const { o } = await click({ ref: "f8" });
  assert.equal(o.ok, false);
  assert.match(o.error, /scroll/);
  assert.deepEqual(world.posted, []);
});

test("frame refs are for click {trusted:true} only", async () => {
  const { world } = frameWorld();
  await snap();
  world.reset();
  for (const [name, args] of [
    ["click", { ref: "f4" }],
    ["click", { ref: "f4", hover: true }],
    ["fill", { ref: "f1", text: "4242" }],
    ["fill", { ref: "f1", text: "4242", trusted: true }],
    ["fill", { fields: [{ ref: "f2", text: "94103" }] }],
    ["press", { ref: "f1", key: "Enter" }],
    ["press", { ref: "f1", key: "Enter", trusted: true }],
    ["select", { ref: "f6", text: "US" }],
    ["get_text", { ref: "f7" }],
    ["file_upload", { ref: "f4", path: "/etc/hosts" }],
  ]) {
    const r = await handleCall(name, args);
    assert.equal(r.isError, true, name);
    assert.match(text(r), /frame refs need click \{trusted:true\}/, `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(world.posted, []);
  assert.equal(world.counts["tab.execute"], undefined, "no page JS ran");
});

test("raise:true clicks a frame ref through the foreground route and puts the cursor back", async () => {
  const { world } = frameWorld();
  await snap();
  world.reset();
  const { o } = await click({ ref: "f4", raise: true });
  assert.equal(o.ok, true);
  assert.equal(o.delivery, "hid");
  assert.deepEqual(world.posted.filter((e) => e.type === 1).map((e) => [e.via, e.pt]), [["hid", { x: 160, y: 410 }]]);
  assert.deepEqual(world.state.cursor, { x: 1, y: 2 });
});
