/**
 * Fast, read-only access to the Messages.app store (iMessage / SMS).
 *
 * Messages keeps everything in a single SQLite database at
 * `~/Library/Messages/chat.db`. We read it directly (immutable, no lock — same
 * discipline as the Mail Envelope Index in mailstore.ts) because driving
 * Messages.app over Apple Events is slow and exposes almost no read API.
 *
 * Two quirks of this schema that every query here has to handle:
 *
 *   1. `message.date` is an Apple-epoch timestamp in *nanoseconds* since
 *      2001-01-01 (older OSes used seconds — we detect and handle both).
 *
 *   2. `message.text` is NULL for most modern messages; the body lives in
 *      `message.attributedBody`, an NSAttributedString archived as a binary
 *      "typedstream". We pull it out with `hex(attributedBody)` and decode the
 *      length-prefixed UTF-8 string after the `NSString` class marker. This is
 *      a heuristic (no public format), so it is best-effort: if it fails we
 *      fall back to a placeholder rather than throwing.
 *
 * Requires Full Disk Access for the host process to read chat.db.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { querySqlite, sqlLiteral } from "./sqlite.js";

/** Thrown when chat.db is missing or its schema is unrecognized. */
export class ImessageStoreUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImessageStoreUnavailable";
  }
}

/** Seconds between the Unix epoch (1970) and the Apple epoch (2001-01-01 UTC). */
const APPLE_EPOCH_OFFSET = 978_307_200;

export interface ChatSummary {
  id: string; // chat ROWID, the value list_messages / search accept
  guid: string;
  name: string; // display_name if set, else the identifier
  identifier: string; // chat_identifier (phone/email, or group id)
  isGroup: boolean;
  service: string | null; // "iMessage" | "SMS" | …
  participants: string[]; // handle ids (phones/emails)
  lastDate: string | null; // ISO timestamp of the newest message
  lastText: string; // preview of the newest message
  lastFromMe: boolean;
}

export interface ImessageSummary {
  id: string; // message ROWID
  guid: string;
  chatId: string;
  text: string;
  fromMe: boolean;
  sender: string | null; // handle id, or null when fromMe
  date: string | null; // ISO timestamp
  service: string | null;
  hasAttachments: boolean;
}

/** Locate `~/Library/Messages/chat.db`. */
export function findChatDb(): string | null {
  const p = join(homedir(), "Library", "Messages", "chat.db");
  return existsSync(p) ? p : null;
}

function requireDb(): string {
  const db = findChatDb();
  if (!db) {
    throw new ImessageStoreUnavailable(
      "Messages' chat.db was not found (need Full Disk Access, or Messages isn't set up).",
    );
  }
  return db;
}

/** Verify the tables/columns we depend on still exist. */
async function assertSchema(db: string): Promise<void> {
  const tables = await querySqlite<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('message','chat','handle','chat_message_join','chat_handle_join');",
  );
  const have = new Set(tables.map((t) => t.name));
  for (const req of [
    "message",
    "chat",
    "handle",
    "chat_message_join",
    "chat_handle_join",
  ]) {
    if (!have.has(req)) {
      throw new ImessageStoreUnavailable(
        `chat.db schema unrecognized (missing table '${req}').`,
      );
    }
  }
}

/* ── value decoding ──────────────────────────────────────────────────────── */

/** Convert an Apple-epoch timestamp (ns on modern macOS, s on old) to ISO. */
function appleDateToIso(raw: number | null): string | null {
  if (raw === null || raw === undefined || raw === 0) return null;
  // Nanosecond timestamps are ~8e17; second timestamps are ~7e8. Anything past
  // ~1e12 is comfortably in nanosecond territory.
  const unixSec = raw > 1e12 ? raw / 1e9 + APPLE_EPOCH_OFFSET : raw + APPLE_EPOCH_OFFSET;
  const d = new Date(unixSec * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Extract the message text from a hex-encoded `attributedBody` typedstream.
 *
 * Layout we rely on: the archive contains the literal `NSString`, then (after a
 * few class/version control bytes) a `+` (0x2B) marker, then a length, then the
 * UTF-8 bytes. Lengths ≥ 0x81 use a 1/2/3-byte little-endian extension. This is
 * the well-known community heuristic; returns null if the markers aren't found.
 */
export function decodeAttributedBody(hex: string | null): string | null {
  if (!hex) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(hex, "hex");
  } catch {
    return null;
  }
  const marker = buf.indexOf("NSString", 0, "latin1");
  if (marker === -1) return null;
  let i = marker + "NSString".length;
  // Advance to the `+` (0x2B) marker that precedes the string payload.
  while (i < buf.length && buf[i] !== 0x2b) i++;
  i += 1; // skip the 0x2B
  if (i >= buf.length) return null;
  let len = buf[i];
  i += 1;
  if (len === 0x81) {
    len = buf[i] | (buf[i + 1] << 8);
    i += 2;
  } else if (len === 0x82) {
    len = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16);
    i += 3;
  }
  if (len <= 0 || i + len > buf.length) return null;
  const s = buf.slice(i, i + len).toString("utf8");
  return s.length ? s : null;
}

