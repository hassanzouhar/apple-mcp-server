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
import {
  MailStoreUnavailable,
  listMailboxes as storeListMailboxes,
  listMessages as storeListMessages,
  searchMessages as storeSearchMessages,
  getMessageMeta as storeGetMessageMeta,
} from "../services/mailstore.js";
import { consolidatedShape, parseAction } from "./dispatch.js";

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
/* list_mail_accounts                                                 */
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
/* list_mailboxes                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const ListMailboxesInput = z
  .object({
    account_name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Limit to one account's mailboxes. Use action 'list_accounts' to discover.",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function listMailboxes(params: z.infer<typeof ListMailboxesInput>) {
  try {
    let boxes: RawMailbox[];
    try {
      boxes = await storeListMailboxes(params.account_name ?? null);
    } catch (e) {
      if (e instanceof MailStoreUnavailable) return listMailboxesViaJxa(params);
      throw e;
    }
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

async function listMailboxesViaJxa(params: z.infer<typeof ListMailboxesInput>) {
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
/* list_messages                                                      */
/* ──────────────────────────────────────────────────────────────────────── */

const ListMessagesInput = z
  .object({
    mailbox_name: z
      .string()
      .min(1)
      .describe(
        "Name of the mailbox to list from (e.g. 'INBOX'). Use action 'list_mailboxes' to discover.",
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

function renderMessageList(
  title: string,
  msgs: RawMessageSummary[],
): string {
  return [
    title,
    "",
    ...msgs.map(
      (m) =>
        `- ${m.read ? "📭" : "📬"} **${clip(m.subject || "(no subject)", 70)}** ` +
        `_from ${clip(m.sender, 40)}_ — ${humanDate(m.dateSent)} — id: \`${m.id}\``,
    ),
  ].join("\n");
}

async function listMessages(params: z.infer<typeof ListMessagesInput>) {
  try {
    let msgs: RawMessageSummary[];
    try {
      msgs = await storeListMessages({
        mailboxName: params.mailbox_name,
        accountName: params.account_name ?? null,
        unreadOnly: params.unread_only,
        since: params.since ?? null,
        until: params.until ?? null,
        limit: params.limit,
      });
    } catch (e) {
      if (e instanceof MailStoreUnavailable) return listMessagesViaJxa(params);
      throw e;
    }
    const md = renderMessageList(
      `# Messages in \`${params.mailbox_name}\`${params.account_name ? ` _(${params.account_name})_` : ""} — ${msgs.length}`,
      msgs,
    );
    return buildResult(params.response_format, md, {
      count: msgs.length,
      mailbox_name: params.mailbox_name,
      messages: msgs,
    });
  } catch (e) {
    return errorResult(e);
  }
}

async function listMessagesViaJxa(params: z.infer<typeof ListMessagesInput>) {
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
/* search_messages                                                    */
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
    let msgs: RawMessageSummary[];
    try {
      msgs = await storeSearchMessages({
        query: params.query,
        mailboxName: params.mailbox_name ?? null,
        accountName: params.account_name ?? null,
        limit: params.limit,
      });
    } catch (e) {
      if (e instanceof MailStoreUnavailable) return searchMessagesViaJxa(params);
      throw e;
    }
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

async function searchMessagesViaJxa(params: z.infer<typeof SearchMessagesInput>) {
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
/* get_message                                                        */
/* ──────────────────────────────────────────────────────────────────────── */

const GetMessageInput = z
  .object({
    message_id: z
      .string()
      .min(1)
      .describe(
        "The message id (the `id` returned by action 'list_messages' / 'search').",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function getMessage(params: z.infer<typeof GetMessageInput>) {
  try {
    // Use the Envelope Index (fast) to learn which account+mailbox holds this
    // message, then point JXA straight at it. The full RFC822 body and the
    // recipient lists only come from Mail.app, but a *targeted* fetch is cheap.
    // Falls back to a full scan if the index is unavailable or the hint misses.
    let accountHint: string | null = null;
    let mailboxLeafHint: string | null = null;
    try {
      const meta = await storeGetMessageMeta(params.message_id);
      if (meta) {
        accountHint = meta.account;
        mailboxLeafHint = meta.mailbox.split("/").pop() ?? null;
      }
    } catch (e) {
      if (!(e instanceof MailStoreUnavailable)) throw e;
      // index unavailable → proceed hint-less (full scan)
    }

    const msg = await runJxa<RawMessage | null>({
      args: {
        messageId: params.message_id,
        accountHint,
        mailboxLeafHint,
      },
      timeoutMs: MAIL_OSASCRIPT_TIMEOUT_MS,
      script: `
        const Mail = Application('Mail');
        const idNum = Number(INPUT.messageId);
        const id = Number.isInteger(idNum) ? idNum : INPUT.messageId;

        let accounts = [];
        if (INPUT.accountHint) {
          try { accounts = Mail.accounts.whose({ name: INPUT.accountHint })(); } catch (_) {}
        }
        if (!accounts || accounts.length === 0) accounts = Mail.accounts();

        for (let i = 0; i < accounts.length; i++) {
          const a = accounts[i];
          let boxes = [];
          if (INPUT.mailboxLeafHint) {
            try { boxes = a.mailboxes.whose({ name: INPUT.mailboxLeafHint })(); } catch (_) {}
          }
          if (!boxes || boxes.length === 0) boxes = a.mailboxes();
          for (let j = 0; j < boxes.length; j++) {
            const box = boxes[j];
            let matches;
            try { matches = box.messages.whose({ id: id })(); }
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
/* send_message                                                       */
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
/* create_draft                                                       */
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
/* mark_message                                                       */
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
/* delete_message                                                     */
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

const mailAction = z
  .enum([
    "list_accounts",
    "list_mailboxes",
    "list_messages",
    "search",
    "get",
    "send",
    "create_draft",
    "mark",
    "delete",
  ])
  .describe(
    [
      "Which Mail operation to perform. Required fields per action:",
      "• list_accounts — (no other fields)",
      "• list_mailboxes — optional account_name",
      "• list_messages — mailbox_name; optional account_name, unread_only, since, until, limit",
      "• search — query; optional mailbox_name, account_name, scan, limit",
      "• get — message_id",
      "• send — to[], subject, body, confirm=true; optional cc[], bcc[], from_account (sends IMMEDIATELY)",
      "• create_draft — optional to[], cc[], bcc[], subject, body (opens an unsent draft)",
      "• mark — message_id, read (true=read, false=unread)",
      "• delete — message_id, confirm=true (moves to Trash)",
    ].join("\n"),
  );

const MailToolInput = z.object(
  consolidatedShape(mailAction, [
    ListAccountsInput,
    ListMailboxesInput,
    ListMessagesInput,
    SearchMessagesInput,
    GetMessageInput,
    SendMessageInput,
    CreateDraftInput,
    MarkMessageInput,
    DeleteMessageInput,
  ]),
);

async function dispatchMail(raw: z.infer<typeof MailToolInput>) {
  try {
    switch (raw.action) {
      case "list_accounts":
        return await listAccounts(parseAction(ListAccountsInput, raw));
      case "list_mailboxes":
        return await listMailboxes(parseAction(ListMailboxesInput, raw));
      case "list_messages":
        return await listMessages(parseAction(ListMessagesInput, raw));
      case "search":
        return await searchMessages(parseAction(SearchMessagesInput, raw));
      case "get":
        return await getMessage(parseAction(GetMessageInput, raw));
      case "send":
        return await sendMessage(parseAction(SendMessageInput, raw));
      case "create_draft":
        return await createDraft(parseAction(CreateDraftInput, raw));
      case "mark":
        return await markMessage(parseAction(MarkMessageInput, raw));
      case "delete":
        return await deleteMessage(parseAction(DeleteMessageInput, raw));
      default:
        return errorResult(
          new Error(`Unknown mail action: ${String(raw.action)}`),
        );
    }
  } catch (e) {
    return errorResult(e);
  }
}

export function registerMailTools(server: McpServer) {
  server.registerTool(
    "mail",
    {
      title: "Mail",
      description:
        "Read and manage Mail.app email. Pick an operation with `action`: " +
        "list_accounts, list_mailboxes, list_messages, search, get, send, " +
        "create_draft, mark, delete. See the `action` field for the parameters " +
        "each operation needs. `send` dispatches email IMMEDIATELY and requires " +
        "confirm=true; use create_draft for a reviewable draft. `delete` (confirm=true) " +
        "moves a message to Trash. NOTE: this is EMAIL — for iMessage/SMS use the `imessage` tool.",
      inputSchema: MailToolInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    dispatchMail,
  );
}
