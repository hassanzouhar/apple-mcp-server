/**
 * Calendar.app tools.
 *
 * All operations go through JXA (Application('Calendar')). We try to keep each
 * JXA script as small and side-effect-aware as possible, and we always return
 * structured data that we can re-shape into Markdown server-side.
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
  clip,
  errorResult,
  humanDate,
} from "../services/format.js";
import { runJxa } from "../services/osascript.js";

/* ──────────────────────────────────────────────────────────────────────── */
/* Types returned from JXA scripts                                          */
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
/* apple_list_calendars                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const ListCalendarsInput = z
  .object({
    response_format: responseFormatField,
  })
  .strict();

async function listCalendars(params: z.infer<typeof ListCalendarsInput>) {
  try {
    const cals = await runJxa<RawCalendar[]>({
      script: `
        const Calendar = Application('Calendar');
        const out = [];
        const all = Calendar.calendars();
        for (let i = 0; i < all.length; i++) {
          const c = all[i];
          let color = null;
          try { color = c.color(); } catch (_) {}
          let description = null;
          try { description = c.description(); } catch (_) {}
          let writable = true;
          try { writable = c.writable(); } catch (_) {}
          out.push({
            id: c.uid(),
            name: c.name(),
            description: description || null,
            writable: !!writable,
            color: color || null,
          });
        }
        return out;
      `,
    });

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
/* apple_list_events                                                        */
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
        "Optional. Limit results to one calendar. Use apple_list_calendars to find names.",
      ),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

