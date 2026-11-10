#!/usr/bin/env node
// Stands in for the loft CLI (github.com/sryo/loft) for perch's new_tab {loft:"WxH"}:
// logs each argv line to $FAKE_LOFT_LOG, answers `up WxH --new --owner <pid> --json`
// by writing $LOFT_HOME/lofts/loft-<n>.json (its holder pid: the caller, alive) for
// display $FAKE_LOFT_DISPLAY, and `down <id>` by removing it. FAKE_LOFT=fail answers
// up as loft does when the display can't be added; FAKE_LOFT=bad_size as for a bad size.
import { appendFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
if (process.env.FAKE_LOFT_LOG) appendFileSync(process.env.FAKE_LOFT_LOG, argv.join(" ") + "\n");
const dir = join(process.env.LOFT_HOME, "lofts");
if (argv[0] === "up") {
  if (process.env.FAKE_LOFT === "fail") { console.log(JSON.stringify({ ok: false, code: "display_failed", error: "could not add the display: CGVirtualDisplay returned no display" })); process.exit(1); }
  const [w, h] = argv[1].split("x").map(Number);
  if (process.env.FAKE_LOFT === "bad_size" || w < 640) { console.log(JSON.stringify({ ok: false, code: "bad_size", error: `size must be WIDTHxHEIGHT, from 640x480 to 5120x2880 (got ${argv[1]})` })); process.exit(2); }
  let n = 1;
  while (existsSync(join(dir, `loft-${n}.json`))) n++;
  const id = `loft-${n}`, displayId = Number(process.env.FAKE_LOFT_DISPLAY || 81);
  const owner = Number(argv[argv.indexOf("--owner") + 1]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ pid: process.ppid, cmd: "holder.js", displayId, x: -w, y: 0, w, h, serial: 2, owner, started: "2026-11-10T10:00:00Z" }));
  console.log(JSON.stringify({ up: true, id, displayId, vendor: 0x6c66, product: 0x7466, name: "loft", bounds: { x: -w, y: 0, w, h } }));
} else if (argv[0] === "down") {
  rmSync(join(dir, `${argv[1]}.json`), { force: true });
  console.log(`loft ${argv[1]} is down`);
}
