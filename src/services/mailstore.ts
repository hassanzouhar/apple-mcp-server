/**
 * Fast, read-only access to Mail.app's local store.
 *
 * Mail keeps a SQLite index ("Envelope Index") of every message's metadata —
 * subject, sender, dates, read/flag state, mailbox. Reading it directly is
 * orders of magnitude faster than driving Mail.app over Apple Events (which
 * costs one IPC round-trip per property and times out on large mailboxes).
 *
 * We use it for the read-heavy list/search paths. Message *bodies* and
 * recipients live in the on-disk `.emlx` files (see emlx.ts). Writes
 * (send/draft/mark/delete) stay on JXA.
 *
 * Everything here is best-effort and self-guarding: if the schema looks
 * unfamiliar (a future macOS changing the layout) we throw
 * `MailStoreUnavailable` so callers can fall back to JXA.
 *
 * Requires Full Disk Access for the host process to read the index.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { querySqlite, sqlLiteral } from "./sqlite.js";

/** Thrown when the on-disk store is missing or its schema is unrecognized. */
export class MailStoreUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailStoreUnavailable";
  }
}

export interface MailboxInfo {
  name: string;
  accountName: string | null;
  unreadCount: number;
  accountId: string;
}

export interface MessageSummary {
  id: string;
  subject: string;
  sender: string;
  dateSent: string | null;
  read: boolean;
  mailbox: string;
  account: string | null;
}

/** Locate the newest `~/Library/Mail/V<n>/MailData/Envelope Index`. */
export function findEnvelopeIndex(): string | null {
  const base = join(homedir(), "Library", "Mail");
  if (!existsSync(base)) return null;
  const versions = readdirSync(base)
    .filter((d) => /^V\d+$/.test(d))
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  for (const v of versions) {
    const p = join(base, v, "MailData", "Envelope Index");
    if (existsSync(p)) return p;
  }
  return null;
}

function requireIndex(): string {
  const db = findEnvelopeIndex();
  if (!db) {
    throw new MailStoreUnavailable(
      "Mail's Envelope Index was not found (need Full Disk Access, or Mail isn't set up).",
    );
  }
  return db;
}

/** Verify the tables/columns we depend on still exist. */
async function assertSchema(db: string): Promise<void> {
  const tables = await querySqlite<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages','subjects','addresses','mailboxes');",
  );
  const have = new Set(tables.map((t) => t.name));
  for (const req of ["messages", "subjects", "addresses", "mailboxes"]) {
    if (!have.has(req)) {
      throw new MailStoreUnavailable(
        `Envelope Index schema unrecognized (missing table '${req}').`,
      );
    }
  }
  const cols = await querySqlite<{ name: string }>(
    db,
    "SELECT name FROM pragma_table_info('messages');",
  );
  const cset = new Set(cols.map((c) => c.name));
  for (const req of ["subject", "sender", "date_received", "mailbox", "read", "deleted"]) {
    if (!cset.has(req)) {
      throw new MailStoreUnavailable(
        `Envelope Index 'messages' schema unrecognized (missing column '${req}').`,
      );
    }
  }
}

/* ── account name resolution (accountsd, cached) ─────────────────────────── */

const ACCOUNTS_DB = join(homedir(), "Library", "Accounts", "Accounts4.sqlite");
let accountCache: Map<string, string> | null = null;

/** UUID → friendly account description, read from accountsd. Best-effort. */
async function accountMap(): Promise<Map<string, string>> {
  if (accountCache) return accountCache;
  const map = new Map<string, string>();
  if (existsSync(ACCOUNTS_DB)) {
    try {
      // Mail's per-account rows often carry a NULL description; the friendly
      // name ("iCloud", "Gmail (hz82)") lives on the parent (umbrella) account.
      // Coalesce own → parent description so every account resolves.
      const rows = await querySqlite<{ ident: string; d: string }>(
        ACCOUNTS_DB,
        "SELECT c.ZIDENTIFIER AS ident, " +
          "COALESCE(c.ZACCOUNTDESCRIPTION, p.ZACCOUNTDESCRIPTION) AS d " +
          "FROM ZACCOUNT c LEFT JOIN ZACCOUNT p ON p.Z_PK = c.ZPARENTACCOUNT " +
          "WHERE c.ZIDENTIFIER IS NOT NULL " +
          "AND COALESCE(c.ZACCOUNTDESCRIPTION, p.ZACCOUNTDESCRIPTION) IS NOT NULL;",
      );
      for (const r of rows) map.set(r.ident.toUpperCase(), r.d);
    } catch {
      /* names will degrade to the raw UUID; listing still works */
    }
  }
  accountCache = map;
  return map;
}

/** Parse a mailbox `url` into its account UUID and human mailbox path. */
export function parseMailboxUrl(url: string): { accountId: string; name: string } {
  try {
    const u = new URL(url);
    const accountId = u.hostname.toUpperCase();
    const path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    return { accountId, name: path || "(root)" };
  } catch {
    return { accountId: "", name: url };
  }
}