async function listEvents(params: z.infer<typeof ListEventsInput>) {
  try {
    const events = await runJxa<RawEvent[]>({
      args: {
        startIso: params.start_date,
        endIso: params.end_date,
        calendarName: params.calendar_name ?? null,
        limit: params.limit,
      },
      // Calendar's whose() over events is unreliable across versions, so we
      // iterate calendars and filter by start date in JS. We bail out as soon
      // as we hit the limit. We DO use whose() to narrow per-calendar to a
      // reasonable window first.
      script: `
        const Calendar = Application('Calendar');
        const start = new Date(INPUT.startIso);
        const end = new Date(INPUT.endIso);
        const wantName = INPUT.calendarName;
        const limit = INPUT.limit;

        const cals = Calendar.calendars();
        const matchingCals = wantName
          ? cals.filter(c => c.name() === wantName)
          : cals;
        if (wantName && matchingCals.length === 0) {
          throw new Error("Calendar not found: " + wantName);
        }

        const out = [];
        for (let i = 0; i < matchingCals.length && out.length < limit; i++) {
          const cal = matchingCals[i];
          let evs;
          try {
            evs = cal.events.whose({
              _and: [
                { startDate: { _greaterThan: start } },
                { startDate: { _lessThan: end } },
              ],
            })();
          } catch (e) {
            // Some calendars (e.g. read-only subscriptions) reject whose().
            // Fall back to scanning all events.
            evs = cal.events();
          }
          for (let j = 0; j < evs.length && out.length < limit; j++) {
            const ev = evs[j];
            let sd = null, ed = null;
            try { sd = ev.startDate(); } catch (_) {}
            try { ed = ev.endDate(); } catch (_) {}
            if (sd && (sd < start || sd >= end)) continue;
            out.push({
              id: ev.uid(),
              summary: ev.summary() || "",
              startDate: sd ? sd.toISOString() : null,
              endDate: ed ? ed.toISOString() : null,
              allDay: !!ev.alldayEvent(),
              location: ev.location() || null,
              description: ev.description() || null,
              calendarName: cal.name(),
              url: ev.url() || null,
            });
          }
        }

        out.sort((a, b) => {
          const ax = a.startDate || "";
          const bx = b.startDate || "";
          return ax < bx ? -1 : ax > bx ? 1 : 0;
        });
        return out;
      `,
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
/* apple_search_events                                                      */
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
      "Optional. Narrow the search to events starting on/after this date.",
    ),
    end_date: optionalIsoDateField.describe(
      "Optional. Narrow the search to events starting before this date.",
    ),
    calendar_name: z.string().min(1).optional(),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

async function searchEvents(params: z.infer<typeof SearchEventsInput>) {
  try {
    const events = await runJxa<RawEvent[]>({
      args: {
        query: params.query.toLowerCase(),
        startIso: params.start_date ?? null,
        endIso: params.end_date ?? null,
        calendarName: params.calendar_name ?? null,
        limit: params.limit,
      },
      script: `
        const Calendar = Application('Calendar');
        const q = INPUT.query;
        const start = INPUT.startIso ? new Date(INPUT.startIso) : null;
        const end = INPUT.endIso ? new Date(INPUT.endIso) : null;
        const wantName = INPUT.calendarName;
        const limit = INPUT.limit;

        const cals = Calendar.calendars();
        const matchingCals = wantName
          ? cals.filter(c => c.name() === wantName)
          : cals;

        const out = [];
        for (let i = 0; i < matchingCals.length && out.length < limit; i++) {
          const cal = matchingCals[i];
          let evs;
          try {
            if (start && end) {
              evs = cal.events.whose({
                _and: [
                  { startDate: { _greaterThan: start } },
                  { startDate: { _lessThan: end } },
                ],
              })();
            } else {
              evs = cal.events();
            }
          } catch (_) {
            evs = cal.events();
          }
          for (let j = 0; j < evs.length && out.length < limit; j++) {
            const ev = evs[j];
            const summary = (ev.summary() || "").toLowerCase();
            const location = (ev.location() || "").toLowerCase();
            const description = (ev.description() || "").toLowerCase();
            if (
              !summary.includes(q) &&
              !location.includes(q) &&
              !description.includes(q)
            ) continue;
            let sd = null, ed = null;
            try { sd = ev.startDate(); } catch (_) {}
            try { ed = ev.endDate(); } catch (_) {}
            if (start && sd && sd < start) continue;
            if (end && sd && sd >= end) continue;
            out.push({
              id: ev.uid(),
              summary: ev.summary() || "",
              startDate: sd ? sd.toISOString() : null,
              endDate: ed ? ed.toISOString() : null,
              allDay: !!ev.alldayEvent(),
              location: ev.location() || null,
              description: ev.description() || null,
              calendarName: cal.name(),
              url: ev.url() || null,
            });
          }
        }
        out.sort((a, b) => (a.startDate || "") < (b.startDate || "") ? -1 : 1);
        return out;
      `,
    });

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
/* apple_get_event                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

const GetEventInput = z
  .object({
    event_id: z
      .string()
      .min(1)
      .describe("The event's UID (returned by other Calendar tools)."),
    response_format: responseFormatField,
  })
  .strict();

async function getEvent(params: z.infer<typeof GetEventInput>) {
  try {
    const event = await runJxa<RawEvent | null>({
      args: { eventId: params.event_id },
      script: `
        const Calendar = Application('Calendar');
        const id = INPUT.eventId;
        const cals = Calendar.calendars();
        for (let i = 0; i < cals.length; i++) {
          const cal = cals[i];
          let evs;
          try { evs = cal.events.whose({ uid: id })(); } catch (_) { evs = []; }
          if (evs && evs.length > 0) {
            const ev = evs[0];
            let sd = null, ed = null;
            try { sd = ev.startDate(); } catch (_) {}
            try { ed = ev.endDate(); } catch (_) {}
            return {
              id: ev.uid(),
              summary: ev.summary() || "",
              startDate: sd ? sd.toISOString() : null,
              endDate: ed ? ed.toISOString() : null,
              allDay: !!ev.alldayEvent(),
              location: ev.location() || null,
              description: ev.description() || null,
              calendarName: cal.name(),
              url: ev.url() || null,
            };
          }
        }
        return null;
      `,
    });

    if (!event) {
      return errorResult(
        new Error(`No event found with id '${params.event_id}'`),
        "Use apple_list_events or apple_search_events to discover valid IDs.",
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
/* apple_create_event                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

const CreateEventInput = z
  .object({
    calendar_name: z
      .string()
      .min(1)
      .describe(
        "The calendar to add the event to. Use apple_list_calendars to discover names.",
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
    const result = await runJxa<{ id: string }>({
      args: {
        calendarName: params.calendar_name,
        summary: params.summary,
        startIso: params.start_date,
        endIso: params.end_date,
        allDay: params.all_day,
        location: params.location ?? null,
        description: params.description ?? null,
        url: params.url ?? null,
      },
      script: `
        const Calendar = Application('Calendar');
        const cals = Calendar.calendars.whose({ name: INPUT.calendarName })();
        if (cals.length === 0) {
          throw new Error("Calendar not found: " + INPUT.calendarName);
        }
        const cal = cals[0];

        const props = {
          summary: INPUT.summary,
          startDate: new Date(INPUT.startIso),
          endDate: new Date(INPUT.endIso),
          alldayEvent: !!INPUT.allDay,
        };
        if (INPUT.location) props.location = INPUT.location;
        if (INPUT.description) props.description = INPUT.description;
        if (INPUT.url) props.url = INPUT.url;

        const ev = Calendar.Event(props);
        cal.events.push(ev);
        return { id: ev.uid() };
      `,
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
/* apple_update_event                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

const UpdateEventInput = z
  .object({
    event_id: z.string().min(1).describe("The event UID to update."),
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
    const ok = await runJxa<{ updated: boolean }>({
      args: {
        eventId: params.event_id,
        summary: params.summary ?? null,
        startIso: params.start_date ?? null,
        endIso: params.end_date ?? null,
        allDay: params.all_day ?? null,
        location: params.location ?? null,
        description: params.description ?? null,
        url: params.url ?? null,
      },
      script: `
        const Calendar = Application('Calendar');
        const cals = Calendar.calendars();
        for (let i = 0; i < cals.length; i++) {
          const cal = cals[i];
          let evs;
          try { evs = cal.events.whose({ uid: INPUT.eventId })(); } catch (_) { evs = []; }
          if (evs.length > 0) {
            const ev = evs[0];
            if (INPUT.summary !== null) ev.summary = INPUT.summary;
            if (INPUT.startIso !== null) ev.startDate = new Date(INPUT.startIso);
            if (INPUT.endIso !== null) ev.endDate = new Date(INPUT.endIso);
            if (INPUT.allDay !== null) ev.alldayEvent = !!INPUT.allDay;
            if (INPUT.location !== null) ev.location = INPUT.location;
            if (INPUT.description !== null) ev.description = INPUT.description;
            if (INPUT.url !== null) ev.url = INPUT.url;
            return { updated: true };
          }
        }
        throw new Error("Event not found: " + INPUT.eventId);
      `,
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
/* apple_delete_event                                                       */
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
    const ok = await runJxa<{ deleted: boolean }>({
      args: { eventId: params.event_id },
      script: `
        const Calendar = Application('Calendar');
        const cals = Calendar.calendars();
        for (let i = 0; i < cals.length; i++) {
          const cal = cals[i];
          let evs;
          try { evs = cal.events.whose({ uid: INPUT.eventId })(); } catch (_) { evs = []; }
          if (evs.length > 0) {
            Calendar.delete(evs[0]);
            return { deleted: true };
          }
        }
        throw new Error("Event not found: " + INPUT.eventId);
      `,
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

export function registerCalendarTools(server: McpServer) {
  server.registerTool(
    "apple_list_calendars",
    {
      title: "List Calendars",
      description:
        "List every calendar configured in Calendar.app (local, iCloud, Google, Exchange, subscriptions). Returns each calendar's name, UID, writable flag, and color. Use this first to discover the `calendar_name` values that other tools accept.",
      inputSchema: ListCalendarsInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    listCalendars,
  );

  server.registerTool(
    "apple_list_events",
    {
      title: "List Calendar Events",
      description:
        "List Calendar.app events that start within a date range, optionally filtered to a single calendar. Returns id, summary, start/end ISO timestamps, all-day flag, location, description, calendar name, and URL. Date range is half-open: events with start ≥ start_date and start < end_date are returned. Use apple_get_event to fetch a single event by id.",
      inputSchema: ListEventsInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    listEvents,
  );

  server.registerTool(
    "apple_search_events",
    {
      title: "Search Calendar Events",
      description:
        "Case-insensitive substring search across event summary, location, and description. Optionally narrow by date range and/or calendar. Results are capped by `limit` for performance — refine your query if you hit the cap.",
      inputSchema: SearchEventsInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    searchEvents,
  );

  server.registerTool(
    "apple_get_event",
    {
      title: "Get Calendar Event",
      description:
        "Fetch a single event by its UID. The UID is the `id` field returned by apple_list_events / apple_search_events.",
      inputSchema: GetEventInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    getEvent,
  );

  server.registerTool(
    "apple_create_event",
    {
      title: "Create Calendar Event",
      description:
        "Create a new event in the named calendar. Required: calendar_name, summary, start_date, end_date. For an all-day event set all_day=true and use date-only ISO strings (YYYY-MM-DD). Returns the new event's UID.",
      inputSchema: CreateEventInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    createEvent,
  );

  server.registerTool(
    "apple_update_event",
    {
      title: "Update Calendar Event",
      description:
        "Update one or more fields of an existing event. Only the fields you supply are changed. The event_id is the UID returned by other Calendar tools.",
      inputSchema: UpdateEventInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    updateEvent,
  );

  server.registerTool(
    "apple_delete_event",
    {
      title: "Delete Calendar Event",
      description:
        "Permanently delete an event. This cannot be undone. Pass the event's UID. You MUST pass confirm=true to acknowledge.",
      inputSchema: DeleteEventInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    deleteEvent,
  );
}
