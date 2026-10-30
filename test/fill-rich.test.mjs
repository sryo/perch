// fill into a rich editor (ProseMirror, Lexical, Draft.js, Slate) types through
// the browser's editing commands, so the editor's own model takes the text from
// the beforeinput/input they fire: each line as insertText, a line break as
// insertLineBreak, a blank line as insertParagraph. A DOM rewrite with a
// synthetic input event, which such editors re-render away, is the fallback
// only where the command is refused. An editor that renders a task later is
// read again in the same call. The whole text must be the text: one that never
// takes it, or keeps old text beside it, is ok:false.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

// An editor that keeps its text in a model, takes input only from beforeinput
// (preventDefault, then its own render, so no input event follows), and
// re-renders from the model a task after an input event, which reverts a
// direct DOM write.
// Each line renders as its own <p>. opts: lazy (render a task after the
// command), deaf (the command runs but the editor ignores it), refuse (the
// command is unsupported and returns false), stale (types at its old cursor,
// after the old text, whatever is selected). later(fn) queues a task.
const EDITOR = `<div id=ed contenteditable aria-label="Write a message"><p>old draft</p></div><button id=send disabled>Send</button>`;
const editorJs = (opts = {}) => `
  const ed = document.getElementById('ed');
  window.model = 'old draft'; window.cmds = [];
  const render = () => {
    while (ed.firstChild) ed.removeChild(ed.firstChild);
    window.model.split('\\n').forEach((l) => { const p = document.createElement('p'); p.textContent = l; ed.appendChild(p); });
    document.getElementById('send').disabled = !window.model.trim();
  };
  const all = () => { const s = document.getSelection(); if (!s.rangeCount) return false; const r = s.getRangeAt(0); return r.startContainer === ed && r.startOffset === 0 && r.endContainer === ed && r.endOffset === ed.childNodes.length && ed.childNodes.length > 0; };
  ed.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    ${opts.deaf ? "return;" : ""}
    ${opts.stale ? "" : "if (all()) window.model = '';"}
    const t = e.inputType;
    window.model += t === 'insertText' ? e.data : t === 'insertLineBreak' ? '\\n' : t === 'insertParagraph' ? '\\n\\n' : '';
    document.getSelection().collapse(ed, ed.childNodes.length);
    ${opts.lazy ? "later(render);" : "render();"}
  });
  ed.addEventListener('input', () => { later(render); });
  document.execCommand = (cmd, ui, value) => {
    window.cmds.push(value == null ? cmd : cmd + ':' + value);
    ${opts.refuse ? "return false;" : ""}
    const inputType = cmd === 'delete' ? 'deleteContentBackward' : cmd;
    ed.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data: cmd === 'insertText' ? value : null }));
    return true;
  };`;
const QUEUE = `window.__q = []; window.later = (fn) => { window.__q.push(fn); }; window.__tick = () => { const q = window.__q; window.__q = []; q.forEach((f) => f()); };`;
const MSG = "Hi Ana,\n\nThanks for the intro.\nTalk soon";

function editorPage(opts) {
  const w = page(EDITOR);
  w.eval(QUEUE + editorJs(opts));
  return w;
}

test("fill types into an editor that takes only beforeinput, and its model keeps the text", () => {
  const w = editorPage();
  const o = run(w, "fill", { label_pattern: "message", text: MSG });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.kind, "rich");
  w.__tick();
  assert.equal(w.model, MSG);
  assert.deepEqual([...w.cmds], ["insertText:Hi Ana,", "insertParagraph", "insertText:Thanks for the intro.", "insertLineBreak", "insertText:Talk soon"]);
  assert.equal(w.document.getElementById("send").disabled, false);
});

test("fill clears a rich editor with the delete command", () => {
  const w = editorPage();
  const o = run(w, "fill", { selector: "#ed", text: "" });
  assert.equal(o.ok, true, JSON.stringify(o));
  w.__tick();
  assert.equal(w.model, "");
  assert.deepEqual([...w.cmds], ["delete"]);
});

