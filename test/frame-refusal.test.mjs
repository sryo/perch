// Sign-in, challenge and password controls inside frames are the user's: the
// snapshot flags them and a trusted frame click refuses them without posting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run, deliverPress } from "./helpers/page.mjs";

const AREA = { x: 56, y: 157, w: 598, h: 500 };

// One frame per URL, stacked 40pt apart, each holding one button.
function world(urls, extra = []) {
  const dom = page(`<button id=b>Go</button>`, { url: "https://shop.test/checkout" });
  const other = page(`<button>Other</button>`, { url: "https://other.test/" });
  for (const d of [dom, other]) {
    Object.defineProperty(d, "innerWidth", { value: 598, configurable: true });
    Object.defineProperty(d, "innerHeight", { value: 500, configurable: true });
  }
  const frames = urls.map((url, i) => ({ url, box: { x: 100, y: 170 + i * 40, w: 400, h: 36 }, kids: [
    { role: "AXButton", title: "Verify", box: { x: 110, y: 172 + i * 40, w: 100, h: 30 } },
  ] })).concat(extra);
  const w = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs: [
      { url: "https://shop.test/checkout", id: "t", dom },
      { url: "https://other.test/", id: "u", dom: other },
      { url: "https://third.test/", id: "v", dom: page(`<p>x</p>`, { url: "https://third.test/" }) },
    ] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ ...AREA, frames }] } }],
  });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = w.daemon;
  DAEMONS.slow = w.daemon;
  w.reset();
  w.frames = frames;
  w.dom = dom;
  return w;
}

const text = (r) => r.content[0].text;
const frameLines = (s) => s.split("\n").slice(1).filter((l) => /^f\d+ /.test(l));
const snap = async () => text(await handleCall("accessibility_snapshot", { frames: true }));
const click = async (ref, extra = {}) => JSON.parse(text(await handleCall("click", { ref, trusted: true, ...extra })));

const HANDOFF = [
  "https://accounts.google.com/o/oauth2/auth?client_id=x",
  "https://www.google.com/recaptcha/api2/anchor?k=x",
  "https://google.com/recaptcha/api2/bframe",
  "https://www.recaptcha.net/recaptcha/api2/anchor",
  "https://recaptcha.net/recaptcha/api2/anchor",
  "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html",
  "https://hcaptcha.com/checkbox",
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2",
  "https://appleid.apple.com/auth/authorize",
  "https://idmsa.apple.com/appleauth/auth/signin",
  "https://client-api.arkoselabs.com/fc/gc/?token=x",
  "https://acme-api.arkoselabs.com/v2/x/enforcement.html",
  "https://login.microsoftonline.com/common/oauth2/authorize",
  "https://login.live.com/oauth20_authorize.srf",
  "https://ACCOUNTS.Google.com./signin",
  "https://geo.captcha-delivery.com/captcha/?initialCid=x",
  "https://captcha-delivery.com/interstitial/",
  "https://abc123.edge.sdk.awswaf.com/abc123/def/captcha.js",
  "https://static.geetest.com/static/js/gt.0.4.9.js",
  "https://api.friendlycaptcha.com/api/v1/puzzle",
  "",
  "about:blank",
  "about:srcdoc",
  "not a url",
];

const ORDINARY = [
  "https://www.google.com/maps/embed?pb=x",
  "https://google.com/search?q=recaptcha",
  "https://www.google.com/recaptchas-are-fun",
  "https://maps.google.com/recaptcha/x",
  "https://notrecaptcha.net/",
  "https://hcaptcha.com.evil.test/",
  "https://myhcaptcha.com/",
  "https://arkoselabs.com.example/",
  "https://apple.com/appleid",
  "https://js.stripe.com/v3/elements-inner-card.html",
  "https://captcha-delivery.com.evil.test/",
  "https://notgeetest.com/",
];

test("the snapshot flags sign-in and challenge frames handoff, and only those", async () => {
  world(HANDOFF.concat(ORDINARY));
  const lines = frameLines(await snap());
  assert.equal(lines.length, HANDOFF.length + ORDINARY.length);
  lines.forEach((l, i) => {
    const url = (HANDOFF.concat(ORDINARY))[i];
    assert.equal(/ handoff$/.test(l), i < HANDOFF.length, `${url}: ${l}`);
  });
  assert.ok(!lines.join("\n").includes("/recaptcha"), "no frame path leaks");
});

