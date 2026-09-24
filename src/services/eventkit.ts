/**
 * Bridge to the compiled EventKit helper binary (eventkit/helper.swift).
 *
 * Calendar and Reminders are read AND written through EventKit rather than JXA:
 *   - Reads are orders of magnitude faster (indexed framework query vs. one
 *     Apple Event per property).
 *   - Writes go through the same framework so the identifiers we hand back from
 *     reads (EventKit's `eventIdentifier` / `calendarItemIdentifier`) are the
 *     exact ids the write commands accept. JXA uses a *different* id scheme
 *     (`x-apple-reminder://…`, bare event UIDs), so mixing the two would break
 *     "list then delete/complete" round-trips.
 *
 * The helper speaks JSON over argv + stdin/stdout; see helper.swift.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class EventKitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventKitError";
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));

let cachedBin: string | null = null;

/** Locate the helper binary across both the bundle layout and dev layout. */
function resolveHelper(): string {
  if (cachedBin) return cachedBin;
  const candidates = [
    process.env.EVENTKIT_HELPER_PATH,
    join(HERE, "bin", "eventkit-helper"), // bundle: server/index.js → server/bin
    join(HERE, "..", "..", "server", "bin", "eventkit-helper"), // dev: src/services → repo/server/bin
    join(HERE, "..", "bin", "eventkit-helper"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(c)) {
      ensureExecutable(c);
      cachedBin = c;
      return c;
    }
  }
  throw new EventKitError(
    "eventkit-helper binary not found (run `npm run build:helper`). Looked in: " +
      candidates.join(", "),
  );
}

/**
 * Ensure the helper has its execute bit set. `mcpb pack` / Claude Desktop's
 * unpack do NOT preserve the executable permission, so a freshly installed
 * extension ships the binary as `rw-------` and spawning it fails with EACCES.
 * We re-assert 0o755 here (best-effort — the unpacked extension dir is writable).
 */
function ensureExecutable(path: string): void {
  try {
    const mode = statSync(path).mode;
    if ((mode & 0o111) !== 0o111) chmodSync(path, 0o755);
  } catch {
    /* best-effort: if we can't stat/chmod, the spawn error will surface it */
  }
}

/** Default timeout. EventKit calls are sub-second; this guards against hangs. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Invoke the helper with a command and JSON args, returning the parsed `value`.
 * Throws EventKitError on a protocol-level failure (e.g. access denied).
 */
export async function runHelper<T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const bin = resolveHelper();
  return new Promise<T>((resolve, reject) => {
    const proc = spawn(bin, [command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new EventKitError(`eventkit-helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    proc.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint = /EACCES/.test(e.message)
        ? ` — the binary is not executable. Run: chmod +x "${bin}"`
        : "";
      reject(
        new EventKitError(`Failed to spawn eventkit-helper: ${e.message}${hint}`),
      );
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new EventKitError(
            `eventkit-helper exited ${code} with no output${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      let parsed: { ok: boolean; value?: unknown; error?: string };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        reject(
          new EventKitError(`Could not parse helper output: ${trimmed.slice(0, 300)}`),
        );
        return;
      }
      if (!parsed.ok) {
        reject(new EventKitError(parsed.error ?? "unknown EventKit error"));
        return;
      }
      resolve(parsed.value as T);
    });

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();
  });
}

/** ISO string for `days` from now (negative = past). Used for default windows. */
export function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}
