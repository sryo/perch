// scripts/bench.mjs pieces that need no browser: the fixture server, scratch tab
// choice, and the baseline comparison that refuses to compare bytes across pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "../scripts/mcp-client.mjs";
import {
  parseArgs, FIXTURE_FILE, fixtureHash, serveFixture, pickScratch, restorable, compareLines,
} from "../scripts/bench.mjs";

test("--tab picks the scratch tab and defaults to none", () => {
  assert.equal(parseArgs([]).tab, undefined);
  assert.equal(parseArgs(["--tab", "chrome:1:2", "--tab", "chrome:1:3"]).tab, "chrome:1:3");
});

test("fixtureHash is a stable content hash", async () => {
  const html = await readFile(join(ROOT, FIXTURE_FILE));
  assert.match(fixtureHash(html), /^[0-9a-f]{64}$/);
  assert.equal(fixtureHash(html), fixtureHash(Buffer.from(html)));
  assert.notEqual(fixtureHash(html), fixtureHash(Buffer.concat([html, Buffer.from(" ")])));
});

test("serveFixture serves the fixture on 127.0.0.1 and nothing else", async () => {
  const html = await readFile(join(ROOT, FIXTURE_FILE));
  const server = await serveFixture(html);
  try {
    const u = new URL(server.url);
    assert.equal(u.protocol, "http:");
    assert.equal(u.hostname, "127.0.0.1");
    assert.ok(Number(u.port) > 0);
    const res = await fetch(server.url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.equal(fixtureHash(Buffer.from(await res.arrayBuffer())), fixtureHash(html));
    const miss = await fetch(new URL("/other.html", server.url));
    assert.equal(miss.status, 404);
    await miss.arrayBuffer();
  } finally {
    await server.close();
  }
  await assert.rejects(fetch(server.url));
});

const row = (o) => ({ app: "Google Chrome Canary", url: "about:blank", active: false, ...o });

test("pickScratch prefers a shown about:blank tab, frontmost browser first", () => {
  const tabs = [
    row({ tabId: "a", url: "https://example.test/", active: true }),
    row({ tabId: "b" }),
    row({ tabId: "c", active: true }),
    row({ tabId: "d", app: "Arc", active: true }),
  ];
  assert.equal(pickScratch(tabs, {}).tabId, "c");
  assert.equal(pickScratch(tabs.filter((t) => t.tabId !== "c"), {}).tabId, "d");
  assert.equal(pickScratch(tabs.slice(0, 2), {}).tabId, "b");
});

test("pickScratch never falls back to a tab the user is reading", () => {
  const tabs = [row({ tabId: "a", url: "https://example.test/", active: true })];
  assert.throws(() => pickScratch(tabs, {}), /about:blank/);
  assert.throws(() => pickScratch([], {}), /no browser tabs/);
});

test("pickScratch takes --tab when it can be navigated and restored", () => {
  const tabs = [row({ tabId: "a", url: "https://example.test/" }), row({ tabId: "b", url: "chrome://newtab/" })];
  assert.equal(pickScratch(tabs, { tabId: "a" }).tabId, "a");
  assert.throws(() => pickScratch(tabs, { tabId: "b" }), /http\(s\) or about:blank/);
  assert.throws(() => pickScratch(tabs, { tabId: "z" }), /not found/);
});

test("restorable is http(s) and about:blank only", () => {
  assert.equal(restorable("about:blank"), true);
  assert.equal(restorable("http://127.0.0.1:9/x"), true);
  assert.equal(restorable("https://example.test/"), true);
  for (const u of ["file:///tmp/x.html", "chrome://newtab/", "data:text/html,x", "", undefined]) assert.equal(restorable(u), false, String(u));
});

const report = (fixture, snapBytes) => ({
  rev: "r", macos: "27", browser: "Canary", date: "d", fixture,
  results: {
    list_tabs: { p50: 10, bytes: 100 },
    accessibility_snapshot: { p50: 20, bytes: snapBytes },
    schema: { tools: 17, chars: 8000 },
  },
});

test("compareLines compares bytes when the fixture matches", () => {
  const lines = compareLines(report({ sha256: "aa" }, 150), report({ sha256: "aa" }, 150)).join("\n");
  assert.doesNotMatch(lines, /warning/i);
  assert.match(lines, /accessibility_snapshot\s+20 -> 20 \(0%\)\s+150 -> 150/);
});

test("compareLines warns and skips bytes when the fixture differs or is unknown", () => {
  for (const before of [report({ sha256: "bb" }, 6668), report(undefined, 6668)]) {
    const lines = compareLines(before, report({ sha256: "aa" }, 150)).join("\n");
    assert.match(lines, /warning: .*fixture/i);
    assert.match(lines, /accessibility_snapshot\s+20 -> 20 \(0%\)/);
    assert.doesNotMatch(lines, /6668/);
    assert.doesNotMatch(lines, /100 -> 100/);
  }
});
