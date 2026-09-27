import { test } from "node:test";
import assert from "node:assert/strict";
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
