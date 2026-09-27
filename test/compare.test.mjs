// Hermetic tests for scripts/compare.mjs: the pure logic of the perch vs extension
// benchmark harness, driven by a fake `call` so no browser or osascript runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  median, p90, summarize, OPS, OP_IDS, EXPECTED_STATUS, FIXTURE_URL,
  measure, runSuite, shapeReport, parseArgs, statusMatches,
} from "../scripts/compare.mjs";

const txt = (s) => ({ content: [{ type: "text", text: s }] });
const err = (s) => ({ content: [{ type: "text", text: s }], isError: true });

// A fake perch that models just enough page state for the op suite.
function fakePerch({ fail = {}, statusText } = {}) {
  const calls = [];
  let form = null;
  const handlers = {
    new_tab: () => txt(JSON.stringify({ app: "Google Chrome Canary", tabId: "canary:7" })),
    activate_tab: () => txt(JSON.stringify({ ok: true })),
    list_tabs: () => txt(JSON.stringify({ tabs: [{ app: "Google Chrome Canary", tabId: "canary:7", url: FIXTURE_URL, title: "perch compare fixture" }], total: 1 })),
    navigate: (a) => { form = { name: "", email: "", msg: "", country: "", agree: false, status: "Not submitted" }; return txt(JSON.stringify({ ok: true, url: a.url, tabId: "canary:7" })); },
    get_text: (a) => a.selector === "#status" ? txt(statusText ?? form.status) : txt("Compare fixture\n" + "Paragraph 29: perch".padEnd(5000, ".")),
    accessibility_snapshot: () => txt('# {"url":"x","count":160}\n1 textbox "Name" name="name"'),
    eval_js: () => txt("perch compare fixture"),
    fill: (a) => {
      if (a.fields) {
        const results = a.fields.map((f) => {
          if (f.option != null) { form.country = f.option === "Argentina" ? "AR" : ""; return { ok: !!form.country, kind: "select" }; }
          if (f.checked != null) { form.agree = f.checked; return { ok: true, kind: "check", checked: f.checked }; }
          const k = { "^name": "name", "^email": "email", "^message": "msg" }[f.label_pattern];
          if (!k) return { ok: false, error: "no match" };
          form[k] = f.text; return { ok: true, kind: "plain" };
        });
        return txt(JSON.stringify({ ok: results.every((r) => r.ok), results }));
      }
      const key = { "^name": "name", "^email": "email", "^message": "msg" }[a.label_pattern];
      if (!key) return txt(JSON.stringify({ ok: false, error: "no match" }));
      form[key] = a.text;
      return txt(JSON.stringify({ ok: true, kind: "plain", el: `textbox "${key}"`, len: a.text.length }));
    },
    select: (a) => { form.country = a.text === "Argentina" ? "AR" : ""; return txt(JSON.stringify({ ok: true, value: form.country })); },
    click: (a) => {
      if (a.selector === "#agree") form.agree = !form.agree;
      if (a.selector === "#submit") form.status = "Submitted: " + [form.name, form.email, form.msg, form.country, form.agree].join("|");
      if (a.readback === "#status") return txt(JSON.stringify({ ok: true, readback: statusText ?? form.status, changed: true }));
      return txt(JSON.stringify({ ok: true }));
    },
    screenshot: () => ({ content: [{ type: "image", data: "A".repeat(400), mimeType: "image/png" }, { type: "text", text: JSON.stringify({ window: { x: 0, y: 0, w: 800, h: 600 }, image: { w: 1600, h: 1200 } }) }] }),
  };
  const call = async (name, args = {}) => {
    calls.push({ name, args: structuredClone(args) });
    if (fail[name]) return typeof fail[name] === "function" ? fail[name](args) : err(fail[name]);
    return handlers[name](args);
  };
  return { call, calls };
}

let clock = 0;
const now = () => (clock += 5);

test("median averages the middle pair, p90 is nearest-rank", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90([5]), 5);
  assert.equal(median([]), null);
  assert.equal(p90([]), null);
});

test("summarize rounds to 0.1ms and reports min/max", () => {
  assert.deepEqual(summarize([10.04, 30.26, 20.11]), { median: 20.1, p90: 30.3, min: 10, max: 30.3 });
  assert.deepEqual(summarize([]), { median: null, p90: null, min: null, max: null });
});

test("op table is O1..O8 in order, matching the extension-side suite, then the one-call variants", () => {
  assert.deepEqual(OP_IDS, ["O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8", "O6b", "O7b"]);
  assert.deepEqual(OPS.map((o) => o.name), ["list_tabs", "navigate", "read_text", "snapshot", "eval", "fill_form", "click_verify", "screenshot", "fill_form_fields", "click_readback"]);
  assert.equal(FIXTURE_URL, "http://127.0.0.1:8787/fixture.html");
  assert.equal(EXPECTED_STATUS, "Submitted: Ada|ada@x.test|hello\nworld|AR|true");
});