test("a click on a handoff frame's control is refused, for every host class, with nothing posted", async () => {
  const w = world(HANDOFF);
  await snap();
  w.reset();
  for (let i = 0; i < HANDOFF.length; i++) {
    const o = await click("f" + (i + 1));
    assert.equal(o.ok, false, HANDOFF[i]);
    assert.match(o.error, /sign-in, challenge or password.*hand it to the user/, HANDOFF[i]);
    assert.equal(o.ref, "f" + (i + 1));
  }
  const raised = await click("f1", { raise: true });
  assert.equal(raised.ok, false);
  assert.deepEqual(w.posted, []);
  assert.equal(w.counts["tab.execute"], undefined, "refused before probing the page or walking the frames");
  assert.equal(w.counts["activate(Google Chrome)"], undefined);
});

test("a secure field's row is refused, whatever frame holds it", async () => {
  const w = world([], [{ url: "https://widget.example/embed", box: { x: 100, y: 170, w: 400, h: 100 }, kids: [
    { role: "AXTextField", subrole: "AXSecureTextField", description: "Password", box: { x: 110, y: 180, w: 200, h: 30 } },
    { role: "AXSecureTextField", description: "PIN", box: { x: 110, y: 220, w: 200, h: 30 } },
  ] }]);
  assert.deepEqual(frameLines(await snap()), [
    `f1 textbox "Password" frame="widget.example" secure`,
    `f2 textbox "PIN" frame="widget.example" secure`,
  ]);
  w.reset();
  for (const ref of ["f1", "f2"]) {
    const o = await click(ref);
    assert.equal(o.ok, false, ref);
    assert.match(o.error, /hand it to the user/);
  }
  assert.equal((await click("f1", { raise: true })).ok, false);
  assert.deepEqual(w.posted, []);
  assert.equal(w.counts["activate(Google Chrome)"], undefined, "refused before raising");
  assert.equal(w.counts["tab.execute"], undefined, "refused before the fresh walk");
});

test("ordinary frames still click", async () => {
  const w = world(ORDINARY.slice(0, 3));
  await snap();
  for (let i = 0; i < 3; i++) {
    w.posted.length = 0;
    const o = await click("f" + (i + 1));
    assert.equal(o.ok, true, ORDINARY[i]);
    assert.deepEqual(w.posted.filter((e) => e.type === 1 && e.pt.x >= 0).map((e) => e.pt), [{ x: 160, y: 187 + i * 40 }]);
  }
});

test("a ref that names a handoff row in one tab and an ordinary row in another is refused only in the first", async () => {
  const w = world(["https://challenges.cloudflare.com/turnstile"]);
  await snap();
  w.winSpec("Google Chrome", 0).active = 1;
  w.frames[0].url = "https://widget.example/embed";
  await snap();
  w.reset();
  const ok = await click("f1", { target: { tabId: "chrome:u" } });
  assert.equal(ok.ok, true);
  w.posted.length = 0;
  w.winSpec("Google Chrome", 0).active = 0;
  w.frames[0].url = "https://challenges.cloudflare.com/turnstile";
  const no = await click("f1", { target: { tabId: "chrome:t" } });
  assert.equal(no.ok, false);
  assert.match(no.error, /hand it to the user/);
  assert.deepEqual(w.posted, []);
});

// f1 is a challenge in tab t and an ordinary button in tab u; tab v has no f1.
async function splitRef() {
  const w = world(["https://challenges.cloudflare.com/turnstile"]);
  await snap();
  w.winSpec("Google Chrome", 0).active = 1;
  w.frames[0].url = "https://widget.example/embed";
  await snap();
  w.winSpec("Google Chrome", 0).active = 0;
  w.reset();
  return w;
}
const untouched = (w) => {
  assert.deepEqual(w.posted, []);
  for (const k of ["activate(Google Chrome)", "win.index=", "win.activeTabIndex=", "tab.select", "tab.execute"]) assert.equal(w.counts[k], undefined, k);
};

test("raise:true on a ref that is handoff in the target tab is refused before the browser is raised", async () => {
  const w = await splitRef();
  const o = await click("f1", { raise: true, target: { tabId: "chrome:t" } });
  assert.equal(o.ok, false);
  assert.match(o.error, /sign-in, challenge or password.*hand it to the user/);
  untouched(w);
});

test("raise:true on a ref the target tab never listed is stale before the browser is raised", async () => {
  const w = await splitRef();
  const r = await handleCall("click", { ref: "f1", trusted: true, raise: true, target: { tabId: "chrome:v" } });
  assert.match(text(r), /stale or unknown; call accessibility_snapshot again/);
  untouched(w);
});

test("raise:true on the same ref's ordinary row in the other tab still raises and clicks", async () => {
  const w = await splitRef();
  w.frames[0].url = "https://widget.example/embed";
  const o = await click("f1", { raise: true, target: { tabId: "chrome:u" } });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.delivery, "hid");
  assert.equal(w.counts["activate(Google Chrome)"], 1);
  assert.deepEqual(w.posted.filter((e) => e.type === 1 && e.pt.x >= 0).map((e) => [e.via, e.pt]), [["hid", { x: 160, y: 187 }]]);
});

