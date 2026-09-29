// screenshot {ref|selector}: the element is scrolled into view, the capture is
// cropped to it (plus a small margin, never past the viewport), and every
// scroll position the page had is put back in the same runtime call.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { JXA_PRELUDE, DAEMONS, handleCall, deps } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";
import { throwAt, noRaw } from "./helpers/fault.mjs";

const saved = { fast: DAEMONS.fast, slow: DAEMONS.slow, exec: deps.exec };
afterEach(() => Object.assign(DAEMONS, { fast: saved.fast, slow: saved.slow }) && Object.assign(deps, { exec: saved.exec }));

// A page whose #t sits at `from` (client CSS px, below the viewport by default)
// and at `rect` once scrolled into view, inside #box, scrolled to 37; the
// window is scrolled to (0, 40). scrollIntoView scrolls both, as a browser
// would, unless #t already sits at `rect` (fully visible: a no-op), and
// records how it was asked. `boxRect` makes #box an overflow:auto scroller
// with that rect as its client area.
function scrolled({ rect = "100,200,300,50", from = "100,1200,300,50", iw = 800, ih = 620, boxRect = null } = {}) {
  const dom = page(`<div id=box${boxRect ? ` style="overflow:auto" data-rect="${boxRect}"` : ""}><p id=t data-rect="${from}">x</p></div><p id=u>u</p>`);
  for (const [k, v] of Object.entries({ innerWidth: iw, innerHeight: ih })) {
    Object.defineProperty(dom, k, { value: v, configurable: true });
  }
  const box = dom.document.getElementById("box"), t = dom.document.getElementById("t");
  if (boxRect) {
    const [, , w, h] = boxRect.split(",").map(Number);
    Object.defineProperty(box, "clientWidth", { value: w });
    Object.defineProperty(box, "clientHeight", { value: h });
  }
  dom.scrollTo({ left: 0, top: 40, behavior: "instant" });
  box.scrollTop = 37;
  dom.intoView = [];
  t.scrollIntoView = function (o) {
    dom.intoView.push(o);
    if (t.getAttribute("data-rect") === rect) return;
    t.setAttribute("data-rect", rect);
    dom.scrollTo({ left: 0, top: 900, behavior: "instant" });
    box.scrollTop = 0;
  };
  return { dom, box, t };
}
const where = ({ dom, box }) => [dom.scrollX, dom.scrollY, box.scrollTop];
// An element already fully visible, which scrollIntoView leaves in place.
const still = (opts = {}) => scrolled({ ...opts, from: opts.rect || "100,200,300,50" });


// ---- the page scripts ----

test("shot_clip scrolls an element outside the viewport the least way in and reports its client rect and viewport", () => {
  const p = scrolled();
  const c = run(p.dom, "shot_clip", { selector: "#t" });
  assert.equal(JSON.stringify(p.dom.intoView), JSON.stringify([{ block: "nearest", inline: "nearest", behavior: "instant" }]));
  assert.deepEqual(c, { ok: true, x: 100, y: 200, w: 300, h: 50, iw: 800, ih: 620, moved: true });
});

test("shot_clip: a fully visible element is not moved, even on a scrolled page", () => {
  for (const rect of ["100,200,300,50", "0,0,800,620"]) {
    const p = still({ rect });
    const c = run(p.dom, "shot_clip", { selector: "#t" });
    assert.equal(p.dom.intoView.length, 1, rect);
    assert.equal(c.moved, false);
    assert.deepEqual(where(p), [0, 40, 37]);
    assert.deepEqual(run(p.dom, "shot_restore", {}), { ok: true });
  }
});

test("shot_clip: an element still clipped by a scrolling container after the scroll is refused, the scroll restored", () => {
  // #box shows 50..450 x 100..400; the element ends at 430 even after scrolling.
  const p = scrolled({ boxRect: "50,100,400,300", rect: "100,380,300,50" });
  const c = run(p.dom, "shot_clip", { selector: "#t" });
  assert.deepEqual(c, { ok: false, error: "screenshot: the element is clipped by a scrolling container; nothing was captured", restore: true });
});

test("shot_clip: an element larger than the viewport is refused before anything scrolls", () => {
  for (const from of ["0,100,900,50", "0,100,300,700"]) {
    const p = scrolled({ from });
    const c = run(p.dom, "shot_clip", { selector: "#t" });
    assert.equal(c.ok, false);
    assert.match(c.error, /^screenshot: the element is larger than the viewport \(\d+x\d+ CSS px in 800x620\); nothing was captured; screenshot without ref or selector$/);
    assert.deepEqual([p.dom.intoView, where(p)], [[], [0, 40, 37]]);
  }
});

