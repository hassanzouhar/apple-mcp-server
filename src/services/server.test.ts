import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exercise the real protocol without reading or modifying personal app data.
test("MCP server starts, lists all apps, and rejects invalid actions", {
  skip: process.platform !== "darwin", timeout: 15_000,
}, async () => {
  const entry = process.env.AMCP_TEST_ENTRY;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: entry ? [entry] : ["--import", "tsx", fileURLToPath(new URL("../index.ts", import.meta.url))],
    stderr: "pipe",
  });
  const client = new Client({ name: "regression-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ["calendar", "contacts", "imessage", "mail", "reminders"]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.inputSchema.required?.includes("action"));
      const result = await client.callTool({ name: tool.name, arguments: { action: "__invalid_test_action__" } });
      assert.equal(result.isError, true, tool.name);
    }
    const result = await client.callTool({ name: "contacts", arguments: { action: "get" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Invalid parameters/);
  } finally {
    await client.close();
  }
});
