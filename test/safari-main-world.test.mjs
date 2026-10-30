// Safari runs Apple Events JS in the page's own world, so eval_js {world:"main"}
// on a Safari tab runs as a plain eval: one execute instead of a kick and a read,
// and it works on a page whose Content-Security-Policy blocks the injected
// <script> the main-world protocol needs elsewhere (live: tab_not_scriptable).
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

const entry = (script) => [...script.matchAll(/__perch\.(\w+)\(/g)].map((m) => m[1]).find((f) => f !== "takeNote" && f !== "lateArm");
function install() {
  const dom = page(`<p>hi</p>`, { url: "https://s.test/" });
  dom.pageGlobal = 41;
  const world = makeWorld({ browsers: [{ name: "Safari", kind: "safari", windows: [{ id: 3, active: 0, tabs: [{ url: "https://s.test/", title: "s", dom }] }] }], cg: [{ owner: "Safari" }] });
  world.run(JXA_PRELUDE);
  const sent = [];
  for (const lane of ["fast", "slow", "long"]) DAEMONS[lane] = { run: (s) => { sent.push([entry(s), s]); return world.daemon.run(s); } };
  return { world, sent };
}
const text = (r) => r.content[0].text;

test("eval_js world:main on a Safari tab is a plain page-world eval, one execute, no injected script", async () => {
  const { world, sent } = install();
  const tab = JSON.parse(text(await handleCall("list_tabs", { app: "safari" }))).tabs[0].tabId;
  world.reset();
  sent.length = 0;
  const r = await handleCall("eval_js", { script: "return window.pageGlobal + 1", world: "main", target: { tabId: tab } });
  assert.equal(text(r), "42");
  assert.deepEqual(sent.map(([e]) => e), ["evalJs"]);
  assert.ok(!sent.some(([, s]) => s.includes("createElement")), "no <script> injected");
  assert.equal(world.counts["tab.doJavaScript"] ?? world.counts["doJavaScript"] ?? 1, 1);
});

test("eval_js world:main with awaitPromise on a Safari tab awaits in the page world without an injected script", async () => {
  const { sent } = install();
  const tab = JSON.parse(text(await handleCall("list_tabs", { app: "safari" }))).tabs[0].tabId;
  sent.length = 0;
  // The fake's Safari page never runs a microtask, so no await settles there; the
  // value is checked live. What it pins is the protocol: awaitPromise's own kick.
  await handleCall("eval_js", { script: "await Promise.resolve(); return window.pageGlobal", world: "main", awaitPromise: true, target: { tabId: tab } });
  const kicks = sent.filter(([e]) => e === "evalKicked").map(([, s]) => s);
  assert.equal(kicks.length, 1);
  assert.ok(!kicks[0].includes("data-perch-ran"), "not the main-world kick");
  assert.ok(kicks[0].includes("__perch_async_"), "awaitPromise's page-world kick");
});
