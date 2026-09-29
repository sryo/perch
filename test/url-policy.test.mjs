// perch loads absolute http(s) and file URLs and about:blank. Anything else is
// refused as bad_url in Node, before any Apple Event, and again in the runtime
// before it can reach a url-setting call.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { JXA_PRELUDE, DAEMONS, HANDLERS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";

const chrome = (windows) => ({ name: "Google Chrome", kind: "chrome", windows });
const arc = (windows) => ({ name: "Arc", kind: "arc", windows });
const safari = (windows) => ({ name: "Safari", kind: "safari", windows });
const two = (p, ids) => [{ url: `https://${p}0.test/`, title: `${p}0`, id: ids[0] }, { url: `https://${p}1.test/`, title: `${p}1`, id: ids[1] }];

const FIXTURES = {
  chrome: () => ({ browsers: [chrome([{ id: 1, active: 0, tabs: two("c", [7, 8]) }])], cg: [{ owner: "Google Chrome" }] }),
  chromeAway: () => ({ browsers: [chrome([{ id: 1, active: 0, tabs: two("c", [7, 8]) }])], cg: [{ owner: "Finder", pid: 50 }, { owner: "Google Chrome" }] }),
  arc: () => ({ browsers: [arc([{ id: "A", active: 0, tabs: two("a", ["a0", "a1"]) }])], cg: [{ owner: "Arc" }] }),
  safari: () => ({ browsers: [safari([{ id: 3, active: 0, tabs: two("s", ["s0", "s1"]) }])], cg: [{ owner: "Safari" }] }),
};

const CASES = [
  ["new_tab chrome", "chrome", "new_tab", { app: "Google Chrome" }],
  ["new_tab arc", "arc", "new_tab", { app: "Arc" }],
  ["new_tab safari", "safari", "new_tab", { app: "Safari" }],
  ["navigate chrome front tab", "chrome", "navigate", {}],
  ["navigate chrome background tab", "chrome", "navigate", { target: { tabId: "chrome:8" } }],
  ["navigate safari", "safari", "navigate", {}],
  ["navigate raise:true", "chromeAway", "navigate", { raise: true }],
];

const REFUSED = [
  ["not a url", "no scheme"],
  ["example.com", "no scheme; pass https://example.com"],
  ["localhost:3000", "no scheme; pass http://localhost:3000"],
  ["localhost:3000/a?b", "no scheme; pass http://localhost:3000"],
  ["127.0.0.1:8080", "no scheme; pass http://127.0.0.1:8080"],
  ["[::1]:5173", "no scheme; pass http://[::1]:5173"],
  ["app.localhost:3000", "no scheme; pass http://app.localhost:3000"],
  ["shop.test", "no scheme; pass http://shop.test"],
  ["example.com:8443", "no scheme; pass https://example.com:8443"],
  ["javascript:1", "javascript"],
  ["JavaScript:1/", "javascript"],
  ["data:1", "data"],
  ["vbscript:1", "vbscript"],
  ["tel:5551234", "tel"],
  ["ws:8080", "ws"],
  ["view-source:80", "view-source"],
  ["about:1", "about"],
  ["/relative", "no scheme"],
  ["javascript:alert(1)", "javascript"],
  [" JavaScript:alert(1)", "javascript"],
  ["file:relative", "file"],
  ["data:text/html,x", "data"],
  ["chrome://settings", "chrome"],
  ["arc://newtab", "arc"],
  ["about:config", "about"],
  ["http://", "http"],
  ["", "no scheme"],
  [42, "a number"],
  [{}, "a object"],
];