test("measure counts calls and text chars, and records image size separately", async () => {
  const { call } = fakePerch();
  const m = await measure(call, async (c) => {
    await c("eval_js", { script: "x" });
    await c("screenshot", {});
    return { ok: true };
  }, now);
  assert.equal(m.calls, 2);
  assert.equal(m.chars, "perch compare fixture".length + JSON.stringify({ window: { x: 0, y: 0, w: 800, h: 600 }, image: { w: 1600, h: 1200 } }).length);
  assert.deepEqual(m.image, { b64: 400, w: 1600, h: 1200 });
  assert.equal(m.ok, true);
  assert.equal(m.ms, 5);
});

test("measure turns isError and thrown calls into ok:false with a note", async () => {
  const { call } = fakePerch({ fail: { eval_js: "error: tab_not_visible: needs activate_tab", get_text: () => { throw new Error("get_text timed out after 60000ms"); } } });
  const a = await measure(call, async (c) => { await c("eval_js", {}); return { ok: true }; }, now);
  assert.equal(a.ok, false);
  assert.match(a.note, /tab_not_visible/);
  const b = await measure(call, async (c) => { await c("get_text", {}); return { ok: true }; }, now);
  assert.equal(b.ok, false);
  assert.match(b.note, /timed out/);
  assert.equal(b.calls, 1);
});

test("statusMatches accepts the exact value, and innerText's collapsed newline with a note", () => {
  assert.deepEqual(statusMatches(EXPECTED_STATUS), { ok: true });
  const collapsed = statusMatches("Submitted: Ada|ada@x.test|hello world|AR|true");
  assert.equal(collapsed.ok, true);
  assert.match(collapsed.note, /whitespace/);
  assert.equal(statusMatches("Submitted: Ada|ada@x.test|hello world|AR|false").ok, false);
});

test("runSuite creates one scratch tab, targets it everywhere, and closes it", async () => {
  const { call, calls } = fakePerch();
  const closed = [];
  const out = await runSuite(call, { app: "canary", reps: 3, now, close: (t) => closed.push(t) });
  assert.equal(calls[0].name, "new_tab");
  assert.deepEqual(calls[0].args, { app: "canary", url: FIXTURE_URL });
  assert.equal(calls.filter((c) => c.name === "new_tab").length, 1);
  for (const c of calls.slice(1)) {
    if (c.name === "list_tabs") assert.deepEqual(c.args, { app: "canary", urlContains: "127.0.0.1" });
    else assert.deepEqual(c.args.target, { tabId: "canary:7" }, `${c.name} untargeted`);
  }
  assert.deepEqual(closed, [{ app: "Google Chrome Canary", tabId: "canary:7" }]);
  assert.deepEqual(Object.keys(out.ops), OP_IDS);
  for (const id of OP_IDS) {
    assert.equal(out.ops[id].reps.length, 3, id);
    assert.ok(out.ops[id].reps.every((r) => r.ok), `${id}: ${JSON.stringify(out.ops[id].reps[0])}`);
  }
});

test("activate:true selects the scratch tab once, untimed, before the suite", async () => {
  const { call, calls } = fakePerch();
  await runSuite(call, { app: "canary", reps: 1, now, close: () => {}, activate: true });
  assert.deepEqual(calls.slice(0, 2).map((c) => c.name), ["new_tab", "activate_tab"]);
  assert.deepEqual(calls[1].args, { target: { tabId: "canary:7" } });
  assert.equal(calls.filter((c) => c.name === "activate_tab").length, 1);
});

test("without activate, the suite never selects a tab", async () => {
  const { call, calls } = fakePerch();
  await runSuite(call, { app: "canary", reps: 1, now, close: () => {} });
  assert.ok(!calls.some((c) => c.name === "activate_tab"));
});

test("runSuite warms each op once untimed before the timed reps", async () => {
  const { call, calls } = fakePerch();
  await runSuite(call, { app: "canary", reps: 2, now, close: () => {} });
  assert.equal(calls.filter((c) => c.name === "eval_js").length, 3);
  assert.equal(calls.filter((c) => c.name === "screenshot").length, 3);
});

test("O6 fills by label pattern, selects Argentina, clicks #agree: 5 calls", async () => {
  const { call, calls } = fakePerch();
  const out = await runSuite(call, { app: "canary", reps: 1, now, close: () => {} });
  assert.equal(out.ops.O6.reps[0].calls, 5);
  const fills = calls.filter((c) => c.name === "fill").slice(0, 3).map((c) => [c.args.label_pattern, c.args.text]);
  assert.deepEqual(fills, [["^name", "Ada"], ["^email", "ada@x.test"], ["^message", "hello\nworld"]]);
  const sel = calls.find((c) => c.name === "select");
  assert.equal(sel.args.text, "Argentina");
  assert.ok(calls.some((c) => c.name === "click" && c.args.selector === "#agree"));
});

