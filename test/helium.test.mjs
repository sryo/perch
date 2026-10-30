// Helium is a Chromium browser with Chrome's scripting dictionary (its sdef
// differs from Canary's only by an extra `select` command), so it takes the
// chrome kind and is listed and targeted like the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, BROWSERS } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

test("Helium is a chrome-kind browser with its own key and bundle id", () => {
  const h = BROWSERS.find((b) => b.app === "Helium");
  assert.deepEqual(h && { kind: h.kind, key: h.key, bundle: h.bundle }, { kind: "chrome", key: "helium", bundle: "net.imput.helium" });
});

test("list_tabs lists a Helium tab under a helium: handle", async () => {
  const world = makeWorld({
    browsers: [{ name: "Helium", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", title: "a", id: "t0" }] }] }],
    cg: [{ owner: "Helium" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  const r = await handleCall("list_tabs", {});
  assert.equal(r.isError, undefined, r.content[0].text);
  const rows = JSON.parse(r.content[0].text).tabs;
  assert.deepEqual(rows.map((t) => [t.app, t.tabId]), [["Helium", "helium:t0"]]);
});
