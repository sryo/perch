// Fakes for Node's screencapture/sips fallback, and a TMPDIR of the test's own
// so whatever the fallback leaves behind is visible.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tempDir } from "../../scripts/temp.mjs";
import { page } from "./page.mjs";

export const SHOT_NO_IMAGE = "timeout: screenshot: the window capture gave no image within 3s; nothing was captured";
export const NO_GRANT = "screenshot: needs the Screen Recording grant for the app running perch (System Settings > Privacy & Security > Screen Recording); nothing was captured";
export const BOUND = { timeout: 3000, killSignal: "SIGKILL" };
export const RAW = "Command failed: screencapture -l 77 -x -o -t png /var/folders/xy/T/perch-1-abc.png";

export function ownTmp(t) {
  const dir = tempDir("perch-shot-", t);
  const was = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(() => { if (was == null) delete process.env.TMPDIR; else process.env.TMPDIR = was; });
  return dir;
}

export function clean(text) {
  for (const k of ["Command failed", "ENOENT", "/var/folders", "perch-"]) assert.ok(!text.includes(k), text);
}

// A child that hangs: without a timeout option it never settles; with one it
// writes a partial file and is killed, as execFile reports a timeout. Any other
// command goes to `rest`.
export function hung(which, seen, rest) {
  return (cmd, a, opts) => {
    if (cmd !== which || (which === "sips" && a[0] !== "--cropToHeightWidth")) return rest(cmd, a, opts);
    seen.push([cmd, opts]);
    if (!opts || !opts.timeout) return new Promise(() => {});
    return writeFile(a[a.length - 1], "partial").then(() => {
      throw Object.assign(new Error(RAW), { killed: true, signal: opts.killSignal, code: null });
    });
  };
}

// A page whose #t sits at `from` (client CSS px, below the viewport by default)
// and at `rect` once scrolled into view, inside #box, scrolled to 37; the
// window is scrolled to (0, 40). scrollIntoView scrolls both, as a browser
// would, unless #t already sits at `rect` (fully visible: a no-op), and
// records how it was asked. `boxRect` makes #box an overflow:auto scroller
// with that rect as its client area.
export function scrolled({ rect = "100,200,300,50", from = "100,1200,300,50", iw = 800, ih = 620, boxRect = null } = {}) {
  const dom = page(`<div id=box${boxRect ? ` style="overflow:auto" data-rect="${boxRect}"` : ""}><p id=t data-rect="${from}">x</p></div><p id=u>u</p>`);
  for (const [k, v] of Object.entries({ innerWidth: iw, innerHeight: ih })) {
    Object.defineProperty(dom, k, { value: v, configurable: true });
  }
  const box = dom.document.getElementById("box"), t = dom.document.getElementById("t");
  if (boxRect) {
    const [, , w, h] = boxRect.split(",").map(Number);
    Object.defineProperty(box, "clientWidth", { value: w });
    Object.defineProperty(box, "clientHeight", { value: h });
  }
  dom.scrollTo({ left: 0, top: 40, behavior: "instant" });
  box.scrollTop = 37;
  // Animation frames run one per page script the world sends (see install).
  dom.rafs = [];
  dom.requestAnimationFrame = (cb) => dom.rafs.push(cb);
  // Timers fire only on a page script that finds no frame pending (see install).
  dom.timers = [];
  dom.setTimeout = (cb) => dom.timers.push(cb);
  dom.intoView = [];
  t.scrollIntoView = function (o) {
    dom.intoView.push(o);
    if (t.getAttribute("data-rect") === rect) return;
    t.setAttribute("data-rect", rect);
    dom.scrollTo({ left: 0, top: 900, behavior: "instant" });
    box.scrollTop = 0;
  };
  return { dom, box, t };
}
export const where = ({ dom, box }) => [dom.scrollX, dom.scrollY, box.scrollTop];
// An element already fully visible, which scrollIntoView leaves in place.
export const still = (opts = {}) => scrolled({ ...opts, from: opts.rect || "100,200,300,50" });
