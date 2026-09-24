/**
 * iMessage / Messages.app tools.
 *
 * Reads go through the chat.db SQLite store (services/imessagestore.ts) — fast
 * and rich. Sending goes through Messages.app via JXA.
 *
 * Caveats worth knowing:
 *   - Reading chat.db requires Full Disk Access for the host process.
 *   - Sending via Messages.app over JXA is inherently less reliable than the
 *     read path on recent macOS: the recipient must be resolvable as a buddy on
 *     an active iMessage service. `send` is gated behind confirm=true like every
 *     other outward-facing action.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MESSAGES_OSASCRIPT_TIMEOUT_MS } from "../constants.js";
import {
  limitField,
  optionalIsoDateField,
  responseFormatField,
} from "../schemas/common.js";
import { buildResult, clip, errorResult, humanDate } from "../services/format.js";
import { runJxa } from "../services/osascript.js";
import {
  listChats as storeListChats,
  listMessages as storeListMessages,
  searchMessages as storeSearchMessages,
  type ChatSummary,
  type ImessageSummary,
} from "../services/imessagestore.js";
import { consolidatedShape, parseAction } from "./dispatch.js";

/* ──────────────────────────────────────────────────────────────────────── */
/* list_chats                                                               */
/* ──────────────────────────────────────────────────────────────────────── */

const ListChatsInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Optional. Substring match against chat name, identifier, or a participant's phone/email.",
      ),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

function chatLine(c: ChatSummary): string {
  const who = c.isGroup
    ? `${c.name} _(group: ${c.participants.join(", ") || "—"})_`
    : c.name;
  const preview = clip(`${c.lastFromMe ? "You: " : ""}${c.lastText}`, 60);
  return (
    `- **${who}** — ${humanDate(c.lastDate)} — ${preview} ` +
    `_[${c.service ?? "?"}]_ — chat: \`${c.identifier}\``
  );
}

