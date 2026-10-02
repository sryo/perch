// fill {trusted:true, label_pattern} resolves its field by plain fill's
// ranking: a clear best match wins, and two fields each named by their own
// label with neither favoured (the tie only_empty skips) get no typing at all
// (ambiguous:true, candidates), on the background route, the raised route and
// a fill {fields} trusted entry alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

const NAMES = `<label>First name <input id=a></label><label>Last name <input id=b></label>`;
const EMAILS = `<label>Confirm email <input id=c></label><label>Email <input id=e></label>`;
const METRICS = { screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 };

function install(spec) {
  const world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
function metrics(w) {
  for (const [k, v] of Object.entries(METRICS)) Object.defineProperty(w, k, { value: v, configurable: true });
}
// The editing command a background trusted fill uses, landing as trusted input.
function trustedEdits(dom) {
  dom.document.execCommand = (_command, _ui, text) => {
    const el = dom.document.activeElement;
    el.value = text;
    const event = new dom.Event("input", { bubbles: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    el.dispatchEvent(event);
    return true;
  };
}
// Terminal in front, the page's tab shown: fill {trusted} without raise.
function background(html) {
  const dom = page(html);
  metrics(dom);
  trustedEdits(dom);
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600 }],
  });
  return { dom, world };
}
// The browser in front: fill {trusted, raise}, keystrokes typed into the focused field.
function raised(html) {
  const dom = page(html);
  metrics(dom);
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 798, h: 500 }] } }],
  });
  return { dom, world };
}
const call = async (args) => {
  const r = await handleCall("fill", args);
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};
const values = (dom) => Array.from(dom.document.querySelectorAll("input"), (el) => el.value);

test("background trusted fill refuses a label tie and types nothing", async () => {
  const { dom, world } = background(NAMES);
  const o = await call({ trusted: true, label_pattern: "name", text: "Doe" });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.ambiguous, true);
  assert.deepEqual(o.candidates, ['textbox "First name"', 'textbox "Last name"']);
  assert.match(o.error, /^several fields matched \/name\/i equally/);
  assert.deepEqual(values(dom), ["", ""]);
  assert.equal(world.posted.length, 0);
});

test("raised trusted fill refuses a label tie before posting anything", async () => {
  const { dom, world } = raised(NAMES);
  const o = await call({ trusted: true, raise: true, label_pattern: "name", text: "Doe", target: { tabIndex: 1 } });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.ambiguous, true);
  assert.deepEqual(o.candidates, ['textbox "First name"', 'textbox "Last name"']);
  assert.deepEqual(values(dom), ["", ""]);
  assert.deepEqual(world.posted, []);
});

test("trusted fill refuses the tie plain fill guesses at, and follows its ranking where there is none", async () => {
  const plain = run(page(EMAILS), "fill", { label_pattern: "email", text: "a@b.test" });
  assert.deepEqual(plain.ambiguous, ['textbox "Confirm email"', 'textbox "Email"'], "plain fill writes the first and flags the pair");
  const { dom } = background(EMAILS);
  const tie = await call({ trusted: true, label_pattern: "email", text: "a@b.test" });
  assert.equal(tie.ok, false, JSON.stringify(tie));
  assert.deepEqual(tie.candidates, ['textbox "Confirm email"', 'textbox "Email"']);
  assert.deepEqual(values(dom), ["", ""]);
  const o = await call({ trusted: true, label_pattern: "^email$", text: "a@b.test" });
  assert.deepEqual(o, { ok: true, trusted: true, value: "a@b.test", el: 'textbox "Email"' });
  assert.deepEqual(values(dom), ["", "a@b.test"]);
});

test("raised trusted fill types into the field plain fill's ranking picks", async () => {
  const { dom, world } = raised(EMAILS);
  world.state.onPost = (e) => {
    if (e.type === 1) dom.document.getElementById("e").dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true }));
    if (e.kind === "key" && e.down) dom.document.getElementById("e").value += e.text;
  };
  const o = await call({ trusted: true, raise: true, label_pattern: "^email$", text: "a@b.test", target: { tabIndex: 1 } });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.el, 'textbox "Email"');
  assert.deepEqual(values(dom), ["", "a@b.test"]);
});

test("trusted fill by a label only one field carries still types into it", async () => {
  const { dom } = background(NAMES);
  const o = await call({ trusted: true, label_pattern: "last", text: "Doe" });
  assert.deepEqual(o, { ok: true, trusted: true, value: "Doe", el: 'textbox "Last name"' });
  assert.deepEqual(values(dom), ["", "Doe"]);
  // A visible match still outranks a hidden one, as in plain fill.
  const h = background(`<label>Phone <input id=h hidden></label><label>Phone <input id=p></label>`);
  assert.equal((await call({ trusted: true, label_pattern: "phone", text: "555" })).ok, true);
  assert.deepEqual(values(h.dom), ["", "555"]);
});

test("a no-match trusted fill answers plain fill's miss", async () => {
  background(NAMES);
  const o = await call({ trusted: true, label_pattern: "email", text: "Doe" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^no fillable field matched \/email\/i/);
});

test("trusted fill by label refuses a rich editor its ranking picks", async () => {
  background(`<div contenteditable aria-label="Email body"></div>`);
  const o = await call({ trusted: true, label_pattern: "email", text: "Hi" });
  assert.equal(o.ok, false);
  assert.match(o.error, /plain inputs\/textareas only$/);
});

test("raised trusted fill by label never clears a read-only field its ranking picks", async () => {
  const { dom, world } = raised(`<label>Email <input id=e readonly value=kept@b.test></label>`);
  const o = await call({ trusted: true, raise: true, label_pattern: "email", text: "a@b.test", target: { tabIndex: 1 } });
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /is disabled or read-only$/);
  assert.deepEqual(values(dom), ["kept@b.test"]);
  assert.equal(world.posted.filter((e) => e.kind === "key").length, 0);
});

test("fill {fields}: a trusted entry with a label tie refuses, and only_empty skips it", () => {
  const w = page(NAMES);
  const f = [{ label_pattern: "name", text: "Doe", trusted: true }];
  const o = run(w, "fill_fields", { fields: f });
  assert.equal(o.defer, undefined, "nothing held for typing");
  assert.equal(o.results[0].ok, false);
  assert.equal(o.results[0].ambiguous, true);
  assert.deepEqual(o.results[0].candidates, ['textbox "First name"', 'textbox "Last name"']);
  const s = run(w, "fill_fields", { fields: f, only: true });
  assert.deepEqual(s.results[0], { ok: true, skipped: "ambiguous", candidates: ['textbox "First name"', 'textbox "Last name"'], kind: "text" });
  assert.equal(w.__perch_ta, undefined);
});