// Hashes of {text, log, counts, ms} from the same calls before the policy
// existed: an accepted url behaves exactly as it did.
const BEFORE = Object.fromEntries(Object.entries({
  "new_tab chrome": { "https://n.test/": "53fe62243a43", "HTTP://N.TEST/": "171c6afcdcb1", "about:blank": "0bccf24daee8", "ABOUT:BLANK": "4dc47825f0cf", "(none)": "0bccf24daee8" },
  "new_tab arc": { "https://n.test/": "4fd286a4fc95", "HTTP://N.TEST/": "58dc3a653b64", "about:blank": "a2b3fa110815", "ABOUT:BLANK": "1517ebde3e71", "(none)": "a2b3fa110815" },
  "new_tab safari": { "https://n.test/": "c6ea10cfe6e0", "HTTP://N.TEST/": "af75fbddd6dd", "about:blank": "ed52b752901f", "ABOUT:BLANK": "93198762b7ed", "(none)": "ed52b752901f" },
  "navigate chrome front tab": { "https://n.test/": "41c7efeb27fa", "HTTP://N.TEST/": "2471e9b7bf4d", "about:blank": "19c3af526886", "ABOUT:BLANK": "acaebef29b5e" },
  "navigate chrome background tab": { "https://n.test/": "0e5f82c4a2ad", "HTTP://N.TEST/": "b7bbf7bc3aa6", "about:blank": "0b2b02db69d1", "ABOUT:BLANK": "a9a286798003" },
  "navigate safari": { "https://n.test/": "c1b816dde80d", "HTTP://N.TEST/": "ec4d9f8b6a80", "about:blank": "e7dbcbb6fe31", "ABOUT:BLANK": "4f8f400011d2" },
  "navigate raise:true": { "https://n.test/": "41c7efeb27fa", "HTTP://N.TEST/": "2471e9b7bf4d", "about:blank": "19c3af526886", "ABOUT:BLANK": "acaebef29b5e" },
}).flatMap(([c, o]) => Object.entries(o).map(([u, h]) => [`${c}|${u}`, h])));

// The same calls with a file: url before the policy existed. navigate from a
// window behind another app still needs raise:true.
const FILE_BEFORE = {
  "new_tab chrome": ["d7f298402483", "91a414df1711"],
  "new_tab arc": ["e98ca1f37729", "79a4ab6ecfba"],
  "new_tab safari": ["3e8b546c42dd", "588b3fef6d00"],
  "navigate chrome front tab": ["61b903d42db8", "af17a158e1e6"],
  "navigate chrome background tab": ["4b7a84b076b7", "5b1cc67ec094"],
  "navigate safari": ["d905d0c75e09", "7abd1cab6ead"],
  "navigate raise:true": ["a68035db1f23", "0c7d2f2b2b36"],
};

const ACCEPTED = ["https://n.test/", "HTTP://N.TEST/", "about:blank", "ABOUT:BLANK", " https://n.test/ "];

let world;
function install(spec) {
  world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}

beforeEach(() => { world = null; });

async function observe(fixture, tool, args) {
  install(FIXTURES[fixture]());
  const t0 = world.clock.t;
  const r = await handleCall(tool, args);
  const seen = { text: r.content[0].text, isError: !!r.isError, log: world.log, counts: world.counts, ms: world.clock.t - t0 };
  return { seen, hash: createHash("sha1").update(JSON.stringify(seen)).digest("hex").slice(0, 12) };
}

