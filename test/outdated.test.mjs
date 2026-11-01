import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleCall, selfCheck } from "../server.js";

// An MCP client keeps one perch server for the whole session, so after a pull
// it runs old code and nothing says so. Each server records server.js's
// identity (mtime and size) at start, re-reads it at most every selfCheck.every
// ms, and once it differs adds one `outdated` note to the next result, once per
// server. The stat and the clock are faked here.
let ident, now;
beforeEach(() => {
  ident = "a";
  now = 1000;
  Object.assign(selfCheck, { id: "a", at: 1000, told: false, ident: () => ident, now: () => now });
});
const call = () => handleCall("no_such_tool", {});
const notes = (out) => out.content.filter((c) => c.type === "text" && c.text.includes("outdated"));

test("an unchanged server.js adds nothing", async () => {
  now += selfCheck.every;
  assert.equal(notes(await call()).length, 0);
});

test("a changed server.js is told once, on the next call after the throttle", async () => {
  ident = "b";
  assert.equal(notes(await call()).length, 0, "within the throttle the file is not read");
  now += selfCheck.every;
  const out = await call();
  const n = notes(out);
  assert.equal(n.length, 1);
  assert.match(n[0].text, /restart/);
  assert.ok(n[0].text.length <= 100, `note is ${n[0].text.length} chars`);
  assert.equal(out.content[0].text.startsWith("error: unknown tool"), true, "the call's own result comes first");
  now += selfCheck.every;
  assert.equal(notes(await call()).length, 0, "told once per server");
});

test("the file is read at most once per throttle window", async () => {
  let reads = 0;
  selfCheck.ident = () => { reads++; return ident; };
  for (let i = 0; i < 5; i++) await call();
  assert.equal(reads, 0);
  now += selfCheck.every;
  for (let i = 0; i < 5; i++) await call();
  assert.equal(reads, 1);
});

test("a vanished server.js (mid-checkout) is not a change", async () => {
  selfCheck.ident = () => null;
  now += selfCheck.every;
  assert.equal(notes(await call()).length, 0);
});

test("the real identity check takes well under a millisecond", async () => {
  const { selfIdent } = await import("../server.js");
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) selfIdent();
  const per = Number(process.hrtime.bigint() - t0) / 100 / 1e6;
  assert.ok(typeof selfIdent() === "string");
  assert.ok(per < 0.5, `${per.toFixed(3)}ms per check`);
});
