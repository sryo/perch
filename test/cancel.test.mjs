import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DAEMONS, handleCall, createServer } from "../server.js";

// A client that gives up on a call (its own timeout, the user's stop) sends
// notifications/cancelled. A call still waiting in the page (wait, an eval_js
// await) is then aborted: its REPL job fails as a timeout's would, so the tab lock
// and the lane are free for the next call. A call that may have acted (a click,
// a fill) is left to finish, as perch never cuts a step with side effects.
let jobs;
const hanging = () => ({
  run: (script, timeout, token) => new Promise((resolve, reject) => { jobs.push({ script, token, resolve, reject }); }),
  abort(err, token) {
    const j = jobs.find((x) => x.token === token && !x.done);
    if (!j || token === undefined) return false;
    j.done = true; j.aborted = true; j.reject(err);
    return true;
  },
});
const quick = { run: async () => "null" };
beforeEach(() => {
  jobs = [];
  for (const k of Object.keys(DAEMONS)) delete DAEMONS[k];
  Object.assign(DAEMONS, { fast: quick, slow: hanging(), long: hanging() });
});
const tick = () => new Promise((r) => setImmediate(r));

test("a cancelled wait aborts its page poll and frees the tab for the next call", async () => {
  const ac = new AbortController();
  const target = { tabId: "canary:1" };
  const first = handleCall("wait", { quiet: 1000, timeout: 600000, target }, { signal: ac.signal });
  await tick();
  assert.equal(jobs.length, 1, "the wait is running in the page");
  ac.abort();
  const r = await first;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^error: cancelled/);
  assert.equal(jobs[0].aborted, true);
  const second = handleCall("wait", { quiet: 100, timeout: 1000, target });
  await tick();
  assert.equal(jobs.length, 2, "the next call on the tab is not held behind the cancelled one");
  jobs[1].resolve('{"ok":true}');
  await second;
});

test("an eval_js await that is cancelled stops polling", async () => {
  const ac = new AbortController();
  const p = handleCall("eval_js", { script: "await new Promise(() => {})", awaitPromise: true, timeout: 120000, target: { tabId: "canary:1" } }, { signal: ac.signal });
  await tick();
  assert.equal(jobs.length, 1);
  ac.abort();
  const r = await p;
  assert.match(r.content[0].text, /^error: cancelled/);
  assert.equal(jobs[0].aborted, true);
});

test("a call already cancelled when it starts sends nothing", async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await handleCall("wait", { expression: "false", timeout: 5000, target: { tabId: "canary:1" } }, { signal: ac.signal });
  assert.match(r.content[0].text, /^error: cancelled/);
  assert.equal(jobs.length, 0);
});

test("a cancelled click is left to finish: it may already have acted", async () => {
  DAEMONS.fast = hanging();
  const ac = new AbortController();
  const p = handleCall("click", { selector: "#b", target: { tabId: "canary:1" } }, { signal: ac.signal });
  await tick();
  assert.equal(jobs.length, 1);
  ac.abort();
  await tick();
  assert.equal(jobs[0].aborted, undefined);
  jobs[0].resolve('{"ok":true}');
  await p;
});

// The wiring an MCP client sees: the SDK aborts the request's signal on
// notifications/cancelled, and the server passes it to handleCall.
test("an MCP client's cancel reaches a running wait", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const ac = new AbortController();
  const call = client.callTool({ name: "wait", arguments: { expression: "false", timeout: 600000, target: { tabId: "canary:1" } } }, undefined, { signal: ac.signal, timeout: 700000 });
  for (let i = 0; i < 50 && !jobs.length; i++) await tick();
  assert.equal(jobs.length, 1);
  ac.abort();
  await assert.rejects(call);
  for (let i = 0; i < 50 && !jobs[0].aborted; i++) await tick();
  assert.equal(jobs[0].aborted, true, "the page poll was aborted, not left running");
  await client.close();
});