for (const [name, fixture, tool, extra] of CASES) {
  const inputs = tool === "new_tab" ? [...ACCEPTED, undefined] : ACCEPTED;
  test(`${name}: accepted urls behave as before`, async () => {
    for (const url of inputs) {
      const args = url === undefined ? { ...extra } : { ...extra, url };
      const { seen, hash } = await observe(fixture, tool, args);
      const key = `${name}|${url === undefined ? "(none)" : url.trim()}`;
      assert.equal(seen.isError, false, `${key}: ${seen.text}`);
      assert.equal(hash, BEFORE[key], `${key} changed: ${JSON.stringify(seen)}`);
    }
  });

  test(`${name}: file: urls behave as before`, async () => {
    for (const [i, url] of ["file:///tmp/p.html", "FILE:///tmp/p.html"].entries()) {
      const { seen, hash } = await observe(fixture, tool, { ...extra, url });
      assert.equal(seen.isError, false, `${url}: ${seen.text}`);
      assert.equal(hash, FILE_BEFORE[name][i], `${url} changed: ${JSON.stringify(seen)}`);
    }
  });

  test(`${name}: refuses anything but http(s), file and about:blank, before any Apple Event`, async () => {
    for (const [url, got] of REFUSED) {
      install(FIXTURES[fixture]());
      const r = await handleCall(tool, { ...extra, url });
      const t = r.content[0].text;
      const label = JSON.stringify(url);
      assert.equal(r.isError, true, `${label}: ${t}`);
      assert.match(t, /^error: bad_url: /, label);
      assert.ok(t.endsWith(`got ${got}`), `${label}: ${t}`);
      assert.ok(!t.includes("text/html,x"), `${label} echoed the url: ${t}`);
      assert.deepEqual(world.log.filter((l) => ["newTab", "navigate", "assign"].includes(l[0])), [], label);
      assert.equal(world.counts["tab.url="], undefined, label);
      assert.equal(world.counts["tab.execute"], undefined, label);
      assert.deepEqual(Object.keys(world.counts), [], `${label} spent Apple Events`);
    }
  });
}

test("navigate to a file: url from a window behind another app still needs raise:true, as before", async () => {
  const { seen, hash } = await observe("chromeAway", "navigate", { url: "file:///tmp/p.html" });
  assert.match(seen.text, /^error: tab_not_visible: .*raise:true/);
  assert.equal(seen.counts["tab.url="], undefined);
  assert.equal(hash, "f9947dd63e6e", JSON.stringify(seen));
});

test("the runtime refuses a raw call with a url it must not load, before any Apple Event", () => {
  install(FIXTURES.chrome());
  assert.throws(() => world.run(`__perch.navigate(${JSON.stringify({ target: null, url: "javascript:1", timeout: 15000 })})`),
    (e) => /^bad_url: navigate takes an absolute http\(s\) or file URL, or about:blank; got javascript$/.test(e.message));
  assert.throws(() => world.run(`__perch.newTab(${JSON.stringify({ app: "Google Chrome", url: "data:text/html,x" })})`),
    (e) => /^bad_url: new_tab takes an absolute http\(s\) or file URL, or about:blank; got data$/.test(e.message));
  assert.equal(world.counts["tab.url="], undefined);
  assert.deepEqual(Object.keys(world.counts), []);
});

test("new_tab and navigate refuse without reaching the runtime at all", async () => {
  let calls = 0;
  const lane = { run: async () => { calls++; throw new Error("the runtime was called"); } };
  DAEMONS.fast = lane;
  DAEMONS.slow = lane;
  await assert.rejects(HANDLERS.new_tab({ url: "javascript:1" }), /^Error: bad_url: /);
  await assert.rejects(HANDLERS.navigate({ url: "javascript:1" }), /^Error: bad_url: /);
  assert.equal(calls, 0);
});

// Every place the runtime hands a url to the browser. A new one fails here
// until someone checks it sits behind the bad_url guard.
test("the runtime's url sinks are the reviewed ones", async () => {
  const lines = (await readFile(new URL("../server.js", import.meta.url), "utf8")).split("\n");
  const SINK = /Tab\(\{\s*url:|\.url\s*=\s*a\.url|location\.assign\(/g;
  const FN = /^\s{4}(\w+)\([^)]*\)\s*\{|^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
  const found = {};
  let fn = null;
  for (const l of lines) {
    const m = FN.exec(l);
    if (m) fn = m[1] || m[2];
    for (const _ of l.matchAll(SINK)) found[fn] = (found[fn] || 0) + 1;
  }
  assert.deepEqual(found, { navigate: 3, newTab: 4 });
});
