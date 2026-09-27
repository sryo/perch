import { test } from "node:test";
import assert from "node:assert/strict";
import { sameTab } from "../scripts/mcp-client.mjs";

test("sameTab compares whole handles, never just the browser", () => {
  assert.equal(sameTab("canary:5", "canary:5"), true);
  assert.equal(sameTab("canary:5", "canary:6"), false);
  assert.equal(sameTab("canary:5", "chrome:5"), false);
  assert.equal(sameTab("arc:ab-12", "arc:ab-13"), false);
});

test("sameTab ignores a Safari handle's URL hash, which a load changes", () => {
  assert.equal(sameTab("safari:7.2.k3f9", "safari:7.2.a01x"), true);
  assert.equal(sameTab("safari:7.2.k3f9", "safari:7.3.k3f9"), false);
  assert.equal(sameTab("safari:7.2.k3f9", "safari:8.2.k3f9"), false);
  assert.equal(sameTab("canary:7.2.x", "canary:7.2.y"), false, "only Safari handles carry a hash");
});
