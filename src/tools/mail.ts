/**
 * Mail.app tools.
 *
 * Notes:
 *   - Mail is the slowest of the apps we wrap; we use longer timeouts and
 *     aggressive limits.
 *   - whose() filters on `messages` are unreliable on large mailboxes;
 *     prefer scanning the most-recent N messages and filtering in JS.
 *   - send_message is destructive (you can't un-send). It is opt-in via a
 *     required `confirm` parameter so an agent can't fire emails accidentally.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MAIL_OSASCRIPT_TIMEOUT_MS } from "../constants.js";
import {
  limitField,
  optionalIsoDateField,
  responseFormatField,
} from "../schemas/common.js";
import {
  buildResult,
  clip,
  errorResult,
  humanDate,
} from "../services/format.js";
import { runJxa } from "../services/osascript.js";

/* ──────────────────────────────────────────────────────────────────────── */
/* Types                                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

interface RawMailAccount {
  id: string;
  name: string;
  fullName: string | null;
  emailAddresses: string[];
}

interface RawMailbox {
  name: string;
  accountName: string | null;
  unreadCount: number;
}

interface RawMessageSummary {
  id: string;
  subject: string;
  sender: string;
  dateSent: string | null;
  read: boolean;
  mailbox: string;
  account: string | null;
}

interface RawMessage extends RawMessageSummary {
  recipients: string[];
  ccRecipients: string[];
  content: string;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_list_mail_accounts                                                 */
/* ──────────────────────────────────────────────────────────────────────── */

const ListAccountsInput = z
  .object({ response_format: responseFormatField })
  .strict();

