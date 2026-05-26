/**
 * Shared formatting and error-handling helpers used across all tools.
 */

import { OsaScriptError } from "./osascript.js";
import { CHARACTER_LIMIT } from "../constants.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/**
 * Standard tool-result envelope returned to the MCP host. Matches the shape
 * the MCP SDK expects from a tool handler — note the open index signature
 * which the SDK's CallToolResult type demands.
 */
export interface ToolResult {
  [k: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Coerce arbitrary values into the Record<string, unknown> shape required by
 * the MCP SDK for `structuredContent`. Primitives and arrays get wrapped in
 * `{ value: ... }` so the SDK's typing accepts them.
 */
function toStructured(value: unknown): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/**
 * Build a successful ToolResult, automatically choosing the text content
 * representation based on the requested response format.
 */
export function buildResult(
  format: ResponseFormat,
  markdown: string,
  structured: unknown,
): ToolResult {
  let text = format === ResponseFormat.MARKDOWN
    ? markdown
    : JSON.stringify(structured, null, 2);

  if (text.length > CHARACTER_LIMIT) {
    const truncMsg =
      `\n\n[Response truncated: ${text.length} > ${CHARACTER_LIMIT} chars. ` +
      `Pass a smaller \`limit\`, narrower date range, or more specific filters.]`;
    text = text.slice(0, CHARACTER_LIMIT - truncMsg.length) + truncMsg;
  }

  return {
    content: [{ type: "text", text }],
    structuredContent: toStructured(structured),
  };
}

/**
 * Build a uniform error ToolResult. Always sets isError=true so the MCP host
 * can surface the problem to the agent, and includes hints when we can.
 */
export function errorResult(err: unknown, hint?: string): ToolResult {
  const message = describeError(err);
  const fullText = hint
    ? `Error: ${message}\n\nHint: ${hint}`
    : `Error: ${message}`;
  return {
    isError: true,
    content: [{ type: "text", text: fullText }],
  };
}

/**
 * Translate raw errors into actionable messages for the agent.
 */
export function describeError(err: unknown): string {
  if (err instanceof OsaScriptError) {
    const lower = (err.stderr || err.message).toLowerCase();
    if (lower.includes("not authorized") || lower.includes("not allowed assistive access") || lower.includes("-1743") || lower.includes("not allowed to send apple events")) {
      return (
        `macOS denied access. Grant the host app (the process running this MCP server, ` +
        `e.g. your terminal or Claude desktop) permission under ` +
        `System Settings → Privacy & Security → Automation, and for Contacts/Calendar/Reminders ` +
        `also under the matching Privacy & Security category. ` +
        `Original: ${err.message}`
      );
    }
    if (lower.includes("can’t get") || lower.includes("can't get")) {
      return `The named record was not found. ${err.message}`;
    }
    if (lower.includes("application isn’t running") || lower.includes("application isn't running") || lower.includes("application not running")) {
      return `The target app (Calendar / Reminders / Contacts / Mail) is not running. The MCP will auto-launch it on the next call; if this persists, open the app once manually. Original: ${err.message}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Truncate a string to `max` characters with an ellipsis. Used in Markdown
 * renderers to keep table-style lines readable.
 */
export function clip(value: string | null | undefined, max = 80): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

/**
 * Render an ISO date as a human-friendly local string.
 */
export function humanDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
