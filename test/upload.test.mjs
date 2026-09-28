import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JXA_PRELUDE, DAEMONS, handleCall } from "../server.js";
import { makeWorld } from "./fakes/jxa-world.mjs";
import { page, run, runBody } from "./helpers/page.mjs";

const PDF = { b64: Buffer.from("%PDF-1.4").toString("base64"), name: "cv.pdf", mime: "application/pdf" };

test("file_upload: an input the site replaces on change reports ok with detached", () => {
  const w = page(`<div id=box><input type=file id=f></div>`);
  runBody(w, `document.getElementById('f').addEventListener('change', (e) => {
    const n = e.target.files[0].name;
    const fresh = document.createElement('input'); fresh.type = 'file'; fresh.id = 'f';
    e.target.replaceWith(fresh);
    const s = document.createElement('span'); s.textContent = n + ' uploaded'; document.getElementById('box').append(s);
  }); return 1`);
  const o = run(w, "file_upload", { ...PDF, selector: "#f" });
  assert.equal(o.ok, true);
  assert.equal(o.detached, true);
  assert.equal(o.shown, true);
  assert.equal(o.name, "cv.pdf");
});

test("file_upload: a removed input with no indicator is still ok, detached, not shown", () => {
  const w = page(`<input type=file id=f>`);
  runBody(w, `document.getElementById('f').addEventListener('change', (e) => e.target.remove()); return 1`);
  const o = run(w, "file_upload", { ...PDF, selector: "#f" });
  assert.equal(o.ok, true);
  assert.equal(o.detached, true);
  assert.equal(o.shown, false);
});

test("file_upload: an input the site empties after change reports ok with cleared", () => {
  const w = page(`<input type=file id=f><ul id=l></ul>`);
  runBody(w, `document.getElementById('f').addEventListener('change', (e) => {
    document.getElementById('l').innerHTML = '<li>' + e.target.files[0].name + '</li>';
    e.target.files = new DataTransfer().files;
  }); return 1`);
  const o = run(w, "file_upload", { ...PDF, selector: "#f" });
  assert.equal(o.ok, true);
  assert.equal(o.cleared, true);
  assert.equal(o.shown, true);
});

test("file_upload: failures always carry an error string", () => {
  const w = page(`<input type=file id=f><div id=d></div>`);
  runBody(w, `Object.defineProperty(document.getElementById('f'), 'files', { get: () => null, set() {} }); return 1`);
  const o = run(w, "file_upload", { ...PDF, selector: "#f" });
  assert.equal(o.ok, false);
  assert.match(o.error, /file/);
  const d = run(w, "file_upload", { ...PDF, selector: "#d" });
  assert.equal(d.ok, false);
  assert.match(d.error, /not an <input type=file>/);
  assert.equal(run(page(`<p>none</p>`), "file_upload", PDF).ok, false);
});

test("file_upload: with no selector, skips an images-only input for a PDF and flags the ambiguity", () => {
  const w = page(`<label for=p>Photo</label><input type=file id=p accept="image/*">
    <label for=c>CV</label><input type=file id=c accept=".pdf,.doc,.docx">`);
  const o = run(w, "file_upload", PDF);
  assert.equal(o.ok, true);
  assert.equal(o.ambiguous, true);
  assert.match(o.el, /CV/);
  assert.equal(runBody(w, `return document.getElementById('c').files.length + ':' + document.getElementById('p').files.length`), "1:0");
});

