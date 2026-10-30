// Names other projects detect perch by stay exported: figma-cdp copies from
// before 5725447 check for buildMainKick to know eval_js has world:"main".
import { test } from "node:test";
import assert from "node:assert/strict";
import * as perch from "../server.js";

test("buildMainKick, buildMainRead and buildMainDrop alias the main-world kick, read and drop", () => {
  for (const name of ["buildMainKick", "buildMainRead", "buildMainDrop", "buildKick", "handleCall"]) assert.equal(typeof perch[name], "function", name);
  assert.equal(perch.buildMainKick("return 1", "__k", true), perch.buildKick("return 1", "__k", { world: "main", awaitPromise: true }));
  assert.equal(perch.buildMainKick("return 1", "__k"), perch.buildKick("return 1", "__k", { world: "main" }));
  assert.equal(perch.buildMainRead("__k"), perch.buildRead("__k", "main"));
  assert.equal(perch.buildMainDrop("__k"), perch.buildDrop("__k"));
});
