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
  assert.equal(o.value ?? o.selected, "Banana");
  assert.deepEqual(o.trusted, ["control"]);
  assert.deepEqual([...w.dom.pickerLog], ["fruit:Banana"]);
  assert.deepEqual(presses(w), [["skylight", { x: 106, y: 167 }]]);
  noFocusTaken(w);
});

test("trusted: options that also ignore synthetic presses get a trusted click of their own", async () => {
  const w = world();
  const o = await select({ label_pattern: "^city$", text: "Quito", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value ?? o.selected, "Quito");
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
  const edits = editing(w.dom);
  const o = await select({ selector: "#fruit", text: "Banana", trusted: true });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.error, "the control's option list did not open or is empty");
  assert.deepEqual(o.trusted, ["control"]);
  assert.deepEqual(edits, []);
  assert.equal(presses(w).length, 1);
});

for (const shown of [true, false]) test(`trusted: a control that opens synthetically posts nothing and types nothing (${shown ? "shown" : "hidden"} tab)`, async () => {
  const w = world({ shown });
  const edits = editing(w.dom);
  const o = await select({ selector: "#size", text: "Large", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value ?? o.selected, "Large");
  assert.equal(o.trusted, undefined);
  assert.deepEqual(w.posted, []);
  assert.deepEqual(edits, []);
  noFocusTaken(w);
});

test("trusted: a control with no text box of its own, in a tab its window doesn't show, is tab_not_visible, with nothing posted, typed or activated", async () => {
  const w = world({ shown: false });
  const edits = editing(w.dom);
  const o = await select({ selector: "#fruit", text: "Banana", trusted: true });
  assert.equal(o.isError, true, JSON.stringify(o));
  assert.match(o.error, /^error: tab_not_visible: select \{trusted:true\} needs the tab its window shows; activate_tab \(takes focus\) or retry later$/);
  assert.deepEqual(w.posted, []);
  assert.deepEqual(edits, []);
  assert.deepEqual([...w.dom.pickerLog], []);
  noFocusTaken(w);
});

// The browser's editing command, as Chrome runs it in a background tab: it edits
// the focused box's selection and fires an input event, trusted unless `trusted`
// is false. Returns the commands it ran.
function editing(dom, { trusted = true, after } = {}) {
  const calls = [];
  dom.document.execCommand = (cmd, _ui, text) => {
    calls.push([cmd, text]);
    const el = dom.document.activeElement;
    if (!el || el.value == null) return false;
    const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? el.value.length;
    el.value = cmd === "insertText" ? el.value.slice(0, a) + text + el.value.slice(b) : a < b ? el.value.slice(0, a) + el.value.slice(b) : el.value.slice(0, Math.max(0, a - 1)) + el.value.slice(a);
    const ev = new dom.Event("input", { bubbles: true });
    Object.defineProperty(ev, "isTrusted", { value: trusted });
    el.dispatchEvent(ev);
    if (after) after(cmd);
    return true;
  };
  return calls;
}
const $ = (w, sel) => w.dom.document.querySelector(sel);

test("trusted, background tab: a picker that opens only on trusted input is typed into with the editing command, then picked", async () => {
  const w = world({ shown: false });
  w.state.ax = false; // a trusted click would need Accessibility; typing does not
  const edits = editing(w.dom);
  const o = await select({ selector: "#loc", text: "Córdoba, Argentina", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.selected, "Córdoba, Argentina");
  assert.equal(o.value ?? o.selected, "Córdoba, Argentina");
  assert.deepEqual(o.trusted, ["typed"]);
  assert.deepEqual(edits, [["insertText", "Córdoba"]]);
  assert.deepEqual([...w.dom.pickerLog], ["loc:Córdoba, Argentina"]);
  assert.deepEqual(w.posted, []);
  noFocusTaken(w);
});

test("trusted, shown tab: a picker the trusted click leaves shut is typed into with the editing command, then picked", async () => {
  const w = world();
  const edits = editing(w.dom);
  const o = await select({ selector: "#loc", text: "Córdoba, Argentina", trusted: true });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.value ?? o.selected, "Córdoba, Argentina");
  assert.deepEqual(o.trusted, ["control", "typed"]);
  assert.deepEqual(edits, [["insertText", "Córdoba"]]);
  assert.deepEqual([...w.dom.pickerLog], ["loc:Córdoba, Argentina"]);
  assert.equal(presses(w).length, 1);
  noFocusTaken(w);
});

test("trusted, background tab: no option matching after typing withdraws the typed text and lists the candidates", async () => {
  const w = world({ shown: false });
  const edits = editing(w.dom);
  let blurs = 0;
  $(w, "#loc-input").addEventListener("blur", () => blurs++);
  const o = await select({ selector: "#loc", text: "Córdoba, Mexico", trusted: true });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.error, "no option of this control matched");
  assert.deepEqual(o.candidates, ["Córdoba, Argentina", "Córdoba, Spain"]);
  assert.deepEqual(o.trusted, ["typed"]);
  assert.deepEqual(edits.map((e) => e[0]), ["insertText", "delete"]);
  assert.equal($(w, "#loc-input").value, "");
  assert.deepEqual([...w.dom.pickerLog], []);
  assert.deepEqual(w.posted, []);
  assert.equal(blurs, 0, "a refusal never blurs the box select typed in");
  noFocusTaken(w);
});

