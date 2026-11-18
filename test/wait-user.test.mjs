// wait {user}: the agent hands a step to the user (a sign-in, a 2FA code) and keeps
// going once the page shows it done, with no turn in chat. perch notifies the user
// once, then polls until no sign-in UI is left (password or one-time-code field, a
// sign-in or challenge frame, a login path) and the page moved on: the sign-in UI was
// there at the start, or the URL changed. It answers outcome continued, timeout (call
// again to keep waiting, with no second notice) or closed. It never raises the tab.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, deps } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

let world, dom, shown;
function onPage(html, url = "https://a.test/p") {
  dom = page(html, { url });
  world = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 7, active: 0, tabs: [{ url, id: "x", dom }, { url: "https://z.test/", id: "z" }] }] }], cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  DAEMONS.long = world.daemon;
  world.reset();
}
beforeEach(() => { shown = []; deps.notify = async (a) => { shown.push(a); return { ok: true }; }; });
const call = async (args) => { const r = await handleCall("wait", args), t = r.content[0].text; return { r, o: r.isError ? t : JSON.parse(t) }; };
const target = { tabId: "chrome:x" };
const after = (n, fn) => { let k = 0; world.state.onDelay = () => { if (++k === n) fn(); }; };
const noFocus = () => {
  assert.ok(!world.log.some(([k]) => k === "activate"));
  for (const k of ["tab.select", "win.activeTabIndex=", "win.index="]) assert.equal(world.counts[k], undefined, k);
};

test("a sign-in form the user completes: one notice, then continued with the page it left", async () => {
  onPage(`<form><input name=u><input type=password id=pw></form>`, "https://a.test/login");
  after(3, () => { dom.document.getElementById("pw").remove(); dom.happyDOM.setURL("https://a.test/home"); dom.document.title = "Home"; });
  const { r, o } = await call({ user: "Sign in to a.test", target, timeout: 60000 });
  assert.equal(r.isError, undefined, JSON.stringify(o));
  assert.equal(o.ok, true);
  assert.equal(o.outcome, "continued");
  assert.equal(o.url, "https://a.test/home");
  assert.equal(o.title, "Home");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].message, "Sign in to a.test");
  assert.match(shown[0].subtitle, /a\.test/);
  noFocus();
});

test("a password field still there is not done; the call times out and a second call resumes without a second notice", async () => {
  onPage(`<input type=password>`);
  let { o } = await call({ user: "Sign in", target, timeout: 1000 });
  assert.equal(o.ok, false);
  assert.equal(o.outcome, "timeout");
  assert.match(o.note, /wait \{user\}/);
  after(2, () => dom.document.querySelector("input").remove());
  ({ o } = await call({ user: "Sign in", target, timeout: 60000 }));
  assert.equal(o.outcome, "continued");
  assert.equal(shown.length, 1, "the user was told once");
});

test("a page with no sign-in UI is done only once the URL changes (a payment step that redirects)", async () => {
  onPage(`<button>Pay</button>`, "https://a.test/checkout");
  let { o } = await call({ user: "Approve the payment", target, timeout: 1000 });
  assert.equal(o.outcome, "timeout");
  after(2, () => dom.happyDOM.setURL("https://a.test/thanks"));
  ({ o } = await call({ user: "Approve the payment", target, timeout: 60000 }));
  assert.equal(o.outcome, "continued");
  assert.equal(o.url, "https://a.test/thanks");
});

test("a challenge frame counts as sign-in UI until it goes; an ordinary frame does not", async () => {
  onPage(`<iframe id=f src="https://challenges.cloudflare.com/x"></iframe><iframe src="https://ads.test/"></iframe>`);
  after(2, () => dom.document.getElementById("f").remove());
  const { o } = await call({ user: "Solve the check", target, timeout: 60000 });
  assert.equal(o.outcome, "continued");
});

test("the tab closing ends the wait as closed", async () => {
  onPage(`<input type=password>`);
  after(2, () => world.closeTab("Google Chrome", 0, 0));
  const { o } = await call({ user: "Sign in", target, timeout: 60000 });
  assert.equal(o.ok, false);
  assert.equal(o.outcome, "closed");
});

test("user takes a non-empty string and no selector, expression, quiet or job, before any Apple Event", async () => {
  onPage(`<input type=password>`);
  for (const args of [{ user: "" }, { user: 3 }, { user: "x", selector: "#a" }, { user: "x", expression: "1" }, { user: "x", quiet: 500 }]) {
    const { r, o } = await call({ target, ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(o, /^error: bad_args: wait `user`/, JSON.stringify(args));
  }
  assert.deepEqual(world.aeLog, []);
  assert.equal(shown.length, 0);
});
