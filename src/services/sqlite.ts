/**
 * Read-only SQLite access for the macOS app stores (Mail's "Envelope Index").
 *
 * We shell out to the system `/usr/bin/sqlite3` rather than depend on a native
 * node addon:
 *   - It is always present on macOS.
 *   - The `immutable=1` URI flag lets us read a *live* database (one Mail.app
 *     has open, possibly in WAL mode) without taking any lock or risking a
 *     write — critical, since we must never mutate the user's mail store.
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

/** Build a read-only, immutable file: URI for a database path. */
export function readonlyUri(dbPath: string): string {
  const encoded = dbPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file:${encoded}?mode=ro&immutable=1`;
}

/**
 * Run a single read-only SELECT and return the rows as parsed JSON objects.
 * `sql` MUST be a single statement; embed any user data with `sqlLiteral()`.
 */
export async function querySqlite<T = Record<string, unknown>>(
  dbPath: string,
  sql: string,
  timeoutMs: number = DEFAULT_SQLITE_TIMEOUT_MS,
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const proc = spawn(SQLITE3, ["-json", readonlyUri(dbPath)], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new Error(`sqlite3 timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    proc.stderr.on("data", (c) => (stderr += c.toString("utf8")));
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
