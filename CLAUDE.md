# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) server that exposes **5 tools** — one per app: `calendar`, `reminders`, `contacts`, `mail`, `imessage` — over **Calendar**, **Reminders**, **Contacts**, **Mail**, and **iMessage** on macOS. Each tool takes an `action` parameter that selects the operation (e.g. `calendar` → `list_events`/`create_event`/`delete_event`). It is a local stdio integration — no network, no external services.

Two paths reach the OS: **writes and most app control go through `/usr/bin/osascript`** using **JavaScript for Automation (JXA)**, not classic AppleScript; **reads of Mail and iMessage go directly to their on-disk SQLite stores** (Mail's Envelope Index and Messages' `chat.db`) read-only via `/usr/bin/sqlite3` — this requires Full Disk Access and is much faster than Apple Events.

macOS-only: `main()` in `src/index.ts` exits immediately if `process.platform !== "darwin"`.

## Commands

```bash
npm run build      # tsc → dist/ (used by `dev`/`start` and the config-JSON install path)
npm run dev        # tsx watch src/index.ts — hot reload during development
npm start          # node dist/index.js (requires a prior build)
npm run bundle     # esbuild src/index.ts → server/index.js (single self-contained ESM file)
npm run clean      # rm -rf dist server
```

### Packaging as a Desktop Extension (MCPB)

`manifest.json` (MCPB v0.4, `darwin`-only) + `npm run bundle` produce an installable `.mcpb`:

```bash
npm run bundle
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack .      # → apple-mcp-server.mcpb (~150 KB)
```

`.mcpbignore` keeps the bundle to just `manifest.json` + `server/index.js` + `README.md` — no `node_modules`, because esbuild inlines all deps. Claude Desktop unpacks the bundle into its own dir, so `${__dirname}` in the manifest resolves there, not the repo. Install via Settings → Extensions → Advanced settings → Install Extension.

Tests run via `npm test` (`node --import tsx --test "src/**/*.test.ts"`). The `*.test.ts` files mix pure unit tests with integration tests that read live OS state and **skip** when the relevant app isn't authorized / Full Disk Access isn't granted (e.g. Calendar/Reminders permission, or a readable `chat.db`). No linter is configured. `evaluations.xml` defines read-only eval questions that assume fixture data on the host machine — it is a spec for an external harness, not something runnable via npm.

Because the transport is stdio, you don't run the server interactively to test it; point an MCP client at `dist/index.js` (see README for Claude Desktop / `claude mcp add` config), or drive it with an MCP inspector.

## Architecture

The flow is uniform across all five domains. Each app file keeps **one Zod schema + one handler per action** (the original per-tool design), then exposes them through a **single consolidated MCP tool** that dispatches on `action`:

```
src/index.ts            → registers all five tools, starts StdioServerTransport
src/tools/{calendar,reminders,contacts,mail,imessage}.ts
                        → one file per app; per-action Zod schemas + handlers,
                          a consolidated *ToolInput schema, and a dispatch fn;
                          embeds JXA scripts as template strings, registers ONE tool
src/tools/dispatch.ts     → consolidatedShape() builds the permissive outer schema;
                            parseAction() strips `action` and re-validates against the
                            precise per-action schema (enforces confirm + required fields)
src/services/osascript.ts → runJxa(): the ONLY way scripts reach osascript
src/services/sqlite.ts    → querySqlite(): read-only `/usr/bin/sqlite3` (immutable=1)
src/services/mailstore.ts → fast read path for Mail (Envelope Index)
src/services/imessagestore.ts → fast read path for iMessage (chat.db); decodes the
                            binary `attributedBody` message bodies
src/services/eventkit.ts  → runHelper(): native EventKit bridge for Calendar/Reminders
src/services/format.ts    → buildResult / errorResult / describeError + helpers
src/schemas/common.ts     → shared Zod fragments (limit, iso date, response_format)
src/constants.ts          → timeouts, limits, server name/version
```

### The consolidation pattern (`dispatch.ts`) — read before editing any tool

Each app is ONE tool with an `action` enum. The outer schema can't make per-action
fields conditionally required, so the original per-action `.strict()` Zod schemas are
kept as **internal validators**. `consolidatedShape(action, [schemas…])` merges every
action's fields (made optional) into the outer shape the MCP host sees; the dispatch
function switches on `action` and calls `parseAction(SpecificInput, raw)`, which strips
`action` and re-parses with the precise schema — so `confirm: z.literal(true)` and
required fields are still enforced (a failure throws and becomes an `errorResult`).
**Trade-off:** a consolidated tool's MCP `annotations` are coarse — any tool containing a
write/delete is marked `destructiveHint: true`. Document each action's required fields in
the `action` enum's `.describe()` (the host reads it; the flat shape alone can't show
per-action requirements).

