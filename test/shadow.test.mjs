// Open shadow roots in the snapshot, selector resolution and label search, plus
// the snapshot's query filter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCall } from "../server.js";
import { page, run, runBody } from "./helpers/page.mjs";

// <x-outer> holds a button in its shadow root, and an <x-inner> whose own shadow
// root holds a labelled input and a button. The closed root must stay hidden.
function shadowPage() {
  const w = page(`<button>Light</button><x-outer></x-outer><x-closed></x-closed><a href="/after">After</a>`);
  const d = w.document;
  const outer = d.querySelector("x-outer").attachShadow({ mode: "open" });
  outer.innerHTML = `<button id=ob>Outer</button><x-inner></x-inner>`;
  const inner = outer.querySelector("x-inner").attachShadow({ mode: "open" });
  inner.innerHTML = `<span id=lbl>Work email</span><input id=em aria-labelledby=lbl><button id=deep>Deep</button>`;
  d.querySelector("x-closed").attachShadow({ mode: "closed" }).innerHTML = `<button>Secret</button>`;
  inner.getElementById("deep").addEventListener("click", () => { w.clicked = (w.clicked || 0) + 1; });
  return { w, inner };
}

const lines = (out) => out.split("\n").slice(1);
const head = (out) => JSON.parse(out.split("\n")[0].slice(2));

test("deepAll walks open shadow roots in document order", () => {
  const { w } = shadowPage();
  assert.deepEqual(runBody(w, `return deepAll("button").map(b => b.textContent)`), ["Light", "Outer", "Deep"]);
});

test("snapshot lists elements inside nested open shadow roots, and a ref clicks one", () => {
  const { w } = shadowPage();
  const out = run(w, "snapshot", { max: 500 });
  assert.deepEqual(lines(out), [
    `1 button "Light"`,
    `2 button "Outer"`,
    `3 textbox "Work email"`,
    `4 button "Deep"`,
    `5 link "After" href="/after"`,
  ]);
  assert.equal(run(w, "click", { ref: "4" }).ok, true);
  assert.equal(w.clicked, 1);
});

test("snapshot focus names an element focused inside a shadow root", () => {
  const { w, inner } = shadowPage();
  inner.getElementById("em").focus();
  assert.equal(head(run(w, "snapshot", { max: 500 })).focus, "3");
});

test("a selector that misses the document falls back to open shadow roots", () => {
  const { w } = shadowPage();
  assert.equal(runBody(w, `return resolveEl({ selector: "#deep" }).el.textContent`), "Deep");
  assert.equal(runBody(w, `return resolveEl({ selector: "button" }).el.textContent`), "Light");
  assert.match(runBody(w, `return resolveEl({ selector: "#nope" }).out.error`), /no element for selector/);
});

test("fill finds a field by its aria-labelledby label inside a shadow root", () => {
  const { w, inner } = shadowPage();
  const o = run(w, "fill", { label_pattern: "work email", text: "a@b.c" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.el, `textbox "Work email"`);
  assert.equal(inner.getElementById("em").value, "a@b.c");
});

test("query keeps matching lines, numbers refs over them, and reports matched", () => {
  const { w } = shadowPage();
  const out = run(w, "snapshot", { max: 500, query: "button.*(outer|deep)" });
  assert.deepEqual(lines(out), [`1 button "Outer"`, `2 button "Deep"`]);
  assert.equal(head(out).count, 2);
  assert.equal(head(out).matched, 2);
  assert.equal(runBody(w, `return window.__perch_refs['2'].id`), "deep");
  assert.equal(head(run(w, "snapshot", { max: 500 })).matched, undefined);
});

test("query matches keys but not the ref, and max caps the emitted lines", () => {
  const { w } = shadowPage();
  assert.deepEqual(lines(run(w, "snapshot", { max: 500, query: "href=\"/after" })), [`1 link "After" href="/after"`]);
  assert.deepEqual(lines(run(w, "snapshot", { max: 500, query: "^4" })), []);
  const capped = run(w, "snapshot", { max: 1, query: "button" });
  // Refs continue from the first snapshot's one row.
  assert.deepEqual(lines(capped), [`2 button "Light"`]);
  assert.deepEqual([head(capped).count, head(capped).matched, head(capped).truncated], [1, 3, true]);
});

test("a bad query regex errors in Node before reaching the page", async () => {
  const r = await handleCall("accessibility_snapshot", { query: "(" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /accessibility_snapshot: invalid query/);
});
