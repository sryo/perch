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
import { throwAt, noRaw } from "./helpers/fault.mjs";

// A server renumbers a ref it showed before, so rows across fresh pages compare without it.
const unref = (l) => l.replace(/^\d+ /, "");
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
  assert.deepEqual(head.form, { fields: 2, requiredEmpty: 2 });

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

function tabOf(dom) {
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
}

// viewOf's throw, through a tool call: the ref-miss hint for the call's ref.
// Any other thrown name is the neutral fault, with none of the page's text.
test("(b) a frame document gone mid-call is the ref-miss hint through fill and click; another fault is neutral", async () => {
  const firstName = async () => (await handleCall("accessibility_snapshot", {})).content[0].text.split("\n").find((l) => l.includes(`"First name"`)).split(" ")[0];
  for (const [tool, marker, args] of [["fill", "return fillOne(A);", { text: "Ada" }], ["click", "const r = resolveClick(A);", {}]]) {
    const { w } = sameOrigin();
    tabOf(w);
    const ref = await firstName();
    throwAt(w, marker, undefined, "viewOf({ ownerDocument: { defaultView: null } });");
    const r = await handleCall(tool, { ...args, ref });
    assert.equal(r.isError, true, tool);
    assert.equal(r.content[0].text, `error: ref ${ref} is stale or unknown; call accessibility_snapshot again (refs die on re-snapshot and navigation)`);
    const b = sameOrigin();
    tabOf(b.w);
    const bref = await firstName();
    throwAt(b.w, marker);
    const o = await handleCall(tool, { ...args, ref: bref });
    assert.equal(o.isError, undefined, o.content[0].text);
    noRaw(JSON.parse(o.content[0].text));
    assert.deepEqual(JSON.parse(o.content[0].text), { ok: false, error: `${tool}: the page script failed on this page (TypeError); nothing verified` });
  }
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
  assert.deepEqual(snap(w).head.form, { fields: 2, requiredEmpty: 2 });
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
  assert.ok(lines.map(unref).includes(`textbox "First name" name="first" required frame=0`), s);
  const h = JSON.parse(s.split("\n")[0].slice(2));
  assert.deepEqual(h.frames, { count: 1 });
  assert.equal(h.fr, undefined, "the frame rects stay private");
  assert.deepEqual(h.iframes.map((f) => f.same), [true, false]);
});

// A page with a same-origin frame at CSS (100,100) 400x300, i.e. screen
// (156,257) in AREA, and the Accessibility frames `frames` inside AREA.
function framesWorld(dom, frames) {
  Object.defineProperty(dom, "innerWidth", { value: 598, configurable: true });
  Object.defineProperty(dom, "innerHeight", { value: 500, configurable: true });
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 900, tabs: [{ url: "https://a.test/p", id: "t", dom }] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 900, ax: { web: [{ ...AREA, frames }] } }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
const MINE_BOX = { x: 156, y: 257, w: 400, h: 300 };
const frameSnap = async (args = {}) => {
  const s = (await handleCall("accessibility_snapshot", { frames: true, ...args })).content[0].text;
  const [h, ...lines] = s.split("\n");
  return { s, head: JSON.parse(h.slice(2)), lines, f: lines.filter((l) => /^f\d+ /.test(l)) };
};

test("frames:true keeps a cross-origin frame nested in a walked same-origin frame, and drops the walked frame's own rows", async () => {
  const { w: dom } = sameOrigin();
  dom.document.getElementById("app").setAttribute("data-rect", "100,100,400,300");
  const card = { url: "https://pay.example/card", box: { x: 166, y: 347, w: 300, h: 100 }, kids: [{ role: "AXTextField", title: "Card", box: { x: 176, y: 357, w: 200, h: 30 } }] };
  const mine = { url: "https://a.test/app", box: MINE_BOX, kids: [{ role: "AXTextField", title: "First name", box: { x: 166, y: 267, w: 200, h: 30 } }], frames: [card] };
  framesWorld(dom, [mine]);
  const { s, head, lines, f } = await frameSnap();
  assert.deepEqual(f, [`f1 textbox "Card" frame="pay.example"`], s);
  assert.ok(lines.map(unref).includes(`textbox "First name" name="first" required frame=0`), s);
  assert.deepEqual(head.frames, { count: 1 });
});