test("O6 and O7 reps start from a fresh navigation that isn't timed", async () => {
  const { call, calls } = fakePerch();
  const out = await runSuite(call, { app: "canary", reps: 2, now, close: () => {} });
  const seq = calls.map((c) => c.name);
  // Every fill_form run (warm-up + 2 reps) and click_verify run is preceded by a navigate.
  const navs = seq.filter((n) => n === "navigate").length;
  assert.equal(navs, 3 /* O2 */ + 3 /* O6 */ + 3 /* O7 */ + 3 /* O6b */ + 3 /* O7b */);
  assert.equal(out.ops.O6b.reps[0].calls, 1);
  assert.equal(out.ops.O7b.reps[0].calls, 1);
  assert.equal(out.ops.O7b.reps[0].ok, true);
  assert.equal(out.ops.O7.reps[0].calls, 2);
  assert.equal(out.ops.O7.reps[0].ok, true);
  assert.equal(out.ops.O2.reps[0].calls, 1);
});

test("O7 reports a wrong status as ok:false with the value it saw", async () => {
  const { call } = fakePerch({ statusText: "Not submitted" });
  const out = await runSuite(call, { app: "canary", reps: 1, now, close: () => {} });
  assert.equal(out.ops.O7.reps[0].ok, false);
  assert.match(out.ops.O7.reps[0].note, /Not submitted/);
});

test("navigate's returned tabId becomes the target for later ops", async () => {
  const { call, calls } = fakePerch({ fail: { navigate: (a) => txt(JSON.stringify({ ok: true, url: a.url, tabId: "safari:1.2.abc" })) } });
  await runSuite(call, { app: "safari", reps: 1, now, close: () => {} });
  const after = calls.slice(calls.findIndex((c) => c.name === "navigate") + 1).filter((c) => c.name !== "list_tabs");
  assert.ok(after.every((c) => c.args.target.tabId === "safari:1.2.abc"));
});

test("runSuite closes the scratch tab even when an op throws", async () => {
  const { call } = fakePerch({ fail: { accessibility_snapshot: () => { throw new Error("boom"); } } });
  const closed = [];
  const out = await runSuite(call, { app: "canary", reps: 1, now, close: (t) => closed.push(t) });
  assert.equal(closed.length, 1);
  assert.equal(out.ops.O4.reps[0].ok, false);
  assert.equal(out.ops.O5.reps[0].ok, true);
});

test("runSuite fails loudly when new_tab fails and closes nothing", async () => {
  const { call } = fakePerch({ fail: { new_tab: "error: no_browser: none running" } });
  const closed = [];
  await assert.rejects(runSuite(call, { app: "canary", reps: 1, now, close: (t) => closed.push(t) }), /no_browser/);
  assert.deepEqual(closed, []);
});

test("shapeReport produces the shared comparison schema", async () => {
  const { call } = fakePerch({ fail: { eval_js: (() => { let n = 0; return () => (n++ % 2 ? err("error: timeout") : txt("perch compare fixture")); })() } });
  const out = await runSuite(call, { app: "canary", reps: 4, now, close: () => {} });
  const r = shapeReport(out, { app: "Google Chrome Canary", date: "2026-09-27T00:00:00.000Z", node: "v22.0.0", macos: "27.2" });
  assert.equal(r.tool, "perch");
  assert.equal(r.app, "Google Chrome Canary");
  assert.equal(r.macos, "27.2");
  assert.deepEqual(Object.keys(r.ops), OP_IDS);
  const o6 = r.ops.O6;
  assert.equal(o6.calls, 5);
  assert.equal(typeof o6.chars, "number");
  assert.deepEqual(Object.keys(o6.ms), ["median", "p90", "min", "max"]);
  assert.equal(o6.ok_rate, 1);
  assert.ok(Array.isArray(o6.notes));
  assert.equal(r.ops.O5.ok_rate, 0.5);
  assert.ok(r.ops.O5.notes.some((n) => /timeout/.test(n)));
  assert.deepEqual(r.ops.O8.image, { b64: 400, w: 1600, h: 1200 });
});

test("parseArgs reads --app, --reps, --out with defaults", () => {
  assert.deepEqual(parseArgs(["--app", "canary"]), { app: "canary", reps: 10, out: "bench/runs/compare.json", activate: false });
  assert.deepEqual(parseArgs(["--app", "arc", "--reps", "3", "--out", "x.json", "--activate"]), { app: "arc", reps: 3, out: "x.json", activate: true });
  assert.throws(() => parseArgs([]), /--app/);
  assert.throws(() => parseArgs(["--app", "arc", "--reps", "0"]), /--reps/);
});

test("parseArgs lets a repeated flag's last value win, as bench.mjs does", () => {
  const args = parseArgs(["--app", "canary", "--reps", "5", "--out", "a.json", "--app", "arc", "--reps", "2", "--out", "b.json"]);
  assert.deepEqual(args, { app: "arc", reps: 2, out: "b.json", activate: false });
  assert.throws(() => parseArgs(["--app", "arc", "--reps", "3", "--reps", "0"]), /--reps/);
});

test("importing compare.mjs does not start the CLI", async () => {
  // Reaching here means the import above neither spawned server.js nor exited.
  assert.equal(typeof runSuite, "function");
});
