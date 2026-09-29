// A click that opens a new tab (a target=_blank link or form, window.open) says
// so: `opened` with the new tab's handle, or `blocked` with the URL, so the
// caller neither hunts for the tab nor takes a dropped popup for success. perch
// never selects the new tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, CLICK_BLANK_GO } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

const LINK = `<a id=a href="/job/1" target=_blank>Apply</a><a id=same href="/job/2">Details</a><button id=b>Save</button><p id=s>Idle</p>`;
// The second pass: a short script that runs what the first pass kept.
const go = (w) => JSON.parse(w.eval(CLICK_BLANK_GO));
const count = (w, sel) => w.eval(`(function(){var n=0;document.querySelector(${JSON.stringify(sel)}).addEventListener('click',function(){n++});return function(){return n}})()`);

// ---- page script ----

test("the first pass on a _blank link returns its absolute URL without clicking", () => {
  const w = page(LINK);
  const n = count(w, "#a");
  assert.deepEqual(run(w, "click", { selector: "#a", probe: true }), { ok: true, blank: { href: "https://a.test/job/1" } });
  assert.equal(n(), 0);
});

test("a submit button in a form aimed at _blank is a candidate too; a plain button is not", () => {
  const w = page(`<form action="/apply" target=_blank><input name=q><button id=go>Send</button><button id=t type=button>Toggle</button></form>`);
  assert.deepEqual(run(w, "click", { selector: "#go", probe: true }), { ok: true, blank: { href: "https://a.test/apply" } });
  const n = count(w, "#t");
  assert.deepEqual(run(w, "click", { selector: "#t", probe: true }), { ok: true, el: `button "Toggle"` });
  assert.equal(n(), 1);
});

test("same-tab links, buttons, downloads and non-http _blank links click in the first pass as before", () => {
  const w = page(LINK + `<a id=m href="mailto:x@a.test" target=_blank>Mail</a><a id=d href="/cv.pdf" target=_blank download>CV</a>`);
  for (const [sel, el] of [["#same", `link "Details"`], ["#b", `button "Save"`], ["#m", `link "Mail"`], ["#d", `link "CV"`]]) {
    const n = count(w, sel);
    assert.deepEqual(run(w, "click", { selector: sel, probe: true }), { ok: true, el });
    assert.equal(n(), 1, sel);
  }
});

test("the second pass clicks the element the first pass found, and refuses when the page changed", () => {
  const w = page(LINK);
  const n = count(w, "#a");
  run(w, "click", { selector: "#a", probe: true });
  assert.deepEqual(go(w), { ok: true, el: `link "Apply"` });
  assert.equal(n(), 1);
  const again = go(w);
  assert.equal(again.ok, false);
  assert.match(again.error, /nothing was clicked/);
  assert.equal(n(), 1);
});

test("the second pass says when the page cancelled the link's default", () => {
  const w = page(LINK);
  w.eval(`document.getElementById('a').addEventListener('click', function (e) { e.preventDefault(); })`);
  run(w, "click", { selector: "#a", probe: true });
  assert.deepEqual(go(w), { ok: true, el: `link "Apply"`, cancelled: true });
});

test("window.open during the click: a null return is blocked, a window is opened; the original is restored", () => {
  const w = page(`<button id=b>Apply</button>`);
  w.eval(`window.__win = null; window.open = function () { return window.__win; }; window.__orig = window.open;
    document.getElementById('b').addEventListener('click', function () { window.open('/job/7', '_blank'); });`);
  assert.deepEqual(run(w, "click", { selector: "#b", probe: true }), { ok: true, el: `button "Apply"`, blocked: true, href: "https://a.test/job/7" });
  assert.equal(w.eval("window.open === window.__orig"), true);
  w.eval("window.__win = {}");
  assert.deepEqual(run(w, "click", { selector: "#b", probe: true }), { ok: true, el: `button "Apply"`, opened: { url: "https://a.test/job/7" }, note: "list_tabs to find it" });
  assert.equal(w.eval("window.open === window.__orig"), true);
});

test("the browser's own window.open is back after the click, and a click that opens nothing adds no keys", () => {
  const w = page(`<button id=b>Apply</button>`);
  w.eval("window.__orig = window.open; window.__own = Object.prototype.hasOwnProperty.call(window, 'open')");
  assert.deepEqual(run(w, "click", { selector: "#b", probe: true }), { ok: true, el: `button "Apply"` });
  assert.equal(w.eval("window.open === window.__orig && Object.prototype.hasOwnProperty.call(window, 'open') === window.__own"), true);
});

test("a window.open the page swapped in during the click is left alone", () => {
  const w = page(`<button id=b>Apply</button>`);
  w.eval(`window.__mine = function () { return null; };
    document.getElementById('b').addEventListener('click', function () { window.open = window.__mine; });`);
  run(w, "click", { selector: "#b", probe: true });
  assert.equal(w.eval("window.open === window.__mine"), true);
});

// ---- through the runtime ----

