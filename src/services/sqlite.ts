/**
 * Read-only SQLite access for the macOS app stores (Mail's "Envelope Index").
 *
 * We shell out to the system `/usr/bin/sqlite3` rather than depend on a native
 * node addon:
 *   - It is always present on macOS.
 *   - `mode=ro` reads a *live* WAL database (one Mail.app has open), including
 *     commits not yet checkpointed, without any risk of a write — critical,
 *     since we must never mutate the user's mail store.
 *   - No node-version coupling (node:sqlite is gated behind recent releases and
 *     the host's bundled Node version is outside our control).
 *
 * User-supplied values must be embedded via `sqlLiteral()`, never string
 * concatenation — same injection-safety discipline as the JXA bridge.
 */

import { spawn } from "node:child_process";

const SQLITE3 = "/usr/bin/sqlite3";

/** Default query timeout. Envelope Index reads are sub-second; this is a guard. */
export const DEFAULT_SQLITE_TIMEOUT_MS = 15_000;

/**
 * Escape a value for safe inclusion in a SQLite SQL string literal.
 * Strings get single-quote-doubled and wrapped; finite numbers pass through;
 * null becomes NULL. Anything else throws.
 */
export function sqlLiteral(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Refusing to embed a non-finite number in SQL");
    }
    return String(value);
  }
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * Build a read-only file: URI for a database path. `immutable` skips the WAL,
 * so it can miss recent commits; use it only when a live read is impossible.
 */
export function readonlyUri(dbPath: string, immutable = false): string {
  const encoded = dbPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file:${encoded}?mode=ro${immutable ? "&immutable=1" : ""}`;
}

/**
 * Build a case-insensitive "contains" GLOB pattern. SQLite's lower() and LIKE
 * only fold ASCII, so `Østby` would not match `østby`; a character class per
 * letter handles every script. Embed the result with `sqlLiteral()`.
 */
export function containsGlob(query: string): string {
  let body = "";
  for (const ch of query) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower !== upper && [...lower].length === 1 && [...upper].length === 1) {
      body += `[${lower}${upper}]`;
    } else {
      body += "*?[".includes(ch) ? `[${ch}]` : ch;
    }
  }
  return `*${body}*`;
}

/** Failures a live read can hit that an immutable snapshot read avoids. */
const LIVE_READ_FAILURE = /unable to open|readonly|locked|busy/i;

/**
 * Run a single read-only SELECT and return the rows as parsed JSON objects.
 * `sql` MUST be a single statement; embed any user data with `sqlLiteral()`.
 * Reads through the WAL so fresh rows are visible, falling back to an immutable
 * snapshot when the live database cannot be opened.
 */
export async function querySqlite<T = Record<string, unknown>>(
  dbPath: string,
  sql: string,
  timeoutMs: number = DEFAULT_SQLITE_TIMEOUT_MS,
): Promise<T[]> {
  try {
    return await runQuery<T>(readonlyUri(dbPath), sql, timeoutMs);
  } catch (e) {
    if (!LIVE_READ_FAILURE.test((e as Error).message)) throw e;
    return runQuery<T>(readonlyUri(dbPath, true), sql, timeoutMs);
  }
}

function runQuery<T>(uri: string, sql: string, timeoutMs: number): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const proc = spawn(SQLITE3, ["-json", "-cmd", ".timeout 2000", uri], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // Decode across chunk boundaries so split UTF-8 characters stay intact.
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new Error(`sqlite3 timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (c: string) => (stdout += c));
    proc.stderr.on("data", (c: string) => (stderr += c));
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn sqlite3: ${e.message}`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(`sqlite3 exited with ${code}: ${stderr.trim() || "no stderr"}`),
        );
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve([]); // sqlite3 -json prints nothing for an empty result set
        return;
      }
      try {
        resolve(JSON.parse(trimmed) as T[]);
      } catch (e) {
        reject(
          new Error(`Could not parse sqlite3 JSON output: ${(e as Error).message}`),
        );
      }
    });

    proc.stdin.write(sql);
    proc.stdin.end();
  });
}
