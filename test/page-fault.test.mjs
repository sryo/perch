// A perch page script that throws reaches the agent as one coded ok:false,
// the same for every tool but eval_js: the error's name only, never the page's
// message or stack, and no isError. When input already went out (a trusted
// click or typing) the reply says so, so the agent checks before retrying.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";
import { throwAt, noRaw } from "./helpers/fault.mjs";

function install(spec) {
  const world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
function onPage(html) {
  const dom = page(html);
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  return { dom, world };
}
const METRICS = { screenX: 0, screenY: 57, outerWidth: 854, innerWidth: 798, outerHeight: 600, innerHeight: 500 };
function raisedTab(html) {
  const dom = page(html);
  for (const [k, v] of Object.entries(METRICS)) Object.defineProperty(dom, k, { value: v, configurable: true });
  const world = install({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [{ url: "about:blank", id: "other" }, { url: "about:blank", id: "t", dom }] }] }],
    cg: [{ owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 798, h: 500 }] } }],
  });
  return { dom, world };
}

const neutral = (tool) => `${tool}: the page script failed on this page (TypeError); nothing verified`;
async function faulted(tool, args, threw) {
  const r = await handleCall(tool, args);
  assert.ok(threw() > 0, `${tool}: the marker never ran`);
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(r.content.length, 1);
  const o = JSON.parse(r.content[0].text);
  noRaw(o);
  return o;
}
async function isNeutral(tool, args, threw) {
  const o = await faulted(tool, args, threw);
  assert.deepEqual(o, { ok: false, error: neutral(tool) });
}

test("fill {label_pattern}: a page script that throws is the neutral fault", async () => {
  const { dom } = onPage(`<label>Name <input name=n></label>`);
  await isNeutral("fill", { label_pattern: "name", text: "Ada" }, throwAt(dom, "return fillOne(A);"));
});

test("fill {trusted} in the background: a page script that throws is the neutral fault", async () => {
  const { dom } = onPage(`<input id=i aria-label="Name">`);
  dom.document.execCommand = () => true;
  await isNeutral("fill", { trusted: true, selector: "#i", text: "Ada" }, throwAt(dom, "return { ok: e.ok, trusted: e.trusted"));
});

test("fill {trusted, raise}: a check that throws after typing says the text went out, unverified", async () => {
  const { dom, world } = raisedTab(`<input id=i aria-label="Name">`);
  const el = dom.document.getElementById("i");
  world.state.onPost = (e) => { if (e.kind === "key" && e.down) el.value += e.text; };
  const o = await faulted("fill", { trusted: true, raise: true, selector: "#i", text: "Ada", target: { tabIndex: 1 } }, throwAt(dom, "if (st.off) st.off();"));
  assert.equal(o.ok, false);
  assert.equal(o.error, "fill: the page script failed on this page (TypeError); the text was sent, outcome unverified");
  assert.equal(o.delivery, "hid");
  assert.equal(o.el, `textbox "Name"`);
  assert.deepEqual(Object.keys(o).sort(), ["delivery", "el", "error", "ok"]);
});

test("click {trusted, raise}: a check that throws after the press keeps the point and says the click went out", async () => {
  const { dom } = raisedTab(`<button id=b>Go</button>`);
  const o = await faulted("click", { trusted: true, raise: true, selector: "#b", target: { tabIndex: 1 } }, throwAt(dom, "if (st.off) st.off();"));
  assert.equal(o.ok, false);
  assert.equal(o.error, "click: the page script failed on this page (TypeError); the click was sent, outcome unverified");
  assert.equal(o.delivery, "hid");
  assert.equal(o.el, `button "Go"`);
  assert.equal(typeof o.point.x, "number");
  assert.deepEqual(Object.keys(o).sort(), ["delivery", "el", "error", "ok", "point"]);
});

test("click plain and click {hover}: a page script that throws is the neutral fault", async () => {
  let { dom } = onPage(`<button id=b>Go</button>`);
  await isNeutral("click", { selector: "#b" }, throwAt(dom, "const r = resolveClick(A);"));
  ({ dom } = onPage(`<button id=b>Go</button>`));
  await isNeutral("click", { selector: "#b", hover: true }, throwAt(dom, "return { ok: true, el: ident(r.el) };"));
});

