// select {trusted:true} on custom selects that open only on a real, trusted press
// (test/fixtures/trusted-select.html). The synthetic open comes first; a trusted
// click on the control follows only when that shows no own options, and one on
// the option only when the synthetic pick doesn't show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/trusted-select.html", import.meta.url), "utf8");
const BODY = /<body>([\s\S]*?)<script>/.exec(FIXTURE)[1];
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(FIXTURE)[1];
const METRICS = { screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 };
const AREA = { x: 56, y: 157, w: 798, h: 500 };

function fixture() {
  const dom = page(BODY, { url: "https://form.test/" });
  for (const [k, v] of Object.entries(METRICS)) Object.defineProperty(dom, k, { value: v, configurable: true });
  dom.eval(SCRIPT);
  return dom;
}

// Terminal in front, the fixture's tab second in a background Chrome window.
// `shown`: that tab is the one its window shows. A posted press reaches the
// element the probe armed as a trusted gesture, or `aimAt` (by id) instead.
function world({ shown = true, frames = [], aimAt = null } = {}) {
  const dom = fixture();
  const w = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: shown ? 1 : 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "https://form.test/", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ ...AREA, frames }] } }],
  });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = w.daemon;
  DAEMONS.slow = w.daemon;
  w.reset();
  const fire = (el, types, C) => types.forEach((type) => {
    const e = new C(type, { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(e, "isTrusted", { value: true });
    el.dispatchEvent(e);
  });
  let target = null;
  w.state.onPost = (e) => {
    if (e.kind !== "mouse" || e.pt.x < 0 || (e.type !== 1 && e.type !== 2)) return;
    if (e.type === 1) target = aimAt ? dom.document.getElementById(aimAt) : dom.__perch_trusted && dom.__perch_trusted.el;
    if (!target) return;
    const P = dom.PointerEvent || dom.MouseEvent;
    if (e.type === 1) { fire(target, ["pointerdown"], P); fire(target, ["mousedown"], dom.MouseEvent); }
    else { fire(target, ["pointerup"], P); fire(target, ["mouseup", "click"], dom.MouseEvent); }
  };
  w.dom = dom;
  return w;
}

const select = async (args) => {
  const r = await handleCall("select", { target: { tabIndex: 1 }, ...args });
  const t = r.content[0].text;
  try { return JSON.parse(t); } catch { return { ok: false, error: t, isError: r.isError }; }
};
const presses = (w) => w.posted.filter((e) => e.kind === "mouse" && e.type === 1 && e.pt.x >= 0).map((e) => [e.via, e.pt]);
const noFocusTaken = (w) => {
  assert.equal(w.counts["activate(Google Chrome)"], undefined);
  assert.equal(w.counts["win.activeTabIndex="], undefined);
  assert.equal(w.log.filter((entry) => entry[0] === "SLPSPostEventRecordTo").length, 0);
  assert.deepEqual(w.state.cursor, { x: 1, y: 2 });
  assert.deepEqual(w.state.warps, []);
};

test("without trusted, a control that opens only on a trusted press misses and says to retry with trusted", async () => {
  const w = world();
  const o = await select({ selector: "#fruit", text: "Banana" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /did not open or is empty; retry with select \{trusted:true\}/);
  assert.deepEqual(presses(w), []);
});

test("trusted: a control that ignores synthetic presses is opened with a background trusted click, then picked", async () => {
  const w = world();
  const o = await select({ selector: "#fruit", text: "banana", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Banana");
  assert.equal(o.value, "Banana");
  assert.deepEqual(o.trusted, ["control"]);
  assert.deepEqual([...w.dom.pickerLog], ["fruit:Banana"]);
  assert.deepEqual(presses(w), [["skylight", { x: 106, y: 167 }]]);
  noFocusTaken(w);
});

test("trusted: options that also ignore synthetic presses get a trusted click of their own", async () => {
  const w = world();
  const o = await select({ label_pattern: "^city$", text: "Quito", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value, "Quito");
  assert.deepEqual(o.trusted, ["control", "option"]);
  assert.deepEqual([...w.dom.pickerLog], ["city:Quito"]);
  assert.equal(presses(w).length, 2);
  noFocusTaken(w);
});

test("trusted: a click whose check gets no reply says the select ran, not to select again", async () => {
  const w = world();
  const post = w.state.onPost;
  w.state.onPost = (e) => { post(e); if (e.kind === "mouse" && e.type === 2) w.state.hung = true; };
  const t0 = w.clock.t;
  const o = await select({ selector: "#fruit", text: "banana", trusted: true });
  assert.equal(o.isError, true);
  assert.match(o.error, /^error: timeout: the select ran but .*don't select again/);
  assert.ok(w.clock.t - t0 < 10000, `took ${w.clock.t - t0}ms`);
  assert.equal(presses(w).length, 1);
});

test("trusted: a list still empty after the trusted click misses, saying it clicked", async () => {
  const w = world();
  w.dom.document.getElementById("fruit-list").remove();
  const o = await select({ selector: "#fruit", text: "Banana", trusted: true });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.error, "the control's option list did not open or is empty");
  assert.deepEqual(o.trusted, ["control"]);
  assert.equal(presses(w).length, 1);
});

test("trusted: a control that opens synthetically posts nothing, even in a tab its window doesn't show", async () => {
  const w = world({ shown: false });
  const o = await select({ selector: "#size", text: "Large", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value, "Large");
  assert.equal(o.trusted, undefined);
  assert.deepEqual(w.posted, []);
  noFocusTaken(w);
});

test("trusted: a tab its window doesn't show is tab_not_visible, with nothing posted or activated", async () => {
  const w = world({ shown: false });
  const o = await select({ selector: "#fruit", text: "Banana", trusted: true });
  assert.equal(o.isError, true, JSON.stringify(o));
  assert.match(o.error, /^error: tab_not_visible: select \{trusted:true\} needs the tab its window shows/);
  assert.deepEqual(w.posted, []);
  assert.deepEqual([...w.dom.pickerLog], []);
  noFocusTaken(w);
});

test("trusted: Accessibility's hit test finding a frame over the control refuses, with nothing posted", async () => {
  const w = world({ frames: [{ url: "https://ads.example/slot", box: { x: 56, y: 157, w: 300, h: 100 }, kids: [] }] });
  const o = await select({ selector: "#fruit", text: "Banana", trusted: true });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /not on the page itself/);
  assert.deepEqual(presses(w), []);
  assert.deepEqual([...w.dom.pickerLog], []);
});

test("trusted: a press that lands on another element fails closed and picks nothing", async () => {
  const w = world({ aimAt: "size" });
  const o = await select({ selector: "#fruit", text: "Banana", trusted: true });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.hit, false);
  assert.match(o.error, /trusted click on combobox "Fruit" did not land on it/);
  assert.deepEqual([...w.dom.pickerLog], []);
  assert.equal(presses(w).length, 1);
});

test("trusted: a native <select> needs no click", async () => {
  const w = world();
  w.dom.document.body.insertAdjacentHTML("beforeend", `<label>Plan <select id=plan><option>Free</option><option>Pro</option></select></label>`);
  const o = await select({ selector: "#plan", text: "Pro", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(w.posted, []);
});

test("trusted_probe aims at select's control, then its picked option, and reports a gone option", () => {
  const dom = fixture();
  assert.match(run(dom, "trusted_probe", { select: "control" }).error, /select state lost/);
  run(dom, "select_start", { selector: "#fruit", text: "Apple" });
  const c = run(dom, "trusted_probe", { select: "control" });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.el, `combobox "Fruit"`);
  assert.deepEqual(run(dom, "trusted_probe", { select: "option" }), { ok: false, gone: true });
  dom.document.getElementById("fruit-list").hidden = false;
  dom.document.getElementById("fruit-list").innerHTML = `<li role=option>Apple</li>`;
  run(dom, "select_pick", { selector: "#fruit", text: "Apple" });
  assert.equal(run(dom, "trusted_probe", { select: "option" }).el, `option "Apple"`);
  dom.document.getElementById("fruit-list").innerHTML = "";
  assert.deepEqual(run(dom, "trusted_probe", { select: "option" }), { ok: false, gone: true });
});
