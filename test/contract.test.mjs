// What perch's dependents rely on, pinned so a change here fails in perch
// rather than in them: avis (SKILL.md, references/setup.md) and an unattended
// form-filling agent. Each test names who depends on it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JXA_PRELUDE, DAEMONS, handleCall, deps } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run } from "./helpers/page.mjs";

const tabs = (n, p = "t") => Array.from({ length: n }, (_, i) => ({ url: `https://${p}${i}.test/`, title: `${p}${i}`, id: `${p}${i}` }));

function install(spec) {
  const world = makeWorld(spec);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  world.reset();
  return world;
}
const canary = (t) => install({
  browsers: [{ name: "Google Chrome Canary", kind: "chrome", windows: [{ id: 1, active: 0, x: 10, y: 20, w: 800, h: 600, tabs: t }] }],
  cg: [{ owner: "Google Chrome Canary", pid: 4242, wid: 77, x: 10, y: 0, w: 800, h: 620 }],
});
const text = (r) => { assert.equal(r.isError, undefined, r.content[0].text); return r.content[0].text; };
const json = (r) => JSON.parse(text(r));

// ---- tab handles ----

test("list_tabs: {tabs,total}; rows carry the full app name and a tabId (avis, form agent)", async () => {
  canary(tabs(3));
  const o = json(await handleCall("list_tabs", { app: "canary", urlContains: "t1" }));
  assert.equal(o.total, 1);
  assert.deepEqual(Object.keys(o.tabs[0]).sort(), ["app", "tabId", "title", "url"].sort().concat(o.tabs[0].active ? ["active"] : []).sort());
  // The form agent matches tabs by comparing app to the full name.
  assert.equal(o.tabs[0].app, "Google Chrome Canary");
  assert.equal(o.tabs[0].url, "https://t1.test/");
  assert.equal(typeof o.tabs[0].tabId, "string");
});

test("new_tab returns {app,tabId}, and that tabId targets the new tab (form agent)", async () => {
  const world = canary(tabs(1));
  const o = json(await handleCall("new_tab", { app: "Google Chrome Canary", url: "https://n.test/" }));
  assert.deepEqual(Object.keys(o).sort(), ["app", "tabId"]);
  assert.equal(o.app, "Google Chrome Canary");
  await handleCall("eval_js", { script: "window.mark = 1; return 1", target: { tabId: o.tabId } });
  assert.equal(world.page("Google Chrome Canary", 0, 1).mark, 1);
});

test("navigate returns {ok,url,tabId}; the tabId keeps targeting the tab (avis, form agent)", async () => {
  const world = canary(tabs(2));
  const o = json(await handleCall("navigate", { url: "https://next.test/", target: { tabId: json(await handleCall("list_tabs", {})).tabs[1].tabId } }));
  assert.equal(o.ok, true);
  assert.equal(o.url, "https://next.test/");
  assert.equal(typeof o.tabId, "string");
  await handleCall("eval_js", { script: "window.mark = 2; return 1", target: { tabId: o.tabId } });
  assert.equal(world.page("Google Chrome Canary", 0, 1).mark, 2);
});

// ---- eval_js results ----

test("eval_js: objects come back as JSON text, strings as raw text, once (avis)", async () => {
  canary(tabs(1));
  assert.deepEqual(json(await handleCall("eval_js", { script: "return {mounted: true, n: [1]}" })), { mounted: true, n: [1] });
  assert.equal(text(await handleCall("eval_js", { script: "return 'plain'" })), "plain");
  assert.deepEqual(json(await handleCall("eval_js", { script: "return Promise.resolve({a: 1})", awaitPromise: true })), { a: 1 });
});

// ---- local files: ~ and relative paths ----

const tmp = await mkdtemp(join(tmpdir(), "perch-contract-"));
after(() => rm(tmp, { recursive: true, force: true }));

async function inFakeHome(fn) {
  const home = process.env.HOME, cwd = process.cwd();
  process.env.HOME = join(tmp, "home");
  await mkdir(join(tmp, "home", "lib"), { recursive: true });
  await mkdir(join(tmp, "work", "data"), { recursive: true });
  process.chdir(join(tmp, "work"));
  try { await fn(); } finally { process.env.HOME = home; process.chdir(cwd); }
}

