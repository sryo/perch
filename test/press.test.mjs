// press {key} and click {hover}: synthetic keyboard and pointer events that
// work in background tabs. Page scripts run in happy-dom; the Node wiring runs
// through the real JXA runtime against a fake world.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, parseKey } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };

test("parseKey: named keys, characters and chords", () => {
  const table = [
    ["Enter", { key: "Enter", code: "Enter", keyCode: 13 }],
    ["escape", { key: "Escape", code: "Escape", keyCode: 27 }],
    ["Tab", { key: "Tab", code: "Tab", keyCode: 9 }],
    ["Backspace", { key: "Backspace", code: "Backspace", keyCode: 8 }],
    ["Delete", { key: "Delete", code: "Delete", keyCode: 46 }],
    ["Space", { key: " ", code: "Space", keyCode: 32 }],
    ["ArrowDown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }],
    ["ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }],
    ["Home", { key: "Home", code: "Home", keyCode: 36 }],
    ["PageDown", { key: "PageDown", code: "PageDown", keyCode: 34 }],
    ["F5", { key: "F5", code: "F5", keyCode: 116 }],
    ["F12", { key: "F12", code: "F12", keyCode: 123 }],
    ["a", { key: "a", code: "KeyA", keyCode: 65 }],
    ["7", { key: "7", code: "Digit7", keyCode: 55 }],
    ["/", { key: "/", code: "", keyCode: 0 }],
  ];
  for (const [chord, want] of table) assert.deepEqual(parseKey(chord), { ...want, ...mods }, chord);
  assert.deepEqual(parseKey("cmd+k"), { key: "k", code: "KeyK", keyCode: 75, ...mods, metaKey: true });
  assert.deepEqual(parseKey("Ctrl+Shift+A"), { key: "A", code: "KeyA", keyCode: 65, ...mods, ctrlKey: true, shiftKey: true });
  assert.deepEqual(parseKey("option+meta+Enter"), { key: "Enter", code: "Enter", keyCode: 13, ...mods, altKey: true, metaKey: true });
  assert.deepEqual(parseKey("shift+Tab"), { key: "Tab", code: "Tab", keyCode: 9, ...mods, shiftKey: true });
  assert.equal(parseKey("cmd++").key, "+");
  for (const bad of ["", "Enterr", "cmd+", "cmd+a+b", "hyper+a", "F13", undefined]) {
    assert.throws(() => parseKey(bad), /^Error: press: unknown key/, String(bad));
  }
});

const press = (w, chord, A = {}) => run(w, "press", { ...A, ...parseKey(chord) });

test("Enter in a form field submits the form", () => {
  const w = page(`<form id=f><input id=q name=q></form>`);
  let submits = 0;
  w.document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
  const o = press(w, "Enter", { selector: "#q" });
  assert.deepEqual(o, { ok: true, el: `textbox "q"`, prevented: false, focus: `textbox "q"` });
  assert.equal(submits, 1);
});

test("Enter in a form with a submit button clicks it, as implicit submission does", () => {
  const w = page(`<form id=f><input id=q><button id=go>Go</button></form>`);
  const seen = [];
  w.document.getElementById("go").addEventListener("click", () => seen.push("click"));
  w.document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); seen.push("submit"); });
  press(w, "Enter", { selector: "#q" });
  assert.deepEqual(seen, ["click", "submit"]);
});

test("a prevented keydown skips the default action", () => {
  const w = page(`<form id=f><input id=q></form>`);
  let submits = 0;
  w.document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
  w.document.getElementById("q").addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  assert.equal(press(w, "Enter", { selector: "#q" }).prevented, true);
  assert.equal(submits, 0);
});

test("Enter and Space activate buttons and links", () => {
  const w = page(`<button id=b>Open</button><a id=l href="#x">Docs</a>`);
  const clicks = [];
  w.document.getElementById("b").addEventListener("click", () => clicks.push("b"));
  w.document.getElementById("l").addEventListener("click", (e) => { e.preventDefault(); clicks.push("l"); });
  press(w, "Enter", { selector: "#b" });
  press(w, "Space", { selector: "#b" });
  press(w, "Enter", { selector: "#l" });
  assert.deepEqual(clicks, ["b", "b", "l"]);
});

test("Escape reaches a document keydown listener with key, code and keyCode; keyup follows", () => {
  const w = page(`<div role=dialog id=d>Modal</div>`);
  const seen = [];
  const log = (e) => seen.push([e.type, e.key, e.code, e.keyCode, e.bubbles, e.composed]);
  w.document.addEventListener("keydown", log);
  w.document.addEventListener("keypress", log);
  w.document.addEventListener("keyup", log);
  const o = press(w, "Escape");
  assert.equal(o.ok, true);
  assert.deepEqual(seen, [["keydown", "Escape", "Escape", 27, true, true], ["keyup", "Escape", "Escape", 27, true, true]]);
});

