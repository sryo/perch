// Behaviour-lock harness: runs a scenario (scenarios.mjs) against a fresh copy
// of server.js and the fake JXA world, and records per call what a rewrite of
// server.js must keep: the MCP result, the Apple Events sent to each browser and
// the page script bytes handed to tabs.
//
// Each scenario imports its own server.js instance (a query string makes a new
// module), so server-wide state (late tokens, ref maps, tab hints, stamps) never
// leaks from one scenario into the next and any subset runs alone.
//
// Nondeterminism is normalized here and only here (normalize below):
// - image content keeps its mimeType and decoded byte length, not the base64;
// - page-made owner tokens (TOK_LIB's rbTok, "<counter>.<random>") under a
//   `tok`/`rbTok` key become "<tok>";
// - wall-clock durations Node measures (Date.now in server.js, not the fake
//   clock) are listed in WALL_KEYS and become "<ms>";
// - temp paths under the scenario's own temp dir become "<tmp>";
// - the fake world's file URL in a page stack (eval_js errors) becomes "<fake>",
//   so editing jxa-world.mjs moves no golden.
// Everything the runtime times runs on the fake world's clock, and happy-dom
// pages get a fixed performance.timeOrigin (test/helpers/page.mjs), which seeds
// snapshot refs, so refs and waits need no normalizing.
import { makeWorld } from "../fakes/jxa-world.mjs";
import { page } from "../helpers/page.mjs";

const WALL_KEYS = [];
const TOK = /("(?:tok|rbTok)":")\d+\.[a-z0-9]+"/g;
const FAKE = /\(file:\/\/[^()]*?\/test\/fakes\/jxa-world\.mjs:\d+:\d+\)/g;

let seq = 0;
export async function freshServer(tag) {
  const srv = await import(`../../server.js?lock=${++seq}-${encodeURIComponent(tag)}`);
  const refuse = (what) => async () => { throw new Error(`lock harness: ${what} reached the real system`); };
  for (const lane of Object.keys(srv.DAEMONS)) srv.DAEMONS[lane] = { run: refuse(`DAEMONS.${lane}`) };
  srv.deps.exec = refuse("deps.exec");
  srv.roomsReset({ home: "/nonexistent/perch-test-rooms", fetch: refuse("rooms.fetch"), WebSocket: class { constructor() { throw new Error("lock harness: rooms.WebSocket reached the real system"); } } });
  return srv;
}

export function normalize(content, { tmp } = {}) {
  return content.map((c) => {
    if (c.type === "image") return { type: "image", mimeType: c.mimeType, bytes: Buffer.from(c.data, "base64").length };
    let text = c.text.replace(TOK, '$1<tok>"').replace(FAKE, "(<fake>)");
    if (tmp) text = text.split(tmp).join("<tmp>");
    for (const k of WALL_KEYS) text = text.replace(new RegExp(`"${k}":\\d+`, "g"), `"${k}":"<ms>"`);
    return { type: c.type, text };
  });
}

// One scenario's context: install a world, then call tools; every call is recorded.
export function context(srv, { tmp } = {}) {
  const h = {
    srv, world: null, steps: [], execs: [], tmp,
    page,
    install(spec, state = {}) {
      const w = makeWorld(spec);
      w.run(srv.JXA_PRELUDE);
      Object.assign(w.state, state);
      for (const lane of Object.keys(srv.DAEMONS)) srv.DAEMONS[lane] = w.daemon;
      srv.deps.dialogs = async (target) => JSON.parse(w.run(`JSON.stringify(__perch.dialogs(${JSON.stringify({ target })}))`));
      srv.deps.exec = async (cmd, args) => { h.execs.push(cmd); throw new Error(`lock harness: ${cmd} is not faked`); };
      w.reset();
      h.world = w;
      return w;
    },
    // Runs a tool call and records it. Returns the parsed first text item (or the text).
    async call(name, args = {}) {
      const w = h.world;
      if (w) w.reset();
      h.execs.length = 0;
      const r = await srv.handleCall(name, structuredClone(args));
      const shown = JSON.stringify([name, args]);
      const step = { call: JSON.parse(tmp ? shown.split(tmp).join("<tmp>") : shown), content: normalize(r.content, { tmp }), isError: r.isError === true };
      if (w) {
        const ae = {};
        for (const [app, k] of w.aeLog) (ae[app] = ae[app] || []).push(k);
        step.events = w.aeLog.length;
        step.ae = ae;
        step.pageScripts = w.sent.length;
        step.pageBytes = w.sent.reduce((a, b) => a + b, 0);
      }
      if (h.execs.length) step.execs = [...h.execs];
      h.steps.push(step);
      const t = r.content.find((c) => c.type === "text")?.text;
      try { return JSON.parse(t); } catch { return t; }
    },
  };
  return h;
}

// Runs one scenario on its own server instance; returns its recorded steps.
export async function runScenario(name, fn, t) {
  const { tempDir } = await import("../../scripts/temp-dirs.mjs");
  const srv = await freshServer(name);
  const h = context(srv, { tmp: tempDir("perch-lock-", t) });
  await fn(h);
  return h.steps;
}
