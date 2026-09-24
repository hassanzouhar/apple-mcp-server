#!/usr/bin/env node
/**
 * apple-mcp-server — MCP server for Apple Calendar, Reminders, Contacts, and Mail.
 *
 * Transport: stdio (this is a local desktop integration, not a remote service).
 * Logs go to STDERR — stdout is reserved for the MCP protocol stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerImessageTools } from "./tools/imessage.js";
import { registerMailTools } from "./tools/mail.js";
import { registerReminderTools } from "./tools/reminders.js";

function log(message: string): void {
  // Stdio MCP servers MUST NOT write to stdout — that's the protocol channel.
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

async function main() {
  if (process.platform !== "darwin") {
    log(
      `FATAL: ${SERVER_NAME} only runs on macOS — process.platform was '${process.platform}'.`,
    );
    process.exit(1);
  }

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerCalendarTools(server);
  registerReminderTools(server);
  registerContactTools(server);
  registerMailTools(server);
  registerImessageTools(server);

  log(
    `${SERVER_NAME} v${SERVER_VERSION} starting (Calendar + Reminders + Contacts + Mail + iMessage)`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("stdio transport ready");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[${SERVER_NAME}] fatal: ${message}\n`);
  process.exit(1);
});
