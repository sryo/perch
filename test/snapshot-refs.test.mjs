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
    assert.equal(JSON.stringify(dom.clicked), JSON.stringify(["b"]), String(bad));
  }
});

// A seeded generator, so the sweep is the same on every run.
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Rows alternate a button and a text field, so a stray ref can land on either.
const rowsHtml = (k, tag) => Array.from({ length: k }, (_, i) => i % 2
  ? `<label for=${tag}${i}>${tag} field ${i}</label><input id=${tag}${i}>`
  : `<button id=${tag}${i} onclick="window.clicked = (window.clicked || []).concat(this.id)">${tag} ${i}</button>`).join("");

test("a ref from the tab's previous document misses on the next one, even where the two ref ranges overlap", async () => {
  // The page seeds its counter from timeOrigin % 900, so two documents' ranges
  // overlap often. The sweep picks the overlapping pairs; the full calls run on a sample.
  const rnd = prng(37), seed = (t) => Math.floor(t % 900);
  const pairs = [];
  for (let i = 0; i < 2000; i++) {
    const t1 = 1790000000000 + rnd() * 1e9, t2 = t1 + 1000 + rnd() * 1e7;
    const k1 = 100 + Math.floor(rnd() * 201), k2 = 100 + Math.floor(rnd() * 201);
    const a = seed(t1), b = seed(t2);
    if (a < b + k2 && b < a + k1) pairs.push({ t1, t2, k1, k2 });
  }
  assert.ok(pairs.length > 400, `only ${pairs.length} of 2000 pairs overlap`);
  for (const { t1, t2, k1, k2 } of pairs.slice(0, 12)) {
    const spec = { url: "https://a.test/p", id: "t", dom: page(rowsHtml(k1, "a"), { timeOrigin: t1 }) };
    const w = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [spec] }] }], cg: [{ owner: "Google Chrome" }] });
    w.run(JXA_PRELUDE);
    DAEMONS.fast = DAEMONS.slow = w.daemon;
    w.reset();
    const one = rows(text(await handleCall("accessibility_snapshot", { max: 1000 }))).map(([r]) => r);
    assert.equal(one.length, k1);
    const pageOne = Object.keys(spec.dom.__perch_refs);
    const doc2 = spec.dom = page(rowsHtml(k2, "b"), { timeOrigin: t2 });
    const two = rows(text(await handleCall("accessibility_snapshot", { max: 1000 }))).map(([r]) => r);
    assert.equal(two.length, k2);
    assert.ok(pageOne.some((r) => Object.hasOwn(doc2.__perch_refs, r)), "the page's two maps should share refs");
    assert.ok(!one.some((r) => two.includes(r)), "a ref shown before is shown under a new number");
    for (const ref of one) {
      for (const [tool, args] of [["click", { ref }], ["fill", { ref, text: "x" }], ["eval_js", { ref, script: "window.__ran = (window.__ran || 0) + 1; return 1" }]]) {
        const r = await handleCall(tool, args);
        assert.equal(r.isError, true, `${tool} ${ref}: ${text(r)}`);
        assert.match(text(r), STALE(ref));
      }
    }
    assert.equal(doc2.clicked, undefined);
    assert.equal(doc2.__ran, undefined);
    assert.ok(Array.from(doc2.document.querySelectorAll("input")).every((el) => el.value === ""));
  }
});