test("script_path expands ~ and runs before script in one body (avis toolbar mount)", async () => {
  canary(tabs(1));
  await inFakeHome(async () => {
    await writeFile(join(tmp, "home", "lib", "toolbar.js"), "window.__lib = { info: () => ({ ok: 1 }) };");
    const o = json(await handleCall("eval_js", { script_path: "~/lib/toolbar.js", script: "return window.__lib.info()" }));
    assert.deepEqual(o, { ok: 1 });
  });
});

test("fill text_path resolves a relative path against the server's cwd (form agent cover letters)", async () => {
  const dom = page(`<textarea aria-label="Cover letter"></textarea>`);
  canary([{ url: "https://a.test/p", id: "d", dom }]);
  await inFakeHome(async () => {
    await writeFile(join(tmp, "work", "data", "job_cover.txt"), "Dear team,\nhello.");
    const o = json(await handleCall("fill", { label_pattern: "cover", text_path: "data/job_cover.txt" }));
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(dom.document.querySelector("textarea").value, "Dear team,\nhello.");
  });
});

test("file_upload expands ~ and names the file by its basename (form agent)", async () => {
  const dom = page(`<input type="file" id="cv">`);
  canary([{ url: "https://a.test/p", id: "d", dom }]);
  await inFakeHome(async () => {
    await writeFile(join(tmp, "home", "lib", "cv.pdf"), "%PDF-1.4");
    const o = json(await handleCall("file_upload", { selector: "#cv", path: "~/lib/cv.pdf" }));
    assert.equal(o.ok, true, JSON.stringify(o));
    const f = dom.document.querySelector("#cv").files[0];
    assert.equal(f.name, "cv.pdf");
    assert.equal(f.type, "application/pdf");
  });
});

// ---- screenshot ----

async function shoot(args, width = 3000) {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(width, 16); png.writeUInt32BE(1000, 20);
  const calls = [];
  const real = deps.exec;
  deps.exec = async (cmd, a) => {
    calls.push([cmd, ...a]);
    if (cmd === "screencapture") await writeFile(a[a.length - 1], png);
    if (cmd === "sips") { const out = Buffer.from(png); out.writeUInt32BE(Number(a[1]), 16); await writeFile(a[a.length - 1], out); }
    return { stdout: "" };
  };
  try { return { r: await handleCall("screenshot", args), calls }; } finally { deps.exec = real; }
}

test("screenshot: image block then {window,image} meta; 1568 default, maxWidth:0 keeps full size, jpeg (form agent vision)", async () => {
  canary(tabs(1));
  let { r, calls } = await shoot({});
  assert.equal(r.content.length, 2);
  assert.equal(r.content[0].type, "image");
  assert.equal(r.content[0].mimeType, "image/png");
  const meta = JSON.parse(r.content[1].text);
  assert.deepEqual(Object.keys(meta.window).sort(), ["h", "w", "x", "y"]);
  assert.deepEqual(meta.image, { w: 1568, h: 1000 });
  assert.deepEqual(calls.find((c) => c[0] === "sips").slice(1, 3), ["--resampleWidth", "1568"]);

  ({ r, calls } = await shoot({ maxWidth: 0 }));
  assert.deepEqual(JSON.parse(r.content[1].text).image, { w: 3000, h: 1000 });
  assert.equal(calls.some((c) => c[0] === "sips"), false);

  ({ r, calls } = await shoot({ format: "jpeg" }, 1000));
  assert.equal(r.content[0].mimeType, "image/jpeg");
  assert.ok(calls[0].includes("jpg"), calls[0].join(" "));
});

// ---- accessibility_snapshot, read by the form agent's line parser ----