test("press: a page script that throws is the neutral fault", async () => {
  const { dom } = onPage(`<input id=q>`);
  await isNeutral("press", { key: "Enter", selector: "#q" }, throwAt(dom, `send("keyup", f || el);`));
});

test("accessibility_snapshot, with and without frames: a page script that throws is the neutral fault", async () => {
  for (const frames of [false, true]) {
    const { dom } = onPage(`<button>Go</button>`);
    await isNeutral("accessibility_snapshot", { frames }, throwAt(dom, `return "# " + JSON.stringify(head)`));
  }
});

test("get_text and console_capture: a page script that throws is the neutral fault", async () => {
  let { dom } = onPage(`<p>hello</p>`);
  await isNeutral("get_text", {}, throwAt(dom, "if (A.offset === 0 && s.length <= A.maxChars) return s;"));
  ({ dom } = onPage(`<p>hello</p>`));
  await isNeutral("console_capture", { mode: "read" }, throwAt(dom, "if (!s || !s.installed) return"));
});

async function cvFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "perch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = join(dir, "cv.pdf");
  await writeFile(f, "%PDF-1.4");
  return f;
}

test("file_upload: a first pass or a drop pass that throws is the neutral fault, never ok:true", async (t) => {
  const path = await cvFile(t);
  let { dom } = onPage(`<input type=file id=f>`);
  const first = await faulted("file_upload", { path, selector: "#f" }, throwAt(dom, "if (many) { out.ambiguous = true; out.el = who; }"));
  assert.notEqual(first.ok, true);
  assert.deepEqual(first, { ok: false, error: neutral("file_upload") });
  ({ dom } = onPage(`<p>Resume</p><div id=z role=presentation><input type=file id=f style='display:none'><p>Drag and drop your file here</p></div>`));
  const drop = await faulted("file_upload", { path, selector: "#z" }, throwAt(dom, "return dropOn(U);"));
  assert.notEqual(drop.ok, true);
  assert.deepEqual(drop, { ok: false, error: neutral("file_upload") });
});

test("wait {selector}: a page script that throws is a coded error without the page's text", async () => {
  const { dom } = onPage(`<p>hello</p>`);
  Object.defineProperty(dom.document, "readyState", { value: "complete", configurable: true });
  const threw = throwAt(dom, "if (!A.selector) return true;");
  const r = await handleCall("wait", { selector: "p", timeout: 1000 });
  assert.ok(threw() > 0);
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "error: wait: the page script failed on this page (TypeError); nothing verified");
});

test("a fault named PerchStaleRef is the ref-miss hint with the call's ref, else a re-snapshot hint", async () => {
  const stale = "throw Object.assign(new Error('https://a.test/x secret-internal'), { name: 'PerchStaleRef' });";
  let { dom } = onPage(`<label>Name <input name=n></label>`);
  dom.eval(`window.__perch_refs = { "7": document.querySelector("input") }`);
  throwAt(dom, "return fillOne(A);", undefined, stale);
  const r = await handleCall("fill", { ref: "7", text: "Ada" });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "error: ref 7 is stale or unknown; call accessibility_snapshot again (refs die on re-snapshot and navigation)");
  ({ dom } = onPage(`<label>Name <input name=n></label>`));
  const threw = throwAt(dom, "return fillOne(A);", undefined, stale);
  const o = await faulted("fill", { selector: "input", text: "Ada" }, threw);
  assert.deepEqual(o, { ok: false, error: "fill: a ref's frame document is gone; call accessibility_snapshot again" });
});

test("a page error's raw form still reaches eval_js, where the script is the caller's", async () => {
  onPage(`<p>hello</p>`);
  const r = await handleCall("eval_js", { script: 'throw new Error("x")' });
  assert.equal(r.isError, true);
  const o = JSON.parse(r.content[0].text);
  assert.equal(o.__perch_error, "x");
  assert.equal(o.__perch_error_name, "Error");
});