/** Prefer the plain `text` column; fall back to decoding `attributedBody`. */
function resolveText(
  text: string | null,
  bodyHex: string | null,
  hasAttachments: boolean,
): string {
  if (text && text.length) return text;
  const decoded = decodeAttributedBody(bodyHex);
  if (decoded) return decoded;
  return hasAttachments ? "[attachment]" : "[message has no plain text]";
}

/* ── public read API ─────────────────────────────────────────────────────── */

export interface ListChatsOpts {
  query?: string | null; // substring match against name/identifier/participants
  limit: number;
}

interface ChatRow {
  id: number;
  guid: string;
  identifier: string;
  display_name: string | null;
  style: number; // 43 = group, 45 = 1:1 (Apple's enum)
  service: string | null;
  last_date: number | null;
}

export async function listChats(opts: ListChatsOpts): Promise<ChatSummary[]> {
  const db = requireDb();
  await assertSchema(db);

  // Pull a generous slab of the most-recently-active chats; we filter/slice in
  // JS so a `query` can match display name, identifier, OR a participant handle.
  const slab = Math.max(opts.limit * (opts.query ? 8 : 1), opts.limit);
  const chats = await querySqlite<ChatRow>(
    db,
    `SELECT c.ROWID AS id, c.guid AS guid, c.chat_identifier AS identifier,
            c.display_name AS display_name, c.style AS style,
            c.service_name AS service, MAX(m.date) AS last_date
     FROM chat c
     JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
     JOIN message m ON m.ROWID = cmj.message_id
     GROUP BY c.ROWID
     ORDER BY last_date DESC
     LIMIT ${Math.max(1, Math.floor(slab))};`,
  );
  if (chats.length === 0) return [];

  const ids = chats.map((c) => c.id);
  const participants = await participantsByChat(db, ids);
  const lasts = await lastMessageByChat(db, ids);

  let out: ChatSummary[] = chats.map((c) => {
    const last = lasts.get(c.id);
    return {
      id: String(c.id),
      guid: c.guid,
      identifier: c.identifier,
      name: c.display_name || c.identifier,
      isGroup: c.style === 43,
      service: c.service,
      participants: participants.get(c.id) ?? [],
      lastDate: appleDateToIso(c.last_date),
      lastText: last
        ? resolveText(last.text, last.body_hex, !!last.has_att)
        : "",
      lastFromMe: last ? !!last.from_me : false,
    };
  });

  if (opts.query) {
    const q = opts.query.toLowerCase();
    out = out.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.identifier.toLowerCase().includes(q) ||
        c.participants.some((p) => p.toLowerCase().includes(q)),
    );
  }
  return out.slice(0, opts.limit);
}

export interface ListImessagesOpts {
  chat: string; // chat ROWID, chat_identifier, or chat guid
  since?: string | null;
  until?: string | null;
  limit: number;
}

export async function listMessages(
  opts: ListImessagesOpts,
): Promise<ImessageSummary[]> {
  const db = requireDb();
  await assertSchema(db);

  const chatIds = await resolveChatIds(db, opts.chat);
  if (chatIds.length === 0) {
    throw new Error(`Chat not found: ${opts.chat}`);
  }

  const conds = [`cmj.chat_id IN (${chatIds.join(",")})`];
  if (opts.since) conds.push(`m.date >= ${isoToAppleNanos(opts.since)}`);
  if (opts.until) conds.push(`m.date < ${isoToAppleNanos(opts.until)}`);

  const rows = await querySqlite<MessageRow>(
    db,
    `SELECT m.ROWID AS id, m.guid AS guid, cmj.chat_id AS chat_id,
            m.text AS text, hex(m.attributedBody) AS body_hex,
            m.is_from_me AS from_me, h.id AS sender, m.date AS date,
            m.service AS service, m.cache_has_attachments AS has_att
     FROM message m
     JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
     LEFT JOIN handle h ON h.ROWID = m.handle_id
     WHERE ${conds.join(" AND ")}
     ORDER BY m.date DESC
     LIMIT ${Math.max(1, Math.floor(opts.limit))};`,
  );

  // Fetched newest-first; return oldest-first so it reads as a conversation.
  return rows.reverse().map(toMessageSummary);
}

export interface SearchImessagesOpts {
  query: string;
  chat?: string | null;
  scan: number; // how many recent messages to decode + scan
  limit: number;
}

