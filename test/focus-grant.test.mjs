// perch moves the user's focus (raise:true, activate_tab, a new_tab that would
// raise its window) only under a grant the user gave: one file every perch process
// reads, with an expiry, and a log line per raise. Without one the call answers
// needs_focus and sends nothing. Room tabs move no Mac focus and need none. The
// suite's other tests run under a grant of their own (test/helpers/isolate.mjs).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { tempDir } from "../scripts/temp.mjs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { JXA_PRELUDE, DAEMONS, handleCall, focusReset, focusGrant, grantFocus, revokeFocus } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

let dir, world;
beforeEach(() => {
  dir = tempDir("focus-grant-");
  focusReset({ dir });
  world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "a" }, { url: "https://b.test/", id: "b" }] }] }],
    cg: [{ owner: "Terminal" }, { owner: "Google Chrome" }],
  });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
});
afterEach(() => { focusReset({ dir: process.env.PERCH_STATE }); });

const activates = () => world.log.filter(([k]) => k === "activate").length;
const sent = () => Object.keys(world.counts).filter((k) => !/^(CGWindowList|deepUnwrap|Application\(|running\()/.test(k)).length;

for (const [label, tool, args] of [
  ["activate_tab", "activate_tab", { target: { tabId: "chrome:b" } }],
  ["navigate {raise}", "navigate", { url: "https://c.test/", raise: true, target: { tabId: "chrome:a" } }],
  ["screenshot {raise}", "screenshot", { raise: true, target: { tabId: "chrome:b" } }],
  ["click {trusted, raise}", "click", { trusted: true, raise: true, x: 10, y: 10 }],
  ["new_tab file:", "new_tab", { app: "Google Chrome", url: "file:///tmp/p.html" }],
]) {
  test(`without a grant, ${label} answers needs_focus and sends nothing`, async () => {
    const r = await handleCall(tool, args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^error: needs_focus: /);
    assert.match(r.content[0].text, /perch focus allow/);
    assert.equal(activates(), 0);
    assert.equal(sent(), 0, JSON.stringify(world.counts));
  });
}

test("a grant lets activate_tab take focus, and the raise is logged", async () => {
  grantFocus(15, "test");
  const r = await handleCall("activate_tab", { target: { tabId: "chrome:b" } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(activates(), 1);
  const log = readFileSync(join(dir, "focus-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].tool, log[0].tabId, log[0].by], ["activate_tab", "chrome:b", "test"]);
});

test("an expired grant refuses like none", async () => {
  grantFocus(15, "test");
  assert.ok(focusGrant());
  assert.equal(focusGrant(Date.now() + 16 * 60000), null);
  revokeFocus();
  assert.equal(existsSync(join(dir, "focus-grant.json")), false);
  const r = await handleCall("activate_tab", { target: { tabId: "chrome:b" } });
  assert.match(r.content[0].text, /^error: needs_focus: /);
});

// About 14 perch processes run at once: a grant one of them wrote holds for all.
test("a grant written by another process is honoured", async () => {
  const server = new URL("../server.js", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(server)}); m.focusReset({ dir: ${JSON.stringify(dir)} }); m.grantFocus(15, "other process"); process.exit(0);`]);
  assert.equal(focusGrant().by, "other process");
  const r = await handleCall("activate_tab", { target: { tabId: "chrome:b" } });
  assert.equal(r.isError, undefined, r.content[0].text);
});

test("calls that move no focus need no grant", async () => {
  for (const [tool, args] of [["list_tabs", {}], ["eval_js", { script: "return 1", target: { tabId: "chrome:a" } }], ["new_tab", { app: "Google Chrome", url: "about:blank" }]]) {
    const r = await handleCall(tool, args);
    assert.doesNotMatch(r.content[0].text, /needs_focus/, tool);
  }
  assert.equal(activates(), 0);
});

test("a room tab moves no Mac focus, so it needs no grant", async () => {
  const r = await handleCall("activate_tab", { target: { tabId: "room:main:T1" } });
  assert.doesNotMatch(r.content[0].text, /needs_focus/);
});

// Behind the gate, the runtime's own focus() refuses a call that didn't pass it.
test("the runtime's focus() refuses a call that carries no grant", () => {
  assert.throws(() => world.run(`__perch.focusOk(false); __perch.activate({ target: { tabId: "chrome:b" } })`), /needs_focus/);
  assert.equal(activates(), 0);
});

// `perch focus allow 15m` needs a typed yes on a terminal (/dev/tty), which an
// agent's shell doesn't have, so an agent can't grant itself focus. detached runs
// the CLI in its own session, with no terminal even when the suite has one.
const cli = (...a) => { try { return { out: execFileSync(process.execPath, [new URL("../server.js", import.meta.url).pathname, "focus", ...a], { env: { ...process.env, PERCH_STATE: dir }, stdio: ["ignore", "pipe", "pipe"], detached: true }).toString(), code: 0 }; } catch (e) { return { out: String(e.stdout) + String(e.stderr), code: e.status }; } };
test("perch focus allow refuses without a terminal; status and revoke work", () => {
  const a = cli("allow", "15m");
  assert.notEqual(a.code, 0);
  assert.match(a.out, /terminal/);
  assert.equal(existsSync(join(dir, "focus-grant.json")), false);
  assert.match(cli("status").out, /no focus grant/);
  grantFocus(15, "test");
  assert.match(cli("status").out, /allowed until .* \(test\)/);
  assert.equal(cli("revoke").code, 0);
  assert.equal(existsSync(join(dir, "focus-grant.json")), false);
});

// With no grant, perch asks the user through the client (MCP elicitation) when the
// client can: accept writes a grant and the call goes on; a deny, no answer within
// the ask timeout, or a client that can't be asked leaves needs_focus.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, focusAsk } from "../server.js";
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

test("the user allows focus through the client: a grant is written and the call goes on", async () => {
  const { client, asked } = await connected(() => ({ action: "accept", content: { allow: "15 min" } }));
  const r = await activate(client);
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(asked.length, 1);
  assert.match(asked[0].message, /activate_tab/);
  assert.equal(focusGrant().by, "the user, asked by perch");
  assert.equal(activates(), 1);
  await client.close();
});

test("a deny, no answer, or a client that can't be asked leaves needs_focus", async () => {
  for (const answer of [() => ({ action: "accept", content: { allow: "Deny" } }), () => ({ action: "decline" }), () => new Promise(() => {}), null]) {
    focusAsk.ms = 50;
    const { client } = await connected(answer);
    const r = await activate(client);
    assert.match(r.content[0].text, /^error: needs_focus: /);
    assert.equal(focusGrant(), null);
    await client.close();
  }
  focusAsk.ms = 60000;
  assert.equal(activates(), 0);
});