test("shot_restore puts back the window's scroll and every scrolled ancestor's, then forgets them", () => {
  const p = scrolled();
  run(p.dom, "shot_clip", { selector: "#t" });
  assert.deepEqual(where(p), [0, 900, 0]);
  assert.deepEqual(run(p.dom, "shot_restore", {}), { ok: true });
  assert.deepEqual(where(p), [0, 40, 37]);
  assert.equal(p.dom.__perch_shot, null);
  assert.deepEqual(run(p.dom, "shot_restore", {}), { ok: false }, "a second restore has nothing to put back");
});

test("shot_clip takes a ref; a stale or unknown ref is a ref miss that scrolls nothing", () => {
  const p = scrolled();
  p.dom.__perch_refs = { e4: p.t, e5: p.dom.document.getElementById("u") };
  assert.equal(run(p.dom, "shot_clip", { ref: "e4" }).ok, true);
  run(p.dom, "shot_restore", {});
  p.dom.document.getElementById("u").remove();
  for (const ref of ["e5", "e9"]) {
    assert.deepEqual(run(p.dom, "shot_clip", { ref }), { __perch_ref_miss: true, ref });
    assert.deepEqual(where(p), [0, 40, 37]);
    assert.equal(p.dom.intoView.length, 1, "only e4 was scrolled to");
  }
});

test("shot_clip: no match, or an element with no size, scrolls nothing", () => {
  const p = scrolled({ rect: "0,0,0,0", from: "0,0,0,0" });
  assert.deepEqual(run(p.dom, "shot_clip", { selector: "#nope" }), { ok: false, error: "no element for selector #nope" });
  const c = run(p.dom, "shot_clip", { selector: "#t" });
  assert.equal(c.ok, false);
  assert.match(c.error, /has no size/);
  assert.deepEqual(where(p), [0, 40, 37]);
});

// ---- the runtime: aim, crop, restore ----

// Chrome's window at (100, 50), 1000x700 points; the page's viewport starts 200pt
// in (a left side panel) and 80pt down (tabs and toolbar), 800x620 points.
const AREA = { x: 300, y: 130, w: 800, h: 620 };
let world;
function install(p, { scale = 2, active = true, area = AREA } = {}) {
  const tabsList = [{ url: "https://a.test/", id: "c0", dom: p.dom }, { url: "https://b.test/", id: "c1" }];
  world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: active ? 0 : 1, x: 100, y: 50, w: 1000, h: 700, tabs: tabsList }] }],
    cg: [{ owner: "Google Chrome", pid: 4242, wid: 77, x: 100, y: 50, w: 1000, h: 700, ax: { web: [area] } }],
  });
  world.state.shotScale = scale;
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
function spawns(width) {
  const calls = [];
  const png = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  deps.exec = async (cmd, a) => {
    calls.push([cmd, ...a]);
    if (cmd === "screencapture") await writeFile(a[a.length - 1], png(width, 1400));
    if (cmd === "sips" && a[0] === "--cropToHeightWidth") await writeFile(a[a.length - 1], png(Number(a[2]), Number(a[1])));
    else if (cmd === "sips") await writeFile(a[a.length - 1], png(Number(a[1]), 100));
    return { stdout: "" };
  };
  return calls;
}
const shoot = async (args) => {
  const r = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, ...args });
  assert.equal(r.isError, undefined, r.content[0].text);
  return { r, meta: JSON.parse(r.content[1].text) };
};

test("a 2x capture is cropped to the element plus 8 CSS px, placed by the Accessibility page area", async () => {
  const p = scrolled();
  install(p);
  const calls = spawns(2000);
  const { meta } = await shoot({ selector: "#t" });
  assert.deepEqual(calls, [], "cropped in the runtime");
  const [s] = world.state.shots;
  // Viewport origin (200, 80) in the window; the box 92..408 x 192..258 CSS px at 1pt each, 2px per point.
  assert.deepEqual(s.crop, { x: 584, y: 544, w: 632, h: 132 });
  assert.deepEqual(s.encoded, { type: 4, props: null, w: 632, h: 132 });
  assert.deepEqual(meta, { window: { x: 100, y: 50, w: 1000, h: 700 }, image: { w: 632, h: 132 }, clip: { x: 584, y: 544, w: 632, h: 132 }, aim: "ax" });
  assert.deepEqual(where(p), [0, 40, 37], "every scroll position restored");
  assert.equal(world.log.filter((e) => e[0] === "activate").length, 0);
});

test("without Accessibility an element crop is refused before any page JS, whatever the browser's panels", async () => {
  // DevTools docked at the bottom: the page is 400 of the window's 620 content points.
  for (const ih of [620, 400]) {
    const p = scrolled({ ih });
    install(p);
    world.state.ax = false;
    const calls = spawns(2000);
    const r = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, selector: "#t" });
    assert.equal(r.content.length, 1, "no image");
    assert.deepEqual(JSON.parse(r.content[0].text), { ok: false, error: "screenshot: cropping to an element needs the Accessibility grant to place the page in the window; grant it, or screenshot without ref or selector" });
    assert.equal(world.counts["tab.execute"], undefined);
    assert.deepEqual([calls, world.state.shots, p.dom.intoView], [[], [], []]);
  }
});

