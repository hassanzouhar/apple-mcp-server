# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) server that exposes 29 tools over **Calendar**, **Reminders**, **Contacts**, and **Mail** on macOS. It is a local stdio integration — no network, no external services. Every operation runs through `/usr/bin/osascript` using **JavaScript for Automation (JXA)**, not classic AppleScript.

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

There is **no test runner and no linter configured.** `evaluations.xml` defines read-only eval questions that assume fixture data on the host machine (a `scripts/load-fixtures.osascript` referenced there does not exist in the repo) — it is a spec for an external harness, not something runnable via npm.

Because the transport is stdio, you don't run the server interactively to test it; point an MCP client at `dist/index.js` (see README for Claude Desktop / `claude mcp add` config), or drive it with an MCP inspector.

## Architecture

The flow is uniform across all four domains:

```
src/index.ts            → registers all tool groups, starts StdioServerTransport
src/tools/{calendar,reminders,contacts,mail}.ts
                        → one file per app; defines Zod input schemas + handlers,
                          embeds JXA scripts as template strings, registers tools
src/services/osascript.ts → runJxa(): the ONLY way scripts reach osascript
src/services/format.ts    → buildResult / errorResult / describeError + helpers
src/schemas/common.ts     → shared Zod fragments (limit, iso date, response_format)
src/constants.ts          → timeouts, limits, server name/version
```

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

`describeError` (in `format.ts`) translates raw `OsaScriptError`s into actionable messages — most importantly it detects the macOS "not authorized" / "-1743" family and tells the agent which System Settings pane to fix. Extend this function when you encounter a new opaque osascript error.

### Conventions when adding or editing a tool

- Define the input as a Zod object with `.strict()`, reusing fragments from `src/schemas/common.ts` (`responseFormatField`, `limitField`, `isoDateField`/`optionalIsoDateField`). Pass `Schema.shape` (not the schema) to `registerTool`'s `inputSchema`.
- Set MCP `annotations` honestly: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. All tools are `openWorldHint: true` (they touch live OS state).
- **Destructive operations gate on an explicit `confirm: true` argument**, declared as `confirm: z.literal(true)` in the input schema (Zod validation rejects the call if it's missing/false — the handler needs no manual check). This guards every delete (`apple_delete_event`/`_contact`/`_reminder`/`_message`) plus `apple_send_message`. Do not remove this guard; apply the same pattern to any new destructive tool.
- `whose()` (JXA's query DSL) is unreliable on some Calendar/Mail collections. The established pattern is to *try* `whose()` for a coarse narrow, `catch` the failure, fall back to fetching all items, and then **filter in JS**. Follow this pattern rather than trusting `whose()` alone. Individual property reads (`ev.location()`, etc.) are also wrapped in per-field try/catch because some records reject them.
- Timeouts: default is `DEFAULT_OSASCRIPT_TIMEOUT_MS` (30 s); Mail uses `MAIL_OSASCRIPT_TIMEOUT_MS` (60 s) because large mailboxes are slow. Pass `timeoutMs` to `runJxa` for Mail calls.

### Important runtime constraint

This is a **stdio MCP server: stdout is the protocol channel.** Never `console.log` — all diagnostics must go to **stderr** (use the `log()` helper in `index.ts`). A stray stdout write corrupts the MCP stream.

## Module system

ESM (`"type": "module"`, TS `Node16` resolution). Relative imports **must** carry the `.js` extension even in `.ts` source (e.g. `import { runJxa } from "../services/osascript.js"`). `strict` is on.
