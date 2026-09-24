/**
 * Reminders.app tools — backed by EventKit (see services/eventkit.ts).
 *
 * Reads and writes both go through EventKit so identifiers are consistent and
 * list/search queries are fast. NOTE: EventKit does not expose the "flagged"
 * attribute, so `flagged` reads back as false and cannot be set through these
 * tools (the field is accepted but ignored on create/update).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  limitField,
  optionalIsoDateField,
  responseFormatField,
} from "../schemas/common.js";
import { buildResult, errorResult, humanDate } from "../services/format.js";
import { runHelper } from "../services/eventkit.js";
import { consolidatedShape, parseAction } from "./dispatch.js";

/* ──────────────────────────────────────────────────────────────────────── */
/* Types returned from the EventKit helper                                   */
/* ──────────────────────────────────────────────────────────────────────── */

interface RawReminderList {
  id: string;
  name: string;
}

interface RawReminder {
  id: string;
  name: string;
  body: string | null;
  completed: boolean;
  completionDate: string | null;
  dueDate: string | null;
  remindMeDate: string | null;
  priority: number;
  flagged: boolean;
  listName: string;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* list_reminder_lists                                                */
/* ──────────────────────────────────────────────────────────────────────── */

const ListListsInput = z
  .object({
    response_format: responseFormatField,
  })
  .strict();

async function listLists(params: z.infer<typeof ListListsInput>) {
  try {
    const lists = await runHelper<RawReminderList[]>("list-reminder-lists");
    const md = [
      `# Reminder Lists (${lists.length})`,
      "",
      ...lists.map((l) => `- **${l.name}** — id: \`${l.id}\``),
    ].join("\n");
    return buildResult(params.response_format, md, {
      count: lists.length,
      lists,
    });
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* list_reminders                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const ListRemindersInput = z
  .object({
    list_name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Limit to one list. Use action 'list_lists' to discover names.",
      ),
    include_completed: z
      .boolean()
      .default(false)
      .describe(
        "Include reminders that are already marked complete. Default false.",
      ),
    due_before: optionalIsoDateField.describe(
      "Optional. Only return reminders with a due date strictly before this date.",
    ),
    due_after: optionalIsoDateField.describe(
      "Optional. Only return reminders with a due date on/after this date.",
    ),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

function renderReminders(title: string, reminders: RawReminder[]): string {
  return [
    title,
    "",
    reminders.length === 0
      ? "_No reminders match._"
      : reminders
          .map(
            (r) =>
              `- ${r.completed ? "✅" : "⬜"} **${r.name}** ` +
              (r.dueDate ? `_(due ${humanDate(r.dueDate)})_ ` : "") +
              `_(${r.listName})_ — id: \`${r.id}\``,
          )
          .join("\n"),
  ].join("\n");
}

async function listReminders(params: z.infer<typeof ListRemindersInput>) {
  try {
    const reminders = await runHelper<RawReminder[]>("list-reminders", {
      listName: params.list_name ?? null,
      includeCompleted: params.include_completed,
      dueBeforeIso: params.due_before ?? null,
      dueAfterIso: params.due_after ?? null,
      limit: params.limit,
    });
    const structured = {
      count: reminders.length,
      list_name: params.list_name ?? null,
      reminders,
    };
    const md = renderReminders(
      `# Reminders${params.list_name ? ` in \`${params.list_name}\`` : ""} (${reminders.length})`,
      reminders,
    );
    return buildResult(params.response_format, md, structured);
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* search_reminders                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

const SearchRemindersInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe("Case-insensitive substring match against name or body."),
    include_completed: z.boolean().default(false),
    list_name: z.string().min(1).optional(),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

async function searchReminders(params: z.infer<typeof SearchRemindersInput>) {
  try {
    const reminders = await runHelper<RawReminder[]>("list-reminders", {
      query: params.query,
      includeCompleted: params.include_completed,
      listName: params.list_name ?? null,
      limit: params.limit,
    });
    const md = [
      `# Reminder search: \`${params.query}\` (${reminders.length})`,
      "",
      ...reminders.map(
        (r) =>
          `- ${r.completed ? "✅" : "⬜"} **${r.name}** _(${r.listName})_ — id: \`${r.id}\``,
      ),
    ].join("\n");
    return buildResult(params.response_format, md, {
      query: params.query,
      count: reminders.length,
      reminders,
    });
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* create_reminder                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

const CreateReminderInput = z
  .object({
    list_name: z
      .string()
      .min(1)
      .describe("Target list. Use action 'list_lists' to discover names."),
    name: z.string().min(1).max(500).describe("The reminder's title."),
    body: z.string().max(5000).optional().describe("Notes / details."),
    due_date: optionalIsoDateField.describe(
      "Optional due date (ISO 8601). For a date-only reminder, pass YYYY-MM-DD.",
    ),
    remind_me_date: optionalIsoDateField.describe(
      "Optional date/time when macOS should fire a notification.",
    ),
    priority: z
      .number()
      .int()
      .min(0)
      .max(9)
      .optional()
      .describe("0 = none, 1 = high, 5 = medium, 9 = low (Apple's numbering)."),
    response_format: responseFormatField,
  })
  .strict();

async function createReminder(params: z.infer<typeof CreateReminderInput>) {
  try {
    const result = await runHelper<{ id: string }>("create-reminder", {
      listName: params.list_name,
      name: params.name,
      body: params.body ?? null,
      dueIso: params.due_date ?? null,
      remindIso: params.remind_me_date ?? null,
      priority: params.priority ?? null,
    });
    return buildResult(
      params.response_format,
      `Created reminder **${params.name}** in **${params.list_name}** — id: \`${result.id}\``,
      { created: true, id: result.id, ...params },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* update_reminder                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

const UpdateReminderInput = z
  .object({
    reminder_id: z.string().min(1).describe("The reminder's id."),
    name: z.string().min(1).max(500).optional(),
    body: z.string().max(5000).optional(),
    due_date: optionalIsoDateField,
    remind_me_date: optionalIsoDateField,
    priority: z.number().int().min(0).max(9).optional(),
    response_format: responseFormatField,
  })
  .strict();

async function updateReminder(params: z.infer<typeof UpdateReminderInput>) {
  const hasUpdate = [
    params.name,
    params.body,
    params.due_date,
    params.remind_me_date,
    params.priority,
  ].some((x) => x !== undefined);
  if (!hasUpdate) {
    return errorResult(
      new Error("At least one field besides reminder_id must be provided."),
    );
  }
  try {
    const ok = await runHelper<{ updated: boolean }>("update-reminder", {
      id: params.reminder_id,
      name: params.name ?? null,
      body: params.body ?? null,
      dueIso: params.due_date ?? null,
      remindIso: params.remind_me_date ?? null,
      priority: params.priority ?? null,
    });
    return buildResult(
      params.response_format,
      `Updated reminder \`${params.reminder_id}\``,
      { updated: ok.updated, id: params.reminder_id, ...params },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* complete_reminder                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

const CompleteReminderInput = z
  .object({
    reminder_id: z.string().min(1),
    completed: z
      .boolean()
      .default(true)
      .describe(
        "true marks the reminder complete, false re-opens it. Default true.",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function completeReminder(params: z.infer<typeof CompleteReminderInput>) {
  try {
    const ok = await runHelper<{ completed: boolean }>("complete-reminder", {
      id: params.reminder_id,
      completed: params.completed,
    });
    return buildResult(
      params.response_format,
      `${params.completed ? "Completed" : "Re-opened"} reminder \`${params.reminder_id}\``,
      { completed: ok.completed, id: params.reminder_id },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* delete_reminder                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

const DeleteReminderInput = z
  .object({
    reminder_id: z.string().min(1),
    confirm: z
      .literal(true)
      .describe(
        "Required acknowledgement that the deletion is permanent. Must be true.",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function deleteReminder(params: z.infer<typeof DeleteReminderInput>) {
  try {
    const ok = await runHelper<{ deleted: boolean }>("delete-reminder", {
      id: params.reminder_id,
    });
    return buildResult(
      params.response_format,
      `Deleted reminder \`${params.reminder_id}\``,
      { deleted: ok.deleted, id: params.reminder_id },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* create_reminder_list                                               */
/* ──────────────────────────────────────────────────────────────────────── */

const CreateListInput = z
  .object({
    name: z.string().min(1).max(200).describe("Name for the new list."),
    response_format: responseFormatField,
  })
  .strict();

async function createList(params: z.infer<typeof CreateListInput>) {
  try {
    const result = await runHelper<{ id: string }>("create-reminder-list", {
      name: params.name,
    });
    return buildResult(
      params.response_format,
      `Created list **${params.name}** — id: \`${result.id}\``,
      { created: true, id: result.id, name: params.name },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Registration                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

const reminderAction = z
  .enum([
    "list_lists",
    "list",
    "search",
    "create",
    "update",
    "complete",
    "delete",
    "create_list",
  ])
  .describe(
    [
      "Which Reminders operation to perform. Required fields per action:",
      "• list_lists — (no other fields)",
      "• list — optional list_name, include_completed, due_before, due_after, limit",
      "• search — query; optional list_name, include_completed, limit",
      "• create — list_name, name; optional body, due_date, remind_me_date, priority",
      "• update — reminder_id + at least one of name/body/due_date/remind_me_date/priority",
      "• complete — reminder_id; optional completed (default true)",
      "• delete — reminder_id, confirm=true",
      "• create_list — name",
    ].join("\n"),
  );

const ReminderToolInput = z.object(
  consolidatedShape(reminderAction, [
    ListListsInput,
    ListRemindersInput,
    SearchRemindersInput,
    CreateReminderInput,
    UpdateReminderInput,
    CompleteReminderInput,
    DeleteReminderInput,
    CreateListInput,
  ]),
);

async function dispatchReminders(raw: z.infer<typeof ReminderToolInput>) {
  try {
    switch (raw.action) {
      case "list_lists":
        return await listLists(parseAction(ListListsInput, raw));
      case "list":
        return await listReminders(parseAction(ListRemindersInput, raw));
      case "search":
        return await searchReminders(parseAction(SearchRemindersInput, raw));
      case "create":
        return await createReminder(parseAction(CreateReminderInput, raw));
      case "update":
        return await updateReminder(parseAction(UpdateReminderInput, raw));
      case "complete":
        return await completeReminder(parseAction(CompleteReminderInput, raw));
      case "delete":
        return await deleteReminder(parseAction(DeleteReminderInput, raw));
      case "create_list":
        return await createList(parseAction(CreateListInput, raw));
      default:
        return errorResult(
          new Error(`Unknown reminders action: ${String(raw.action)}`),
        );
    }
  } catch (e) {
    return errorResult(e);
  }
}

export function registerReminderTools(server: McpServer) {
  server.registerTool(
    "reminders",
    {
      title: "Reminders",
      description:
        "Read and manage Reminders.app. Pick an operation with `action`: " +
        "list_lists, list, search, create, update, complete, delete, create_list. " +
        "See the `action` field for the parameters each operation needs. " +
        "Destructive actions (delete) require confirm=true.",
      inputSchema: ReminderToolInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    dispatchReminders,
  );
}