test("fill falls back to writing the DOM when the editing command is refused", () => {
  const w = editorPage({ refuse: true });
  const o = run(w, "fill", { selector: "#ed", text: "Hello there" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(w.document.getElementById("ed").textContent, "Hello there");
  assert.deepEqual([...w.cmds], ["insertText:Hello there"]);
});

// ---- through the server: the in-call re-read and the late check ----

function onPage(opts) {
  const dom = page(EDITOR);
  dom.eval(QUEUE + editorJs(opts));
  const ev = dom.eval.bind(dom);
  dom.eval = (js) => { dom.__tick(); return ev(js); };
  const world = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }], cg: [{ owner: "Google Chrome" }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return { dom, world };
}
const call = async (name, args = {}) => {
  const r = await handleCall(name, args);
  const texts = r.content.filter((c) => c.type === "text").map((c) => c.text);
  const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
  return { o: parse(texts[0]), rest: texts.slice(1).map(parse) };
};
const execs = (world) => (world.counts["tab.execute"] || 0) + (world.counts["doJavaScript"] || 0);

test("fill into an editor that renders synchronously costs one page run", async () => {
  const { dom, world } = onPage();
  const f = await call("fill", { label_pattern: "message", text: MSG });
  assert.equal(f.o.ok, true, JSON.stringify(f.o));
  assert.equal(execs(world), 1);
  const next = await call("get_text", { selector: "#ed" });
  assert.equal(next.o.late, undefined, JSON.stringify(next));
  assert.equal(dom.model, MSG);
});

test("fill into an editor that renders a task later is read again in the same call", async () => {
  const { dom, world } = onPage({ lazy: true });
  const f = await call("fill", { label_pattern: "message", text: MSG });
  assert.deepEqual(f.o, { ok: true, kind: "rich", el: `textbox "Write a message"`, len: MSG.length });
  assert.equal(execs(world), 2);
  assert.equal(dom.model, MSG);
});

test("fill into an editor that ignores the typed text is ok:false and names what it kept", async () => {
  const { dom } = onPage({ deaf: true });
  const f = await call("fill", { label_pattern: "message", text: MSG });
  assert.equal(f.o.ok, false, JSON.stringify(f.o));
  assert.equal(f.o.reverted, true);
  assert.equal(f.o.kept, "old draft");
  assert.doesNotMatch(f.o.error, /trusted/, "trusted fill takes no rich editor");
  assert.equal(dom.model, "old draft");
});

test("fill {trusted:true} on a rich editor points to plain fill", async () => {
  onPage();
  const f = await call("fill", { selector: "#ed", text: "Hi", trusted: true });
  assert.equal(f.o.ok, false);
  assert.match(f.o.error, /trusted fill takes inputs\/textareas only; use plain fill$/);
});

test("fill {fields}: a rich editor that renders later passes its re-read, one that ignores the text fails it", async () => {
  const lazy = onPage({ lazy: true });
  const ok = await call("fill", { fields: [{ label_pattern: "message", text: MSG }] });
  assert.equal(ok.o.ok, true, JSON.stringify(ok.o));
  assert.equal(ok.o.results[0].unseen, undefined);
  assert.equal(lazy.dom.model, MSG);
  onPage({ deaf: true });
  const no = await call("fill", { fields: [{ label_pattern: "message", text: MSG }] });
  assert.equal(no.o.ok, false, JSON.stringify(no.o));
  assert.equal(no.o.results[0].reverted, true);
  assert.doesNotMatch(no.o.results[0].error, /trusted/);
});

// Draft.js-style: the editor tracks its own selection and types at the cursor
// it last saw, so the old text stays in front of the new. Holding the text is
// not enough; the whole text must be it.
test("fill into an editor that types at a stale cursor is ok:false and names what it holds", () => {
  const w = editorPage({ stale: true });
  const o = run(w, "fill", { label_pattern: "message", text: "Hi Ana" });
  assert.deepEqual(o, { ok: false, kind: "rich", el: `textbox "Write a message"`, kept: "old draftHi Ana", error: `textbox "Write a message" holds "old draftHi Ana" instead of the text` });
});

test("fill into a stale-cursor editor that renders a task later fails its in-call re-read", async () => {
  onPage({ stale: true, lazy: true });
  const f = await call("fill", { label_pattern: "message", text: "Hi Ana" });
  assert.equal(f.o.ok, false, JSON.stringify(f.o));
  assert.equal(f.o.kind, "rich");
  assert.equal(f.o.kept, "old draftHi Ana");
  assert.match(f.o.error, /another value replaced it$/);
});

test("fill {fields}: a stale-cursor editor fails its slot", async () => {
  onPage({ stale: true });
  const f = await call("fill", { fields: [{ label_pattern: "message", text: "Hi Ana" }] });
  assert.equal(f.o.ok, false, JSON.stringify(f.o));
  assert.equal(f.o.results[0].kept, "old draftHi Ana");
});

test("fill: an editor that renders later on a browser with no bounded re-read is ok:false and checked by the next call", async () => {
  const { world } = onPage({ deaf: true });
  world.state.hangIf = (js) => js.includes("items = m && m[A.tok]");
  const f = await call("fill", { label_pattern: "message", text: MSG });
  assert.equal(f.o.ok, false, JSON.stringify(f.o));
  assert.match(f.o.error, /had not shown it yet; read it back with get_text/);
  world.state.hangIf = null;
  const next = await call("get_text", { selector: "#ed" });
  assert.deepEqual(next.o.late || next.rest.map((x) => x && x.late).find(Boolean), [{ el: `textbox "Write a message"`, error: `changed to "old draft" after it was filled; the page reverted the write` }]);
});