test("with a bottom-docked panel the Accessibility page area places the crop", async () => {
  const p = scrolled({ ih: 400 });
  install(p, { scale: 1, area: { x: 300, y: 130, w: 800, h: 400 } });
  spawns(2000);
  const { meta } = await shoot({ selector: "#t" });
  assert.deepEqual(meta.clip, { x: 292, y: 272, w: 316, h: 66 });
  assert.equal(meta.aim, "ax");
});

test("when Accessibility finds no page area the crop is refused, with the scroll restored", async () => {
  const p = scrolled();
  install(p, { area: { x: 300, y: 130, w: 500, h: 300 } });
  const calls = spawns(2000);
  const r = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, selector: "#t" });
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: false, error: "screenshot: Accessibility shows no page area matching this tab's viewport; nothing was captured; screenshot without ref or selector" });
  assert.deepEqual([calls, world.state.shots], [[], []]);
  assert.deepEqual(where(p), [0, 40, 37]);
});

test("an element scrolled out of view inside an overflow box is scrolled in, cropped there, and the box put back", async () => {
  const p = scrolled({ boxRect: "50,100,400,300", from: "100,20,300,50", rect: "100,200,300,50" });
  install(p);
  spawns(2000);
  const { meta } = await shoot({ selector: "#t" });
  assert.equal(p.dom.intoView.length, 1);
  assert.deepEqual(meta.clip, { x: 584, y: 544, w: 632, h: 132 });
  assert.deepEqual(where(p), [0, 40, 37]);
});

test("an element a scrolling container still clips is refused, with every scroll position restored", async () => {
  const p = scrolled({ boxRect: "50,100,400,300", rect: "100,380,300,50" });
  install(p);
  const calls = spawns(2000);
  const r = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, selector: "#t" });
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: false, error: "screenshot: the element is clipped by a scrolling container; nothing was captured" });
  assert.deepEqual([calls, world.state.shots], [[], []]);
  assert.deepEqual(where(p), [0, 40, 37]);
});

test("page zoom: the Accessibility area's width over innerWidth scales the CSS box", async () => {
  // 125% zoom: 640x496 CSS px fill the 800x620pt area.
  const p = scrolled({ iw: 640, ih: 496 });
  install(p);
  spawns(2000);
  const { meta } = await shoot({ selector: "#t" });
  // 92..408 x 192..258 CSS px * 1.25 + (200, 80), * 2.
  assert.deepEqual(meta.clip, { x: 630, y: 640, w: 790, h: 165 });
  assert.equal(meta.aim, "ax");
});

test("an element past the viewport's edge is cropped at the viewport, clipped:true", async () => {
  const p = scrolled({ rect: "-20,600,300,100" });
  install(p, { scale: 1 });
  spawns(2000);
  const { meta } = await shoot({ selector: "#t" });
  // CSS 0..288 x 592..620 from the viewport origin (200, 80).
  assert.deepEqual(meta.clip, { x: 200, y: 672, w: 288, h: 28 });
  assert.equal(meta.clipped, true);
});

test("the crop comes before the downscale", async () => {
  const p = scrolled({ rect: "0,0,800,300" });
  install(p);
  spawns(2000);
  const { meta } = await shoot({ selector: "#t", maxWidth: 800 });
  const [s] = world.state.shots;
  assert.deepEqual(s.crop, { x: 400, y: 160, w: 1600, h: 616 });
  assert.deepEqual([s.scaled.w, s.scaled.h], [800, 308]);
  assert.deepEqual(meta.image, { w: 800, h: 308 });
  assert.equal(meta.clipped, undefined);
});

test("without the capture grant, an element already in view is cropped by sips before any resample", async () => {
  const p = still();
  install(p);
  world.state.capture = false;
  const calls = spawns(2000);
  const { meta } = await shoot({ selector: "#t", maxWidth: 400 });
  assert.deepEqual(calls.map((c) => c.slice(0, 7)), [
    ["screencapture", "-l", "77", "-x", "-o", "-t", "png"],
    ["sips", "--cropToHeightWidth", "132", "632", "--cropOffset", "544", "584"],
    ["sips", "--resampleWidth", "400", calls[2][3], "--out", calls[2][5]],
  ].map((c) => c.slice(0, 7)));
  assert.equal(calls[2][3], calls[1][calls[1].length - 1], "the resample reads the crop");
  assert.deepEqual(meta.clip, { x: 584, y: 544, w: 632, h: 132 });
  assert.equal(meta.image.w, 400);
  assert.deepEqual(where(p), [0, 40, 37]);
});

