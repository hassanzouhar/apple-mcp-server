import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Every destructive action, with otherwise-valid params. These calls must be
// rejected by validation BEFORE anything reaches the OS, so they never touch
// real personal data. If a guard regressed, the call would hit a real app, so
// the params use ids/addresses that cannot match anything.
const DESTRUCTIVE: Array<[tool: string, args: Record<string, unknown>]> = [
  ["calendar", { action: "delete_event", event_id: "amcp-test-nonexistent" }],
  ["reminders", { action: "delete", reminder_id: "amcp-test-nonexistent" }],
  ["contacts", { action: "delete", contact_id: "amcp-test-nonexistent" }],
  ["mail", { action: "delete", message_id: "amcp-test-nonexistent" }],
  [
    "mail",
    { action: "send", to: ["amcp-test@invalid.invalid"], subject: "test", body: "test" },
  ],
  ["imessage", { action: "send", to: "amcp-test-nonexistent", text: "test" }],
];

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const entry = process.env.AMCP_TEST_ENTRY;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: entry
      ? [entry]
      : ["--import", "tsx", fileURLToPath(new URL("../index.ts", import.meta.url))],
    stderr: "pipe",
  });
  const client = new Client({ name: "guard-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("destructive actions are rejected without confirm=true", {
  skip: process.platform !== "darwin",
  timeout: 20_000,
}, async () => {
  await withClient(async (client) => {
    for (const [name, args] of DESTRUCTIVE) {
      for (const confirm of [undefined, false, "true", 1]) {
        const arguments_ = confirm === undefined ? args : { ...args, confirm };
        const r = await client.callTool({ name, arguments: arguments_ });
        const label = `${name}.${args.action} confirm=${JSON.stringify(confirm)}`;
        assert.equal(r.isError, true, label);
        const text = JSON.stringify(r.content);
        // Rejected by either the SDK's outer schema or parseAction's per-action schema.
        assert.match(text, /Invalid parameters|Input validation error/, label);
        assert.match(text, /confirm/, label);
      }
    }
  });
});

test("tool annotations mark every tool as destructive and open-world", {
  skip: process.platform !== "darwin",
  timeout: 15_000,
}, async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, false, t.name);
      assert.equal(t.annotations?.destructiveHint, true, t.name);
      assert.equal(t.annotations?.openWorldHint, true, t.name);
    }
  });
});

test("manifest.json tools match the tools the server registers", {
  skip: process.platform !== "darwin",
  timeout: 15_000,
}, async () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
  ) as { tools: { name: string }[] };
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      manifest.tools.map((t) => t.name).sort(),
      tools.map((t) => t.name).sort(),
    );
  });
});