async function listChats(params: z.infer<typeof ListChatsInput>) {
  try {
    const chats = await storeListChats({
      query: params.query ?? null,
      limit: params.limit,
    });
    const md = [
      `# iMessage chats (${chats.length})`,
      "",
      chats.length === 0 ? "_No chats found._" : chats.map(chatLine).join("\n"),
    ].join("\n");
    return buildResult(params.response_format, md, {
      count: chats.length,
      chats,
    });
  } catch (e) {
    return errorResult(
      e,
      "Reading iMessage requires Full Disk Access for the host app (System Settings → Privacy & Security → Full Disk Access).",
    );
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* list_messages                                                            */
/* ──────────────────────────────────────────────────────────────────────── */

const ListMessagesInput = z
  .object({
    chat: z
      .string()
      .min(1)
      .describe(
        "Which conversation to read: a chat identifier (phone/email or group id) " +
          "from list_chats, or a numeric chat id.",
      ),
    since: optionalIsoDateField.describe(
      "Optional. Only return messages on/after this date.",
    ),
    until: optionalIsoDateField.describe(
      "Optional. Only return messages strictly before this date.",
    ),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

function messageLine(m: ImessageSummary): string {
  const who = m.fromMe ? "You" : m.sender ?? "Them";
  return `- **${who}** _(${humanDate(m.date)})_: ${m.text}`;
}

async function listMessages(params: z.infer<typeof ListMessagesInput>) {
  try {
    const msgs = await storeListMessages({
      chat: params.chat,
      since: params.since ?? null,
      until: params.until ?? null,
      limit: params.limit,
    });
    const md = [
      `# Conversation \`${params.chat}\` (${msgs.length} messages, oldest first)`,
      "",
      msgs.length === 0
        ? "_No messages match._"
        : msgs.map(messageLine).join("\n"),
    ].join("\n");
    return buildResult(params.response_format, md, {
      chat: params.chat,
      count: msgs.length,
      messages: msgs,
    });
  } catch (e) {
    return errorResult(
      e,
      "Reading iMessage requires Full Disk Access for the host app. Use action 'list_chats' to find a valid `chat` value.",
    );
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* search                                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

const SearchInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe("Case-insensitive substring to find in message text."),
    chat: z
      .string()
      .min(1)
      .optional()
      .describe("Optional. Limit the search to one conversation."),
    scan: z
      .number()
      .int()
      .min(1)
      .max(20_000)
      .default(2000)
      .describe(
        "How many recent messages to scan. Most message bodies are stored in a " +
          "binary field that can't be searched in SQL, so search decodes and scans " +
          "the most-recent N messages. Higher = slower but more thorough.",
      ),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

async function search(params: z.infer<typeof SearchInput>) {
  try {
    const msgs = await storeSearchMessages({
      query: params.query,
      chat: params.chat ?? null,
      scan: params.scan,
      limit: params.limit,
    });
    const md = [
      `# iMessage search: \`${params.query}\` (${msgs.length})`,
      "",
      ...msgs.map(
        (m) =>
          `- **${m.fromMe ? "You" : m.sender ?? "Them"}** _(${humanDate(m.date)})_ ` +
          `in chat \`${m.chatId}\`: ${clip(m.text, 100)}`,
      ),
    ].join("\n");
    return buildResult(params.response_format, md, {
      query: params.query,
      count: msgs.length,
      messages: msgs,
    });
  } catch (e) {
    return errorResult(
      e,
      "Reading iMessage requires Full Disk Access for the host app (System Settings → Privacy & Security → Full Disk Access).",
    );
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* send                                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const SendInput = z
  .object({
    to: z
      .string()
      .min(1)
      .describe(
        "Recipient handle: a phone number (E.164, e.g. +4712345678) or an iMessage email.",
      ),
    text: z.string().min(1).max(20_000).describe("The message body to send."),
    confirm: z
      .literal(true)
      .describe(
        "Required acknowledgement that the message will actually be sent. Must be true.",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function send(params: z.infer<typeof SendInput>) {
  try {
    const result = await runJxa<{ sent: boolean; service: string }>({
      args: { to: params.to, text: params.text },
      timeoutMs: MESSAGES_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Messages = Application('Messages');

        // Prefer an iMessage service; fall back to whatever is signed in.
        let svc = null;
        try {
          const im = Messages.services.whose({ serviceType: 'iMessage' })();
          if (im.length) svc = im[0];
        } catch (_) {}
        if (!svc) {
          const all = Messages.services();
          for (let i = 0; i < all.length; i++) {
            try {
              const enabled = (function(){ try { return all[i].enabled(); } catch (_) { return true; } })();
              if (enabled) { svc = all[i]; break; }
            } catch (_) {}
          }
          if (!svc && all.length) svc = all[0];
        }
        if (!svc) throw new Error("No Messages service is available — open Messages.app and sign in to iMessage.");

        // Resolve the recipient to a buddy on that service.
        let buddy = null;
        try {
          const matches = svc.buddies.whose({ handle: INPUT.to })();
          if (matches.length) buddy = matches[0];
        } catch (_) {}
        if (!buddy) {
          try { buddy = svc.buddies.byId('iMessage;-;' + INPUT.to); buddy.id(); } catch (_) { buddy = null; }
        }
        if (!buddy) {
          throw new Error("Could not resolve recipient '" + INPUT.to + "' as a buddy on the active service. Make sure you've messaged them before, or that the handle is correct.");
        }

        Messages.send(INPUT.text, { to: buddy });
        let svcName = 'Messages';
        try { svcName = String(svc.serviceType()); } catch (_) {}
        return { sent: true, service: svcName };
      `,
    });
    return buildResult(
      params.response_format,
      `Sent via ${result.service} → ${params.to}`,
      { sent: result.sent, to: params.to, service: result.service },
    );
  } catch (e) {
    return errorResult(
      e,
      "Sending requires Messages.app to be signed in and the host app to have Automation permission for Messages (System Settings → Privacy & Security → Automation).",
    );
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Registration                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

const imessageAction = z
  .enum(["list_chats", "list_messages", "search", "send"])
  .describe(
    [
      "Which iMessage operation to perform. Required fields per action:",
      "• list_chats — optional query, limit",
      "• list_messages — chat; optional since, until, limit",
      "• search — query; optional chat, scan, limit",
      "• send — to, text, confirm=true (sends IMMEDIATELY via Messages.app)",
    ].join("\n"),
  );

const ImessageToolInput = z.object(
  consolidatedShape(imessageAction, [
    ListChatsInput,
    ListMessagesInput,
    SearchInput,
    SendInput,
  ]),
);

async function dispatchImessage(raw: z.infer<typeof ImessageToolInput>) {
  try {
    switch (raw.action) {
      case "list_chats":
        return await listChats(parseAction(ListChatsInput, raw));
      case "list_messages":
        return await listMessages(parseAction(ListMessagesInput, raw));
      case "search":
        return await search(parseAction(SearchInput, raw));
      case "send":
        return await send(parseAction(SendInput, raw));
      default:
        return errorResult(
          new Error(`Unknown imessage action: ${String(raw.action)}`),
        );
    }
  } catch (e) {
    return errorResult(e);
  }
}

export function registerImessageTools(server: McpServer) {
  server.registerTool(
    "imessage",
    {
      title: "iMessage",
      description:
        "Read and send iMessage / SMS via Messages.app. Pick an operation with " +
        "`action`: list_chats (recent conversations), list_messages (read one " +
        "conversation), search (find messages by text), send (send a new message). " +
        "Reading requires Full Disk Access; `send` dispatches IMMEDIATELY and " +
        "requires confirm=true. This is iMessage/SMS — for email use the `mail` tool.",
      inputSchema: ImessageToolInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    dispatchImessage,
  );
}