test("a field that turned secure since the snapshot is refused on the fresh walk", async () => {
  const w = world([], [{ url: "https://widget.example/embed", box: { x: 100, y: 170, w: 400, h: 100 }, kids: [
    { role: "AXTextField", description: "Code", box: { x: 110, y: 180, w: 200, h: 30 } },
  ] }]);
  assert.deepEqual(frameLines(await snap()), [`f1 textbox "Code" frame="widget.example"`]);
  w.frames[0].kids[0].subrole = "AXSecureTextField";
  const o = await click("f1");
  assert.equal(o.ok, false);
  assert.match(o.error, /hand it to the user/);
  assert.deepEqual(w.posted, []);
});

test("a frame nested anywhere under a handoff frame is handoff too, and refused with nothing posted", async () => {
  const inner = (url, y) => ({ url, box: { x: 100, y, w: 400, h: 36 }, kids: [
    { role: "AXButton", title: "Continue", box: { x: 110, y: y + 2, w: 100, h: 30 } },
  ] });
  const w = world([], [
    { url: "https://accounts.google.com/gsi/iframe", box: { x: 100, y: 170, w: 400, h: 200 }, kids: [],
      frames: [{ url: "https://widget.example/a", box: { x: 100, y: 170, w: 400, h: 200 }, kids: [], frames: [inner("https://widget.example/b", 180)] }] },
    { url: "", box: { x: 100, y: 400, w: 400, h: 100 }, kids: [], frames: [inner("https://widget.example/c", 410)] },
    inner("https://widget.example/d", 520),
  ]);
  const lines = frameLines(await snap());
  assert.deepEqual(lines, [
    `f1 button "Continue" frame="widget.example"`,
    `f2 button "Continue" frame="widget.example" handoff`,
    `f3 button "Continue" frame="widget.example" handoff`,
  ]);
  w.reset();
  for (const ref of ["f2", "f3"]) {
    const o = await click(ref);
    assert.equal(o.ok, false, ref);
    assert.match(o.error, /hand it to the user/);
  }
  assert.deepEqual(w.posted, []);
  assert.equal(w.counts["tab.execute"], undefined);
  const ok = await click("f1");
  assert.equal(ok.ok, true);
  assert.deepEqual(w.posted.filter((e) => e.type === 1 && e.pt.x >= 0).map((e) => e.pt), [{ x: 160, y: 537 }]);
});

test("a row whose frame moved under a handoff frame since the snapshot is not clicked", async () => {
  const kid = { role: "AXButton", title: "Continue", box: { x: 110, y: 182, w: 100, h: 30 } };
  const child = { url: "https://widget.example/b", box: { x: 100, y: 180, w: 400, h: 36 }, kids: [kid] };
  const w = world([], [{ url: "https://widget.example/a", box: { x: 100, y: 170, w: 400, h: 200 }, kids: [], frames: [child] }]);
  assert.deepEqual(frameLines(await snap()), [`f1 button "Continue" frame="widget.example"`]);
  w.frames[0].url = "https://challenges.cloudflare.com/turnstile";
  const r = await handleCall("click", { ref: "f1", trusted: true });
  assert.equal(r.isError, true);
  assert.match(text(r), /ref/);
  assert.deepEqual(w.posted, []);
});

// ---- trusted clicks aimed by selector or point never land on a frame element ----

const FRAME_HINT = /accessibility_snapshot \{frames:true\}.*fN/;

test("trusted_probe refuses a frame element as the target, arming nothing", () => {
  for (const tag of ["iframe", "frame", "object", "embed"]) {
    const w = page(`<${tag} id=f title="reCAPTCHA"></${tag}>`);
    const o = run(w, "trusted_probe", { selector: "#f" });
    assert.equal(o.ok, false, tag);
    assert.match(o.error, FRAME_HINT, tag);
    assert.equal(w.__perch_trusted, undefined, `${tag}: no listeners armed`);
  }
});

test("trusted_probe refuses when a frame, or something inside one, is what sits at the aim point", () => {
  const w = page(`<div id=cover>Verify</div><iframe id=f></iframe><object id=o><span id=inner>x</span></object>`);
  for (const id of ["f", "inner"]) {
    w.document.elementFromPoint = () => w.document.getElementById(id);
    const o = run(w, "trusted_probe", { selector: "#cover" });
    assert.equal(o.ok, false, id);
    assert.match(o.error, FRAME_HINT, id);
  }
  assert.equal(w.__perch_trusted, undefined);
});