function onPage(browser, html, setup, { tabUrl = "https://a.test/", active = 0 } = {}) {
  const dom = page(html);
  if (setup) dom.eval(setup);
  const world = makeWorld({
    browsers: [{ name: browser.name, kind: browser.kind, windows: [{ id: 7, active, tabs: [{ url: "https://z.test/", id: "z0" }, { url: tabUrl, id: "x", dom }].slice(active ? 0 : 1) }] }],
    cg: [{ owner: "Terminal" }, { owner: browser.name }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return { dom, world };
}
const CHROME = { name: "Google Chrome", kind: "chrome" }, SAFARI = { name: "Safari", kind: "safari" }, ARC = { name: "Arc", kind: "arc" };
const call = async (name, args) => {
  const r = await handleCall(name, args);
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};
// The fake browser's answer to an untrusted click on the link: a new tab, shown or not.
const opensTab = (world, dom, b, { select = false } = {}) => {
  dom.document.getElementById("a").addEventListener("click", (e) => world.openTab(b.name, 0, e.currentTarget.href, { select }));
};
const focusEvents = (world) => Object.keys(world.counts).filter((k) => /select|activeTabIndex=|currentTab=|activate|index=/.test(k));

test("a _blank link that opens a tab reports its handle; the shown tab stays and nothing is selected", async () => {
  const { dom, world } = onPage(CHROME, LINK);
  opensTab(world, dom, CHROME);
  const o = await call("click", { selector: "#a" });
  assert.equal(o.ok, true);
  assert.equal(o.el, `link "Apply"`);
  assert.equal(o.opened.url, "https://a.test/job/1");
  assert.equal(o.note, undefined);
  assert.equal(o.blocked, undefined);
  const tabs = (await call("list_tabs", {})).tabs;
  assert.equal(tabs.find((t) => t.tabId === o.opened.tabId)?.url, "https://a.test/job/1");
  assert.equal(world.winSpec(CHROME.name, 0).active, 0, "the clicked tab is still shown");
  assert.deepEqual(focusEvents(world), []);
  assert.ok(!world.log.some(([k]) => k === "activate"));
});

test("a _blank link that opens nothing is blocked, with the absolute URL to open", async () => {
  onPage(CHROME, LINK);
  assert.deepEqual(await call("click", { selector: "#a" }), { ok: true, el: `link "Apply"`, blocked: true, href: "https://a.test/job/1" });
});

test("a tab the browser shows by itself gets a note, and perch sends no select", async () => {
  const { dom, world } = onPage(CHROME, LINK);
  opensTab(world, dom, CHROME, { select: true });
  const o = await call("click", { selector: "#a" });
  assert.match(o.opened.tabId, /:pop1$/);
  assert.equal(o.note, "the browser showed the new tab");
  assert.equal(world.winSpec(CHROME.name, 0).active, 1, "left on the tab the browser chose");
  assert.deepEqual(focusEvents(world), []);
});

test("a _blank link whose page cancelled the default and opened nothing reports neither", async () => {
  onPage(CHROME, LINK, `document.getElementById('a').addEventListener('click', function (e) { e.preventDefault(); document.getElementById('s').textContent = 'Routed'; })`);
  assert.deepEqual(await call("click", { selector: "#a" }), { ok: true, el: `link "Apply"` });
});

test("click {readback} on a _blank link reports the new tab and still reads back", async () => {
  const { dom, world } = onPage(CHROME, LINK);
  opensTab(world, dom, CHROME);
  const o = await call("click", { selector: "#a", readback: "#s" });
  assert.equal(o.ok, true);
  assert.match(o.opened.tabId, /:pop1$/);
  assert.equal(o.readback, "Idle");
  assert.equal(o.changed, false);
});

test("Safari: the opened tab's handle is the one list_tabs gives, and resolves to that tab", async () => {
  const { dom, world } = onPage(SAFARI, LINK, null, { active: 1 });
  opensTab(world, dom, SAFARI);
  const o = await call("click", { selector: "#a" });
  assert.equal(o.opened.url, "https://a.test/job/1");
  const listed = (await call("list_tabs", {})).tabs;
  assert.equal(listed.find((t) => t.url === "https://a.test/job/1")?.tabId, o.opened.tabId);
  assert.equal(world.winSpec(SAFARI.name, 0).active, 1);
  assert.deepEqual(focusEvents(world), []);
  assert.deepEqual(await call("close_tab", { tabId: o.opened.tabId }), { ok: true, closed: o.opened.tabId });
  assert.deepEqual(world.tabsOf(SAFARI.name, 0).map((t) => t.spec.id), ["z0", "x"]);
});

test("Arc: a tab opened from the shown tab is reported by its id", async () => {
  const { dom, world } = onPage(ARC, LINK);
  opensTab(world, dom, ARC);
  const o = await call("click", { selector: "#a" });
  assert.match(o.opened.tabId, /^arc:pop1$/);
  assert.deepEqual(focusEvents(world), []);
});

// ---- trusted ----

function trustedTab(html) {
  const dom = page(html);
  for (const [k, v] of Object.entries({ screenX: 0, screenY: 57, outerWidth: 654, innerWidth: 598, outerHeight: 600, innerHeight: 500 })) Object.defineProperty(dom, k, { value: v, configurable: true });
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "https://a.test/", id: "c0", dom }] }] }],
    cg: [{ owner: "Google Chrome", pid: 40, wid: 400, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 598, h: 500 }] } }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return { dom, world };
}

test("a background trusted click on a _blank link reports the tab the real click opened", async () => {
  const { dom, world } = trustedTab(LINK);
  world.state.onPost = (e) => {
    if (e.type !== 2 || e.pt.x < 0) return;
    dom.document.getElementById("a").dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true }));
    world.openTab("Google Chrome", 0, "https://a.test/job/1");
  };
  const o = await call("click", { trusted: true, selector: "#a" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.match(o.opened.tabId, /:pop1$/);
  assert.equal(o.opened.url, "https://a.test/job/1");
  assert.equal(world.winSpec("Google Chrome", 0).active, 0);
  assert.deepEqual(focusEvents(world), []);
});

test("a trusted click on a _blank link that opens nothing is blocked", async () => {
  const { dom, world } = trustedTab(LINK);
  world.state.onPost = (e) => {
    if (e.type === 2 && e.pt.x >= 0) dom.document.getElementById("a").dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true }));
  };
  const o = await call("click", { trusted: true, selector: "#a" });
  assert.equal(o.blocked, true, JSON.stringify(o));
  assert.equal(o.href, "https://a.test/job/1");
});
