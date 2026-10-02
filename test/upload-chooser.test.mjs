// Pins file_upload {raise:true}: a site with no file input of its own opens the
// native open panel from a trusted click; perch types the path into its Go to
// sheet, presses the default button and checks the page showed the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../scripts/temp.mjs";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, deliverPress } from "./helpers/page.mjs";

const METRICS = { screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 };
const SERVICE = "Open and Save Panel Service";

function withWindowMetrics(w, m) {
  for (const [k, v] of Object.entries(m)) Object.defineProperty(w, k, { value: v, configurable: true });
}

// Chrome in front, its page holding the composer's trigger. `panel` is the
// native panel the trigger's trusted click opens; `service` adds the panel
// service's CG window (behind the browser) for a panel of kind window.
async function setup({ panel = {}, opensOnClick = true, preview = true, service = false } = {}) {
  const dom = page(`<button id=add>Add photo/video</button><div id=media></div>`);
  withWindowMetrics(dom, METRICS);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 1, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "about:blank", id: "t", dom }] }] }],
    cg: [
      { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 798, h: 500 }] } },
      ...(service ? [{ owner: SERVICE, pid: 999, wid: 90, x: 100, y: 100, w: 600, h: 400 }] : []),
    ],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  world.state.panel = { pid: 4242, kind: "sheet", parent: 50, open: false, ...panel };
  deliverPress(world, dom, dom.document.getElementById("add"));
  const prior = world.state.onPost;
  world.state.onPost = (e) => { prior(e); if (opensOnClick && e.type === 2 && e.pt.x >= 0) world.state.panel.open = true; };
  world.state.onPanelChoose = (path) => {
    if (!preview) return;
    const img = dom.document.createElement("img");
    img.src = "blob:https://example.test/" + path.split("/").pop();
    dom.document.getElementById("media").append(img);
  };
  const dir = tempDir("perch-chooser-");
  const path = join(dir, "31 photo.jpg");
  await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return { dom, world, path };
}
const upload = async (args) => {
  const r = await handleCall("file_upload", { raise: true, label_pattern: "^Add photo/video$", target: { tabIndex: 1 }, ...args });
  const t = r.content[0].text;
  return { r, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
const keys = (world) => world.posted.filter((e) => e.kind === "key" && e.down).map((e) => [e.vk, e.flags]);
const mice = (world) => world.posted.filter((e) => e.kind === "mouse" && e.type === 1);

test("raise:true clicks the trigger, chooses the file in the chooser sheet and sees the preview", async () => {
  const { world, path, dom } = await setup();
  const { o } = await upload({ path });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.chooser, true);
  assert.equal(o.shown, true);
  assert.match(o.el, /Add photo\/video/);
  assert.equal(world.state.panel.chosen, path);
  assert.equal(world.state.panel.open, false);
  assert.deepEqual(keys(world), [[5, 0x120000], [36, 0]]);
  assert.ok(world.posted.filter((e) => e.kind === "key").every((e) => e.via === "tap1"), "keys go to the foreground session tap");
  assert.ok(world.state.axActions.some((a) => a.action === "AXPress" && a.role === "AXButton"));
  assert.equal(dom.document.querySelectorAll("#media img").length, 1);
});

test("a chooser drawn by the panel service, as its own window, is found and used", async () => {
  const { world, path } = await setup({ panel: { pid: 999, kind: "window" }, service: true });
  const { o } = await upload({ path });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(world.state.panel.chosen, path);
});

test("a chooser already open before the click is the user's: refused, nothing clicked", async () => {
  const { world, path } = await setup({ panel: { open: true } });
  const { o } = await upload({ path });
  assert.equal(o.ok, false);
  assert.match(o.error, /already open/);
  assert.equal(mice(world).length, 0);
  assert.equal(keys(world).length, 0);
  assert.equal(world.state.panel.open, true, "the user's chooser is left alone");
});

test("no chooser after the click: ok:false and no key is typed", async () => {
  const { world, path } = await setup({ opensOnClick: false });
  const { o } = await upload({ path });
  assert.equal(o.ok, false);
  assert.match(o.error, /no file chooser opened/);
  assert.equal(mice(world).length, 1);
  assert.equal(keys(world).length, 0);
});

test("a disabled Open button (the site's accept filter) cancels the chooser", async () => {
  const { world, path } = await setup({ panel: { enabled: false } });
  const { o } = await upload({ path });
  assert.equal(o.ok, false);
  assert.match(o.error, /disabled/);
  assert.equal(world.state.panel.cancelled, true);
  assert.equal(world.state.panel.chosen, undefined);
});

test("chosen in the chooser but the page showed nothing: not verified", async () => {
  const { world, path } = await setup({ preview: false });
  const { o } = await upload({ path });
  assert.equal(o.ok, false);
  assert.equal(o.chooser, true);
  assert.match(o.error, /not verified/);
  assert.equal(world.state.panel.chosen, path);
});

test("the browser not in front when the chooser opens: no key typed, the chooser is cancelled", async () => {
  const { world, path } = await setup();
  const prior = world.state.onPost;
  world.state.onPost = (e) => {
    prior(e);
    if (e.type === 2 && e.pt.x >= 0) world.cg.unshift({ owner: "Terminal", pid: 1, wid: 1, x: 0, y: 0, w: 900, h: 900 });
  };
  const { o } = await upload({ path });
  assert.equal(o.ok, false);
  assert.match(o.error, /not in front/);
  assert.equal(keys(world).length, 0);
  assert.equal(world.state.panel.cancelled, true);
});

test("raise:true needs a trigger to click", async () => {
  const { path } = await setup();
  const r = await handleCall("file_upload", { raise: true, path, target: { tabIndex: 1 } });
  assert.match(r.content[0].text, /raise:true needs the control that opens the chooser/);
});