test("a server that took no snapshot of the tab reports a ref stale without running page JS", async () => {
  const C = await import("../server.js?server-c");
  const dom = page(HTML);
  const w = install(dom, C.DAEMONS);
  const ref = refOf(text(await handleCall("accessibility_snapshot", {})), "Beta");
  let execs = 0;
  w.state.onExecute = () => { execs++; };
  for (const [tool, args] of [["click", { ref }], ["click", { ref, trusted: true }], ["fill", { ref, text: "x" }], ["select", { ref, text: "x" }],
    ["eval_js", { ref, script: "window.__ran = 1; return 1" }], ["get_text", { ref }], ["press", { ref, key: "Enter" }], ["screenshot", { ref }]]) {
    const r = await C.handleCall(tool, args);
    assert.equal(r.isError, true, `${tool}: ${text(r)}`);
    assert.match(text(r), STALE(ref), tool);
  }
  assert.equal(execs, 0);
  assert.equal(dom.clicked, undefined);
  assert.equal(dom.__ran, undefined);
  // In fill {fields}, that ref fails its own field, and the rest still fill.
  const f = JSON.parse(text(await C.handleCall("fill", { fields: [{ ref, text: "x" }, { label_pattern: "note", text: "y" }] })));
  assert.equal(f.results[0].ok, false);
  assert.match(f.results[0].error, STALE(ref));
  assert.equal(f.results[1].ok, true, JSON.stringify(f));
  assert.equal(dom.document.getElementById("t").value, "");
  assert.equal(dom.document.getElementById("u").value, "y");
});

test("a ref from before the tab loaded a new document misses there, though that page's map lists the same ref", async () => {
  const B = await import("../server.js?server-b");
  const spec = { url: "https://a.test/p", id: "t", dom: page(HTML) };
  const w = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [spec] }] }], cg: [{ owner: "Google Chrome" }] });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = DAEMONS.slow = B.DAEMONS.fast = B.DAEMONS.slow = w.daemon;
  w.reset();
  const s = text(await handleCall("accessibility_snapshot", {}));
  const ref = refOf(s, "Beta"), inPage = Object.keys(spec.dom.__perch_refs).find((k) => spec.dom.__perch_refs[k].id === "b");
  const doc2 = spec.dom = page(HTML);
  await B.handleCall("accessibility_snapshot", {});
  assert.equal(doc2.__perch_refs[inPage].id, "b", "the new page's map has the old ref's key");
  for (const [tool, args] of [["click", { ref }], ["fill", { ref, text: "x" }], ["eval_js", { ref, script: "window.__ran = 1; return 1" }], ["click", { ref, readback: "#b" }]]) {
    const r = await handleCall(tool, args);
    assert.match(text(r), STALE(ref), tool);
  }
  assert.equal(doc2.clicked, undefined);
  assert.equal(doc2.__ran, undefined);
});

test("a ref keeps to the tab its snapshot named, and a renumbered row still resolves", async () => {
  const one = page(HTML), two = page(HTML);
  two.document.getElementById("t").focus();
  const w = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/p", id: "t1", dom: one }, { url: "https://a.test/q", id: "t2", dom: two }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = DAEMONS.slow = w.daemon;
  w.reset();
  const s1 = text(await handleCall("accessibility_snapshot", { target: { tabId: "chrome:t1" } }));
  const s2 = text(await handleCall("accessibility_snapshot", { target: { tabId: "chrome:t2" } }));
  const ref = refOf(s1, "Beta");
  const miss = await handleCall("click", { ref, target: { tabId: "chrome:t2" } });
  assert.match(text(miss), STALE(ref));
  assert.equal(two.clicked, undefined);
  assert.equal(JSON.parse(s2.split("\n")[0].slice(2)).focus, refOf(s2, "Title"));
  const b2 = await handleCall("click", { ref: refOf(s2, "Beta"), target: { tabId: "chrome:t2" } });
  assert.equal(b2.isError, undefined, text(b2));
  assert.equal(String(two.clicked), "b");
  const ok = await handleCall("click", { ref, target: { tabId: "chrome:t1" } });
  assert.equal(ok.isError, undefined, text(ok));
  assert.equal(String(one.clicked), "b");
});

test("the snapshot's map id stays out of the reply, and two clicks on one ref send the same source", async () => {
  const w = install(page(HTML));
  const s = text(await handleCall("accessibility_snapshot", {}));
  assert.deepEqual(Object.keys(JSON.parse(s.split("\n")[0].slice(2))), ["url", "title", "ready", "count"]);
  const sent = [];
  w.state.onExecute = (spec, js) => sent.push(js);
  const ref = refOf(s, "Alpha");
  await handleCall("click", { ref });
  await handleCall("click", { ref });
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
});
