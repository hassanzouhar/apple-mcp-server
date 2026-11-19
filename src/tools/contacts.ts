/**
 * Contacts.app tools.
 *
 * Uses Application('Contacts') via JXA. Properties available on each person:
 *   id (vCard UID), name, first name, last name, organization, job title,
 *   emails (list with label/value), phones (list with label/value),
 *   addresses (list), birth date, note.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { limitField, responseFormatField } from "../schemas/common.js";
import {
  buildResult,
  errorResult,
  humanDate,
} from "../services/format.js";
import { runJxa } from "../services/osascript.js";
import { consolidatedShape, parseAction } from "./dispatch.js";

/* ──────────────────────────────────────────────────────────────────────── */
/* Types                                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

interface RawEmail {
  label: string | null;
  value: string;
}
interface RawPhone {
  label: string | null;
  value: string;
}
interface RawAddress {
  label: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
}
interface RawContact {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  jobTitle: string | null;
  emails: RawEmail[];
  phones: RawPhone[];
  addresses: RawAddress[];
  birthDate: string | null;
  note: string | null;
}

/** JXA `serializePerson(p)`: builds a RawContact, tolerating unreadable fields. */
const SERIALIZE_PERSON_JXA = `
  function serializePerson(p) {
    const field = (read) => { try { return read() || null; } catch (_) { return null; } };
    const labelled = (read) => {
      let items = [];
      try { items = read(); } catch (_) {}
      return items.map(e => {
        try { return { label: e.label() || null, value: e.value() || "" }; }
        catch (_) { return { label: null, value: "" }; }
      });
    };
    let addresses = [];
    try {
      addresses = p.addresses().map(a => ({
        label: field(() => a.label()),
        street: field(() => a.street()),
        city: field(() => a.city()),
        state: field(() => a.state()),
        zip: field(() => a.zip()),
        country: field(() => a.country()),
      }));
    } catch (_) {}
    let birthDate = null;
    try { const b = p.birthDate(); birthDate = b ? b.toISOString() : null; } catch (_) {}
    return {
      id: p.id(),
      name: p.name() || "",
      firstName: p.firstName() || null,
      lastName: p.lastName() || null,
      organization: p.organization() || null,
      jobTitle: p.jobTitle() || null,
      emails: labelled(() => p.emails()),
      phones: labelled(() => p.phones()),
      addresses,
      birthDate,
      note: p.note() || null,
    };
  }
`;

/* ──────────────────────────────────────────────────────────────────────── */
/* search_contacts                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

const SearchContactsInput = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Case-insensitive substring match against name, organization, email, or phone.",
      ),
    limit: limitField,
    response_format: responseFormatField,
  })
  .strict();

async function searchContacts(params: z.infer<typeof SearchContactsInput>) {
  try {
    const contacts = await runJxa<RawContact[]>({
      args: { query: params.query.toLowerCase(), limit: params.limit },
      script: `
        ${SERIALIZE_PERSON_JXA}
        const Contacts = Application('Contacts');
        // Bulk fetch: one Apple Event per field instead of several per contact.
        const q = INPUT.query;
        const lc = (v) => (v === null || v === undefined) ? "" : String(v).toLowerCase();
        const names = Contacts.people.name();
        let orgs = [];
        try { orgs = Contacts.people.organization(); } catch (_) {}
        let allEmails = [];
        try { allEmails = Contacts.people.emails.value(); } catch (_) {}
        let allPhones = [];
        try { allPhones = Contacts.people.phones.value(); } catch (_) {}
        const hits = [];
        for (let i = 0; i < names.length && hits.length < INPUT.limit; i++) {
          if (lc(names[i]).includes(q) || lc(orgs[i]).includes(q)
            || (allEmails[i] || []).some(v => lc(v).includes(q))
            || (allPhones[i] || []).some(v => lc(v).includes(q))) hits.push(i);
        }
        const out = [];
        for (const i of hits) {
          out.push(serializePerson(Contacts.people[i]));
        }
        return out;
      `,
    });

    const md = [
      `# Contact search: \`${params.query}\` (${contacts.length})`,
      "",
      ...contacts.map((c) => formatContactBullet(c)),
    ].join("\n");
    return buildResult(params.response_format, md, {
      query: params.query,
      count: contacts.length,
      contacts,
    });
  } catch (e) {
    return errorResult(e);
  }
}

function formatContactBullet(c: RawContact): string {
  const emails = c.emails.map((e) => e.value).filter(Boolean).join(", ");
  const phones = c.phones.map((p) => p.value).filter(Boolean).join(", ");
  const extras: string[] = [];
  if (c.organization) extras.push(c.organization);
  if (emails) extras.push(emails);
  if (phones) extras.push(phones);
  const extra = extras.length ? ` — ${extras.join(" · ")}` : "";
  return `- **${c.name || "(no name)"}**${extra} — id: \`${c.id}\``;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* get_contact                                                        */