test("file_upload: prefers the resume field over a resume-autofill parser input", () => {
  const w = page(`<label for=a>Autofill from resume</label><input type=file id=a accept=".pdf">
    <label for=_systemfield_resume>Resume</label><input type=file id=_systemfield_resume name=resume>`);
  const o = run(w, "file_upload", { ...PDF, selector: "input[type=file]" });
  assert.equal(o.ok, true);
  assert.equal(o.ambiguous, true);
  assert.match(o.el, /#_systemfield_resume/);
  assert.equal(runBody(w, `return document.getElementById('a').files.length`), 0);
});

test("file_upload: an image goes to the images-only input when no field says resume", () => {
  const w = page(`<input type=file id=d accept=".pdf"><input type=file id=p accept="image/png,image/jpeg">`);
  const o = run(w, "file_upload", { b64: "AA==", name: "me.png", mime: "image/png" });
  assert.equal(o.ok, true);
  assert.match(o.el, /#p/);
});

test("file_upload: a single match reports no ambiguity", () => {
  const w = page(`<input type=file id=f>`);
  const o = run(w, "file_upload", PDF);
  assert.equal(o.ok, true);
  assert.equal(o.ambiguous, undefined);
});

// ---- tool call, through the fake JXA world ----

// Page timers run on the fake world's virtual clock, firing before the next
// script evaluation that finds them due: a re-render "a tick later" lands
// between polls, as it does live.
function onPage(html, setup) {
  const dom = page(html);
  const world = makeWorld({
    browsers: [{ name: "Google Chrome", kind: "chrome", windows: [{ id: 1, active: 0, tabs: [{ url: "https://a.test/", id: "x", dom }] }] }],
    cg: [{ owner: "Google Chrome" }],
  });
  const timers = [];
  dom.setTimeout = (fn, ms = 0) => { timers.push({ at: world.clock.t + ms, fn }); return timers.length; };
  const orig = dom.eval.bind(dom);
  dom.eval = (js) => {
    for (const tm of timers) if (tm.fn && tm.at <= world.clock.t) { const f = tm.fn; tm.fn = null; f(); }
    return orig(js);
  };
  if (setup) dom.eval(setup);
  world.run(JXA_PRELUDE);
  DAEMONS.fast = world.daemon;
  DAEMONS.slow = world.daemon;
  return { dom, world };
}
async function cvFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "perch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = join(dir, "cv.pdf");
  await writeFile(f, "%PDF-1.4");
  return f;
}
const upload = async (args) => {
  const r = await handleCall("file_upload", args);
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
};

// A zero-size input whose handler takes the file, empties the input, and shows
// the name in a preview on a later render.
const LATE = `<label><input type=file id=f name=file style='width:0;height:0'></label><div id=prev></div>`;
const LATE_JS = `document.getElementById('f').addEventListener('change', (e) => {
  const n = e.target.files[0].name;
  e.target.value = '';
  e.target.files = new DataTransfer().files;
  setTimeout(() => { document.getElementById('prev').innerHTML = '<section><div class=fileName>' + n + '</div><button aria-label="Remove file"></button></section>'; }, 50);
});`;

test("file_upload: a name the site shows a tick after clearing the input reads shown", async (t) => {
  const path = await cvFile(t);
  onPage(LATE, LATE_JS);
  const o = await upload({ path, selector: "#f" });
  assert.deepEqual(o, { ok: true, name: "cv.pdf", size: 8, type: "application/pdf", cleared: true, shown: true });
});

test("file_upload: a removed input with no indicator ends not shown after a short bounded wait", async (t) => {
  const path = await cvFile(t);
  const { world } = onPage(`<input type=file id=f>`, `document.getElementById('f').addEventListener('change', (e) => e.target.remove());`);
  const t0 = world.clock.t;
  const o = await upload({ path, selector: "#f" });
  assert.equal(o.ok, true);
  assert.equal(o.detached, true);
  assert.equal(o.shown, false);
  const spent = world.clock.t - t0;
  assert.ok(spent >= 500 && spent <= 1500, `spent ${spent}ms`);
});

test("file_upload: a name shown at once needs no wait", async (t) => {
  const path = await cvFile(t);
  const { world } = onPage(`<input type=file id=f><ul id=l></ul>`, `document.getElementById('f').addEventListener('change', (e) => {
    document.getElementById('l').innerHTML = '<li>' + e.target.files[0].name + '</li>';
    e.target.files = new DataTransfer().files;
  });`);
  const t0 = world.clock.t;
  const o = await upload({ path, selector: "#f" });
  assert.equal(o.shown, true);
  assert.equal(o.cleared, true);
  assert.equal(world.clock.t - t0, 0, "no follow-up poll");
});

// ---- size cap: checked from a stat, before a byte is read or an Apple Event sent ----

async function sizedFile(t, bytes) {
  const dir = await mkdtemp(join(tmpdir(), "perch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = join(dir, "big.pdf");
  await writeFile(f, "");
  await truncate(f, bytes);
  return f;
}
const refusal = async (args) => {
  const r = await handleCall("file_upload", args);
  assert.equal(r.isError, true, r.content[0].text);
  return r.content[0].text;
};

test("file_upload: a file over 25MB is refused before any Apple Event", async (t) => {
  const path = await sizedFile(t, 25 * 1024 * 1024 + 1);
  const { world } = onPage(`<input type=file id=f>`);
  world.aeLog.length = 0;
  assert.match(await refusal({ path, selector: "#f" }), /^error: file_upload: .*big\.pdf is 25\.0MB, over the 25MB cap/);
  assert.deepEqual(world.aeLog, []);
});

test("file_upload: over 700KB still goes through the daemon", async (t) => {
  const path = await sizedFile(t, 700 * 1024 + 1);
  onPage(`<input type=file id=f>`);
  assert.equal((await upload({ path, selector: "#f" })).ok, true);
});

test("file_upload: without the daemons the cap drops to 700KB, the one-shot argument limit", async (t) => {
  const path = await sizedFile(t, 700 * 1024 + 1);
  const { world } = onPage(`<input type=file id=f>`);
  const saved = { ...DAEMONS };
  delete DAEMONS.fast; delete DAEMONS.slow;
  t.after(() => Object.assign(DAEMONS, saved));
  world.aeLog.length = 0;
  assert.match(await refusal({ path, selector: "#f" }), /over the 700KB cap.*PERCH_DAEMON=0/);
  assert.deepEqual(world.aeLog, []);
});

test("file_upload: a daemon that disabled itself counts as no daemon", async (t) => {
  const path = await sizedFile(t, 700 * 1024 + 1);
  const { world } = onPage(`<input type=file id=f>`);
  world.daemon.disabled = "osascript failed to start: timeout";
  assert.match(await refusal({ path, selector: "#f" }), /over the 700KB cap/);
});

test("file_upload: a missing file still reads as cannot read", async () => {
  onPage(`<input type=file id=f>`);
  assert.match(await refusal({ path: "/nonexistent/perch-none.pdf" }), /cannot read \/nonexistent\/perch-none\.pdf/);
});
