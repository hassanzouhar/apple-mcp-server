/**
 * Reminders.app tools.
 *
 * All ops go through JXA (Application('Reminders')). Reminders has the cleanest
 * AppleScript dictionary of the four apps we cover: lists contain reminders;
 * reminders have name, body, completed, completion date, due date, remind-me
 * date, priority, and flagged.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  isoDateField,
  limitField,
  optionalIsoDateField,
  responseFormatField,
} from "../schemas/common.js";
import {
  ResponseFormat,
  buildResult,
  errorResult,
  humanDate,
} from "../services/format.js";
import { runJxa } from "../services/osascript.js";

/* ──────────────────────────────────────────────────────────────────────── */
/* Types returned from JXA scripts                                          */
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
/* apple_list_reminder_lists                                                */
/* ──────────────────────────────────────────────────────────────────────── */

const ListListsInput = z
  .object({
    response_format: responseFormatField,
  })
  .strict();

async function listLists(params: z.infer<typeof ListListsInput>) {
  try {
    const lists = await runJxa<RawReminderList[]>({
      script: `
        const Reminders = Application('Reminders');
        return Reminders.lists().map(l => ({ id: l.id(), name: l.name() }));
      `,
    });
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
/* apple_list_reminders                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const ListRemindersInput = z
  .object({
    list_name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Limit to one list. Use apple_list_reminder_lists to discover names.",
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

async function listReminders(params: z.infer<typeof ListRemindersInput>) {
  try {
    const reminders = await runJxa<RawReminder[]>({
      args: {
        listName: params.list_name ?? null,
        includeCompleted: params.include_completed,
        dueBefore: params.due_before ?? null,
        dueAfter: params.due_after ?? null,
        limit: params.limit,
      },
      script: `
        const Reminders = Application('Reminders');
        const lists = INPUT.listName
          ? Reminders.lists.whose({ name: INPUT.listName })()
          : Reminders.lists();
        if (INPUT.listName && lists.length === 0) {
          throw new Error("Reminder list not found: " + INPUT.listName);
        }
        const dueBefore = INPUT.dueBefore ? new Date(INPUT.dueBefore) : null;
        const dueAfter  = INPUT.dueAfter  ? new Date(INPUT.dueAfter)  : null;

        const out = [];
        for (let i = 0; i < lists.length && out.length < INPUT.limit; i++) {
          const list = lists[i];
          const rems = list.reminders();
          for (let j = 0; j < rems.length && out.length < INPUT.limit; j++) {
            const r = rems[j];
            const completed = !!r.completed();
            if (completed && !INPUT.includeCompleted) continue;
            let due = null;
            try { due = r.dueDate(); } catch (_) {}
            if (dueBefore && (!due || due >= dueBefore)) continue;
            if (dueAfter && (!due || due < dueAfter)) continue;
            let rmd = null, comp = null;
            try { rmd = r.remindMeDate(); } catch (_) {}
            try { comp = r.completionDate(); } catch (_) {}
            out.push({
              id: r.id(),
              name: r.name() || "",
              body: r.body() || null,
              completed,
              completionDate: comp ? comp.toISOString() : null,
              dueDate: due ? due.toISOString() : null,
              remindMeDate: rmd ? rmd.toISOString() : null,
              priority: r.priority() || 0,
              flagged: !!r.flagged(),
              listName: list.name(),
            });
          }
        }
        return out;
      `,
    });

    const structured = {
      count: reminders.length,
      list_name: params.list_name ?? null,
      reminders,
    };
    const md = [
      `# Reminders${params.list_name ? ` in \`${params.list_name}\`` : ""} (${reminders.length})`,
      "",
      reminders.length === 0
        ? "_No reminders match._"
        : reminders
            .map(
              (r) =>
                `- ${r.completed ? "✅" : "⬜"} **${r.name}** ` +
                (r.dueDate ? `_(due ${humanDate(r.dueDate)})_ ` : "") +
                (r.flagged ? "🚩 " : "") +
                `_(${r.listName})_ — id: \`${r.id}\``,
            )
            .join("\n"),
    ].join("\n");
    return buildResult(params.response_format, md, structured);
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_search_reminders                                                   */
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
    const reminders = await runJxa<RawReminder[]>({
      args: {
        query: params.query.toLowerCase(),
        includeCompleted: params.include_completed,
        listName: params.list_name ?? null,
        limit: params.limit,
      },
      script: `
        const Reminders = Application('Reminders');
        const lists = INPUT.listName
          ? Reminders.lists.whose({ name: INPUT.listName })()
          : Reminders.lists();
        const out = [];
        for (let i = 0; i < lists.length && out.length < INPUT.limit; i++) {
          const list = lists[i];
          const rems = list.reminders();
          for (let j = 0; j < rems.length && out.length < INPUT.limit; j++) {
            const r = rems[j];
            const completed = !!r.completed();
            if (completed && !INPUT.includeCompleted) continue;
            const name = (r.name() || "").toLowerCase();
            const body = (r.body() || "").toLowerCase();
            if (!name.includes(INPUT.query) && !body.includes(INPUT.query)) continue;
            let due = null, rmd = null, comp = null;
            try { due = r.dueDate(); } catch (_) {}
            try { rmd = r.remindMeDate(); } catch (_) {}
            try { comp = r.completionDate(); } catch (_) {}
            out.push({
              id: r.id(),
              name: r.name() || "",
              body: r.body() || null,
              completed,
              completionDate: comp ? comp.toISOString() : null,
              dueDate: due ? due.toISOString() : null,
              remindMeDate: rmd ? rmd.toISOString() : null,
              priority: r.priority() || 0,
              flagged: !!r.flagged(),
              listName: list.name(),
            });
          }
        }
        return out;
      `,
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
/* apple_create_reminder                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

const CreateReminderInput = z
  .object({
    list_name: z
      .string()
      .min(1)
      .describe("Target list. Use apple_list_reminder_lists to discover names."),
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
      .describe(
        "0 = none, 1 = high, 5 = medium, 9 = low (Apple's numbering).",
      ),
    flagged: z.boolean().optional(),
    response_format: responseFormatField,
  })
  .strict();

async function createReminder(params: z.infer<typeof CreateReminderInput>) {
  try {
    const result = await runJxa<{ id: string }>({
      args: {
        listName: params.list_name,
        name: params.name,
        body: params.body ?? null,
        dueIso: params.due_date ?? null,
        remindIso: params.remind_me_date ?? null,
        priority: params.priority ?? null,
        flagged: params.flagged ?? null,
      },
      script: `
        const Reminders = Application('Reminders');
        const lists = Reminders.lists.whose({ name: INPUT.listName })();
        if (lists.length === 0) {
          throw new Error("Reminder list not found: " + INPUT.listName);
        }
        const list = lists[0];

        const props = { name: INPUT.name };
        if (INPUT.body) props.body = INPUT.body;
        if (INPUT.dueIso) props.dueDate = new Date(INPUT.dueIso);
        if (INPUT.remindIso) props.remindMeDate = new Date(INPUT.remindIso);
        if (INPUT.priority !== null) props.priority = INPUT.priority;
        if (INPUT.flagged !== null) props.flagged = INPUT.flagged;

        const r = Reminders.Reminder(props);
        list.reminders.push(r);
        return { id: r.id() };
      `,
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
/* apple_update_reminder                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

const UpdateReminderInput = z
  .object({
    reminder_id: z.string().min(1).describe("The reminder's id."),
    name: z.string().min(1).max(500).optional(),
    body: z.string().max(5000).optional(),
    due_date: optionalIsoDateField,
    remind_me_date: optionalIsoDateField,
    priority: z.number().int().min(0).max(9).optional(),
    flagged: z.boolean().optional(),
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
    params.flagged,
  ].some((x) => x !== undefined);
  if (!hasUpdate) {
    return errorResult(
      new Error("At least one field besides reminder_id must be provided."),
    );
  }
  try {
    const ok = await runJxa<{ updated: boolean }>({
      args: {
        reminderId: params.reminder_id,
        name: params.name ?? null,
        body: params.body ?? null,
        dueIso: params.due_date ?? null,
        remindIso: params.remind_me_date ?? null,
        priority: params.priority ?? null,
        flagged: params.flagged ?? null,
      },
      script: `
        const Reminders = Application('Reminders');
        const lists = Reminders.lists();
        for (let i = 0; i < lists.length; i++) {
          const rems = lists[i].reminders.whose({ id: INPUT.reminderId })();
          if (rems.length > 0) {
            const r = rems[0];
            if (INPUT.name !== null) r.name = INPUT.name;
            if (INPUT.body !== null) r.body = INPUT.body;
            if (INPUT.dueIso !== null) r.dueDate = new Date(INPUT.dueIso);
            if (INPUT.remindIso !== null) r.remindMeDate = new Date(INPUT.remindIso);
            if (INPUT.priority !== null) r.priority = INPUT.priority;
            if (INPUT.flagged !== null) r.flagged = INPUT.flagged;
            return { updated: true };
          }
        }
        throw new Error("Reminder not found: " + INPUT.reminderId);
      `,
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
/* apple_complete_reminder                                                  */
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
    const ok = await runJxa<{ completed: boolean }>({
      args: {
        reminderId: params.reminder_id,
        completed: params.completed,
      },
      script: `
        const Reminders = Application('Reminders');
        const lists = Reminders.lists();
        for (let i = 0; i < lists.length; i++) {
          const rems = lists[i].reminders.whose({ id: INPUT.reminderId })();
          if (rems.length > 0) {
            rems[0].completed = INPUT.completed;
            return { completed: INPUT.completed };
          }
        }
        throw new Error("Reminder not found: " + INPUT.reminderId);
      `,
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
/* apple_delete_reminder                                                    */
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
    const ok = await runJxa<{ deleted: boolean }>({
      args: { reminderId: params.reminder_id },
      script: `
        const Reminders = Application('Reminders');
        const lists = Reminders.lists();
        for (let i = 0; i < lists.length; i++) {
          const rems = lists[i].reminders.whose({ id: INPUT.reminderId })();
          if (rems.length > 0) {
            Reminders.delete(rems[0]);
            return { deleted: true };
          }
        }
        throw new Error("Reminder not found: " + INPUT.reminderId);
      `,
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
/* apple_create_reminder_list                                               */
/* ──────────────────────────────────────────────────────────────────────── */

const CreateListInput = z
  .object({
    name: z.string().min(1).max(200).describe("Name for the new list."),
    response_format: responseFormatField,
  })
  .strict();

async function createList(params: z.infer<typeof CreateListInput>) {
  try {
    const result = await runJxa<{ id: string }>({
      args: { name: params.name },
      script: `
        const Reminders = Application('Reminders');
        const list = Reminders.List({ name: INPUT.name });
        Reminders.lists.push(list);
        return { id: list.id() };
      `,
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

export function registerReminderTools(server: McpServer) {
  server.registerTool(
    "apple_list_reminder_lists",
    {
      title: "List Reminder Lists",
      description:
        "List every reminder list in Reminders.app (across all configured accounts: local, iCloud, Exchange). Returns each list's id and name. Use this first to discover the `list_name` values that other Reminders tools accept.",
      inputSchema: ListListsInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    listLists,
  );

  server.registerTool(
    "apple_list_reminders",
    {
      title: "List Reminders",
      description:
        "List reminders, optionally filtered to one list, by completion state, and by due-date range. Returns id, name, body, completed flag, completion/due/remind-me dates, priority (0-9), flagged flag, and list name. Set include_completed=true to also return completed items.",
      inputSchema: ListRemindersInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    listReminders,
  );

  server.registerTool(
    "apple_search_reminders",
    {
      title: "Search Reminders",
      description:
        "Case-insensitive substring search against reminder name and body. Optionally narrow by list or include completed items.",
      inputSchema: SearchRemindersInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    searchReminders,
  );

  server.registerTool(
    "apple_create_reminder",
    {
      title: "Create Reminder",
      description:
        "Create a new reminder in the named list. Required: list_name, name. Optionally set body, due_date, remind_me_date, priority (0/1/5/9), or flagged. Returns the new reminder's id.",
      inputSchema: CreateReminderInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    createReminder,
  );

  server.registerTool(
    "apple_update_reminder",
    {
      title: "Update Reminder",
      description:
        "Update one or more fields of an existing reminder. Only fields you supply are changed.",
      inputSchema: UpdateReminderInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    updateReminder,
  );

  server.registerTool(
    "apple_complete_reminder",
    {
      title: "Complete/Re-open Reminder",
      description:
        "Toggle a reminder's completed state. Pass completed=false to re-open a completed reminder.",
      inputSchema: CompleteReminderInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    completeReminder,
  );

  server.registerTool(
    "apple_delete_reminder",
    {
      title: "Delete Reminder",
      description:
        "Permanently delete a reminder. This cannot be undone. Pass the reminder's id. You MUST pass confirm=true to acknowledge.",
      inputSchema: DeleteReminderInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    deleteReminder,
  );

  server.registerTool(
    "apple_create_reminder_list",
    {
      title: "Create Reminder List",
      description:
        "Create a new reminder list. The list is created in the default account.",
      inputSchema: CreateListInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    createList,
  );
}
