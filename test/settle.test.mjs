// A click or fill whose element isn't there yet, or is still disabled, waits up
// to PERCH_SETTLE_MS (1.5s) for it and then acts once, with `waited` in the
// result; no wait leaves the result as it was. Only a refusal the page made
// before sending anything waits: a step that ran and failed, a tie, a ref miss
// or a bad selector answer at once. A navigation mid-wait ends it.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, settleClock } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

let world, dom, now, sleeps, onSleep;
function onPage(html) {
  dom = page(html, { url: "https://a.test/p" });
  world = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 7, active: 0, tabs: [{ url: "https://a.test/p", id: "x", dom }] }] }], cg: [{ owner: "Google Chrome" }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = DAEMONS.slow = DAEMONS.long = world.daemon;
  world.reset();
}
const saved = { ...settleClock };
beforeEach(() => {
  now = 1e12; sleeps = 0; onSleep = null;
  Object.assign(settleClock, { ms: 1500, now: () => now, sleep: async (ms) => { now += ms; sleeps++; if (onSleep) onSleep(sleeps); } });
});
afterEach(() => Object.assign(settleClock, saved));
const target = { tabId: "chrome:x" };
const call = async (name, args) => { const r = await handleCall(name, { target, ...args }), t = r.content[0].text; return r.isError ? t : JSON.parse(t); };
const after = (n, fn) => { const at = sleeps + n; onSleep = (k) => { if (k === at) fn(); }; };
const add = (html) => dom.document.body.insertAdjacentHTML("beforeend", html);
const clicks = () => Number(dom.document.body.dataset.clicks || 0);
const counted = (id, label) => `<button id=${id} onclick="document.body.dataset.clicks = Number(document.body.dataset.clicks || 0) + 1">${label}</button>`;

test("a button that renders mid-wait gets exactly one click, with waited", async () => {
  onPage(`<p>Loading</p>`);
  after(2, () => add(counted("go", "Continue")));
  const o = await call("click", { label_pattern: "^Continue$" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(clicks(), 1);
  assert.ok(o.waited > 0 && o.waited < 1500, JSON.stringify(o));
  assert.equal(o.__perch_unsent, undefined);
});

test("a button enabled mid-wait is clicked once; a selector that appears is too", async () => {
  onPage(`${counted("go", "Pay")}`);
  dom.document.getElementById("go").disabled = true;
  after(3, () => { dom.document.getElementById("go").disabled = false; });
  let o = await call("click", { selector: "#go" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(clicks(), 1);
  onPage(`<p>x</p>`);
  after(1, () => add(counted("late", "Late")));
  o = await call("click", { selector: "#late" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(clicks(), 1);
});

test("a field that renders mid-wait is filled", async () => {
  onPage(`<form></form>`);
  after(2, () => dom.document.querySelector("form").innerHTML = `<label>Email <input id=e></label>`);
  const o = await call("fill", { label_pattern: "^email", text: "a@b.co" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(dom.document.getElementById("e").value, "a@b.co");
  assert.ok(o.waited > 0);
});

test("a true miss answers the same refusal after the wait, with waited and nothing sent", async () => {
  onPage(`<button>Other</button>`);
  const o = await call("click", { selector: "#nope" });
  assert.equal(o.ok, false);
  assert.equal(o.error, "no element for selector #nope");
  assert.ok(o.waited >= 1500, JSON.stringify(o));
  assert.deepEqual(Object.keys(o).sort(), ["error", "ok", "waited"]);
});

test("no wait without a pre-send refusal: present elements, ties, bad selectors, ref misses, a failed write", async () => {
  onPage(`<button>Go</button><button>Go</button><input id=n type=number>`);
  let o = await call("click", { label_pattern: "^Go$" });
  assert.equal(o.ok, false);
  assert.equal(o.waited, undefined);
  o = await call("click", { selector: "[[" });
  assert.equal(o.waited, undefined);
  o = await call("fill", { selector: "#n", text: "abc" });
  assert.equal(o.ok, false);
  assert.equal(o.waited, undefined);
  o = await call("click", { ref: "9999" });
  assert.equal(typeof o === "string" ? o : o.waited, typeof o === "string" ? o : undefined);
  assert.equal(sleeps, 0);
});

test("a navigation mid-wait ends it", async () => {
  onPage(`<p>x</p>`);
  after(1, () => dom.happyDOM.setURL("https://a.test/next"));
  const o = await call("click", { selector: "#nope" });
  assert.equal(o.ok, false);
  assert.ok(o.waited < 1500, JSON.stringify(o));
  assert.ok(sleeps <= 2, String(sleeps));
});

test("PERCH_SETTLE_MS 0 turns it off", async () => {
  settleClock.ms = 0;
  onPage(`<p>x</p>`);
  const o = await call("click", { selector: "#nope" });
  assert.equal(o.waited, undefined);
  assert.equal(sleeps, 0);
});

test("a late revert the first try reports survives the wait", async () => {
  onPage(`<form><label>Zip <input id=zip></label></form>`);
  const ev = dom.eval.bind(dom);
  let undo = null;
  dom.eval = (js) => { if (undo) { undo(); undo = null; } return ev(js); };
  dom.document.getElementById("zip").addEventListener("input", (e) => { undo = () => { e.target.value = ""; }; });
  let o = await call("fill", { label_pattern: "^zip", text: "2000" });
  assert.equal(o.ok, true, JSON.stringify(o));
  after(2, () => dom.document.querySelector("form").insertAdjacentHTML("beforeend", `<label>City <input id=city></label>`));
  o = await call("fill", { label_pattern: "^city", text: "Rosario" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.ok(o.waited > 0);
  assert.equal(o.late?.[0]?.el, `textbox "Zip"`, JSON.stringify(o));
});