/* ──────────────────────────────────────────────────────────────────────── */

const GetContactInput = z
  .object({
    contact_id: z.string().min(1).describe("The contact's vCard UID."),
    response_format: responseFormatField,
  })
  .strict();

async function getContact(params: z.infer<typeof GetContactInput>) {
  try {
    const contact = await runJxa<RawContact | null>({
      args: { contactId: params.contact_id },
      script: `
        ${SERIALIZE_PERSON_JXA}
        const Contacts = Application('Contacts');
        const matches = Contacts.people.whose({ id: INPUT.contactId })();
        if (matches.length === 0) return null;
        return serializePerson(matches[0]);
      `,
    });

    if (!contact) {
      return errorResult(
        new Error(`No contact found with id '${params.contact_id}'`),
        "Use action 'search' to discover valid IDs.",
      );
    }

    const lines: string[] = [`# ${contact.name || "(no name)"}`];
    if (contact.organization) lines.push(`**${contact.organization}**${contact.jobTitle ? ` — ${contact.jobTitle}` : ""}`);
    if (contact.emails.length) {
      lines.push("", "**Emails**");
      for (const e of contact.emails)
        lines.push(`- ${e.label ?? "—"}: ${e.value}`);
    }
    if (contact.phones.length) {
      lines.push("", "**Phones**");
      for (const p of contact.phones)
        lines.push(`- ${p.label ?? "—"}: ${p.value}`);
    }
    if (contact.addresses.length) {
      lines.push("", "**Addresses**");
      for (const a of contact.addresses) {
        const parts = [a.street, a.city, a.state, a.zip, a.country]
          .filter(Boolean)
          .join(", ");
        lines.push(`- ${a.label ?? "—"}: ${parts || "(empty)"}`);
      }
    }
    if (contact.birthDate)
      lines.push("", `**Birthday**: ${humanDate(contact.birthDate)}`);
    if (contact.note) lines.push("", contact.note);
    lines.push("", `id: \`${contact.id}\``);
    return buildResult(params.response_format, lines.join("\n"), contact);
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* create_contact                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const EmailEntrySchema = z
  .object({
    label: z
      .string()
      .optional()
      .describe("Label such as 'work' or 'home'. Defaults to 'work'."),
    value: z.string().email().describe("Email address."),
  })
  .strict();

const PhoneEntrySchema = z
  .object({
    label: z.string().optional(),
    value: z.string().min(1),
  })
  .strict();

const CreateContactInput = z
  .object({
    first_name: z.string().min(1).max(200).optional(),
    last_name: z.string().min(1).max(200).optional(),
    organization: z.string().max(200).optional(),
    job_title: z.string().max(200).optional(),
    emails: z.array(EmailEntrySchema).max(10).optional(),
    phones: z.array(PhoneEntrySchema).max(10).optional(),
    note: z.string().max(5000).optional(),
    response_format: responseFormatField,
  })
  .strict();

async function createContact(params: z.infer<typeof CreateContactInput>) {
  if (
    !params.first_name &&
    !params.last_name &&
    !params.organization &&
    !(params.emails && params.emails.length) &&
    !(params.phones && params.phones.length)
  ) {
    return errorResult(
      new Error(
        "Provide at least one of: first_name, last_name, organization, emails, phones.",
      ),
    );
  }
  try {
    const result = await runJxa<{ id: string }>({
      args: {
        firstName: params.first_name ?? null,
        lastName: params.last_name ?? null,
        organization: params.organization ?? null,
        jobTitle: params.job_title ?? null,
        emails: params.emails ?? [],
        phones: params.phones ?? [],
        note: params.note ?? null,
      },
      script: `
        const Contacts = Application('Contacts');
        const props = {};
        if (INPUT.firstName) props.firstName = INPUT.firstName;
        if (INPUT.lastName)  props.lastName  = INPUT.lastName;
        if (INPUT.organization) props.organization = INPUT.organization;
        if (INPUT.jobTitle)  props.jobTitle  = INPUT.jobTitle;
        if (INPUT.note)      props.note      = INPUT.note;

        const person = Contacts.Person(props);
        Contacts.people.push(person);

        for (let i = 0; i < INPUT.emails.length; i++) {
          const e = INPUT.emails[i];
          const em = Contacts.Email({ label: e.label || 'work', value: e.value });
          person.emails.push(em);
        }
        for (let i = 0; i < INPUT.phones.length; i++) {
          const p = INPUT.phones[i];
          const ph = Contacts.Phone({ label: p.label || 'mobile', value: p.value });
          person.phones.push(ph);
        }

        Contacts.save();
        return { id: person.id() };
      `,
    });
    return buildResult(
      params.response_format,
      `Created contact — id: \`${result.id}\``,
      { created: true, id: result.id, ...params },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* update_contact                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const UpdateContactInput = z
  .object({
    contact_id: z.string().min(1),
    first_name: z.string().min(1).max(200).optional(),
    last_name: z.string().min(1).max(200).optional(),
    organization: z.string().max(200).optional(),
    job_title: z.string().max(200).optional(),
    note: z.string().max(5000).optional(),
    response_format: responseFormatField,
  })
  .strict();

async function updateContact(params: z.infer<typeof UpdateContactInput>) {
  const hasUpdate = [
    params.first_name,
    params.last_name,
    params.organization,
    params.job_title,
    params.note,
  ].some((x) => x !== undefined);
  if (!hasUpdate) {
    return errorResult(
      new Error(
        "Provide at least one of: first_name, last_name, organization, job_title, note.",
      ),
    );
  }
  try {
    const ok = await runJxa<{ updated: boolean }>({
      args: {
        contactId: params.contact_id,
        firstName: params.first_name ?? null,
        lastName: params.last_name ?? null,
        organization: params.organization ?? null,
        jobTitle: params.job_title ?? null,
        note: params.note ?? null,
      },
      script: `
        const Contacts = Application('Contacts');
        const matches = Contacts.people.whose({ id: INPUT.contactId })();
        if (matches.length === 0) throw new Error("Contact not found: " + INPUT.contactId);
        const p = matches[0];
        if (INPUT.firstName !== null) p.firstName = INPUT.firstName;
        if (INPUT.lastName !== null) p.lastName = INPUT.lastName;
        if (INPUT.organization !== null) p.organization = INPUT.organization;
        if (INPUT.jobTitle !== null) p.jobTitle = INPUT.jobTitle;
        if (INPUT.note !== null) p.note = INPUT.note;
        Contacts.save();
        return { updated: true };
      `,
    });
    return buildResult(
      params.response_format,
      `Updated contact \`${params.contact_id}\``,
      { updated: ok.updated, id: params.contact_id, ...params },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* delete_contact                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

const DeleteContactInput = z
  .object({
    contact_id: z.string().min(1),
    confirm: z
      .literal(true)
      .describe(
        "Required acknowledgement that the deletion is permanent. Must be true.",
      ),
    response_format: responseFormatField,
  })
  .strict();

async function deleteContact(params: z.infer<typeof DeleteContactInput>) {
  try {
    const ok = await runJxa<{ deleted: boolean }>({
      args: { contactId: params.contact_id },
      script: `
        const Contacts = Application('Contacts');
        const matches = Contacts.people.whose({ id: INPUT.contactId })();
        if (matches.length === 0) throw new Error("Contact not found: " + INPUT.contactId);
        Contacts.delete(matches[0]);
        Contacts.save();
        return { deleted: true };
      `,
    });
    return buildResult(
      params.response_format,
      `Deleted contact \`${params.contact_id}\``,
      { deleted: ok.deleted, id: params.contact_id },
    );
  } catch (e) {
    return errorResult(e);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Registration                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

const contactsAction = z
  .enum(["search", "get", "create", "update", "delete"])
  .describe(
    [
      "Which Contacts operation to perform. Required fields per action:",
      "• search — query; optional limit",
      "• get — contact_id",
      "• create — at least one of first_name/last_name/organization/emails/phones; optional job_title, note",
      "• update — contact_id + at least one of first_name/last_name/organization/job_title/note",
      "• delete — contact_id, confirm=true",
    ].join("\n"),
  );

const ContactsToolInput = z.object(
  consolidatedShape(contactsAction, [
    SearchContactsInput,
    GetContactInput,
    CreateContactInput,
    UpdateContactInput,
    DeleteContactInput,
  ]),
);

async function dispatchContacts(raw: z.infer<typeof ContactsToolInput>) {
  try {
    switch (raw.action) {
      case "search":
        return await searchContacts(parseAction(SearchContactsInput, raw));
      case "get":
        return await getContact(parseAction(GetContactInput, raw));
      case "create":
        return await createContact(parseAction(CreateContactInput, raw));
      case "update":
        return await updateContact(parseAction(UpdateContactInput, raw));
      case "delete":
        return await deleteContact(parseAction(DeleteContactInput, raw));
      default:
        return errorResult(
          new Error(`Unknown contacts action: ${String(raw.action)}`),
        );
    }
  } catch (e) {
    return errorResult(e);
  }
}

export function registerContactTools(server: McpServer) {
  server.registerTool(
    "contacts",
    {
      title: "Contacts",
      description:
        "Read and manage Contacts.app. Pick an operation with `action`: " +
        "search, get, create, update, delete. See the `action` field for the " +
        "parameters each operation needs. Note: update changes only top-level " +
        "fields (not emails/phones). Destructive actions (delete) require confirm=true.",
      inputSchema: ContactsToolInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    dispatchContacts,
  );
}