test("trusted, background tab: an editing command that gives no trusted input picks nothing and restores the empty box", async () => {
  const w = world({ shown: false });
  const edits = editing(w.dom, { trusted: false });
  let blurs = 0;
  $(w, "#loc-input").addEventListener("blur", () => blurs++);
  const o = await select({ selector: "#loc", text: "Córdoba, Argentina", trusted: true });
  assert.deepEqual(o, { ok: false, error: "the picker ignored background typing", trusted: [] });
  assert.equal(blurs, 0, "a refusal never blurs the box select typed in");
  assert.deepEqual(edits.map((e) => e[0]), ["insertText", "delete"]);
  assert.equal($(w, "#loc-input").value, "");
  assert.deepEqual([...w.dom.pickerLog], []);
  noFocusTaken(w);
});

test("trusted, background tab: a box that already holds text is not typed into", async () => {
  const w = world({ shown: false });
  const edits = editing(w.dom);
  $(w, "#loc-input").value = "Ros";
  const o = await select({ selector: "#loc", text: "Rosario, Argentina", trusted: true });
  assert.equal(o.isError, true, JSON.stringify(o));
  assert.match(o.error, /^error: tab_not_visible: select \{trusted:true\}/);
  assert.deepEqual(edits, []);
});

test("trusted, background tab: a reply dropped after typing says the select may have run, never to select again", async () => {
  const w = world({ shown: false });
  editing(w.dom, { after: () => { w.state.hung = true; } });
  const o = await select({ selector: "#loc", text: "Córdoba, Argentina", trusted: true });
  assert.equal(o.isError, true, JSON.stringify(o));
  assert.match(o.error, /^error: timeout: .*it may have run/);
  assert.doesNotMatch(o.error, /retry with select/);
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
  assert.deepEqual(run(dom, "trusted_probe", { select: "option" }), { ok: false, gone: true, tok: c.tok });
  dom.document.getElementById("fruit-list").hidden = false;
  dom.document.getElementById("fruit-list").innerHTML = `<li role=option>Apple</li>`;
  run(dom, "select_pick", { selector: "#fruit", text: "Apple" });
  assert.equal(run(dom, "trusted_probe", { select: "option" }).el, `option "Apple"`);
  dom.document.getElementById("fruit-list").innerHTML = "";
  assert.deepEqual(run(dom, "trusted_probe", { select: "option" }), { ok: false, gone: true, tok: c.tok });
});

test("select_type types only into the control's own box or its linked popup's search box, never the page's", () => {
  const A = { selector: "#c", text: "Design (Lima)" };
  const dom = page(`<form role=search><input id=q></form>
    <div id=c role=combobox aria-label=Team aria-controls=pop aria-expanded=false>Pick</div>
    <div id=pop><input id=f aria-label=Filter></div>`);
  const edits = editing(dom);
  run(dom, "select_start", A);
  assert.deepEqual(run(dom, "select_type", A), { ok: true, tok: dom.__perch_select.tok });
  assert.deepEqual(edits, [["insertText", "Design"]]);
  assert.equal(dom.document.getElementById("f").value, "Design");
  assert.equal(dom.document.getElementById("q").value, "");

  const bare = page(`<input id=q aria-label=Search><div id=c role=combobox aria-label=Team aria-controls=pop>Pick</div><ul id=pop role=listbox></ul>`);
  const none = editing(bare);
  run(bare, "select_start", A);
  assert.deepEqual(run(bare, "select_type", A), { none: true, tok: bare.__perch_select.tok });
  assert.deepEqual(none, []);
});

test("select_type's filter is the option text up to its first punctuation, or the whole text when that is under 2 characters", () => {
  for (const [text, typed] of [["Córdoba, Argentina", "Córdoba"], ["São Paulo - SP", "São Paulo"], ["A-1 Tower", "A-1 Tower"], ["x".repeat(40), "x".repeat(30)]]) {
    const dom = page(`<div id=c class=x__control><input id=i role=combobox aria-label=Where></div>`);
    const edits = editing(dom);
    run(dom, "select_start", { selector: "#i", text });
    run(dom, "select_type", { selector: "#i", text });
    assert.deepEqual(edits[0], ["insertText", typed], text);
  }
});

