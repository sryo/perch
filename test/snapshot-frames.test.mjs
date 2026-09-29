// Embedded frames seen from page JS: the snapshot header lists the large,
// visible ones as iframes:[{src,w,h,same}]; a same-origin frame's controls are
// walked after the page's own rows with frame=<index>, and fill/select take
// their refs in any tab. A cross-origin frame is never read, only named, and
// fill's label miss points there instead of at a reveal button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run, runBody } from "./helpers/page.mjs";

const snap = (w, A = {}) => {
  const [head, ...lines] = run(w, "snapshot", { max: 500, ...A }).split("\n");
  return { head: JSON.parse(head.slice(2)), lines };
};

// A cross-origin frame: contentDocument throws (or reads null) in page JS.
function crossOrigin(w, id, src) {
  const f = w.document.getElementById(id);
  Object.defineProperty(f, "src", { get: () => src, configurable: true });
  Object.defineProperty(f, "contentDocument", { get: () => { throw new Error("SecurityError: blocked a frame"); }, configurable: true });
  return f;
}
const ATS = () => {
  const w = page(`<h1>Careers</h1><p>Apply below</p><iframe id=ats data-rect="0,100,600,800"></iframe>`);
  crossOrigin(w, "ats", "https://jobs.example/acme/apply?token=s3cret&utm=x#top");
  return w;
};

test("(a) a cross-origin frame is listed by origin and path only, and none of it is read", () => {
  const { head, lines } = snap(ATS());
  assert.deepEqual(head.iframes, [{ src: "https://jobs.example/acme/apply", w: 600, h: 800, same: false }]);
  assert.deepEqual(lines, [`1 heading "Careers" level=1`]);
  assert.equal(head.form, undefined);
  assert.ok(!JSON.stringify(head).includes("s3cret"));
});

test("(a) a frame whose contentDocument reads null is not same-origin", () => {
  const w = page(`<iframe id=x data-rect="0,0,400,300"></iframe>`);
  const f = w.document.getElementById("x");
  Object.defineProperty(f, "src", { get: () => "https://other.example/embed", configurable: true });
  Object.defineProperty(f, "contentDocument", { get: () => null, configurable: true });
  assert.deepEqual(snap(w).head.iframes, [{ src: "https://other.example/embed", w: 400, h: 300, same: false }]);
});

function sameOrigin(top = `<h1>Careers</h1>`) {
  const w = page(`${top}<iframe id=app data-rect="0,100,600,800"></iframe>`);
  const d = w.document.getElementById("app").contentDocument;
  d.body.innerHTML = `<form>
    <label for=fn>First name</label><input id=fn name=first required>
    <label for=wa>Work authorization</label><select id=wa name=auth required><option value="">Select...</option><option>Yes</option><option>No</option></select>
  </form>`;
  return { w, d };
}

test("(b) a same-origin frame's controls follow the page rows with frame=0, and fill/select take their refs", () => {
  const { w, d } = sameOrigin();
  const { head, lines } = snap(w);
  assert.deepEqual(head.iframes, [{ src: "about:blank", w: 600, h: 800, same: true }]);
  assert.deepEqual(lines, [
    `1 heading "Careers" level=1`,
    `2 textbox "First name" name="first" required frame=0`,
    `3 combobox "Work authorization" name="auth" options=["Select...","Yes","No"] required frame=0`,
  ]);
  assert.equal(head.count, 3);
  assert.deepEqual(head.form, { fields: 2, requiredEmpty: 1 });

  const f = run(w, "fill", { ref: "2", text: "Ada" });
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.equal(f.hidden, undefined, JSON.stringify(f));
  assert.equal(d.getElementById("fn").value, "Ada");
  const s = run(w, "select_start", { ref: "3", text: "Yes" });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(d.getElementById("wa").value, "Yes");
  assert.deepEqual(snap(w).head.form, { fields: 2, requiredEmpty: 0 });
});

// A frame that navigates or reloads leaves its old document alive: the refs
// the top window kept still read isConnected, but no longer name the frame.
test("(b) a ref into a frame whose document was replaced is stale for fill and click, and nothing is written", () => {
  const { w, d } = sameOrigin();
  snap(w);
  const app = w.document.getElementById("app");
  const fresh = w.document.implementation.createHTMLDocument("");
  Object.defineProperty(app, "contentDocument", { get: () => fresh, configurable: true });
  const old = d.getElementById("fn");
  assert.equal(old.isConnected, true);
  let clicks = 0;
  old.addEventListener("click", () => clicks++);
  assert.deepEqual(run(w, "fill", { ref: "2", text: "Ada" }), { __perch_ref_miss: true, ref: "2" });
  assert.deepEqual(run(w, "click", { ref: "2" }), { __perch_ref_miss: true, ref: "2" });
  assert.equal(old.value, "");
  assert.equal(clicks, 0);
});

