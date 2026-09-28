// click {label_pattern}: one call clicks a control by its accessible name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

const CONTROLS = `
<button id=hid style="display:none">Apply</button>
<button id=now>Apply now</button>
<button id=apply>Apply</button>
<button id=s1>Submit</button><button id=s2>Submit</button>
<a id=em href="#manual">Enter manually</a>
<button id=save disabled>Save</button>
<input id=send type=submit value="Send it">
<p id=s>Idle</p>`;
const RECORD = `window.clicked = []; window.hovered = [];
document.querySelectorAll("button, a, input").forEach((el) => {
  el.addEventListener("click", (e) => { e.preventDefault(); window.clicked.push(el.id); document.getElementById("s").textContent = "Clicked " + el.id; });
  el.addEventListener("mouseover", () => window.hovered.push(el.id));
});`;
function controls() {
  const w = page(CONTROLS);
  w.eval(RECORD);
  return w;
}

test("an anchored pattern clicks the visible control, not a hidden one with the same name", () => {
  const w = controls();
  assert.deepEqual(run(w, "click", { label_pattern: "^apply$" }), { ok: true, el: `button "Apply"` });
  assert.deepEqual([...w.clicked], ["apply"]);
});

test("an exact name beats a longer name that contains the word", () => {
  const w = controls();
  assert.deepEqual(run(w, "click", { label_pattern: "apply" }), { ok: true, el: `button "Apply"` });
  assert.deepEqual([...w.clicked], ["apply"]);
});

test("a tie at the best tier clicks nothing and lists the candidates", () => {
  const w = controls();
  const o = run(w, "click", { label_pattern: "submit" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^ambiguous/);
  assert.deepEqual(o.candidates, [`button "Submit"`, `button "Submit"`]);
  assert.deepEqual([...w.clicked], []);
});

test("links and input buttons are clickable by name", () => {
  const w = controls();
  assert.deepEqual(run(w, "click", { label_pattern: "enter manually" }), { ok: true, el: `link "Enter manually"` });
  assert.deepEqual(run(w, "click", { label_pattern: "send" }), { ok: true, el: `button "Send it"` });
  assert.deepEqual([...w.clicked], ["em", "send"]);
});

test("no match reports the visible clickable names", () => {
  const w = controls();
  const o = run(w, "click", { label_pattern: "checkout" });
  assert.equal(o.ok, false);
  assert.match(o.error, /no button or link matched \/checkout\/i/);
  assert.deepEqual(o.names, ["Apply now", "Apply", "Submit", "Enter manually", "Send it"]);
  assert.deepEqual([...w.clicked], []);
});

test("the names list is capped", () => {
  const w = page(Array.from({ length: 12 }, (_, i) => `<button>B${i}</button>`).join(""));
  assert.equal(run(w, "click", { label_pattern: "zzz" }).names.length, 8);
});

test("a disabled control is skipped, and reported when it is the only match", () => {
  const w = controls();
  const o = run(w, "click", { label_pattern: "save" });
  assert.equal(o.ok, false);
  assert.match(o.error, /disabled: button "Save"/);
  assert.deepEqual([...w.clicked], []);
  const w2 = page(`<button disabled>Next</button><div role=button id=n>Next</div>`);
  assert.deepEqual(run(w2, "click", { label_pattern: "next" }), { ok: true, el: `button "Next"` });
});

test("a control nested in another clickable with the same name is one candidate", () => {
  const w = page(`<a href="#x"><button id=b>Continue</button></a>`);
  assert.deepEqual(run(w, "click", { label_pattern: "continue" }), { ok: true, el: `button "Continue"` });
});

test("hover resolves by label too", () => {
  const w = controls();
  assert.deepEqual(run(w, "hover", { label_pattern: "enter manually" }), { ok: true, el: `link "Enter manually"` });
  assert.deepEqual([...w.hovered], ["em"]);
  assert.deepEqual([...w.clicked], []);
});

// ---- through the tool and the JXA runtime ----

function onPage() {
  const dom = controls();
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return dom;
}

test("click {label_pattern, readback} clicks and reports the change", async () => {
  const dom = onPage();
  const r = await handleCall("click", { label_pattern: "enter manually", readback: "#s" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, el: `link "Enter manually"`, readback: "Clicked em", changed: true });
  assert.deepEqual([...dom.clicked], ["em"]);
});

test("an ambiguous label with readback returns the refusal without waiting", async () => {
  const dom = onPage();
  const o = JSON.parse((await handleCall("click", { label_pattern: "submit", readback: "#s" })).content[0].text);
  assert.equal(o.ok, false);
  assert.equal(o.candidates.length, 2);
  assert.deepEqual([...dom.clicked], []);
});

test("click {label_pattern, hover} hovers without clicking", async () => {
  const dom = onPage();
  const r = await handleCall("click", { label_pattern: "^apply now$", hover: true });
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, el: `button "Apply now"` });
  assert.deepEqual([...dom.hovered], ["now"]);
});

test("label_pattern is exclusive with ref, selector and x/y, and must be a valid regex", async () => {
  onPage();
  for (const extra of [{ selector: "#apply" }, { ref: "3" }, { trusted: true, x: 1, y: 2 }]) {
    const r = await handleCall("click", { label_pattern: "apply", ...extra });
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.content[0].text, /label_pattern/);
  }
  const bad = await handleCall("click", { label_pattern: "(" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /click: invalid label_pattern/);
});