test("printable keys fire keypress; chords with cmd or ctrl do not", () => {
  const w = page(`<input id=q>`);
  const types = [];
  for (const t of ["keydown", "keypress", "keyup"]) w.document.addEventListener(t, (e) => types.push(t + ":" + e.key + (e.metaKey ? "+meta" : "")));
  press(w, "a", { selector: "#q" });
  press(w, "cmd+k", { selector: "#q" });
  assert.deepEqual(types, ["keydown:a", "keypress:a", "keyup:a", "keydown:k+meta", "keyup:k+meta"]);
});

test("Tab and shift+Tab move focus between visible tabbable elements", () => {
  const w = page(`<input id=a><button id=h hidden>Hidden</button><button id=b>B</button><span tabindex=-1 id=n>N</span><button id=c disabled>C</button><a id=d href=#>D</a>`);
  w.document.getElementById("a").focus();
  assert.equal(press(w, "Tab").focus, `button "B"`);
  assert.equal(press(w, "Tab").focus, `link "D"`);
  assert.equal(press(w, "Tab").focus, `textbox ""`, "wraps to the first");
  assert.equal(press(w, "shift+Tab").focus, `link "D"`);
});

test("press reports a stale ref and a missing selector like other element tools", () => {
  const w = page(`<input id=q>`);
  assert.deepEqual(press(w, "Enter", { ref: "9" }), { __perch_ref_miss: true, ref: "9" });
  assert.deepEqual(press(w, "Enter", { selector: "#nope" }), { ok: false, error: "no element for selector #nope" });
});

test("hover fires pointer and mouse over/enter/move at the element center", () => {
  const w = page(`<nav><div id=m>Products</div><ul id=menu hidden><li>Item</li></ul></nav>`);
  const seen = [];
  const m = w.document.getElementById("m");
  for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove", "click"]) {
    m.addEventListener(t, (e) => seen.push(t + "@" + e.clientX + "," + e.clientY));
  }
  m.addEventListener("mouseenter", () => { w.document.getElementById("menu").hidden = false; });
  let delegated = 0, leaked = 0;
  w.document.addEventListener("mouseover", () => delegated++);
  w.document.addEventListener("mouseenter", () => leaked++);
  w.document.addEventListener("pointerenter", () => leaked++);
  assert.deepEqual(run(w, "hover", { selector: "#m" }), { ok: true, el: `generic "Products"` });
  assert.deepEqual(seen, ["pointerover@50,10", "pointerenter@50,10", "mouseover@50,10", "mouseenter@50,10", "pointermove@50,10", "mousemove@50,10"]);
  assert.equal(w.document.getElementById("menu").hidden, false);
  assert.equal(delegated, 1, "mouseover bubbles for delegated menus");
  assert.equal(leaked, 0, "enter events don't bubble");
});

function onPage(html) {
  const dom = page(html);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return dom;
}
const call = async (name, args) => {
  const r = await handleCall(name, args);
  return { err: r.isError, text: r.content[0].text };
};

test("press tool: parses the chord in Node and runs in the page", async () => {
  const dom = onPage(`<input id=q>`);
  let got;
  dom.document.addEventListener("keydown", (e) => { got = [e.key, e.metaKey]; });
  const r = await call("press", { key: "cmd+k", selector: "#q" });
  assert.equal(r.err, undefined, r.text);
  assert.deepEqual(JSON.parse(r.text), { ok: true, el: `textbox ""`, prevented: false, focus: `textbox ""` });
  assert.deepEqual(got, ["k", true]);
});

test("press tool: a bad or missing key errors before touching the page", async () => {
  onPage(`<input id=q>`);
  assert.deepEqual(await call("press", { key: "Entr" }), { err: true, text: "error: press: unknown key Entr" });
  assert.deepEqual(await call("press", {}), { err: true, text: "error: press: unknown key undefined" });
});

test("click {hover}: hovers without clicking; refuses trusted, readback and x/y", async () => {
  const dom = onPage(`<div id=m>Menu</div>`);
  let clicks = 0, enters = 0;
  dom.document.getElementById("m").addEventListener("click", () => clicks++);
  dom.document.getElementById("m").addEventListener("mouseenter", () => enters++);
  const r = await call("click", { selector: "#m", hover: true });
  assert.deepEqual(JSON.parse(r.text), { ok: true, el: `generic "Menu"` });
  assert.deepEqual([clicks, enters], [0, 1]);
  for (const extra of [{ trusted: true }, { readback: "#m" }, { x: 1, y: 2 }]) {
    assert.deepEqual(await call("click", { selector: "#m", hover: true, ...extra }), { err: true, text: "error: click: hover is untrusted and element-only" });
  }
  assert.equal(enters, 1);
});
