// Two perch servers can navigate one tab. Each navigate stamps the document it
// leaves, and a second server's stamp on that same document must not make the
// first read the old document as its own committed load.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const OLD = "http://127.0.0.1:8787/fixture.html";
function install() {
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: OLD, id: 7 }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}

// B's navigate lands on the old document before A's first check: its own stamp,
// then a load of its own that replaces A's and is slow to commit.
function bStampsAtFirstCheck(world) {
  let checks = 0;
  world.state.linger = 5;
  world.state.onExecute = (spec, js) => {
    if (!/href:location\.href,old:/.test(js) || checks++) return;
    world.state.linger = 1e9;
    vm.runInContext("(window.__perch_nav=window.__perch_nav||{}).nB='stamped!';location.assign('https://b.test/')", spec._page.ctx);
  };
}

test("navigate: another server's stamp on the document A is leaving is not A's committed load", async () => {
  const world = install();
  bStampsAtFirstCheck(world);
  const o = JSON.parse((await handleCall("navigate", { url: "https://a.test/", target: { tabId: "chrome:7" } })).content[0].text);
  assert.equal(world.page("Google Chrome", 0, 0).location.href, OLD, "the tab is still on the old document");
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.match(o.error, /^timeout: https:\/\/a\.test\/ had not committed/);
});