export async function searchMessages(
  opts: SearchImessagesOpts,
): Promise<ImessageSummary[]> {
  const db = requireDb();
  await assertSchema(db);

  let chatFilter = "";
  if (opts.chat) {
    const chatIds = await resolveChatIds(db, opts.chat);
    if (chatIds.length === 0) return [];
    chatFilter = `WHERE cmj.chat_id IN (${chatIds.join(",")})`;
  }

  // Most message bodies live in attributedBody, so a SQL LIKE on `text` would
  // miss the majority. Instead we scan the most-recent N messages, decode each,
  // and substring-match in JS — same trade-off as Mail's recent-scan search.
  const rows = await querySqlite<MessageRow>(
    db,
    `SELECT m.ROWID AS id, m.guid AS guid, cmj.chat_id AS chat_id,
            m.text AS text, hex(m.attributedBody) AS body_hex,
            m.is_from_me AS from_me, h.id AS sender, m.date AS date,
            m.service AS service, m.cache_has_attachments AS has_att
     FROM message m
     JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
     LEFT JOIN handle h ON h.ROWID = m.handle_id
     ${chatFilter}
     ORDER BY m.date DESC
     LIMIT ${Math.max(1, Math.floor(opts.scan))};`,
  );

  const q = opts.query.toLowerCase();
  const out: ImessageSummary[] = [];
  for (const r of rows) {
    const summary = toMessageSummary(r);
    if (summary.text.toLowerCase().includes(q)) {
      out.push(summary);
      if (out.length >= opts.limit) break;
    }
  }
  return out;
}

/* ── internal helpers ────────────────────────────────────────────────────── */

interface MessageRow {
  id: number;
  guid: string;
  chat_id: number;
  text: string | null;
  body_hex: string | null;
  from_me: number;
  sender: string | null;
  date: number | null;
  service: string | null;
  has_att: number;
}

function toMessageSummary(r: MessageRow): ImessageSummary {
  const fromMe = !!r.from_me;
  return {
    id: String(r.id),
    guid: r.guid,
    chatId: String(r.chat_id),
    text: resolveText(r.text, r.body_hex, !!r.has_att),
    fromMe,
    sender: fromMe ? null : r.sender,
    date: appleDateToIso(r.date),
    service: r.service,
    hasAttachments: !!r.has_att,
  };
}

/** ISO → Apple-epoch nanoseconds, for date-range filters in SQL. */
function isoToAppleNanos(iso: string): number {
  const sec = new Date(iso).getTime() / 1000;
  return Math.floor((sec - APPLE_EPOCH_OFFSET) * 1e9);
}

/** Resolve a user-supplied chat reference to one or more chat ROWIDs. */
async function resolveChatIds(db: string, chat: string): Promise<number[]> {
  const lit = sqlLiteral(chat);
  const conds = [`chat_identifier = ${lit}`, `guid = ${lit}`];
  if (/^\d+$/.test(chat)) conds.push(`ROWID = ${Number(chat)}`);
  const rows = await querySqlite<{ id: number }>(
    db,
    `SELECT ROWID AS id FROM chat WHERE ${conds.join(" OR ")};`,
  );
  return rows.map((r) => r.id);
}

async function participantsByChat(
  db: string,
  ids: number[],
): Promise<Map<number, string[]>> {
  const rows = await querySqlite<{ chat_id: number; handle: string }>(
    db,
    `SELECT chj.chat_id AS chat_id, h.id AS handle
     FROM chat_handle_join chj
     JOIN handle h ON h.ROWID = chj.handle_id
     WHERE chj.chat_id IN (${ids.join(",")});`,
  );
  const map = new Map<number, string[]>();
  for (const r of rows) {
    const arr = map.get(r.chat_id) ?? [];
    arr.push(r.handle);
    map.set(r.chat_id, arr);
  }
  return map;
}

interface LastMessageRow {
  chat_id: number;
  text: string | null;
  body_hex: string | null;
  has_att: number;
  from_me: number;
}

async function lastMessageByChat(
  db: string,
  ids: number[],
): Promise<Map<number, LastMessageRow>> {
  // ROW_NUMBER() picks the newest message per chat in a single pass.
  const rows = await querySqlite<LastMessageRow>(
    db,
    `SELECT chat_id, text, body_hex, has_att, from_me FROM (
       SELECT cmj.chat_id AS chat_id, m.text AS text,
              hex(m.attributedBody) AS body_hex,
              m.cache_has_attachments AS has_att, m.is_from_me AS from_me,
              ROW_NUMBER() OVER (PARTITION BY cmj.chat_id ORDER BY m.date DESC) AS rn
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       WHERE cmj.chat_id IN (${ids.join(",")})
     ) WHERE rn = 1;`,
  );
  return new Map(rows.map((r) => [r.chat_id, r]));
}
