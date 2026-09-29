// Snapshot refs continue one counter per document, shared by every perch
// server driving the tab, so a ref from any earlier snapshot never names a row
// of a newer one: click, fill and eval_js all report it stale and touch nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

const HTML = `<button id=a onclick="window.clicked = (window.clicked || []).concat('a')">Alpha</button>
<button id=b onclick="window.clicked = (window.clicked || []).concat('b')">Beta</button>
<label for=t>Title</label><input id=t>
<label for=u>Note</label><input id=u>`;

function install(dom, daemons = DAEMONS) {
  const w = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/p", id: "t", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = DAEMONS.slow = w.daemon;
  if (daemons !== DAEMONS) daemons.fast = daemons.slow = w.daemon;
  w.reset();
  return w;
}
const text = (r) => r.content.find((c) => c.type === "text").text;
const rows = (s) => s.split("\n").slice(1).map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)]);
const refOf = (s, name) => {
  const row = rows(s).find(([, l]) => l.includes(JSON.stringify(name)));
  assert.ok(row, s);
  return row[0];
};
const STALE = (ref) => new RegExp(`ref ${ref} is stale or unknown`);

test("a ref from an earlier snapshot is stale for click, fill and eval_js; the newer snapshot's refs work", async () => {
  const dom = page(HTML);
  install(dom);
  const first = text(await handleCall("accessibility_snapshot", {}));
  // Reordered so the same row positions hold different elements.
  dom.document.body.insertBefore(dom.document.getElementById("b"), dom.document.getElementById("a"));
  dom.document.body.appendChild(dom.document.querySelector("label[for=t]"));
  dom.document.body.appendChild(dom.document.getElementById("t"));
  const second = text(await handleCall("accessibility_snapshot", {}));
  const oldA = refOf(first, "Alpha"), oldT = refOf(first, "Title");

  const c = await handleCall("click", { ref: oldA });
  assert.equal(c.isError, true, text(c));
  assert.match(text(c), STALE(oldA));
  const f = await handleCall("fill", { ref: oldT, text: "x" });
  assert.equal(f.isError, true, text(f));
  assert.match(text(f), STALE(oldT));
  const e = await handleCall("eval_js", { ref: oldA, script: "window.__ran = 1; return 1" });
  assert.equal(e.isError, true, text(e));
  assert.match(text(e), STALE(oldA));
  assert.equal(dom.clicked, undefined);
  assert.equal(dom.__ran, undefined);
  assert.equal(dom.document.getElementById("t").value, "");
  assert.equal(dom.document.getElementById("u").value, "");

  const ok = await handleCall("click", { ref: refOf(second, "Alpha") });
  assert.equal(ok.isError, undefined, text(ok));
  assert.equal(String(dom.clicked), "a");
  const fo = await handleCall("fill", { ref: refOf(second, "Title"), text: "x" });
  assert.equal(fo.isError, undefined, text(fo));
  assert.equal(dom.document.getElementById("t").value, "x");
});

test("another perch server's snapshot of the same tab makes this server's refs stale", async () => {
  const B = await import("../server.js?server-b");
  assert.notEqual(B.handleCall, handleCall);
  const dom = page(HTML);
  install(dom, B.DAEMONS);
  const mine = text(await handleCall("accessibility_snapshot", {}));
  const theirs = text(await B.handleCall("accessibility_snapshot", {}));
  const ref = refOf(mine, "Beta");
  assert.ok(!rows(theirs).some(([r]) => r === ref), theirs);
  const c = await handleCall("click", { ref });
  assert.equal(c.isError, true, text(c));
  assert.match(text(c), STALE(ref));
  const e = await handleCall("eval_js", { ref, script: "window.__ran = 1; return 1" });
  assert.match(text(e), STALE(ref));
  assert.equal(dom.clicked, undefined);
  assert.equal(dom.__ran, undefined);
  const ok = await B.handleCall("click", { ref: refOf(theirs, "Beta") });
  assert.equal(ok.isError, undefined, text(ok));
  assert.equal(String(dom.clicked), "b");
});

test("snapshots give disjoint short refs, and max caps the row count of every snapshot", () => {
  const dom = page(HTML + `<a href="/x">X</a><a href="/y">Y</a>`);
  const all = [];
  for (let i = 0; i < 3; i++) {
    const s = run(dom, "snapshot", { max: 3 });
    const head = JSON.parse(s.split("\n")[0].slice(2));
    assert.equal(head.count, 3, s);
    assert.equal(head.truncated, true, s);
    assert.equal(rows(s).length, 3, s);
    all.push(...rows(s).map(([r]) => r));
  }
  assert.equal(new Set(all).size, all.length, all.join(" "));
  for (const r of all) assert.match(r, /^\d{1,7}$/);
  const hidden = page(`<form><div><label for=h>Hidden req</label><input id=h required style="display:none"><button type=button>Enter manually</button></div><input></form>`);
  run(hidden, "snapshot", { max: 50 });
  // The role filter leaves the reveal button without a row of its own, so it gets one.
  const s = run(hidden, "snapshot", { max: 50, role: "textbox" });
  const m = /textbox "Hidden req".* hidden reveal="(\d+)"\n(\d+) button "Enter manually"/.exec(s);
  assert.ok(m && m[1] === m[2], s);
});

test("a new document's refs start away from low numbers an old caller holds", () => {
  const one = rows(run(page(HTML, { timeOrigin: 1790719663412.6 }), "snapshot", { max: 50 })).map(([r]) => r);
  const two = rows(run(page(HTML, { timeOrigin: 1790719668031.2 }), "snapshot", { max: 50 })).map(([r]) => r);
  assert.ok(one.every((r) => !two.includes(r)), one + " / " + two);
  assert.ok(!one.includes("1") && !two.includes("1"));
});

test("the snapshot page script is byte-identical across calls", async () => {
  const w = install(page(HTML));
  const sent = [];
  w.state.onExecute = (spec, js) => sent.push(js);
  await handleCall("accessibility_snapshot", {});
  await handleCall("accessibility_snapshot", {});
  const snaps = sent.filter((js) => js.includes("__perch_refs"));
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0], snaps[1]);
});

test("a page that sets the ref counter to garbage still gets distinct, resolvable refs", async () => {
  for (const bad of [NaN, Infinity, 1e21, -5, 2.5]) {
    const dom = page(HTML);
    dom.__perch_refN = bad;
    install(dom);
    const s = text(await handleCall("accessibility_snapshot", {}));
    const refs = rows(s).map(([r]) => r);
    assert.equal(new Set(refs).size, refs.length, `${bad}: ${s}`);
    const r = await handleCall("click", { ref: refOf(s, "Beta") });
    assert.ok(!r.isError, text(r));
    assert.deepEqual(dom.clicked, ["b"], String(bad));
  }
});