// In a modal select leaves other open menus alone (no Escape the dialog hears),
// so one may cover the popup: a trusted click aimed at the option would land on
// the covering menu's item. The probe's hit test refuses before anything is posted.
test("trusted, in a modal: an option another open menu covers is refused, never clicking the covering menu", async () => {
  const w = world();
  const d = w.dom.document;
  const field = d.getElementById("city").parentElement;
  const dlg = d.createElement("div");
  dlg.id = "dlg"; dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true");
  field.replaceWith(dlg);
  dlg.appendChild(field);
  dlg.insertAdjacentHTML("beforeend", `<input id=other role=combobox aria-expanded=true aria-controls=cover aria-label=Other><ul id=cover role=listbox><li role=option id=cov>Covering item</li></ul>`);
  w.dom.eval(`window.covered = 0; window.dlgCloses = 0;
    document.getElementById('cov').addEventListener('mousedown', () => { window.covered++; });
    document.getElementById('cov').addEventListener('click', () => { window.covered++; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { window.dlgCloses++; document.getElementById('dlg').hidden = true; } });`);
  // The covering menu is on top of city's list once it shows; elsewhere the aimed element is hit.
  d.elementFromPoint = () => (d.getElementById("city-list").hidden ? d.getElementById("city") : d.getElementById("cov"));
  const fire = (el, types, C) => types.forEach((type) => {
    const e = new C(type, { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(e, "isTrusted", { value: true });
    el.dispatchEvent(e);
  });
  let target = null;
  w.state.onPost = (e) => {
    if (e.kind !== "mouse" || e.pt.x < 0 || (e.type !== 1 && e.type !== 2)) return;
    if (e.type === 1) target = d.elementFromPoint(0, 0);
    const P = w.dom.PointerEvent || w.dom.MouseEvent;
    if (e.type === 1) { fire(target, ["pointerdown"], P); fire(target, ["mousedown"], w.dom.MouseEvent); }
    else { fire(target, ["pointerup"], P); fire(target, ["mouseup", "click"], w.dom.MouseEvent); }
  };
  const o = await select({ label_pattern: "^city$", text: "Quito", trusted: true });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /covered by option "Covering item"/);
  assert.equal(w.dom.covered, 0);
  assert.equal(presses(w).length, 1);
  assert.deepEqual([...w.dom.pickerLog], []);
  assert.equal(d.getElementById("dlg").hidden, false);
  assert.equal(w.dom.dlgCloses, 0);
});

// A browser's document.elementFromPoint retargets a hit inside a shadow tree to
// its host, so a web-component control (its combobox in the host's shadow root)
// reads as the host at the aim point: that is the control itself, not a cover.
// So is the control's own label.
test("trusted_probe {select}: a shadow host holding the control, or the control's own label, at the aim point is no cover", () => {
  for (const deep of [true, false]) {
    const dom = page(`<x-sel id=host></x-sel><div id=over>Over</div>`);
    const host = dom.document.getElementById("host");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<span id=sl>Shade</span><div id=sc role=combobox tabindex=0 aria-labelledby=sl aria-expanded=false><span>Pick</span></div>`;
    const sc = root.getElementById("sc");
    dom.document.elementFromPoint = () => host;
    root.elementFromPoint = deep ? () => sc.firstChild : () => null;
    run(dom, "select_start", { selector: "#sc", text: "Apple" });
    const c = run(dom, "trusted_probe", { select: "control" });
    assert.equal(c.ok, true, `deep ${deep} ${JSON.stringify(c)}`);
    // Another element over it is still a cover.
    dom.document.elementFromPoint = () => dom.document.getElementById("over");
    const x = run(dom, "trusted_probe", { select: "control" });
    assert.equal(x.covered, true, `deep ${deep} ${JSON.stringify(x)}`);
  }
  const dom = page(`<label for=lc id=lab>Tier</label><div id=lc role=combobox aria-labelledby=lab tabindex=0>Pick</div><label id=wrap><input id=li role=combobox> Wrapped</label>`);
  dom.document.elementFromPoint = () => dom.document.getElementById("lab");
  run(dom, "select_start", { selector: "#lc", text: "Apple" });
  assert.equal(run(dom, "trusted_probe", { select: "control" }).ok, true, "label for");
  dom.document.elementFromPoint = () => dom.document.getElementById("wrap");
  run(dom, "select_start", { selector: "#li", text: "Apple" });
  assert.equal(run(dom, "trusted_probe", { select: "control" }).ok, true, "wrapping label");
});