// A port of the form agent's snapshot parser (keys name -> attr_name, type -> subtype).
function parseSnapshot(snap) {
  const KEYS = { name: "attr_name", type: "subtype" };
  const out = [];
  for (const line of snap.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [ref, role] = line.split(" ", 2);
    let rest = line.slice(ref.length + role.length + 2);
    const readJson = () => {
      // raw_decode: the longest JSON prefix, without the trailing space JSON.parse allows.
      for (let end = rest.length; end > 0; end--) {
        if (/\s/.test(rest[end - 1])) continue;
        try { const v = JSON.parse(rest.slice(0, end)); rest = rest.slice(end); return v; } catch {}
      }
      throw new Error("no JSON at: " + rest);
    };
    const el = { ref, role, name: readJson() };
    for (let m; (m = /^ ([a-z_]+)(=?)/.exec(rest)); ) {
      const key = KEYS[m[1]] || m[1];
      rest = rest.slice(m[0].length);
      el[key] = m[2] ? readJson() : true;
    }
    assert.equal(rest, "", `unparsed tail in: ${line}`);
    out.push(el);
  }
  return out;
}

test("snapshot lines parse cleanly with the form agent's parser, flags and all", () => {
  const w = page(`
    <h1>Apply</h1>
    <input name="email" type="email" aria-label="Email" value="a@b.c" required>
    <select name="country" aria-label="Country"><option value="AR">Argentina</option><option>Brazil</option></select>
    <label><input type="checkbox" checked> I agree</label>
    <button disabled>Send</button>
    <button aria-expanded="true">More</button>
    <textarea aria-label='Say "hi"'>a "b"
c</textarea>`);
  const els = parseSnapshot(run(w, "snapshot", { max: 500 }));
  const by = Object.fromEntries(els.map((e) => [e.name, e]));
  assert.deepEqual(by.Email, { ref: by.Email.ref, role: "textbox", name: "Email", attr_name: "email", subtype: "email", value: "a@b.c", required: true });
  assert.equal(by.Country.role, "combobox");
  assert.deepEqual(by.Country.options, ["Argentina", "Brazil"]);
  assert.equal(by["I agree"].checked, true);
  assert.equal(by.Send.disabled, true);
  assert.equal(by.More.expanded, true);
  assert.equal(by['Say "hi"'].subtype, "textarea");
  for (const e of els) assert.match(e.ref, /^\d+$/);
});

// ---- tools the form agent calls that only page tests covered ----

test("accessibility_snapshot and console_capture through the tool layer (form agent)", async () => {
  const dom = page(`<button>Go</button><input aria-label="Email">`);
  canary([{ url: "https://a.test/p", id: "d", dom }]);
  const snap = text(await handleCall("accessibility_snapshot", {}));
  assert.deepEqual(parseSnapshot(snap).map((e) => [e.role, e.name]), [["button", "Go"], ["textbox", "Email"]]);
  assert.equal(JSON.parse(snap.split("\n")[0].slice(2)).count, 2);
  assert.equal(text(await handleCall("accessibility_snapshot", { max: 0 })).split("\n").length, 1);
  assert.equal(json(await handleCall("console_capture", { mode: "start" })).ok, true);
  dom.console.warn("careful");
  const read = json(await handleCall("console_capture", {}));
  assert.equal(read.ok, true);
  assert.ok(read.entries.some((e) => /^warn: .*careful/.test(e)), JSON.stringify(read));
});

test("notify shows the message verbatim, quotes and newlines included (form agent CAPTCHA handoff)", async () => {
  const vm = await import("node:vm");
  const fast = DAEMONS.fast;
  let script;
  DAEMONS.fast = { run: async (s) => { script = s; return "ok"; } };
  try {
    assert.deepEqual(json(await handleCall("notify", { message: `Solve the "CAPTCHA"\nthen say go`, subtitle: "job 7" })), { ok: true });
  } finally { DAEMONS.fast = fast; }
  const shown = [];
  const app = { displayNotification: (...a) => shown.push(a) };
  vm.runInNewContext(script, { Application: { currentApplication: () => app } });
  assert.deepEqual(JSON.parse(JSON.stringify(shown)), [[`Solve the "CAPTCHA"\nthen say go`, { withTitle: "perch", subtitle: "job 7", soundName: "Glass" }]]);
  assert.equal(app.includeStandardAdditions, true);
});
