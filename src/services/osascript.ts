/**
 * Bridge to macOS' osascript binary.
 *
 * We prefer JavaScript for Automation (JXA) over classic AppleScript because:
 *   - It supports JSON.stringify natively, so we can return structured data
 *     without inventing a serialization format.
 *   - It supports parsing user-supplied data separately from executable code.
 *
 * Scripts are passed via stdin (NOT via -e or argv) so we never have to worry
 * about shell quoting. User-supplied JSON travels over a separate private pipe
 * (file descriptor 3), never through process arguments or environment variables.
 */

import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import {
  DEFAULT_OSASCRIPT_TIMEOUT_MS,
  MAX_SCRIPT_LENGTH,
} from "../constants.js";

export class OsaScriptError extends Error {
  public readonly stderr: string;
  public readonly exitCode: number | null;
  constructor(message: string, stderr: string, exitCode: number | null) {
    super(message);
    this.name = "OsaScriptError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export type ScriptLanguage = "JavaScript" | "AppleScript";

export interface RunOsaOptions {
  /** Which scripting language osascript should interpret. Default: JavaScript (JXA). */
  language?: ScriptLanguage;
  /** Timeout in milliseconds. Default: DEFAULT_OSASCRIPT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** JSON data sent over private file descriptor 3; use runJxa to parse it as INPUT. */
  argsJson?: string;
}

/**
 * Run a raw osascript invocation. Most callers should use `runJxa` instead.
 */
export async function runOsascript(
  script: string,
  options: RunOsaOptions = {},
): Promise<string> {
  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new OsaScriptError(
      `Script too large (${script.length} > ${MAX_SCRIPT_LENGTH} chars)`,
      "",
      null,
    );
  }

  const language = options.language ?? "JavaScript";
  const timeoutMs = options.timeoutMs ?? DEFAULT_OSASCRIPT_TIMEOUT_MS;

  const args = ["-l", language, "-"];

  return new Promise<string>((resolve, reject) => {
    const proc = spawn("/usr/bin/osascript", args, {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(
        new OsaScriptError(
          `osascript timed out after ${timeoutMs}ms`,
          stderr,
          null,
        ),
      );
    }, timeoutMs);

    // Decode across chunk boundaries so split UTF-8 characters stay intact.
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new OsaScriptError(
          `Failed to spawn osascript: ${err.message}`,
          stderr,
          null,
        ),
      );
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new OsaScriptError(
            `osascript exited with code ${code}: ${stderr.trim() || "no stderr"}`,
            stderr,
            code,
          ),
        );
        return;
      }
      resolve(stdout);
    });

    const input = proc.stdio[3] as Writable;
    // A child can exit before consuming either stream (syntax error or timeout).
    // Handle pipe errors so they cannot become uncaught exceptions.
    const onPipeError = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill("SIGKILL");
      reject(new OsaScriptError("Failed to write osascript input", stderr, null));
    };
    proc.stdin.on("error", onPipeError);
    input.on("error", onPipeError);
    proc.stdin.end(script);
    input.end(options.argsJson ?? "null");
  });
}

/**
 * Run a JXA script and return its parsed JSON return value.
 *
 * Conventions for the script:
 *   - The script body MUST be wrapped in an IIFE that returns a value.
 *   - The script body has access to a global `INPUT` variable which is the
 *     argsJson value (already JSON.parsed for you).
 *   - The script's final value is JSON-stringified by us and returned.
 *
 * Example:
 *   const events = await runJxa<Event[]>({
 *     script: `
 *       const cal = Application('Calendar');
 *       return cal.calendars().map(c => ({ name: c.name() }));
 *     `,
 *     args: { foo: 'bar' },
 *   });
 */
export interface RunJxaOptions<TArgs = unknown> {
  /** The JXA function body. Must `return` a JSON-serializable value. */
  script: string;
  /** Optional arguments. Will be JSON-stringified and bound to `INPUT` inside the script. */
  args?: TArgs;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
}

export async function runJxa<TResult = unknown, TArgs = unknown>(
  options: RunJxaOptions<TArgs>,
): Promise<TResult> {
  const argsJson = JSON.stringify(options.args ?? null);

  // Wrap the user's script body in a runner that:
  //   1. Reads the JSON-encoded INPUT from private file descriptor 3.
  //   2. Runs the body inside a try/catch and returns a tagged result.
  //
  // We MUST stringify the result ourselves before returning because JXA's
  // default coercion turns objects into "[object Object]".
  const wrapper = `
    ObjC.import('Foundation');
    function run() {
      let INPUT = null;
      try {
        const data = $.NSFileHandle.alloc.initWithFileDescriptor(3).readDataToEndOfFile;
        const json = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
        INPUT = JSON.parse(ObjC.unwrap(json));
      } catch (e) {
        return JSON.stringify({ __ok: false, error: 'Failed to parse INPUT JSON: ' + (e && e.message ? e.message : String(e)) });
      }
      try {
        const __result = (function() {
${options.script}
        })();
        return JSON.stringify({ __ok: true, value: __result === undefined ? null : __result });
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        return JSON.stringify({ __ok: false, error: msg });
      }
    }
  `;

  const raw = await runOsascript(wrapper, {
    language: "JavaScript",
    timeoutMs: options.timeoutMs,
    argsJson,
  });

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new OsaScriptError("osascript returned empty output", "", 0);
  }

  let parsed: { __ok: boolean; value?: unknown; error?: string };
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new OsaScriptError(
      `Failed to parse JXA output as JSON: ${(e as Error).message}. Raw output: ${trimmed.slice(0, 500)}`,
      "",
      0,
    );
  }

  if (!parsed.__ok) {
    throw new OsaScriptError(
      `JXA script error: ${parsed.error ?? "unknown"}`,
      parsed.error ?? "",
      0,
    );
  }
  return parsed.value as TResult;
}

/**
 * Convert an ISO 8601 string into a snippet of JXA that constructs the
 * corresponding Date. Returns 'null' if the input is null/undefined.
 *
 * Use this in templated scripts when you need a date value:
 *   const script = `const start = ${jxaDateLiteral(startIso)};`;
 *
 * Prefer passing dates through `args` (as ISO strings) and constructing the
 * Date inside the script body — this helper is for cases where that is awkward.
 */
export function jxaDateLiteral(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "null";
  // Single-quoted, no special chars possible in a valid ISO string.
  const safe = iso.replace(/'/g, "");
  return `new Date('${safe}')`;
}
