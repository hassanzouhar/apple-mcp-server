# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local stdio MCP server exposing **5 tools** — `calendar`, `reminders`, `contacts`, `mail`, `imessage` — each with an `action` parameter selecting the operation. macOS-only: `main()` in `src/index.ts` exits if `process.platform !== "darwin"`. No network, no external services.

**stdout is the MCP protocol channel.** Never `console.log`; diagnostics go to stderr via `log()` in `src/index.ts`.

## Commands

```bash
npm run build         # tsc → dist/
npm run dev           # tsx watch src/index.ts
npm start             # node dist/index.js (needs build)
npm test              # node --import tsx --test "src/**/*.test.ts"
npm run build:helper  # swiftc → server/bin/eventkit-helper (needed for calendar/reminders)
npm run bundle        # build:helper + esbuild → server/index.js (self-contained ESM)
npm run clean         # rm -rf dist server
```

Single test file: `node --import tsx --test src/services/format.test.ts`. Single test by name: add `--test-name-pattern="<regex>"`.

No linter. Tests mix pure unit tests with integration tests against live OS state that **skip** when unavailable (helper not built, Calendar/Reminders not authorized, `chat.db` unreadable without Full Disk Access). Write tests against the EventKit helper only run with `AMCP_TEST_WRITES=1`. `evaluations.xml` is a spec for an external eval harness (assumes fixture data on the host), not runnable via npm.

Stdio means no interactive run; point an MCP client at `dist/index.js` (`claude mcp add apple node /abs/path/dist/index.js`) or use an MCP inspector.

### Packaging (MCPB, darwin-only)

```bash
npm run bundle
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack .      # → apple-mcp-server.mcpb
```

`.mcpbignore` limits the bundle to `manifest.json`, `server/index.js`, `server/bin/eventkit-helper`, README. If you add or rename a tool/action, update the `tools` descriptions in `manifest.json` and the README tables too. `dist/`, `server/`, `*.mcpb` are gitignored.

## Architecture

Three different paths reach the OS — know which one a domain uses before editing:

| Domain | Reads | Writes |
|---|---|---|
| calendar, reminders | EventKit helper (`eventkit/helper.swift`, via `services/eventkit.ts` `runHelper()`) | EventKit helper |
| contacts | JXA via `runJxa` | JXA |
| mail | read-only SQLite on Mail's Envelope Index (`services/mailstore.ts`) — needs Full Disk Access | JXA (send/draft/mark/delete) |
| imessage | read-only SQLite on `chat.db` (`services/imessagestore.ts`, decodes binary `attributedBody`) — needs Full Disk Access | JXA (send) |

Calendar/reminders deliberately use EventKit for writes too: EventKit ids differ from JXA ids, so mixing paths would break list-then-delete/complete round-trips. The helper binary is located via `EVENTKIT_HELPER_PATH` or `server/bin/`, and `ensureExecutable` re-asserts the exec bit because MCPB unpacking drops it. SQLite access goes through `/usr/bin/sqlite3` with `mode=ro` so rows still in the WAL are visible, falling back to `immutable=1` when a live read fails (`services/sqlite.ts`).

```
src/index.ts            registers all five tools, starts StdioServerTransport
src/tools/<app>.ts      per-action Zod schemas + handlers, an `action` enum, a dispatch fn, ONE registerTool
src/tools/dispatch.ts   consolidatedShape() + parseAction()
src/services/           osascript, sqlite, mailstore, imessagestore, eventkit, format
src/schemas/common.ts   shared Zod fragments (limit, iso date, response_format)
src/constants.ts        timeouts, limits, server name/version
```

### Consolidation pattern (`dispatch.ts`) — read before editing any tool

The outer schema the MCP host sees can't express per-action required fields. So each action keeps its own `.strict()` Zod schema as an internal validator; `consolidatedShape(action, [schemas…])` merges all fields (made optional) into the outer shape; the dispatch switch calls `parseAction(SpecificInput, raw)`, which strips `action` and re-validates against the precise schema. A failure throws and becomes an `errorResult`. Document each action's required fields in the `action` enum's `.describe()` — the host reads that, not the per-action schemas.

Adding an action: per-action `.strict()` schema (reuse `responseFormatField`, `limitField`, `isoDateField`), a handler, then wire three places — the `consolidatedShape` list, the `action` enum + `.describe()`, and a `case` in the dispatch switch. Do **not** add a new `registerTool`; there is one tool per app. A new app mirrors an existing file and is registered in `src/index.ts`.

`annotations` are coarse: any tool containing a write/delete is `readOnlyHint: false, destructiveHint: true`; all are `openWorldHint: true`.

### Destructive actions

Every `delete_*` action plus `mail` → `send` and `imessage` → `send` declare `confirm: z.literal(true)` in the *per-action* schema, enforced by `parseAction`. Keep this guard and apply it to any new destructive action.

### JXA bridge (`runJxa`)

- **Never interpolate user data into script text.** Pass it as `args`; it is JSON-serialized over a private pipe (fd 3, not argv/env) and exposed as the global `INPUT` in the script.
- The script body is a **function body** that must `return` a JSON-serializable value; `runJxa` wraps it in an IIFE + try/catch and throws `OsaScriptError` on failure. Scripts go to osascript over stdin, never `-e`.
- Each Apple Event round-trip is slow. Avoid per-item property reads in loops over large collections (this caused the contacts-search timeouts, see `.issue-drafts/01-*`); fetch properties in bulk (`C.people.name()`) and filter in JS.
- `whose()` is unreliable on some Calendar/Mail collections: try it to narrow, catch, fall back to fetching all and filtering in JS. Wrap individual property reads in per-field try/catch.
- Timeouts: `DEFAULT_OSASCRIPT_TIMEOUT_MS` 30 s, `MAIL_OSASCRIPT_TIMEOUT_MS` 60 s, `MESSAGES_OSASCRIPT_TIMEOUT_MS` 30 s; SQLite has its own 15 s. Pass `timeoutMs` to `runJxa`.

### Result envelope

Handlers never throw to the SDK. They return `buildResult(format, markdown, structured)` or `errorResult(err, hint?)` (`isError: true`). `buildResult` honors `response_format` (`markdown` default / `json`) and truncates at `CHARACTER_LIMIT` (25 000). `describeError` in `format.ts` maps opaque errors to actionable ones (Automation `-1743`, TCC denials, SQLite "unable to open database" → Full Disk Access); extend it when you meet a new one.

## Module system

ESM, TS `Node16` resolution, `strict`. Relative imports **must** use the `.js` extension in `.ts` source (`import { runJxa } from "../services/osascript.js"`). Test files are excluded from `tsc`; `node --import tsx` runs them directly.

## Known open issues

`.issue-drafts/` holds drafted GitHub issues: contacts search timeout (01, since partly addressed by bulk property fetching), EventKit TCC denial under Claude Desktop (02), and no fallback when Full Disk Access is missing (03).
