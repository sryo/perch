import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

// Clients without skills (Codex reads MCP resources through its own tools) get
// perch's guide as a resource; it costs nothing in tools/list.
test("SKILL.md is served as the perch://skill resource", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => [r.uri, r.mimeType]), [["perch://skill", "text/markdown"]]);
  const { contents } = await client.readResource({ uri: "perch://skill" });
  assert.equal(contents[0].text, readFileSync(new URL("../SKILL.md", import.meta.url), "utf8"));
  await assert.rejects(client.readResource({ uri: "perch://nope" }));
  await client.close();
});
