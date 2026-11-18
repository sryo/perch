// eval_js result shaping: a script that is one expression returns its value
// with no `return` (Node checks the parse; nothing runs), and a value JSON can't
// carry comes back readable: an element as `<tag#id.class> text`, a NodeList or
// Set as an array, a Map as an object, an object met again as "[seen]" instead
// of a circular-structure error. Strings and numbers pass as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, composeEvalScript, buildKick } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

function onPage(html) {
  const dom = page(html, { url: "https://a.test/p" });
  dom.document.title = "Shop";
  const world = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 7, active: 0, tabs: [{ url: "https://a.test/p", id: "x", dom }] }] }], cg: [{ owner: "Google Chrome" }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = DAEMONS.slow = DAEMONS.long = world.daemon;
  world.reset();
  return { dom, world };
}
const ev = async (script, extra = {}) => {
  const r = await handleCall("eval_js", { target: { tabId: "chrome:x" }, script, ...extra });
  const t = r.content[0].text;
  let v = t; if (!r.isError) try { v = JSON.parse(t); } catch {} return { r, v };
};

test("a lone expression returns its value; statements and return work as before", async () => {
  onPage(`<p>x</p>`);
  assert.equal((await ev("document.title")).v, "Shop");
  assert.equal((await ev("document.title;\n")).v, "Shop");
  assert.equal((await ev("// the title\ndocument.title // trailing")).v, "Shop");
  assert.deepEqual((await ev("{ a: 1, b: [2] }")).v, { a: 1, b: [2] });
  assert.equal((await ev("return document.title")).v, "Shop");
  assert.equal((await ev("const t = document.title; return t + '!'")).v, "Shop!");
  assert.equal((await ev("document.title; 5")).v, null, "two statements stay a body");
  // awaitPromise: the kick, run against a stand-in window, shapes the settled value too.
  for (const [script, want] of [["await Promise.resolve(4)", 4], ["const m = new Map([['k', await 1]]); return m", { k: 1 }]]) {
    const w = {}, kick = buildKick(await composeEvalScript({ script, awaitPromise: true }), "K", { awaitPromise: true, shape: true });
    new Function("window", "return " + kick)(w);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(w.K, { value: want }, script);
  }
});

test("elements, node lists, sets, maps and repeated objects come back readable", async () => {
  onPage(`<button id=go class="btn primary">Pay now</button><a href=/x>X</a><input name=q value=hi>`);
  assert.equal((await ev("document.getElementById('go')")).v, `<button#go.btn.primary> Pay now`);
  assert.deepEqual((await ev("document.querySelectorAll('a, input')")).v, [`<a> X`, `<input name=q>`]);
  assert.deepEqual((await ev("new Set([1, 2])")).v, [1, 2]);
  assert.deepEqual((await ev("new Map([['a', 1]])")).v, { a: 1 });
  assert.deepEqual((await ev("const o = { n: 1 }; o.self = o; return o")).v, { n: 1, self: "[seen]" });
  assert.deepEqual((await ev("return { el: document.querySelector('a'), n: 3 }")).v, { el: "<a> X", n: 3 });
  assert.equal((await ev("return 'plain'")).v, "plain");
});

test("the composed source is byte-identical across calls with the same script", async () => {
  const a = await composeEvalScript({ script: "document.title" }), b = await composeEvalScript({ script: "document.title" });
  assert.equal(a, b);
});