for (const [name, err] of [
  ["an AppleScript -1728", Object.assign(new Error("Can't get object."), { errorNumber: -1728 })],
  ["an ObjC bridge message", new Error("Error: -[__NSCFNumber count]: unrecognized selector sent to instance 0x8f1c")],
]) {
  test(`a frame walk that throws ${name} gives a coded frames.error beside the page rows`, async () => {
    const { w: dom } = sameOrigin();
    const world = framesWorld(dom, [{ url: "https://pay.example/card", box: { x: 156, y: 600, w: 300, h: 50 }, kids: [] }]);
    world.state.axThrow = err;
    const { s, head, lines } = await frameSnap();
    assert.match(head.frames.error, /^[a-z][a-z_]*: /, s);
    assert.doesNotMatch(head.frames.error, /NSCFNumber|Can't get object/, s);
    assert.equal(unref(lines[0]), `heading "Careers" level=1`);
  });
}

// Five buttons fill max:5, so the same-origin frame's document is never walked.
function truncatedPage() {
  const w = page(`${[1, 2, 3, 4, 5].map((i) => `<button>B${i}</button>`).join("")}<iframe id=app data-rect="100,100,400,300"></iframe>`);
  w.document.getElementById("app").contentDocument.body.innerHTML = `<label for=fn>First name</label><input id=fn><label for=ln>Last name</label><input id=ln>`;
  return w;
}
const MINE = { url: "https://a.test/app", box: MINE_BOX, kids: [
  { role: "AXTextField", title: "First name", box: { x: 166, y: 267, w: 200, h: 30 } },
  { role: "AXTextField", title: "Last name", box: { x: 166, y: 307, w: 200, h: 30 } },
] };

test("a page cut at max before a same-origin frame leaves the frame out of the walked boxes, so its controls come back as frame rows", async () => {
  const w = truncatedPage();
  const { head, lines } = snap(w, { max: 5, frames: true });
  assert.equal(head.truncated, true);
  assert.deepEqual(head.iframes.map((f) => f.same), [true]);
  assert.equal(head.fr, undefined);
  assert.ok(!lines.some((l) => / frame=0$/.test(l)), lines.join("\n"));
  assert.deepEqual(snap(w, { max: 500, frames: true }).head.fr, [[100, 100, 400, 300]]);

  framesWorld(w, [MINE]);
  const r = await frameSnap({ max: 5 });
  assert.equal(r.head.truncated, true);
  assert.deepEqual(r.f, [`f1 textbox "First name" frame="a.test"`, `f2 textbox "Last name" frame="a.test"`], r.s);
});

test("an untruncated same-origin frame is listed once, by the page walk", async () => {
  framesWorld(truncatedPage(), [MINE]);
  const r = await frameSnap();
  assert.deepEqual(r.f, [], r.s);
  assert.deepEqual(r.lines.slice(5).map(unref), [`textbox "First name" frame=0`, `textbox "Last name" frame=0`]);
  assert.deepEqual(r.head.frames, { count: 0 });
});

// Nested frames: a same-origin wrapper's own iframes are listed too, each with
// `in`, the index of its parent's entry.
function nestedCross(doc, id, src) {
  const f = doc.getElementById(id);
  Object.defineProperty(f, "src", { get: () => src, configurable: true });
  Object.defineProperty(f, "contentDocument", { get: () => { throw new Error("SecurityError: blocked a frame"); }, configurable: true });
  return f;
}
function wrapper(inner, rect = "0,0,800,600") {
  const w = page(`<h1>Careers</h1><iframe id=wrap data-rect="${rect}"></iframe>`);
  const d = w.document.getElementById("wrap").contentDocument;
  d.body.innerHTML = `<p>Apply</p>${inner}`;
  return { w, d };
}
const FORM = `<form><label for=em>Email</label><input id=em name=email required></form>`;

test("nested (a) a cross-origin form inside a fieldless wrapper is listed with `in`, and fill's miss names it", () => {
  const { w, d } = wrapper(`<iframe id=ats data-rect="10,10,600,500"></iframe>`);
  nestedCross(d, "ats", "https://forms.example/apply?t=x");
  const { head } = snap(w);
  assert.deepEqual(head.iframes, [
    { src: "about:blank", w: 800, h: 600, same: true },
    { src: "https://forms.example/apply", w: 600, h: 500, same: false, in: 0 },
  ]);
  const o = run(w, "fill", { label_pattern: "email", text: "a@b.co" });
  assert.equal(o.ok, false);
  assert.match(o.error, /the page embeds a form frame at https:\/\/forms\.example\/apply: navigate or new_tab there$/);
  assert.doesNotMatch(o.error, /frame=0/);
});

test("nested (b) a wrapper holding fields is still the hint at frame=0", () => {
  const { w, d } = wrapper(`${FORM}<iframe id=ats data-rect="10,10,600,500"></iframe>`);
  nestedCross(d, "ats", "https://forms.example/apply");
  const o = run(w, "fill", { label_pattern: "first name", text: "Ada" });
  assert.match(o.error, /same-origin form frame: accessibility_snapshot lists its fields \(frame=0\); fill them by ref$/);
});

test("nested (c) a same-origin form inside a fieldless wrapper is walked with its own index, named by the hint, and fills by ref", () => {
  const { w, d } = wrapper(`<iframe id=inner data-rect="10,20,600,500"></iframe>`);
  const inner = d.getElementById("inner").contentDocument;
  inner.body.innerHTML = FORM;
  const { head, lines } = snap(w);
  assert.deepEqual(head.iframes, [{ src: "about:blank", w: 800, h: 600, same: true }, { src: "about:blank", w: 600, h: 500, same: true, in: 0 }]);
  assert.deepEqual(lines, [`1 heading "Careers" level=1`, `2 textbox "Email" name="email" required frame=1`]);
  const miss = run(w, "fill", { label_pattern: "first name", text: "Ada" });
  assert.match(miss.error, /accessibility_snapshot lists its fields \(frame=1\); fill them by ref$/);
  const ref = snap(w).lines.find((l) => l.includes('"Email"')).split(" ")[0];
  const f = run(w, "fill", { ref, text: "a@b.co" });
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.equal(inner.getElementById("em").value, "a@b.co");
  // frames:true places the nested frame's box in top-page coordinates.
  w.document.getElementById("wrap").setAttribute("data-rect", "30,40,800,600");
  assert.deepEqual(snap(w, { frames: true }).head.fr, [[30, 40, 800, 600], [40, 60, 600, 500]]);
});

test("nested (d) a wrapper too small to list hides its children", () => {
  const { w, d } = wrapper(`<iframe id=ats data-rect="0,0,600,500"></iframe>`, "0,0,100,100");
  nestedCross(d, "ats", "https://forms.example/apply");
  assert.equal(snap(w).head.iframes, undefined);
  assert.doesNotMatch(run(w, "fill", { label_pattern: "email", text: "x" }).error, /embeds/);
});

function capPage(tops, kidRect) {
  const w = page(`${tops.map((i) => `<iframe id=t${i} data-rect="0,0,900,${600 + i}"></iframe>`).join("")}<iframe id=wrap data-rect="0,0,300,200"></iframe>`);
  tops.forEach((i) => crossOrigin(w, "t" + i, `https://ads.example/t${i}`));
  const wd = w.document.getElementById("wrap").contentDocument;
  wd.body.innerHTML = `<iframe id=kid data-rect="${kidRect}"></iframe>`;
  nestedCross(wd, "kid", "https://forms.example/apply");
  return snap(w).head.iframes.map((f) => [f.src.replace(/^https:\/\/[^/]+\//, ""), f.in]);
}

test("nested (e) depth 4 is not listed; the cap of 5 holds and no `in` names a dropped entry", () => {
  const { w, d } = wrapper(`<iframe id=l2 data-rect="0,0,700,500"></iframe>`);
  const d2 = d.getElementById("l2").contentDocument;
  d2.body.innerHTML = `<iframe id=l3 data-rect="0,0,600,400"></iframe>`;
  const d3 = d2.getElementById("l3").contentDocument;
  d3.body.innerHTML = `<iframe id=l4 data-rect="0,0,500,300"></iframe>`;
  d3.getElementById("l4").contentDocument.body.innerHTML = `<input name=deep>`;
  const { head, lines } = snap(w);
  assert.deepEqual(head.iframes.map((f) => [f.w, f.in]), [[800, undefined], [700, 0], [600, 1]]);
  assert.ok(!lines.some((l) => /deep/.test(l)), lines.join("\n"));

  // A child bigger than its parent sorts first; its `in` points past it.
  assert.deepEqual(capPage([1, 2, 3], "0,0,850,700"), [["apply", 4], ["t3", undefined], ["t2", undefined], ["t1", undefined], ["about:blank", undefined]]);
  // The cap cuts the wrapper, so its child goes too.
  assert.deepEqual(capPage([1, 2, 3, 4], "0,0,850,700"), [["t4", undefined], ["t3", undefined], ["t2", undefined], ["t1", undefined]]);
  assert.deepEqual(capPage([1, 2, 3, 4, 5], "0,0,250,160"), [5, 4, 3, 2, 1].map((i) => ["t" + i, undefined]));
});
