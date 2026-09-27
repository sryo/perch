// Sign-in, challenge and password controls inside frames are the user's: the
// snapshot flags them and a trusted frame click refuses them without posting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

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
    ] }] }],
    cg: [{ owner: "Terminal", pid: 1, wid: 10 }, { owner: "Google Chrome", pid: 4242, wid: 50, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ ...AREA, frames }] } }],
  });
  w.run(JXA_PRELUDE);
  DAEMONS.fast = w.daemon;
  DAEMONS.slow = w.daemon;
  w.reset();
  w.frames = frames;
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
  "about:blank",
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