### The JXA bridge (`runJxa`) — read this before touching any tool

All tool handlers call `runJxa({ script, args, timeoutMs })`. Understanding its contract is essential:

- **Never interpolate user data into the script string.** Pass it via `args` (any JSON-serializable value). `runJxa` JSON-stringifies it and hands it to the script as a single argv slot; the wrapper parses it back into a global **`INPUT`** variable available inside your script body. This is the safety boundary — it sidesteps both shell quoting *and* JXA string-injection.
- The script body is **a function body**, not a full program: it must `return` a JSON-serializable value. `runJxa` wraps it in an IIFE inside a try/catch that returns `{__ok, value|error}`, parses the result, and throws `OsaScriptError` on failure.
- Scripts go to osascript over **stdin**, never via `-e`/argv.
- `jxaDateLiteral()` exists for the rare case where a date must be inlined into the script text; the preferred path is passing ISO strings through `args` and doing `new Date(INPUT.iso)` in the body.

### Result envelope — every handler returns the same shape

Handlers do **not** throw to the SDK. They wrap their body in `try/catch` and return either:
- `buildResult(format, markdown, structured)` on success, or
- `errorResult(err, hint?)` on failure (sets `isError: true`).

`buildResult` honors the `response_format` input (`"markdown"` default, or `"json"`) and truncates any text over `CHARACTER_LIMIT` (25 000) with a hint to narrow the query. Read tools build *both* a Markdown string and a `structured` object so either format is available.

`describeError` (in `format.ts`) translates raw errors into actionable messages — it detects the macOS "not authorized" / "-1743" Automation family (and tells the agent which System Settings pane to fix), and the SQLite "unable to open database" / "operation not permitted" family (→ "grant Full Disk Access"). Extend this function when you encounter a new opaque error.

### Conventions when adding or editing a tool

- **Adding an action to an existing tool:** define a per-action input as a Zod object with `.strict()` (reuse fragments from `src/schemas/common.ts`: `responseFormatField`, `limitField`, `isoDateField`/`optionalIsoDateField`), write its handler, then wire it in three places: add the schema to the `consolidatedShape(action, […])` list, add the value to the `action` enum (with its required fields in the `.describe()`), and add a `case` to the dispatch switch calling `parseAction(YourInput, raw)`. Do **not** add a new `registerTool` — there is exactly one tool per app.
- **Adding a whole new app:** mirror an existing file (per-action schemas + handlers + `action` enum + `consolidatedShape` + dispatch + one `registerTool`), then call its `register*Tools` in `src/index.ts`.
- Set MCP `annotations` honestly. Because each tool bundles many actions, a tool that contains any write/delete is `readOnlyHint: false, destructiveHint: true`. All tools are `openWorldHint: true` (they touch live OS state).
- **Destructive operations gate on an explicit `confirm: true` argument**, declared as `confirm: z.literal(true)` in the *per-action* schema. The outer consolidated schema can't enforce this, but `parseAction` re-parses against the per-action schema, so a missing/false `confirm` throws and becomes an `errorResult`. This guards every `delete_*` action plus `mail` → `send` and `imessage` → `send`. Do not remove this guard; apply the same pattern to any new destructive action.
- `whose()` (JXA's query DSL) is unreliable on some Calendar/Mail collections. The established pattern is to *try* `whose()` for a coarse narrow, `catch` the failure, fall back to fetching all items, and then **filter in JS**. Follow this pattern rather than trusting `whose()` alone. Individual property reads (`ev.location()`, etc.) are also wrapped in per-field try/catch because some records reject them.
- Timeouts: default is `DEFAULT_OSASCRIPT_TIMEOUT_MS` (30 s); Mail uses `MAIL_OSASCRIPT_TIMEOUT_MS` (60 s) because large mailboxes are slow; Messages uses `MESSAGES_OSASCRIPT_TIMEOUT_MS` (30 s). Pass `timeoutMs` to `runJxa` accordingly. SQLite reads use their own `DEFAULT_SQLITE_TIMEOUT_MS` (15 s) in `sqlite.ts`.

### Important runtime constraint

This is a **stdio MCP server: stdout is the protocol channel.** Never `console.log` — all diagnostics must go to **stderr** (use the `log()` helper in `index.ts`). A stray stdout write corrupts the MCP stream.

## Module system

ESM (`"type": "module"`, TS `Node16` resolution). Relative imports **must** carry the `.js` extension even in `.ts` source (e.g. `import { runJxa } from "../services/osascript.js"`). `strict` is on.
