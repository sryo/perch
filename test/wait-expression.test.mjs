// wait {expression}: a broken expression is named rather than polled as "not
// yet" (a syntax error is refused before any Apple Event, a throw is named on
// timeout), "truthy" means JS truthiness, and a timeout carries the last falsy
// value seen. Fake world, virtual clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

let world;
function install() {
  world = makeWorld({ browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x" }] }] }], cg: [{ owner: "Google Chrome" }] });
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
const call = async (name, args) => {
  const r = await handleCall(name, args);
  const t = r.content.find((c) => c.type === "text")?.text;
  return { r, t, o: (() => { try { return JSON.parse(t); } catch { return t; } })() };
};
const executes = () => world.counts["tab.execute"] || 0;

test("a syntax error in the expression is bad_args naming it, with no Apple Event", async () => {
  install();
  const { r, t } = await call("wait", { expression: "document.title ===", timeout: 2000 });
  assert.equal(r.isError, true);
  assert.match(t, /^error: bad_args: wait `expression` does not parse: SyntaxError: /);
  assert.equal(executes(), 0);
  assert.equal(world.counts["windows[0](Google Chrome)"], undefined);
});

test("an expression that throws on every poll names the exception on timeout", async () => {
  install();
  const { r, t } = await call("wait", { expression: "missing.ready", timeout: 300 });
  assert.equal(r.isError, true);
  assert.equal(t, "error: timeout: wait timed out after 300ms; the expression threw ReferenceError: missing is not defined");
  assert.ok(executes() >= 2, "it kept polling: a throw can be a page not ready yet");
});

test("an expression that throws, then comes true, returns its value", async () => {
  install();
  world.run("0");
  const { o } = await call("wait", { expression: "(window.n = (window.n || 0) + 1) > 2 ? window.n : missing.x", timeout: 2000 });
  assert.equal(o.ok, true);
  assert.equal(o.value, 3);
});

test("a value that can't be serialized is named, not polled as not yet", async () => {
  install();
  const { t } = await call("wait", { expression: "(function () { var o = {}; o.o = o; return o; })()", timeout: 300 });
  assert.match(t, /^error: timeout: wait timed out after 300ms; the expression threw TypeError: /);
});

test("falsy values keep waiting, and the timeout names the last one unless it is false", async () => {
  install();
  for (const [expression, tail] of [["0", "; last value: 0"], ["''", '; last value: ""'], ["null", "; last value: null"], ["undefined", "; last value: null"], ["false", ""]]) {
    const { t } = await call("wait", { expression, timeout: 300 });
    assert.equal(t, "error: timeout: wait timed out after 300ms" + tail, expression);
  }
});

test("truthy values end the wait and come back as value, including empty objects and arrays", async () => {
  install();
  for (const [expression, value] of [["1", 1], ["'x'", "x"], ["({n: 2})", { n: 2 }], ["[]", []], ["true", true]]) {
    const { o } = await call("wait", { expression });
    assert.equal(o.ok, true, expression);
    assert.deepEqual(o.value, value, expression);
  }
});

test("an exception message is capped", async () => {
  install();
  const { t } = await call("wait", { expression: "(function () { throw new Error('x'.repeat(5000)); })()", timeout: 300 });
  assert.ok(t.length < 400, `length ${t.length}`);
  assert.match(t, /threw Error: x+/);
});