function lastSegment(name: string): string {
  const parts = name.split("/");
  return parts[parts.length - 1] || name;
}

function epochToIso(sec: number | null): string | null {
  if (sec === null || sec === undefined) return null;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatSender(name: string | null, addr: string | null): string {
  const n = (name ?? "").trim();
  const a = (addr ?? "").trim();
  if (n && a && n.toLowerCase() !== a.toLowerCase()) return `${n} <${a}>`;
  return a || n || "";
}

/** Resolve a friendly account name to the set of matching account UUIDs. */
async function resolveAccountIds(accountName: string): Promise<Set<string>> {
  const map = await accountMap();
  const wanted = accountName.toLowerCase();
  const ids = new Set<string>();
  for (const [id, name] of map) {
    if (name.toLowerCase() === wanted) ids.add(id);
  }
  // Allow passing a raw UUID directly too.
  if (/^[0-9a-f-]{36}$/i.test(accountName)) ids.add(accountName.toUpperCase());
  return ids;
}

/* ── public read API ─────────────────────────────────────────────────────── */

export async function listMailboxes(
  accountName?: string | null,
): Promise<MailboxInfo[]> {
  const db = requireIndex();
  await assertSchema(db);
  const map = await accountMap();
  const rows = await querySqlite<{ url: string; unread: number }>(
    db,
    "SELECT url, unread_count AS unread FROM mailboxes ORDER BY url;",
  );
  let out = rows.map((r) => {
    const { accountId, name } = parseMailboxUrl(r.url);
    return {
      name,
      accountId,
      accountName: map.get(accountId) ?? (accountId || null),
      unreadCount: r.unread ?? 0,
    };
  });
  if (accountName) {
    const ids = await resolveAccountIds(accountName);
    out = out.filter((b) => ids.has(b.accountId));
  }
  return out;
}

/** Internal: find the Envelope-Index mailbox ROWIDs matching a name/account. */
async function matchMailboxes(
  db: string,
  mailboxName: string,
  accountIds: Set<string> | null,
): Promise<{ rowid: number; name: string; accountId: string }[]> {
  const rows = await querySqlite<{ rowid: number; url: string }>(
    db,
    "SELECT ROWID AS rowid, url FROM mailboxes;",
  );
  const want = mailboxName.toLowerCase();
  return rows
    .map((r) => ({ rowid: r.rowid, ...parseMailboxUrl(r.url) }))
    .filter((b) => {
      const n = b.name.toLowerCase();
      const nameOk =
        n === want || lastSegment(n) === want || n.endsWith("/" + want);
      const acctOk = !accountIds || accountIds.has(b.accountId);
      return nameOk && acctOk;
    });
}

export interface ListMessagesOpts {
  mailboxName: string;
  accountName?: string | null;
  unreadOnly?: boolean;
  since?: string | null;
  until?: string | null;
  limit: number;
}

export async function listMessages(opts: ListMessagesOpts): Promise<MessageSummary[]> {
  const db = requireIndex();
  await assertSchema(db);
  const map = await accountMap();
  const accountIds = opts.accountName
    ? await resolveAccountIds(opts.accountName)
    : null;

  const boxes = await matchMailboxes(db, opts.mailboxName, accountIds);
  if (boxes.length === 0) {
    throw new Error(`Mailbox not found: ${opts.mailboxName}`);
  }
  const boxById = new Map(boxes.map((b) => [b.rowid, b]));

  const conds = [
    `m.mailbox IN (${boxes.map((b) => b.rowid).join(",")})`,
    "m.deleted = 0",
  ];
  if (opts.unreadOnly) conds.push("m.read = 0");
  if (opts.since) {
    conds.push(`m.date_received >= ${Math.floor(new Date(opts.since).getTime() / 1000)}`);
  }
  if (opts.until) {
    conds.push(`m.date_received < ${Math.floor(new Date(opts.until).getTime() / 1000)}`);
  }

  const rows = await querySqlite<RawRow>(
    db,
    `SELECT m.ROWID AS id,
            COALESCE(m.subject_prefix,'') || s.subject AS subject,
            a.comment AS sender_name, a.address AS sender_addr,
            COALESCE(m.date_sent, m.date_received) AS dts,
            m.read AS read, m.mailbox AS mbox
     FROM messages m
     JOIN subjects s ON s.ROWID = m.subject
     LEFT JOIN addresses a ON a.ROWID = m.sender
     WHERE ${conds.join(" AND ")}
     ORDER BY m.date_received DESC
     LIMIT ${Math.max(1, Math.floor(opts.limit))};`,
  );

  return rows.map((r) => toSummary(r, boxById, map));
}

export interface SearchMessagesOpts {
  query: string;
  mailboxName?: string | null;
  accountName?: string | null;
  limit: number;
}

export async function searchMessages(
  opts: SearchMessagesOpts,
): Promise<MessageSummary[]> {
  const db = requireIndex();
  await assertSchema(db);
  const map = await accountMap();
  const accountIds = opts.accountName
    ? await resolveAccountIds(opts.accountName)
    : null;

  // Narrow to specific mailboxes if a name/account was given.
  let boxFilter = "";
  let boxById: Map<number, { rowid: number; name: string; accountId: string }> | null =
    null;
  if (opts.mailboxName || accountIds) {
    const boxes = opts.mailboxName
      ? await matchMailboxes(db, opts.mailboxName, accountIds)
      : (await allBoxes(db)).filter((b) => !accountIds || accountIds.has(b.accountId));
    if (boxes.length === 0) return [];
    boxFilter = `AND m.mailbox IN (${boxes.map((b) => b.rowid).join(",")})`;
    boxById = new Map(boxes.map((b) => [b.rowid, b]));
  }

  const pattern = "%" + opts.query.toLowerCase().replace(/[%_\\]/g, "\\$&") + "%";
  const lit = sqlLiteral(pattern);
  const rows = await querySqlite<RawRow>(
    db,
    `SELECT m.ROWID AS id,
            COALESCE(m.subject_prefix,'') || s.subject AS subject,
            a.comment AS sender_name, a.address AS sender_addr,
            COALESCE(m.date_sent, m.date_received) AS dts,
            m.read AS read, m.mailbox AS mbox
     FROM messages m
     JOIN subjects s ON s.ROWID = m.subject
     LEFT JOIN addresses a ON a.ROWID = m.sender
     WHERE m.deleted = 0 ${boxFilter}
       AND ( lower(s.subject) LIKE ${lit} ESCAPE '\\'
          OR lower(COALESCE(a.address,'')) LIKE ${lit} ESCAPE '\\'
          OR lower(COALESCE(a.comment,'')) LIKE ${lit} ESCAPE '\\' )
     ORDER BY m.date_received DESC
     LIMIT ${Math.max(1, Math.floor(opts.limit))};`,
  );

  const lookup = boxById ?? (await boxLookup(db));
  return rows.map((r) => toSummary(r, lookup, map));
}

export interface MessageMeta extends MessageSummary {
  accountId: string;
}

/** Metadata for a single message id (Envelope Index ROWID). Null if absent. */
export async function getMessageMeta(id: string): Promise<MessageMeta | null> {
  const db = requireIndex();
  await assertSchema(db);
  const map = await accountMap();
  const rowid = Number(id);
  if (!Number.isInteger(rowid)) return null;
  const rows = await querySqlite<RawRow>(
    db,
    `SELECT m.ROWID AS id,
            COALESCE(m.subject_prefix,'') || s.subject AS subject,
            a.comment AS sender_name, a.address AS sender_addr,
            COALESCE(m.date_sent, m.date_received) AS dts,
            m.read AS read, m.mailbox AS mbox
     FROM messages m
     JOIN subjects s ON s.ROWID = m.subject
     LEFT JOIN addresses a ON a.ROWID = m.sender
     WHERE m.ROWID = ${rowid} AND m.deleted = 0
     LIMIT 1;`,
  );
  if (rows.length === 0) return null;
  const lookup = await boxLookup(db);
  const summary = toSummary(rows[0], lookup, map);
  const box = lookup.get(rows[0].mbox);
  return { ...summary, accountId: box?.accountId ?? "" };
}

/* ── internal helpers ────────────────────────────────────────────────────── */

interface RawRow {
  id: number;
  subject: string;
  sender_name: string | null;
  sender_addr: string | null;
  dts: number | null;
  read: number;
  mbox: number;
}

function toSummary(
  r: RawRow,
  boxById: Map<number, { name: string; accountId: string }>,
  map: Map<string, string>,
): MessageSummary {
  const box = boxById.get(r.mbox);
  const accountId = box?.accountId ?? "";
  return {
    id: String(r.id),
    subject: r.subject || "",
    sender: formatSender(r.sender_name, r.sender_addr),
    dateSent: epochToIso(r.dts),
    read: !!r.read,
    mailbox: box?.name ?? "",
    account: map.get(accountId) ?? (accountId || null),
  };
}

async function allBoxes(
  db: string,
): Promise<{ rowid: number; name: string; accountId: string }[]> {
  const rows = await querySqlite<{ rowid: number; url: string }>(
    db,
    "SELECT ROWID AS rowid, url FROM mailboxes;",
  );
  return rows.map((r) => ({ rowid: r.rowid, ...parseMailboxUrl(r.url) }));
}

async function boxLookup(
  db: string,
): Promise<Map<number, { rowid: number; name: string; accountId: string }>> {
  return new Map((await allBoxes(db)).map((b) => [b.rowid, b]));
}
