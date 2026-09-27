// How osascript failures reach the caller: permission errors become the actionable
// ERR messages, a killed one-shot is a timeout, AppleScript's wrapping is stripped,
// and PERCH_DAEMON=0 runs every call one-shot. No real osascript runs here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ERR, translatePermissionError, formatOsaFailure, jxa } from "../server.js";

test("translatePermissionError maps each known wording, and nothing else", () => {
  for (const msg of [
    "Error: Executing JavaScript through AppleScript is turned off. To turn it on, ... Allow JavaScript from Apple Events",
    "JavaScript from Apple events is turned off",
  ]) assert.equal(translatePermissionError(msg), ERR.jsOff, msg);
  for (const msg of [
    "execution error: Not authorized to send Apple events to Google Chrome. (-1743)",
    "errAEEventNotPermitted",
  ]) assert.equal(translatePermissionError(msg), ERR.automation, msg);
  assert.equal(translatePermissionError("execution error: Error: Can't get object. (-1728)"), null);
  assert.equal(translatePermissionError(""), null);
});

test("formatOsaFailure: killed is a coded timeout, permissions translate, wrapping is stripped", () => {
  assert.equal(formatOsaFailure({ killed: true, stderr: "anything" }, 1234), ERR.timeout(1234));
  assert.match(formatOsaFailure({ killed: true }, 1234), /^timeout: /);
  assert.equal(formatOsaFailure({ stderr: "execution error: Not authorized to send Apple events to Arc. (-1743)" }, 1), ERR.automation);
  assert.equal(formatOsaFailure({ stderr: "0:12: execution error: Error: stale_tab: tab c1 is gone; re-run list_tabs (-2700)\n" }, 1),
    "stale_tab: tab c1 is gone; re-run list_tabs");
  // A multi-line message keeps its body; only the prefix and the trailing code go.
  assert.equal(formatOsaFailure({ stderr: "execution error: Error: line one\nline two (-2700)" }, 1), "line one\nline two");
  assert.equal(formatOsaFailure({ message: "spawn osascript ENOENT" }, 1), "spawn osascript ENOENT");
});

// A real execFile error always has a message ("Command failed: <cmd>\n<stderr>"),
// and for one-shot the command line carries the whole prelude.
test("formatOsaFailure: a silent exit 1 is an Automation denial, not the command line", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const e = await promisify(execFile)("sh", ["-c", "exit 1", "PRELUDE"]).catch((err) => err);
  assert.equal(e.code, 1);
  assert.equal(e.stderr, "");
  assert.equal(formatOsaFailure(e, 1000), ERR.automation);
});

test("jxa: a daemon permission failure is translated and never retried one-shot", async () => {
  let shots = 0;
  const oneShot = async () => { shots++; return "x"; };
  const denied = { run: async () => { throw new Error("Not authorized to send Apple events to Safari. (-1743)"); } };
  await assert.rejects(jxa("1", { daemons: { fast: denied }, oneShot }), (e) => e.message === ERR.automation);
  assert.equal(shots, 0);
  const other = { run: async () => { throw new Error("stale_tab: gone"); } };
  await assert.rejects(jxa("1", { daemons: { fast: other }, oneShot }), (e) => e.message === "stale_tab: gone");
  assert.equal(shots, 0);
});

test("jxa: the slow lane falls back to the fast daemon, and no daemons means one-shot", async () => {
  const ran = [];
  const fast = { run: async (s) => { ran.push(["fast", s]); return "f"; } };
  assert.equal(await jxa("1", { lane: "slow", daemons: { fast }, oneShot: async () => "o" }), "f");
  assert.deepEqual(ran, [["fast", "1"]]);
  let args;
  assert.equal(await jxa("2", { timeout: 77, daemons: {}, oneShot: async (s, o) => { args = [s, o]; return "o"; } }), "o");
  assert.deepEqual(args, ["2", { timeout: 77 }]);
});

test("PERCH_DAEMON=0 builds no daemons", () => {
  const server = fileURLToPath(new URL("../server.js", import.meta.url));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(server)}); console.log(JSON.stringify(Object.keys(m.DAEMONS))); process.exit(0);`],
  { env: { ...process.env, PERCH_DAEMON: "0" }, encoding: "utf8", timeout: 10000 });
  assert.equal(out.trim(), "[]");
});

// ---- one-shot: through deps.exec, so no osascript runs ----

async function oneShot(fake, timeout = 4321) {
  const { deps, JXA_PRELUDE } = await import("../server.js");
  const real = deps.exec;
  const calls = [];
  deps.exec = async (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return fake(); };
  try {
    const out = await jxa("__perch.x()", { timeout, daemons: {} }).then((v) => ({ v }), (e) => ({ e }));
    return { ...out, calls, JXA_PRELUDE };
  } finally { deps.exec = real; }
}

test("one-shot runs the prelude and the script in one osascript -e, and strips one trailing newline", async () => {
  const { v, calls, JXA_PRELUDE } = await oneShot(async () => ({ stdout: "result\n\n" }));
  assert.equal(v, "result\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "osascript");
  assert.deepEqual(calls[0].argv, ["-l", "JavaScript", "-e", JXA_PRELUDE + ";\n__perch.x()"]);
  assert.equal(calls[0].opts.timeout, 4321);
  assert.ok(calls[0].opts.maxBuffer >= 32 << 20);
});

test("one-shot failures: killed is a coded timeout, silent exit 1 is Automation, stderr is cleaned", async () => {
  const fail = (props) => async () => { throw Object.assign(new Error("Command failed: osascript -l JavaScript -e <prelude>"), props); };
  let { e } = await oneShot(fail({ killed: true, signal: "SIGTERM", stderr: "" }), 500);
  assert.equal(e.message, ERR.timeout(500));
  ({ e } = await oneShot(fail({ code: 1, stderr: "" })));
  assert.equal(e.message, ERR.automation);
  ({ e } = await oneShot(fail({ code: 1, stderr: "0:5: execution error: Error: stale_tab: tab s1 is gone; re-run list_tabs (-2700)\n" })));
  assert.equal(e.message, "stale_tab: tab s1 is gone; re-run list_tabs");
  assert.doesNotMatch(e.message, /Command failed|prelude/);
});