async function listAccounts(params: z.infer<typeof ListAccountsInput>) {
  try {
    const accounts = await runJxa<RawMailAccount[]>({
      timeoutMs: MAIL_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Mail = Application('Mail');
        return Mail.accounts().map(a => ({
          id: a.id(),
          name: a.name(),
          fullName: a.fullName() || null,
          emailAddresses: a.emailAddresses() || [],
        }));
      `,
    });
    const md = [
      `# Mail Accounts (${accounts.length})`,
      "",
      ...accounts.map((a) => {
        const addrs = a.emailAddresses.join(", ");
        return `- **${a.name}** — ${addrs || "(no addresses)"} — id: \`${a.id}\``;
      }),
    ].join("\n");
    return buildResult(params.response_format, md, {
      count: accounts.length,
      accounts,
    });
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_list_mailboxes                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const ListMailboxesInput = z
  .object({
    account_name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Limit to one account's mailboxes. Use apple_list_mail_accounts to discover.",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function listMailboxes(params: z.infer<typeof ListMailboxesInput>) {
  try {
    const boxes = await runJxa<RawMailbox[]>({
      args: { accountName: params.account_name ?? null },
      timeoutMs: MAIL_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Mail = Application('Mail');
        const out = [];
        const accounts = INPUT.accountName
          ? Mail.accounts.whose({ name: INPUT.accountName })()
          : Mail.accounts();
        if (INPUT.accountName && accounts.length === 0) {
          throw new Error("Mail account not found: " + INPUT.accountName);
        }
        for (let i = 0; i < accounts.length; i++) {
          const a = accounts[i];
          const boxes = a.mailboxes();
          for (let j = 0; j < boxes.length; j++) {
            const b = boxes[j];
            let unread = 0;
            try { unread = b.unreadCount(); } catch (_) {}
            out.push({ name: b.name(), accountName: a.name(), unreadCount: unread });
          }
        }
        return out;
      `,
    });
    const md = [
      `# Mailboxes (${boxes.length})`,
      "",
      ...boxes.map(
        (b) =>
          `- **${b.name}**${b.accountName ? ` _(${b.accountName})_` : ""}` +
          (b.unreadCount > 0 ? ` — ${b.unreadCount} unread` : ""),
      ),
    ].join("\n");
    return buildResult(params.response_format, md, {
      count: boxes.length,
      mailboxes: boxes,
    });
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_list_messages                                                      */
/* ──────────────────────────────────────────────────────────────────────── */

const ListMessagesInput = z
  .object({
    mailbox_name: z
      .string()
      .min(1)
      .describe(
        "Name of the mailbox to list from (e.g. 'INBOX'). Use apple_list_mailboxes to discover.",
      ),
    account_name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Restrict to one account. Required if the same mailbox name exists under multiple accounts.",
      ),
    unread_only: z.boolean().default(false),
    since: optionalIsoDateField.describe(
      "Optional. Only return messages with dateSent on/after this date.",
    ),
    until: optionalIsoDateField.describe(
      "Optional. Only return messages with dateSent strictly before this date.",
    ),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

async function listMessages(params: z.infer<typeof ListMessagesInput>) {
  try {
    const msgs = await runJxa<RawMessageSummary[]>({
      args: {
        mailboxName: params.mailbox_name,
        accountName: params.account_name ?? null,
        unreadOnly: params.unread_only,
        sinceIso: params.since ?? null,
        untilIso: params.until ?? null,
        limit: params.limit,
      },
      timeoutMs: MAIL_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Mail = Application('Mail');
        const accounts = INPUT.accountName
          ? Mail.accounts.whose({ name: INPUT.accountName })()
          : Mail.accounts();
        if (INPUT.accountName && accounts.length === 0) {
          throw new Error("Mail account not found: " + INPUT.accountName);
        }

        const since = INPUT.sinceIso ? new Date(INPUT.sinceIso) : null;
        const until = INPUT.untilIso ? new Date(INPUT.untilIso) : null;

        const out = [];
        outer: for (let i = 0; i < accounts.length; i++) {
          const a = accounts[i];
          let boxes;
          try { boxes = a.mailboxes.whose({ name: INPUT.mailboxName })(); }
          catch (_) { boxes = []; }
          for (let j = 0; j < boxes.length; j++) {
            const box = boxes[j];
            // Mail returns messages newest-first by default.
            const msgs = box.messages();
            for (let k = 0; k < msgs.length && out.length < INPUT.limit; k++) {
              const m = msgs[k];
              let read = true;
              try { read = !!m.readStatus(); } catch (_) {}
              if (INPUT.unreadOnly && read) continue;
              let ds = null;
              try { ds = m.dateSent(); } catch (_) {}
              if (since && (!ds || ds < since)) continue;
              if (until && (!ds || ds >= until)) continue;
              out.push({
                id: m.id(),
                subject: m.subject() || "",
                sender: m.sender() || "",
                dateSent: ds ? ds.toISOString() : null,
                read,
                mailbox: box.name(),
                account: a.name(),
              });
              if (out.length >= INPUT.limit) break outer;
            }
          }
        }
        return out;
      `,
    });

    const md = [
      `# Messages in \`${params.mailbox_name}\`${params.account_name ? ` _(${params.account_name})_` : ""} — ${msgs.length}`,
      "",
      ...msgs.map(
        (m) =>
          `- ${m.read ? "📭" : "📬"} **${clip(m.subject || "(no subject)", 70)}** ` +
          `_from ${clip(m.sender, 40)}_ — ${humanDate(m.dateSent)} — id: \`${m.id}\``,
      ),
    ].join("\n");
    return buildResult(params.response_format, md, {
      count: msgs.length,
      mailbox_name: params.mailbox_name,
      messages: msgs,
    });
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_search_messages                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

const SearchMessagesInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Case-insensitive substring match against subject and sender. (Content is NOT searched for performance reasons — use Mail.app for full-text search.)",
      ),
    mailbox_name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Limit to one mailbox. Recommended for large mailboxes.",
      ),
    account_name: z.string().min(1).optional(),
    scan: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(500)
      .describe(
        "How many recent messages to scan per matching mailbox. Higher = slower but more thorough.",
      ),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

async function searchMessages(params: z.infer<typeof SearchMessagesInput>) {
  try {
    const msgs = await runJxa<RawMessageSummary[]>({
      args: {
        query: params.query.toLowerCase(),
        mailboxName: params.mailbox_name ?? null,
        accountName: params.account_name ?? null,
        scan: params.scan,
        limit: params.limit,
      },
      timeoutMs: MAIL_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Mail = Application('Mail');
        const accounts = INPUT.accountName
          ? Mail.accounts.whose({ name: INPUT.accountName })()
          : Mail.accounts();
        const out = [];
        outer: for (let i = 0; i < accounts.length; i++) {
          const a = accounts[i];
          const boxes = INPUT.mailboxName
            ? a.mailboxes.whose({ name: INPUT.mailboxName })()
            : a.mailboxes();
          for (let j = 0; j < boxes.length && out.length < INPUT.limit; j++) {
            const box = boxes[j];
            let msgs;
            try { msgs = box.messages(); } catch (_) { msgs = []; }
            const max = Math.min(msgs.length, INPUT.scan);
            for (let k = 0; k < max && out.length < INPUT.limit; k++) {
              const m = msgs[k];
              const subject = (m.subject() || "").toLowerCase();
              const sender = (m.sender() || "").toLowerCase();
              if (!subject.includes(INPUT.query) && !sender.includes(INPUT.query)) continue;
              let ds = null;
              try { ds = m.dateSent(); } catch (_) {}
              let read = true;
              try { read = !!m.readStatus(); } catch (_) {}
              out.push({
                id: m.id(),
                subject: m.subject() || "",
                sender: m.sender() || "",
                dateSent: ds ? ds.toISOString() : null,
                read,
                mailbox: box.name(),
                account: a.name(),
              });
              if (out.length >= INPUT.limit) break outer;
            }
          }
        }
        return out;
      `,
    });
    const md = [
      `# Mail search: \`${params.query}\` (${msgs.length})`,
      "",
      ...msgs.map(
        (m) =>
          `- **${clip(m.subject || "(no subject)", 70)}** _from ${clip(m.sender, 40)}_ — ${humanDate(m.dateSent)} _(${m.mailbox})_ — id: \`${m.id}\``,
      ),
    ].join("\n");
    return buildResult(params.response_format, md, {
      query: params.query,
      count: msgs.length,
      messages: msgs,
    });
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_get_message                                                        */
/* ──────────────────────────────────────────────────────────────────────── */

const GetMessageInput = z
  .object({
    message_id: z
      .string()
      .min(1)
      .describe(
        "The message id (the `id` returned by apple_list_messages / apple_search_messages).",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function getMessage(params: z.infer<typeof GetMessageInput>) {
  try {
    const msg = await runJxa<RawMessage | null>({
      args: { messageId: params.message_id },
      timeoutMs: MAIL_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Mail = Application('Mail');
        const accounts = Mail.accounts();
        for (let i = 0; i < accounts.length; i++) {
          const a = accounts[i];
          const boxes = a.mailboxes();
          for (let j = 0; j < boxes.length; j++) {
            const box = boxes[j];
            let matches;
            try { matches = box.messages.whose({ id: INPUT.messageId })(); }
            catch (_) { matches = []; }
            if (matches.length > 0) {
              const m = matches[0];
              let ds = null;
              try { ds = m.dateSent(); } catch (_) {}
              let read = true;
              try { read = !!m.readStatus(); } catch (_) {}
              let recipients = [];
              try { recipients = m.toRecipients().map(r => r.address ? r.address() : ""); } catch (_) {}
              let ccs = [];
              try { ccs = m.ccRecipients().map(r => r.address ? r.address() : ""); } catch (_) {}
              return {
                id: m.id(),
                subject: m.subject() || "",
                sender: m.sender() || "",
                dateSent: ds ? ds.toISOString() : null,
                read,
                mailbox: box.name(),
                account: a.name(),
                recipients,
                ccRecipients: ccs,
                content: m.content() || "",
              };
            }
          }
        }
        return null;
      `,
    });
    if (!msg) {
      return errorResult(
        new Error(`No message found with id '${params.message_id}'`),
      );
    }
    const md = [
      `# ${msg.subject || "(no subject)"}`,
      "",
      `- **From**: ${msg.sender}`,
      `- **To**: ${msg.recipients.join(", ") || "(none)"}`,
      msg.ccRecipients.length ? `- **Cc**: ${msg.ccRecipients.join(", ")}` : "",
      `- **Date**: ${humanDate(msg.dateSent)}`,
      `- **Mailbox**: ${msg.mailbox} _(${msg.account ?? "—"})_`,
      "",
      msg.content,
      "",
      `id: \`${msg.id}\``,
    ]
      .filter(Boolean)
      .join("\n");
    return buildResult(params.response_format, md, msg);
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_send_message                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

const SendMessageInput = z
  .object({
    to: z
      .array(z.string().email())
      .min(1)
      .max(50)
      .describe("One or more recipient email addresses."),
    cc: z.array(z.string().email()).max(50).optional(),
    bcc: z.array(z.string().email()).max(50).optional(),
    subject: z.string().min(1).max(500),
    body: z.string().min(1).max(50_000).describe("Plain-text message body."),
    from_account: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. The Mail account name to send from. Defaults to the primary account.",
      ),
    confirm: z
      .literal(true)
      .describe(
        "Required acknowledgement that the message will actually be sent. Must be true.",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function sendMessage(params: z.infer<typeof SendMessageInput>) {
  try {
    const result = await runJxa<{ sent: boolean; subject: string }>({
      args: {
        to: params.to,
        cc: params.cc ?? [],
        bcc: params.bcc ?? [],
        subject: params.subject,
        body: params.body,
        fromAccount: params.from_account ?? null,
      },
      timeoutMs: MAIL_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Mail = Application('Mail');
        const props = { subject: INPUT.subject, content: INPUT.body, visible: false };
        const msg = Mail.OutgoingMessage(props);
        Mail.outgoingMessages.push(msg);

        for (let i = 0; i < INPUT.to.length; i++) {
          const r = Mail.ToRecipient({ address: INPUT.to[i] });
          msg.toRecipients.push(r);
        }
        for (let i = 0; i < INPUT.cc.length; i++) {
          const r = Mail.CcRecipient({ address: INPUT.cc[i] });
          msg.ccRecipients.push(r);
        }
        for (let i = 0; i < INPUT.bcc.length; i++) {
          const r = Mail.BccRecipient({ address: INPUT.bcc[i] });
          msg.bccRecipients.push(r);
        }

        if (INPUT.fromAccount) {
          const accounts = Mail.accounts.whose({ name: INPUT.fromAccount })();
          if (accounts.length === 0) {
            throw new Error("Mail account not found: " + INPUT.fromAccount);
          }
          const emails = accounts[0].emailAddresses();
          if (emails && emails.length > 0) {
            msg.sender = emails[0];
          }
        }

        msg.send();
        return { sent: true, subject: INPUT.subject };
      `,
    });
    return buildResult(
      params.response_format,
      `Sent: **${result.subject}** → ${params.to.join(", ")}`,
      { sent: result.sent, ...params },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_create_draft                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

const CreateDraftInput = z
  .object({
    to: z.array(z.string().email()).max(50).optional(),
    cc: z.array(z.string().email()).max(50).optional(),
    bcc: z.array(z.string().email()).max(50).optional(),
    subject: z.string().max(500).optional(),
    body: z.string().max(50_000).optional(),
    response_format: responseFormatField,
  })
  .strict();

async function createDraft(params: z.infer<typeof CreateDraftInput>) {
  try {
    const result = await runJxa<{ created: boolean }>({
      args: {
        to: params.to ?? [],
        cc: params.cc ?? [],
        bcc: params.bcc ?? [],
        subject: params.subject ?? "",
        body: params.body ?? "",
      },
      timeoutMs: MAIL_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Mail = Application('Mail');
        const msg = Mail.OutgoingMessage({
          subject: INPUT.subject,
          content: INPUT.body,
          visible: true,
        });
        Mail.outgoingMessages.push(msg);
        for (let i = 0; i < INPUT.to.length; i++) {
          msg.toRecipients.push(Mail.ToRecipient({ address: INPUT.to[i] }));
        }
        for (let i = 0; i < INPUT.cc.length; i++) {
          msg.ccRecipients.push(Mail.CcRecipient({ address: INPUT.cc[i] }));
        }
        for (let i = 0; i < INPUT.bcc.length; i++) {
          msg.bccRecipients.push(Mail.BccRecipient({ address: INPUT.bcc[i] }));
        }
        return { created: true };
      `,
    });
    return buildResult(
      params.response_format,
      `Opened a draft in Mail.app${params.subject ? `: **${params.subject}**` : ""}`,
      { created: result.created, ...params },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_mark_message                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

const MarkMessageInput = z
  .object({
    message_id: z.string().min(1),
    read: z
      .boolean()
      .describe("true marks the message as read, false as unread."),
    response_format: responseFormatField,
  })
  .strict();

async function markMessage(params: z.infer<typeof MarkMessageInput>) {
  try {
    const ok = await runJxa<{ updated: boolean }>({
      args: { messageId: params.message_id, read: params.read },
      timeoutMs: MAIL_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Mail = Application('Mail');
        const accounts = Mail.accounts();
        for (let i = 0; i < accounts.length; i++) {
          const boxes = accounts[i].mailboxes();
          for (let j = 0; j < boxes.length; j++) {
            let matches;
            try { matches = boxes[j].messages.whose({ id: INPUT.messageId })(); }
            catch (_) { matches = []; }
            if (matches.length > 0) {
              matches[0].readStatus = INPUT.read;
              return { updated: true };
            }
          }
        }
        throw new Error("Message not found: " + INPUT.messageId);
      `,
    });
    return buildResult(
      params.response_format,
      `Marked message \`${params.message_id}\` as ${params.read ? "read" : "unread"}`,
      { updated: ok.updated, id: params.message_id, read: params.read },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_delete_message                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const DeleteMessageInput = z
  .object({
    message_id: z.string().min(1),
    confirm: z
      .literal(true)
      .describe(
        "Required acknowledgement that the message will be moved to Trash. Must be true.",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function deleteMessage(params: z.infer<typeof DeleteMessageInput>) {
  try {
    const ok = await runJxa<{ deleted: boolean }>({
      args: { messageId: params.message_id },
      timeoutMs: MAIL_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Mail = Application('Mail');
        const accounts = Mail.accounts();
        for (let i = 0; i < accounts.length; i++) {
          const boxes = accounts[i].mailboxes();
          for (let j = 0; j < boxes.length; j++) {
            let matches;
            try { matches = boxes[j].messages.whose({ id: INPUT.messageId })(); }
            catch (_) { matches = []; }
            if (matches.length > 0) {
              Mail.delete(matches[0]);
              return { deleted: true };
            }
          }
        }
        throw new Error("Message not found: " + INPUT.messageId);
      `,
    });
    return buildResult(
      params.response_format,
      `Deleted (moved to Trash) message \`${params.message_id}\``,
      { deleted: ok.deleted, id: params.message_id },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Registration                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

export function registerMailTools(server: McpServer) {
  server.registerTool(
    "apple_list_mail_accounts",
    {
      title: "List Mail Accounts",
      description:
        "List every configured Mail.app account (iCloud, Gmail, Exchange, IMAP, etc.). Returns id, name, full name, and email addresses for each.",
      inputSchema: ListAccountsInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    listAccounts,
  );

  server.registerTool(
    "apple_list_mailboxes",
    {
      title: "List Mailboxes",
      description:
        "List mailboxes (folders) in Mail.app, optionally filtered to one account. Returns name, account, and unread count.",
      inputSchema: ListMailboxesInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    listMailboxes,
  );

  server.registerTool(
    "apple_list_messages",
    {
      title: "List Messages",
      description:
        "List recent messages from a mailbox (e.g. INBOX). Messages are returned newest-first. Supports unread-only filtering and a date window. NOTE: Mail can be slow on large mailboxes — keep `limit` modest and use `since`/`until` to narrow.",
      inputSchema: ListMessagesInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    listMessages,
  );

  server.registerTool(
    "apple_search_messages",
    {
      title: "Search Messages",
      description:
        "Search Mail messages by case-insensitive substring match against subject or sender across recent messages. Scans only the most-recent `scan` messages per mailbox for performance. Content is NOT searched — use Mail.app for full-text search.",
      inputSchema: SearchMessagesInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    searchMessages,
  );

  server.registerTool(
    "apple_get_message",
    {
      title: "Get Message",
      description:
        "Fetch the full body and metadata of a single message by id, including recipients, cc, sender, date, and content.",
      inputSchema: GetMessageInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    getMessage,
  );

  server.registerTool(
    "apple_send_message",
    {
      title: "Send Email",
      description:
        "Send an email message via Mail.app. The message is sent IMMEDIATELY — there is no draft step. You MUST pass confirm=true to acknowledge this. Use apple_create_draft if you want a draft the user can review before sending.",
      inputSchema: SendMessageInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    sendMessage,
  );

  server.registerTool(
    "apple_create_draft",
    {
      title: "Create Email Draft",
      description:
        "Open a new draft message in Mail.app with the supplied subject, body, and recipients. The draft is NOT sent — it is left open in Mail.app for the user to review and send manually.",
      inputSchema: CreateDraftInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    createDraft,
  );

  server.registerTool(
    "apple_mark_message",
    {
      title: "Mark Message Read/Unread",
      description:
        "Mark a message as read or unread. Pass read=true to mark as read, read=false to mark as unread.",
      inputSchema: MarkMessageInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    markMessage,
  );

  server.registerTool(
    "apple_delete_message",
    {
      title: "Delete Message",
      description:
        "Move a message to Trash. You MUST pass confirm=true to acknowledge. The message is recoverable from Trash until Mail empties it.",
      inputSchema: DeleteMessageInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    deleteMessage,
  );
}
