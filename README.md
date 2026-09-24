# apple-mcp-server

A Model Context Protocol server that connects an LLM to the core Apple personal apps on macOS — **Calendar**, **Reminders**, **Contacts**, **Mail**, and **iMessage** — via the JavaScript for Automation (JXA) bridge and direct read-only access to the on-disk Mail / Messages stores.

The server exposes **one tool per app** (`calendar`, `reminders`, `contacts`, `mail`, `imessage`). Each takes an `action` parameter that selects the operation, plus the fields that action needs.

- **Transport:** stdio (local-only)
- **Platform:** macOS (Darwin) — this server uses `/usr/bin/osascript` and will refuse to start on any other OS
- **Stack:** Node.js 18+, TypeScript, [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Zod](https://github.com/colinhacks/zod)
- **External services:** none — everything runs locally against the native macOS apps

## Tools (5)

Each tool dispatches on its `action` field. Destructive actions (`delete_*`, `send`) require `confirm: true`.

### `calendar`
| action | Description |
|---|---|
| `list_calendars` | Enumerate every calendar (local, iCloud, Google, Exchange…) |
| `list_events` | List events in a date range, optionally filtered by calendar |
| `search_events` | Substring search across summary / location / description |
| `get_event` | Fetch one event by id |
| `create_event` | Create a new event |
| `update_event` | Patch any subset of event fields |
| `delete_event` | Delete an event (`confirm: true`) |

### `reminders`
| action | Description |
|---|---|
| `list_lists` | Enumerate every reminders list |
| `list` | List reminders with filters (list, completed, due-date window) |
| `search` | Substring search across name / body |
| `create` | Create a reminder (optional due date, remind-me, priority) |
| `update` | Patch reminder fields |
| `complete` | Toggle the completed flag |
| `delete` | Delete a reminder (`confirm: true`) |
| `create_list` | Create a new list |

### `contacts`
| action | Description |
|---|---|
| `search` | Substring search across name / org / email / phone |
| `get` | Fetch one contact by UID |
| `create` | Create a contact with emails and phones |
| `update` | Patch top-level fields |
| `delete` | Delete a contact (`confirm: true`) |

### `mail`
| action | Description |
|---|---|
| `list_accounts` | Enumerate every Mail.app account |
| `list_mailboxes` | List mailboxes, optionally per account |
| `list_messages` | List recent messages in a mailbox (unread filter, date window) |
| `search` | Substring search across subject / sender |
| `get` | Fetch a full message body |
| `create_draft` | Open a draft in Mail.app (NOT sent) |
| `send` | **Send** an email immediately (`confirm: true`) |
| `mark` | Mark read / unread |
| `delete` | Move to Trash (`confirm: true`) |

### `imessage`
| action | Description |
|---|---|
| `list_chats` | List recent conversations (name, participants, last-message preview) |
| `list_messages` | Read one conversation, oldest-first |
| `search` | Substring search across message text (scans recent messages) |
| `send` | **Send** an iMessage/SMS immediately (`confirm: true`) |

> **Reading Mail and iMessage requires Full Disk Access** (they read Mail's Envelope Index and Messages' `chat.db` directly). See [macOS permissions](#macos-permissions).

## Install & build

```bash
git clone <this-repo> apple-mcp-server
cd apple-mcp-server
npm install
npm run build
```

The compiled entry point is `dist/index.js`.

## Run

```bash
node /absolute/path/to/apple-mcp-server/dist/index.js
```

The server speaks MCP over stdio; you normally don't invoke it directly — point your MCP client at it (see below).

## Wire it up

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "apple": {
      "command": "node",
      "args": ["/absolute/path/to/apple-mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. The first time the LLM calls a tool, macOS will prompt you to grant the *host process* (Claude Desktop) permission to control Calendar / Reminders / Contacts / Mail. Reading Mail and iMessage additionally needs **Full Disk Access** (see below).

### Claude Code / other MCP clients

```bash
claude mcp add apple node /absolute/path/to/apple-mcp-server/dist/index.js
```

## macOS permissions

Each of the four apps gates AppleScript access behind a separate System Settings entry. Approve them up front to avoid mid-conversation prompts:

| Need access to | Where to grant |
|---|---|
| Calendar.app | **System Settings → Privacy & Security → Automation** → enable the host app under "Calendar" |
| Reminders.app | **System Settings → Privacy & Security → Reminders** → add the host app |
| Contacts.app | **System Settings → Privacy & Security → Contacts** → add the host app |
| Mail.app (send/draft/mark/delete) | **System Settings → Privacy & Security → Automation** → enable the host app under "Mail" |
| Messages.app (`imessage` → `send`) | **System Settings → Privacy & Security → Automation** → enable the host app under "Messages" |
| Mail reading + iMessage reading | **System Settings → Privacy & Security → Full Disk Access** → add the host app (it reads Mail's Envelope Index and Messages' `chat.db`) |

If a tool returns `Error: macOS denied access. Grant the host app …`, that's an Automation/category fix. If it returns `Error: Could not read the on-disk store … needs Full Disk Access`, grant Full Disk Access and restart the host app.

## Design notes

- **JXA, not classic AppleScript.** Every script is JavaScript — easier to interpolate user data safely and JSON-stringify return values.
- **No shell quoting.** Scripts are passed to `osascript` over stdin. User input rides in a single argv slot as JSON; the wrapper inside `runJxa` parses it back into `INPUT`.
- **Each script is wrapped in a try/catch** that returns `{__ok, value | error}` so errors surface cleanly as MCP tool errors with actionable hints (we detect the macOS "not authorized" family of errors and translate them).
- **One tool per app, dispatched on `action`.** Each app's tool re-validates its arguments against a precise per-action Zod schema inside the handler, so required fields and the `confirm: true` gate are still enforced even though the outer schema is permissive.
- **Reads of Mail and iMessage go straight to SQLite.** Mail's Envelope Index and Messages' `chat.db` are read read-only (`immutable=1`, no lock) via `/usr/bin/sqlite3` — far faster than Apple Events. iMessage bodies that live in the binary `attributedBody` field are decoded heuristically; writes (Mail send/mark/delete, iMessage send) still go through JXA.
- **Per-call timeouts.** Mail can be slow on huge mailboxes; it gets a 60 s budget. Everything else uses 30 s.
- **whose() is unreliable** on some Calendar / Mail collections — we use it where it helps and fall back to in-JS filtering everywhere else.
- **Destructive ops are explicit.** Every `delete_*`, `mail` → `send`, and `imessage` → `send` requires `confirm: true` to be set by the agent.
- **All read actions return both Markdown and JSON.** Pass `response_format: "json"` for programmatic processing.

## License

MIT