test("without the capture grant, an element that had to be scrolled into view is refused, not cropped from the restored page", async () => {
  const p = scrolled();
  install(p);
  world.state.capture = false;
  const calls = spawns(2000);
  const r = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, selector: "#t" });
  assert.equal(r.content.length, 1, "no image");
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: false, error: "screenshot: cropping an element that had to be scrolled into view needs the Screen Recording grant for in-process capture; grant it, or scroll it into view and call again" });
  assert.deepEqual(calls, [], "no screencapture");
  assert.deepEqual(where(p), [0, 40, 37]);
});

test("scroll positions are restored even when the capture fails", async () => {
  const p = still();
  install(p);
  world.state.capture = false;
  deps.exec = async () => { throw new Error("screencapture failed"); };
  const r = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, selector: "#t" });
  assert.equal(r.isError, true);
  assert.deepEqual(where(p), [0, 40, 37]);
  const q = scrolled();
  install(q);
  world.state.captureThrows = true;
  spawns(2000);
  await handleCall("screenshot", { target: { tabId: "chrome:c0" }, selector: "#t" });
  assert.deepEqual(where(q), [0, 40, 37]);
});

test("a tab its window doesn't show is tab_not_visible before any page JS runs", async () => {
  const p = scrolled();
  install(p, { active: false });
  const calls = spawns(2000);
  const r = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, selector: "#t" });
  assert.match(r.content[0].text, /^error: tab_not_visible: /);
  assert.equal(world.counts["tab.execute"], undefined);
  assert.deepEqual([calls, world.state.shots, p.dom.intoView], [[], [], []]);
});

test("a stale ref or no match captures nothing and says why", async () => {
  const p = scrolled();
  install(p);
  spawns(2000);
  const miss = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, ref: "e9" });
  assert.match(miss.content[0].text, /^error: ref e9 is stale or unknown; call accessibility_snapshot again/);
  const none = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, selector: "#nope" });
  assert.deepEqual(JSON.parse(none.content[0].text), { ok: false, error: "no element for selector #nope" });
  assert.deepEqual(world.state.shots, []);
  assert.deepEqual(where(p), [0, 40, 37]);
});

test("a shot_clip page fault is reported in neutral words, captures nothing and restores the scroll", async () => {
  for (const marker of ["const b = el.getBoundingClientRect();", "const c = el.getBoundingClientRect();"]) {
    const p = scrolled();
    install(p);
    const calls = spawns(2000);
    const threw = throwAt(p.dom, marker);
    for (const how of [{ selector: "#t" }, { ref: "e4" }]) {
      p.dom.__perch_refs = { e4: p.t };
      const r = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, ...how });
      assert.equal(r.content.length, 1, "no image");
      const out = JSON.parse(r.content[0].text);
      assert.deepEqual(out, { ok: false, error: "screenshot: the page script failed on this page (TypeError); nothing was captured" });
      noRaw(out);
      assert.deepEqual(where(p), [0, 40, 37], marker);
    }
    assert.equal(threw(), 2);
    assert.deepEqual([calls, world.state.shots], [[], []]);
  }
});

test("a shot_clip PerchStaleRef is the call's ref miss", async () => {
  const p = scrolled();
  install(p);
  spawns(2000);
  p.dom.__perch_refs = { e4: p.t };
  throwAt(p.dom, "const c = el.getBoundingClientRect();", () => true, "throw Object.assign(new Error('x'), { name: 'PerchStaleRef' });");
  const r = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, ref: "e4" });
  assert.match(r.content[0].text, /^error: ref e4 is stale or unknown; call accessibility_snapshot again/);
  assert.deepEqual(where(p), [0, 40, 37]);
});

test("an element crop runs page JS, so a dialog that blocks it is found and named", async () => {
  install(scrolled());
  DAEMONS.fast = undefined;
  DAEMONS.slow = undefined;
  deps.exec = async () => { throw Object.assign(new Error("killed"), { killed: true }); };
  const dialogs = deps.dialogs;
  let probes = 0;
  deps.dialogs = async () => { probes++; return [{ kind: "alert", message: "x" }]; };
  try {
    const r = await handleCall("screenshot", { target: { tabId: "chrome:c0" }, selector: "#t" });
    assert.match(r.content[0].text, /^error: dialog_open: /);
    assert.equal(probes, 1);
  } finally { deps.dialogs = dialogs; }
});

test("without ref or selector no page JS runs", async () => {
  const p = scrolled();
  install(p);
  spawns(2000);
  const { meta } = await shoot({});
  assert.equal(world.counts["tab.execute"], undefined);
  assert.deepEqual(Object.keys(meta), ["window", "image"]);
});
