/**
 * Calendar.app tools — backed by EventKit (see services/eventkit.ts).
 *
 * Reads and writes both go through the native EventKit framework so that the
 * event identifiers we return are the same ids the update/delete commands
 * accept, and so date-range queries are fast instead of timing out.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  isoDateField,
  limitField,
  optionalIsoDateField,
  responseFormatField,
} from "../schemas/common.js";
import { buildResult, clip, errorResult, humanDate } from "../services/format.js";
import { runHelper, isoDaysFromNow } from "../services/eventkit.js";
import { consolidatedShape, parseAction } from "./dispatch.js";

/* ──────────────────────────────────────────────────────────────────────── */
/* Types returned from the EventKit helper                                  */
/* ──────────────────────────────────────────────────────────────────────── */

interface RawCalendar {
  id: string;
  name: string;
  description: string | null;
  writable: boolean;
  color: string | null;
}

interface RawEvent {
  id: string;
  summary: string;
  startDate: string | null;
  endDate: string | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
  calendarName: string;
  url: string | null;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* list_calendars                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const ListCalendarsInput = z
  .object({
    response_format: responseFormatField,
  })
  .strict();

async function listCalendars(params: z.infer<typeof ListCalendarsInput>) {
  try {
    const cals = await runHelper<RawCalendar[]>("list-calendars");
    const structured = { count: cals.length, calendars: cals };
    const md = [
      `# Calendars (${cals.length})`,
      "",
      ...cals.map(
        (c) =>
          `- **${c.name}**${c.writable ? "" : " _(read-only)_"} — id: \`${c.id}\``,
      ),
    ].join("\n");
    return buildResult(params.response_format, md, structured);
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* list_events                                                        */
/* ──────────────────────────────────────────────────────────────────────── */

const ListEventsInput = z
  .object({
    start_date: isoDateField.describe(
      "Inclusive start of the date range to fetch events from.",
    ),
    end_date: isoDateField.describe(
      "Exclusive end of the date range to fetch events from.",
    ),
    calendar_name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional. Limit results to one calendar. Use action 'list_calendars' to find names.",
      ),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

async function listEvents(params: z.infer<typeof ListEventsInput>) {
  try {
    const events = await runHelper<RawEvent[]>("list-events", {
      startIso: params.start_date,
      endIso: params.end_date,
      calendarName: params.calendar_name ?? null,
      limit: params.limit,
    });

    const structured = {
      count: events.length,
      start_date: params.start_date,
      end_date: params.end_date,
      calendar_name: params.calendar_name ?? null,
      events,
    };
    const md = [
      `# Events ${params.start_date} → ${params.end_date}` +
        (params.calendar_name ? ` in \`${params.calendar_name}\`` : ""),
      "",
      events.length === 0
        ? "_No events found in this range._"
        : events
            .map(
              (e) =>
                `- **${humanDate(e.startDate)}** — ${e.summary}` +
                (e.location ? ` _@${clip(e.location, 40)}_` : "") +
                ` _(${e.calendarName})_ — id: \`${e.id}\``,
            )
            .join("\n"),
    ].join("\n");
    return buildResult(params.response_format, md, structured);
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* search_events                                                      */
/* ──────────────────────────────────────────────────────────────────────── */

const SearchEventsInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Text to search for in event summary, location, or description (case-insensitive substring match).",
      ),
    start_date: optionalIsoDateField.describe(
      "Optional. Narrow the search to events starting on/after this date. Defaults to one year ago.",
    ),
    end_date: optionalIsoDateField.describe(
      "Optional. Narrow the search to events starting before this date. Defaults to one year ahead.",
    ),
    calendar_name: z.string().min(1).optional(),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

async function searchEvents(params: z.infer<typeof SearchEventsInput>) {
  try {
    // EventKit requires a bounded window; default to ±1 year when unspecified.
    const start = params.start_date ?? isoDaysFromNow(-365);
    const end = params.end_date ?? isoDaysFromNow(365);
    const all = await runHelper<RawEvent[]>("list-events", {
      startIso: start,
      endIso: end,
      calendarName: params.calendar_name ?? null,
      limit: 5000,
    });
    const q = params.query.toLowerCase();
    const events = all
      .filter(
        (e) =>
          (e.summary || "").toLowerCase().includes(q) ||
          (e.location || "").toLowerCase().includes(q) ||
          (e.description || "").toLowerCase().includes(q),
      )
      .slice(0, params.limit);

    const structured = { query: params.query, count: events.length, events };
    const md = [
      `# Event search: \`${params.query}\` (${events.length} results)`,
      "",
      ...events.map(
        (e) =>
          `- **${humanDate(e.startDate)}** — ${e.summary} _(${e.calendarName})_ — id: \`${e.id}\``,
      ),
    ].join("\n");
    return buildResult(params.response_format, md, structured);
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* get_event                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

const GetEventInput = z
  .object({
    event_id: z
      .string()
      .min(1)
      .describe("The event's identifier (returned by other Calendar tools)."),
    response_format: responseFormatField,
  })
  .strict();

async function getEvent(params: z.infer<typeof GetEventInput>) {
  try {
    const event = await runHelper<RawEvent | null>("get-event", {
      id: params.event_id,
    });
    if (!event) {
      return errorResult(
        new Error(`No event found with id '${params.event_id}'`),
        "Use action 'list_events' or 'search_events' to discover valid IDs.",
      );
    }
    const md = [
      `# ${event.summary}`,
      "",
      `- **Calendar**: ${event.calendarName}`,
      `- **Start**: ${humanDate(event.startDate)}`,
      `- **End**: ${humanDate(event.endDate)}`,
      `- **All-day**: ${event.allDay ? "yes" : "no"}`,
      event.location ? `- **Location**: ${event.location}` : null,
      event.url ? `- **URL**: ${event.url}` : null,
      event.description ? `\n${event.description}` : null,
      `\nid: \`${event.id}\``,
    ]
      .filter(Boolean)
      .join("\n");
    return buildResult(params.response_format, md, event);
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* create_event                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

const CreateEventInput = z
  .object({
    calendar_name: z
      .string()
      .min(1)
      .describe(
        "The calendar to add the event to. Use action 'list_calendars' to discover names.",
      ),
    summary: z.string().min(1).max(500).describe("Event title."),
    start_date: isoDateField,
    end_date: isoDateField,
    all_day: z
      .boolean()
      .default(false)
      .describe("If true, treat the event as all-day."),
    location: z.string().max(500).optional(),
    description: z.string().max(5000).optional().describe("Notes / details."),
    url: z.string().url().optional(),
    response_format: responseFormatField,
  })
  .strict();

async function createEvent(params: z.infer<typeof CreateEventInput>) {
  try {
    const result = await runHelper<{ id: string }>("create-event", {
      calendarName: params.calendar_name,
      summary: params.summary,
      startIso: params.start_date,
      endIso: params.end_date,
      allDay: params.all_day,
      location: params.location ?? null,
      description: params.description ?? null,
      url: params.url ?? null,
    });
    const structured = { created: true, id: result.id, ...params };
    const md =
      `Created event **${params.summary}** in **${params.calendar_name}**\n\n` +
      `- Start: ${humanDate(params.start_date)}\n` +
      `- End: ${humanDate(params.end_date)}\n` +
      `- id: \`${result.id}\``;
    return buildResult(params.response_format, md, structured);
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* update_event                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

const UpdateEventInput = z
  .object({
    event_id: z.string().min(1).describe("The event identifier to update."),
    summary: z.string().min(1).max(500).optional(),
    start_date: optionalIsoDateField,
    end_date: optionalIsoDateField,
    all_day: z.boolean().optional(),
    location: z.string().max(500).optional(),
    description: z.string().max(5000).optional(),
    url: z.string().url().optional(),
    response_format: responseFormatField,
  })
  .strict();

async function updateEvent(params: z.infer<typeof UpdateEventInput>) {
  const hasUpdate = [
    params.summary,
    params.start_date,
    params.end_date,
    params.all_day,
    params.location,
    params.description,
    params.url,
  ].some((x) => x !== undefined);
  if (!hasUpdate) {
    return errorResult(
      new Error("At least one field besides event_id must be provided."),
      "Pass summary, start_date, end_date, all_day, location, description, or url.",
    );
  }
  try {
    const ok = await runHelper<{ updated: boolean }>("update-event", {
      id: params.event_id,
      summary: params.summary ?? null,
      startIso: params.start_date ?? null,
      endIso: params.end_date ?? null,
      allDay: params.all_day ?? null,
      location: params.location ?? null,
      description: params.description ?? null,
      url: params.url ?? null,
    });
    return buildResult(
      params.response_format,
      `Updated event \`${params.event_id}\``,
      { updated: ok.updated, id: params.event_id, ...params },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* delete_event                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

const DeleteEventInput = z
  .object({
    event_id: z.string().min(1),
    confirm: z
      .literal(true)
      .describe(
        "Required acknowledgement that the deletion is permanent. Must be true.",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function deleteEvent(params: z.infer<typeof DeleteEventInput>) {
  try {
    const ok = await runHelper<{ deleted: boolean }>("delete-event", {
      id: params.event_id,
    });
    return buildResult(
      params.response_format,
      `Deleted event \`${params.event_id}\``,
      { deleted: ok.deleted, id: params.event_id },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Registration                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

const calendarAction = z
  .enum([
    "list_calendars",
    "list_events",
    "search_events",
    "get_event",
    "create_event",
    "update_event",
    "delete_event",
  ])
  .describe(
    [
      "Which Calendar operation to perform. Required fields per action:",
      "• list_calendars — (no other fields)",
      "• list_events — start_date, end_date; optional calendar_name, limit",
      "• search_events — query; optional start_date, end_date, calendar_name, limit",
      "• get_event — event_id",
      "• create_event — calendar_name, summary, start_date, end_date; optional all_day, location, description, url",
      "• update_event — event_id + at least one of summary/start_date/end_date/all_day/location/description/url",
      "• delete_event — event_id, confirm=true",
    ].join("\n"),
  );

const CalendarToolInput = z.object(
  consolidatedShape(calendarAction, [
    ListCalendarsInput,
    ListEventsInput,
    SearchEventsInput,
    GetEventInput,
    CreateEventInput,
    UpdateEventInput,
    DeleteEventInput,
  ]),
);

async function dispatchCalendar(raw: z.infer<typeof CalendarToolInput>) {
  try {
    switch (raw.action) {
      case "list_calendars":
        return await listCalendars(parseAction(ListCalendarsInput, raw));
      case "list_events":
        return await listEvents(parseAction(ListEventsInput, raw));
      case "search_events":
        return await searchEvents(parseAction(SearchEventsInput, raw));
      case "get_event":
        return await getEvent(parseAction(GetEventInput, raw));
      case "create_event":
        return await createEvent(parseAction(CreateEventInput, raw));
      case "update_event":
        return await updateEvent(parseAction(UpdateEventInput, raw));
      case "delete_event":
        return await deleteEvent(parseAction(DeleteEventInput, raw));
      default:
        return errorResult(
          new Error(`Unknown calendar action: ${String(raw.action)}`),
        );
    }
  } catch (e) {
    return errorResult(e);
  }
}

export function registerCalendarTools(server: McpServer) {
  server.registerTool(
    "calendar",
    {
      title: "Calendar",
      description:
        "Read and manage Calendar.app events. Pick an operation with `action`: " +
        "list_calendars, list_events, search_events, get_event, create_event, " +
        "update_event, delete_event. See the `action` field for the parameters " +
        "each operation needs. Destructive actions (delete_event) require confirm=true.",
      inputSchema: CalendarToolInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    dispatchCalendar,
  );
}