test("trusted_probe still aims at an ordinary button beside a frame", () => {
  const w = page(`<button id=b>Go</button><iframe></iframe>`);
  w.document.elementFromPoint = () => w.document.getElementById("b");
  assert.equal(run(w, "trusted_probe", { selector: "#b" }).ok, true);
  w.document.elementFromPoint = () => null;
  assert.equal(run(w, "trusted_probe", { selector: "#b" }).ok, true, "nothing at the point (offscreen) is not a frame");
});

// The page area is AREA at scale 1, so client (cx, cy) is screen (56 + cx, 157 + cy).
function framePage(html, rects = {}) {
  const w = world([]);
  w.dom.document.body.innerHTML = html;
  for (const [id, [l, t, wd, h]] of Object.entries(rects)) {
    w.dom.document.getElementById(id).getBoundingClientRect = () => ({ x: l, y: t, left: l, top: t, width: wd, height: h, right: l + wd, bottom: t + h });
  }
  return w;
}
const pointClick = (x, y, extra = {}) => handleCall("click", { trusted: true, x, y, ...extra });
const downs = (w) => w.posted.filter((e) => e.type === 1 && e.pt.x >= 0).map((e) => e.pt);

test("a trusted click by selector on an iframe is refused before anything is posted", async () => {
  const w = framePage(`<iframe id=f title="reCAPTCHA"></iframe>`);
  const o = JSON.parse(text(await handleCall("click", { selector: "iframe[title*=reCAPTCHA]", trusted: true })));
  assert.equal(o.ok, false);
  assert.match(o.error, FRAME_HINT);
  assert.deepEqual(w.posted, []);
});

test("a trusted click by point on an embedded frame is refused, with nothing posted", async () => {
  const w = framePage(`<button id=b>Go</button><iframe id=f></iframe>`, { b: [0, 0, 100, 20], f: [100, 100, 300, 80] });
  for (const raise of [false, true]) {
    const o = JSON.parse(text(await pointClick(56 + 250, 157 + 140, { raise })));
    assert.equal(o.ok, false, `raise:${raise}`);
    assert.match(o.error, FRAME_HINT);
  }
  assert.deepEqual(w.posted, []);
});

test("a point on a frame is refused under page zoom, and by the page's estimate when Accessibility can't place the page", async () => {
  const set = (w, m) => { for (const [k, v] of Object.entries(m)) Object.defineProperty(w.dom, k, { value: v, configurable: true }); };
  // Zoom 2: the 598x500 page area shows a 299x250 viewport.
  let w = framePage(`<iframe id=f></iframe>`, { f: [50, 50, 100, 50] });
  set(w, { innerWidth: 299, innerHeight: 250 });
  let o = JSON.parse(text(await pointClick(250, 300)));
  assert.equal(o.ok, false);
  assert.match(o.error, FRAME_HINT);
  // No web area has a 1000x1000 viewport's shape, so the page's own origin estimate places it.
  w = framePage(`<iframe id=f></iframe>`, { f: [100, 100, 300, 80] });
  set(w, { innerWidth: 1000, innerHeight: 1000, outerWidth: 1000, outerHeight: 1100, screenX: 0, screenY: 57 });
  o = JSON.parse(text(await pointClick(250, 300)));
  assert.equal(o.ok, false);
  assert.match(o.error, FRAME_HINT);
  assert.deepEqual(w.posted, []);
});

test("a trusted click by point beside a frame still posts", async () => {
  const w = framePage(`<button id=b>Go</button><iframe id=f></iframe>`, { b: [0, 0, 100, 20], f: [100, 100, 300, 80] });
  deliverPress(w, w.dom);
  const o = JSON.parse(text(await pointClick(56 + 50, 157 + 10)));
  assert.equal(o.ok, true);
  assert.deepEqual(downs(w), [{ x: 106, y: 167 }]);
  assert.equal(o.hit, true);
  assert.equal(w.counts["tab.execute"], 2, "the frame check, then the hit check");
});

test("a trusted click by point fails closed when the page can't be checked for frames", async () => {
  const w = framePage(`<button id=b>Go</button>`);
  w.state.jsOff = true;
  const r = await pointClick(56 + 50, 157 + 10);
  assert.equal(r.isError, true);
  w.state.jsOff = false;
  w.dom.document.querySelectorAll = () => { throw new TypeError("secret-internal detail"); };
  const o = JSON.parse(text(await pointClick(56 + 50, 157 + 10)));
  assert.equal(o.ok, false);
  assert.match(o.error, /could not check the page for embedded frames.*\(TypeError\)/);
  const s = JSON.stringify(o);
  for (const k of ["secret-internal", "__perch_error", "stack"]) assert.ok(!s.includes(k), s);
  assert.deepEqual(w.posted, []);
});
