// perch moves the user's focus (raise:true, activate_tab, a new_tab that would
// raise its window) only once the user allowed it: the first such call asks through
// the client, and a yes lasts for that server's life. Without one the call answers
// needs_focus and sends nothing. Room tabs move no Mac focus and need none. The
// suite's other tests run with focus granted (test/helpers/isolate.mjs).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall, focus } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

let world;
beforeEach(() => {
  focus.granted = false;
  world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "a" }, { url: "https://b.test/", id: "b" }] }] }],
    cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
});
afterEach(() => { focus.granted = true; });

const activates = () => world.log.filter(([k]) => k === "activate").length;
const sent = () => Object.keys(world.counts).filter((k) => !/^(CGWindowList|deepUnwrap|Application\(|running\()/.test(k)).length;

for (const [label, tool, args] of [
  ["activate_tab", "activate_tab", { target: { tabId: "chrome:b" } }],
  ["navigate {raise}", "navigate", { url: "https://c.test/", raise: true, target: { tabId: "chrome:a" } }],
  ["screenshot {raise}", "screenshot", { raise: true, target: { tabId: "chrome:b" } }],
  ["click {trusted, raise}", "click", { trusted: true, raise: true, x: 10, y: 10 }],
  ["new_tab file:", "new_tab", { app: "Google Chrome", url: "file:///tmp/p.html" }],
  // Live (Canary, 2026-10-31): a tab made through AppleScript brings a Chromium
  // browser to the front even into a window behind other apps.
  ["new_tab on Chromium", "new_tab", { app: "Google Chrome", url: "about:blank" }],
  ["new_tab in the default browser", "new_tab", { url: "about:blank" }],
]) {
  test(`without a grant, ${label} answers needs_focus and sends nothing`, async () => {
    const r = await handleCall(tool, args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^error: needs_focus: /);
    assert.match(r.content[0].text, /allow it when perch asks/);
    assert.equal(activates(), 0);
    assert.equal(sent(), 0, JSON.stringify(world.counts));
  });
}

test("calls that move no focus need no grant", async () => {
  for (const [tool, args] of [["list_tabs", {}], ["eval_js", { script: "return 1", target: { tabId: "chrome:a" } }], ["new_tab", { app: "Safari", url: "about:blank" }]]) {
    const r = await handleCall(tool, args);
    assert.doesNotMatch(r.content[0].text, /needs_focus/, tool);
  }
  assert.equal(activates(), 0);
});

test("a room tab moves no Mac focus, so it needs no grant", async () => {
  const r = await handleCall("activate_tab", { target: { tabId: "room:main:T1" } });
  assert.doesNotMatch(r.content[0].text, /needs_focus/);
});

// With no grant, perch asks the user through the client (MCP elicitation) when the
// client can: a yes grants focus for the server's life, so later calls don't ask; a
// deny, no answer within the ask timeout, or a client that can't be asked leaves
// needs_focus.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../server.js";
async function connected(answer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "t", version: "0" }, answer ? { capabilities: { elicitation: {} } } : {});
  const asked = [];
  if (answer) client.setRequestHandler(ElicitRequestSchema, async (req) => { asked.push(req.params); return answer(req.params); });
  await client.connect(b);
  return { client, asked };
}
const activate = (client) => client.callTool({ name: "activate_tab", arguments: { target: { tabId: "chrome:b" } } });

test("the user allows focus through the client once, and the session keeps it", async () => {
  const { client, asked } = await connected(() => ({ action: "accept", content: { allow: "Allow for this session" } }));
  for (let i = 0; i < 2; i++) {
    const r = await activate(client);
    assert.equal(r.isError, undefined, r.content[0].text);
  }
  assert.equal(asked.length, 1);
  assert.match(asked[0].message, /activate_tab/);
  assert.equal(activates(), 2);
  await client.close();
});

test("a deny, no answer, or a client that can't be asked leaves needs_focus", async () => {
  for (const answer of [() => ({ action: "accept", content: { allow: "Deny" } }), () => ({ action: "decline" }), () => new Promise(() => {}), null]) {
    focus.askMs = 50;
    const { client } = await connected(answer);
    const r = await activate(client);
    assert.match(r.content[0].text, /^error: needs_focus: /);
    assert.equal(focus.granted, false);
    await client.close();
  }
  focus.askMs = 60000;
  assert.equal(activates(), 0);
});