test("(b) a ref whose frame document lost its window is stale, and a removed frame's too", () => {
  const { w, d } = sameOrigin();
  snap(w);
  Object.defineProperty(d, "defaultView", { get: () => null, configurable: true });
  assert.deepEqual(run(w, "fill", { ref: "2", text: "Ada" }), { __perch_ref_miss: true, ref: "2" });
  assert.equal(d.getElementById("fn").value, "");
  const b = sameOrigin();
  snap(b.w);
  b.w.document.getElementById("app").remove();
  assert.deepEqual(run(b.w, "click", { ref: "2" }), { __perch_ref_miss: true, ref: "2" });
});

test("(b) viewOf fails closed for a detached frame document instead of using the top window", () => {
  const { w, d } = sameOrigin();
  w.__el = d.getElementById("fn");
  assert.equal(runBody(w, `return viewOf(window.__el) === window.document.getElementById("app").contentWindow`), true);
  Object.defineProperty(d, "defaultView", { get: () => null, configurable: true });
  const o = runBody(w, `return viewOf(window.__el) === window`);
  assert.match(String(o && o.__perch_error), /stale/);
});

test("(b) a trusted click can't aim at a same-origin frame's row: its box is in the frame's viewport", () => {
  const { w } = sameOrigin();
  snap(w);
  const o = run(w, "trusted_probe", { ref: "2" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^textbox "First name" lies in an embedded frame, where trusted input can't aim; use it without trusted$/);
  assert.equal(w.__perch_trusted, undefined, "nothing armed");
});

test("(b) a same-origin frame's rows count toward max and query like any other", () => {
  const { w } = sameOrigin();
  assert.deepEqual(snap(w, { query: "frame=0" }).lines, [`1 textbox "First name" name="first" required frame=0`, `2 combobox "Work authorization" name="auth" options=["Select...","Yes","No"] required frame=0`]);
  const capped = snap(w, { max: 2 });
  assert.equal(capped.lines.length, 2);
  assert.equal(capped.head.truncated, true);
});

test("(b) the header's form is the biggest one across the page and its same-origin frames", () => {
  const { w } = sameOrigin(`<form><input name=q placeholder=Search></form>`);
  assert.deepEqual(snap(w).head.form, { fields: 2, requiredEmpty: 1 });
});

test("(b) a frame form's unseen required field gets a hidden row with its frame, and focus inside the frame names its ref", () => {
  const { w, d } = sameOrigin();
  const f = d.querySelector("form");
  f.insertAdjacentHTML("beforeend", `<div><label for=cv>Cover letter</label><textarea id=cv name=cv required style="display:none"></textarea><button type=button>Enter manually</button></div>`);
  d.getElementById("fn").focus();
  // Browsers report the frame element as the page's activeElement; happy-dom doesn't.
  const app = w.document.getElementById("app");
  Object.defineProperty(w.document, "activeElement", { get: () => app, configurable: true });
  const { head, lines } = snap(w);
  assert.deepEqual(lines.slice(3), [`4 button "Enter manually" frame=0`, `5 textbox "Cover letter" name="cv" type="textarea" required hidden frame=0 reveal="4"`]);
  assert.equal(head.focus, "2");
});

test("(b) a hidden iframe's document is not walked", () => {
  const w = page(`<h1>Careers</h1><iframe id=app style="display:none"></iframe>`);
  w.document.getElementById("app").contentDocument.body.innerHTML = `<input name=first required>`;
  const { head, lines } = snap(w);
  assert.equal(head.iframes, undefined);
  assert.deepEqual(lines, [`1 heading "Careers" level=1`]);
});

test("(c) a tracking pixel, a hidden frame and a small frame are not listed; at most 5, largest first", () => {
  const w = page(`<iframe id=px data-rect="0,0,1,1"></iframe><iframe id=none style="display:none"></iframe><iframe id=small data-rect="0,0,199,400"></iframe>
    ${[1, 2, 3, 4, 5, 6].map((i) => `<iframe id=f${i} data-rect="0,0,${200 + i * 10},150"></iframe>`).join("")}`);
  ["px", "none", "small", "f1", "f2", "f3", "f4", "f5", "f6"].forEach((id) => crossOrigin(w, id, `https://ads.example/${id}`));
  const { head } = snap(w);
  assert.deepEqual(head.iframes.map((f) => f.src), ["f6", "f5", "f4", "f3", "f2"].map((id) => `https://ads.example/${id}`));
  const w2 = page(`<iframe id=px data-rect="0,0,1,1"></iframe><iframe id=none style="display:none"></iframe>`);
  ["px", "none"].forEach((id) => crossOrigin(w2, id, `https://ads.example/${id}`));
  assert.equal(snap(w2).head.iframes, undefined);
});

test("(c) a long src is clipped to 150 chars", () => {
  const w = page(`<iframe id=x data-rect="0,0,600,800"></iframe>`);
  crossOrigin(w, "x", "https://jobs.example/" + "a".repeat(300) + "?q=1");
  const src = snap(w).head.iframes[0].src;
  assert.equal(src.length, 151);
  assert.ok(src.endsWith("…"));
});

test("(d) fill's label miss on a page embedding a cross-origin form frame names it, not a reveal button", () => {
  const o = run(ATS(), "fill", { label_pattern: "first name", text: "Ada" });
  assert.equal(o.ok, false);
  assert.match(o.error, /^no fillable field matched \/first name\/i; the page embeds a form frame at https:\/\/jobs\.example\/acme\/apply: navigate or new_tab there$/);
  assert.equal(o.reveal, undefined);
  assert.doesNotMatch(o.error, /clicking/);
});

test("(d) a reveal button still wins over the frame wording", () => {
  const w = page(`<section><h2>First name</h2><button>Enter manually</button></section><iframe id=ats data-rect="0,100,600,800"></iframe>`);
  crossOrigin(w, "ats", "https://jobs.example/acme/apply");
  const o = run(w, "fill", { label_pattern: "first name", text: "Ada" });
  assert.equal(o.ok, false);
  assert.deepEqual(o.reveal, [`button "Enter manually"`]);
  assert.doesNotMatch(o.error, /embeds/);
});

test("(d) a hidden match on a page embedding a cross-origin frame points at the frame", () => {
  const w = page(`<label for=h>First name</label><input id=h style="display:none"><iframe id=ats data-rect="0,100,600,800"></iframe>`);
  crossOrigin(w, "ats", "https://jobs.example/acme/apply");
  const o = run(w, "fill", { label_pattern: "first name", text: "Ada" });
  assert.equal(o.ok, false);
  assert.match(o.error, /the field is hidden; the page embeds a form frame at https:\/\/jobs\.example\/acme\/apply: navigate or new_tab there, or pass its ref or selector to fill it anyway$/);
});

test("(d) label_pattern does not search a same-origin frame; its miss says to snapshot and fill by ref", () => {
  const { w, d } = sameOrigin();
  const o = run(w, "fill", { label_pattern: "first name", text: "Ada" });
  assert.equal(o.ok, false);
  assert.match(o.error, /the page embeds a same-origin form frame: accessibility_snapshot lists its fields \(frame=0\); fill them by ref$/);
  assert.equal(d.getElementById("fn").value, "");
});

test("(e) a page with no iframes: no iframes key, no frame= rows, and the plain miss wording", () => {
  const w = page(`<h1>Careers</h1><form><label for=e>Email</label><input id=e required></form>`);
  const { head, lines } = snap(w);
  assert.equal(head.iframes, undefined);
  assert.deepEqual(lines, [`1 heading "Careers" level=1`, `2 textbox "Email" required`]);
  assert.equal(run(w, "fill", { label_pattern: "first name", text: "x" }).error, "no fillable field matched /first name/i; it may appear only after clicking a button");
});

// frames:true: Accessibility rows of a same-origin frame the page walk already
// listed are dropped; a cross-origin frame's stay.
const AREA = { x: 56, y: 157, w: 598, h: 500 };
test("frames:true drops the Accessibility rows of a same-origin frame already walked", async () => {
  const { w: dom } = sameOrigin();
  dom.document.getElementById("app").setAttribute("data-rect", "100,100,400,300");
  const ext = dom.document.createElement("iframe");
  ext.id = "ext";
  ext.setAttribute("data-rect", "100,420,400,200");
  dom.document.body.appendChild(ext);
  crossOrigin(dom, "ext", "https://widget.example/embed");
  Object.defineProperty(dom, "innerWidth", { value: 598, configurable: true });
  Object.defineProperty(dom, "innerHeight", { value: 500, configurable: true });
  const mine = { url: "about:blank", box: { x: 156, y: 257, w: 400, h: 300 }, kids: [{ role: "AXTextField", title: "First name", box: { x: 166, y: 267, w: 200, h: 30 } }] };
  const theirs = { url: "https://widget.example/embed", box: { x: 156, y: 577, w: 400, h: 200 }, kids: [{ role: "AXButton", title: "Chat", box: { x: 166, y: 587, w: 80, h: 30 } }] };
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 900, tabs: [{ url: "https://a.test/p", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 900, ax: { web: [{ ...AREA, frames: [mine, theirs] }] } }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  const r = await handleCall("accessibility_snapshot", { frames: true });
  const s = r.content[0].text;
  const lines = s.split("\n").slice(1);
  assert.deepEqual(lines.filter((l) => /^f\d+ /.test(l)), [`f1 button "Chat" frame="widget.example"`]);
  assert.ok(lines.includes(`2 textbox "First name" name="first" required frame=0`), s);
  const h = JSON.parse(s.split("\n")[0].slice(2));
  assert.deepEqual(h.frames, { count: 1 });
  assert.equal(h.fr, undefined, "the frame rects stay private");
  assert.deepEqual(h.iframes.map((f) => f.same), [true, false]);
});
