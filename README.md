# apple-mcp-server

A Model Context Protocol server that connects an LLM to the four core Apple personal apps on macOS — **Calendar**, **Reminders**, **Contacts**, and **Mail** — via the JavaScript for Automation (JXA) bridge.

- **Transport:** stdio (local-only)
- **Platform:** macOS (Darwin) — this server uses `/usr/bin/osascript` and will refuse to start on any other OS
- **Stack:** Node.js 18+, TypeScript, [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Zod](https://github.com/colinhacks/zod)
- **External services:** none — everything runs locally against the native macOS apps

## Tools (29)

### Calendar (7)
| Tool | Description |
|---|---|
| `apple_list_calendars` | Enumerate every calendar (local, iCloud, Google, Exchange…) |
| `apple_list_events` | List events in a date range, optionally filtered by calendar |
| `apple_search_events` | Substring search across summary / location / description |
| `apple_get_event` | Fetch one event by UID |
| `apple_create_event` | Create a new event |
| `apple_update_event` | Patch any subset of event fields |
| `apple_delete_event` | Delete an event |

### Reminders (8)
| Tool | Description |
|---|---|
| `apple_list_reminder_lists` | Enumerate every reminders list |
| `apple_list_reminders` | List reminders with filters (list, completed, due-date window) |
| `apple_search_reminders` | Substring search across name / body |
| `apple_create_reminder` | Create a reminder (with optional due date, remind-me, priority, flag) |
| `apple_update_reminder` | Patch reminder fields |
| `apple_complete_reminder` | Toggle the completed flag |
| `apple_delete_reminder` | Delete a reminder |
| `apple_create_reminder_list` | Create a new list |

### Contacts (5)
| Tool | Description |
|---|---|
| `apple_search_contacts` | Substring search across name / org / email / phone |
| `apple_get_contact` | Fetch one contact by UID |
| `apple_create_contact` | Create a contact with emails and phones |
| `apple_update_contact` | Patch top-level fields |
| `apple_delete_contact` | Delete a contact |

### Mail (9)
| Tool | Description |
|---|---|
| `apple_list_mail_accounts` | Enumerate every Mail.app account |
| `apple_list_mailboxes` | List mailboxes, optionally per account |
| `apple_list_messages` | List recent messages in a mailbox (unread filter, date window) |
| `apple_search_messages` | Substring search across subject / sender |
| `apple_get_message` | Fetch a full message body |
| `apple_create_draft` | Open a draft in Mail.app (NOT sent) |
| `apple_send_message` | **Send** a message immediately (requires `confirm: true`) |
| `apple_mark_message` | Mark read / unread |
| `apple_delete_message` | Move to Trash (requires `confirm: true`) |

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

Restart Claude Desktop. The first time the LLM calls a tool, macOS will prompt you to grant the *host process* (Claude Desktop) permission to control Calendar / Reminders / Contacts / Mail.

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
| Mail.app | **System Settings → Privacy & Security → Automation** → enable the host app under "Mail" |

If a tool returns `Error: macOS denied access. Grant the host app …`, that's the fix.

## Design notes

- **JXA, not classic AppleScript.** Every script is JavaScript — easier to interpolate user data safely and JSON-stringify return values.
- **No shell quoting.** Scripts are passed to `osascript` over stdin. User input rides in a single argv slot as JSON; the wrapper inside `runJxa` parses it back into `INPUT`.
- **Each script is wrapped in a try/catch** that returns `{__ok, value | error}` so errors surface cleanly as MCP tool errors with actionable hints (we detect the macOS "not authorized" family of errors and translate them).
- **Per-call timeouts.** Mail can be slow on huge mailboxes; it gets a 60 s budget. Everything else uses 30 s.
- **whose() is unreliable** on some Calendar / Mail collections — we use it where it helps and fall back to in-JS filtering everywhere else.
- **Destructive ops are explicit.** `apple_send_message` and `apple_delete_message` both require `confirm: true` to be set by the agent.
- **All read tools return both Markdown and JSON.** Pass `response_format: "json"` for programmatic processing.

## License

MIT
