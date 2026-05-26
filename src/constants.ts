/**
 * Shared constants for the Apple MCP server.
 */

export const SERVER_NAME = "apple-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Maximum number of characters to return in a single tool response. */
export const CHARACTER_LIMIT = 25_000;

/** Default page size for list operations. */
export const DEFAULT_LIMIT = 25;

/** Maximum page size for list operations. */
export const MAX_LIMIT = 100;

/** Maximum length of an AppleScript/JXA script we will execute. */
export const MAX_SCRIPT_LENGTH = 200_000;

/** Default osascript timeout in milliseconds. */
export const DEFAULT_OSASCRIPT_TIMEOUT_MS = 30_000;

/** Longer timeout for Mail operations which can be very slow. */
export const MAIL_OSASCRIPT_TIMEOUT_MS = 60_000;
