// A targeted call that needs the tab its window shows (a background screenshot,
// trusted input) on a hinted Chrome handle reads the window's shown tab first:
// the shown tab costs that one read; any other tab costs what it did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page } from "./helpers/page.mjs";

let world;
const NOT_AE = /^(win\.tabs|tabs\.byId|win\.activeTab|windows\[\d+\]\(.*\)|Application\(.*\)|running\(.*\)|deepUnwrap|CGWindowList)$/;
const events = () => Object.entries(world.counts).filter(([k]) => !NOT_AE.test(k) && !/^AX/.test(k)).reduce((s, [, n]) => s + n, 0);
const breakdown = () => JSON.stringify(Object.fromEntries(Object.entries(world.counts).filter(([k]) => !NOT_AE.test(k))));
const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  return { r, t, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};

function install() {
  const dom = page(`<button id=b>Go</button>`, { url: "https://c0.test/" });
  for (const [k, v] of Object.entries({ screenX: 0, screenY: 57, outerWidth: 654, innerWidth: 598, outerHeight: 600, innerHeight: 500 })) Object.defineProperty(dom, k, { value: v, configurable: true });
  const tabs = [{ url: "https://c0.test/", id: "c0", dom }, { url: "https://c1.test/", id: "c1", title: "c1" }];
  world = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, x: 0, y: 57, w: 854, h: 600, tabs }] }],
    cg: [{ owner: "Google Chrome", pid: 40, wid: 400, x: 0, y: 57, w: 854, h: 600, ax: { web: [{ x: 56, y: 157, w: 598, h: 500 }] } }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
}

test("a trusted click on a hinted, shown Chrome tab reads its window once; a hidden one is refused as before", async () => {
  install();
  const rows = (await call("list_tabs", {})).o.tabs;
  const shown = rows.find((t) => t.url === "https://c0.test/").tabId, hidden = rows.find((t) => t.url === "https://c1.test/").tabId;
  world.reset();
  const { o } = await call("click", { trusted: true, selector: "#b", target: { tabId: shown } });
  assert.equal(o.el, "button \"Go\"", JSON.stringify(o));
  // Was 6: the window's tab ids, then its shown tab's id. The probe and the check
  // are bounded executes, which the fake counts twice: live this is 3 events.
  assert.equal(events(), 5, breakdown());
  world.reset();
  const { t } = await call("click", { trusted: true, selector: "#b", target: { tabId: hidden } });
  assert.match(t, /^error: tab_not_visible/);
  assert.equal(events(), 2, breakdown());
});
