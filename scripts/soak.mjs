#!/usr/bin/env node
// Live soak (opt-in, --yes): several perch servers drive one loft tab on a
// 127.0.0.1 fixture for --rounds rounds (snapshot, fill, eval_js, get_text each).
// Midway one server is killed with SIGKILL mid-call and replaced. It reports
// failures, p50/p95 latency, the servers' resident memory at start and end,
// and fails on a moved foreground app or a tab claim left behind.
//   node scripts/soak.mjs --yes [--servers 3] [--rounds 30] [--no-kill]
// It opens its tab with new_tab {loft}, which takes no focus, but still waits
// until the user has been idle 5 minutes, as every live new_tab does. It never
// quits or relaunches a browser.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, text } from "./mcp-client.mjs";

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : Number(argv[i + 1]); };
if (!argv.includes("--yes")) { console.error("soak drives a loft tab with several perch servers; pass --yes"); process.exit(2); }
const N = opt("--servers", 3), ROUNDS = opt("--rounds", 30), KILL = !argv.includes("--no-kill");

const idle = () => Number(/"HIDIdleTime" = (\d+)/.exec(execFileSync("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8" }))[1]) / 1e9;
if (idle() < 300) console.error("waiting until the user has been idle 5 minutes");
while (idle() < 300) await new Promise((r) => setTimeout(r, 15000));

const HTML = `<!doctype html><title>soak</title><form><label>Email <input id=e name=email></label><label>Note <textarea id=n></textarea></label><button type=button>Send</button></form>`;
const srv = createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(HTML); }).listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const url = `http://127.0.0.1:${srv.address().port}/`;
const front = () => execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
// A server's resident memory and its osascript lanes', in KB.
const rss = (pid) => {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
    return rows.filter(([p, pp]) => p === pid || pp === pid).reduce((a, [, , k]) => a + k, 0);
  } catch { return 0; }
};

const f0 = front(), fails = [], ms = [];
let servers = await Promise.all(Array.from({ length: N }, () => connect({ timeoutMs: 60000 })));
const pids = () => servers.map((s) => s.pid);
const mem0 = servers.map((s) => rss(s.pid));
let tab = null;
const timed = async (s, name, args) => {
  const t0 = Date.now();
  try {
    const r = await s.call(name, args);
    ms.push(Date.now() - t0);
    if (r.isError) fails.push(`${name}: ${text(r).slice(0, 140)}`);
    return r;
  } catch (e) { fails.push(`${name}: ${e.message}`); return null; }
};
try {
  tab = JSON.parse(text(await servers[0].call("new_tab", { url, loft: "1280x800" })));
  if (!tab.tabId) throw new Error(`new_tab: ${JSON.stringify(tab)}`);
  const target = { tabId: tab.tabId };
  await servers[0].call("wait", { target, selector: "#e", timeout: 15000 });
  for (let round = 0; round < ROUNDS; round++) {
    if (KILL && round === Math.floor(ROUNDS / 2)) {
      // Killed with a call in flight; its replacement joins the next round.
      const victim = servers[N - 1];
      victim.call("accessibility_snapshot", { target }).catch(() => {});
      await new Promise((r) => setTimeout(r, 30));
      process.kill(victim.pid, "SIGKILL");
      servers[N - 1] = await connect({ timeoutMs: 60000 });
    }
    await Promise.all(servers.map(async (s, i) => {
      await timed(s, "accessibility_snapshot", { target });
      await timed(s, "fill", { target, selector: i % 2 ? "#n" : "#e", text: `r${round}s${i}@x.test` });
      await timed(s, "eval_js", { target, script: "document.querySelector('#e').value" });
      await timed(s, "get_text", { target, selector: "form" });
    }));
    if (front() !== f0) fails.push(`round ${round}: the foreground moved to ${front()}`);
  }
} catch (e) {
  fails.push(`setup: ${e.message}`);
} finally {
  if (tab && tab.tabId) {
    const c = await servers[0].call("close_tab", { tabId: tab.tabId }).catch((e) => ({ content: [{ type: "text", text: e.message }] }));
    if (!/"ok":true/.test(text(c) || "")) fails.push(`close_tab: ${text(c)}`);
  }
  const mem1 = servers.map((s) => rss(s.pid));
  for (const s of servers) s.close();
  srv.close();
  const dir = join(process.env.ROOMS_HOME || join(homedir(), ".rooms"), "run", "tabs");
  let left = [];
  try { left = readdirSync(dir).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } }).filter((c) => c && tab && c.tabId === tab.tabId); } catch {}
  if (left.length) fails.push(`a claim on ${tab.tabId} was left behind`);
  if (front() !== f0) fails.push(`the foreground moved to ${front()}`);
  ms.sort((a, b) => a - b);
  const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  console.log(JSON.stringify({ servers: N, rounds: ROUNDS, killed: KILL, calls: ms.length, p50: q(0.5), p95: q(0.95), rssKB: { start: mem0, end: mem1 }, pids: pids(), fails: fails.slice(0, 20), failCount: fails.length }, null, 1));
  process.exitCode = fails.length ? 1 : 0;
}
