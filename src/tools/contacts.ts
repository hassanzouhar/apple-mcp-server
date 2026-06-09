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

/* ──────────────────────────────────────────────────────────────────────── */
/* apple_search_contacts                                                    */
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
        const Contacts = Application('Contacts');
        const people = Contacts.people();
        const out = [];
        const q = INPUT.query;
        for (let i = 0; i < people.length && out.length < INPUT.limit; i++) {
          const p = people[i];
          const name = (p.name() || "").toLowerCase();
          const org  = (p.organization() || "").toLowerCase();
          let emailsRaw = [];
          try { emailsRaw = p.emails(); } catch (_) {}
          let phonesRaw = [];
          try { phonesRaw = p.phones(); } catch (_) {}
          const emailVals = emailsRaw.map(e => { try { return (e.value() || "").toLowerCase(); } catch (_) { return ""; } });
          const phoneVals = phonesRaw.map(e => { try { return (e.value() || "").toLowerCase(); } catch (_) { return ""; } });
          const hit = name.includes(q) || org.includes(q)
            || emailVals.some(v => v.includes(q))
            || phoneVals.some(v => v.includes(q));
          if (!hit) continue;

          const emails = emailsRaw.map(e => {
            try { return { label: e.label() || null, value: e.value() || "" }; }
            catch (_) { return { label: null, value: "" }; }
          });
          const phones = phonesRaw.map(e => {
            try { return { label: e.label() || null, value: e.value() || "" }; }
            catch (_) { return { label: null, value: "" }; }
          });
          let addrs = [];
          try {
            addrs = p.addresses().map(a => ({
              label: (function(){ try { return a.label() || null; } catch (_) { return null; }})(),
              street: (function(){ try { return a.street() || null; } catch (_) { return null; }})(),
              city: (function(){ try { return a.city() || null; } catch (_) { return null; }})(),
              state: (function(){ try { return a.state() || null; } catch (_) { return null; }})(),
              zip: (function(){ try { return a.zip() || null; } catch (_) { return null; }})(),
              country: (function(){ try { return a.country() || null; } catch (_) { return null; }})(),
            }));
          } catch (_) {}

          let birth = null;
          try { const b = p.birthDate(); birth = b ? b.toISOString() : null; } catch (_) {}

          out.push({
            id: p.id(),
            name: p.name() || "",
            firstName: p.firstName() || null,
            lastName: p.lastName() || null,
            organization: p.organization() || null,
            jobTitle: p.jobTitle() || null,
            emails, phones, addresses: addrs,
            birthDate: birth,
            note: p.note() || null,
          });
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
/* apple_get_contact                                                        */
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
        const Contacts = Application('Contacts');
        const matches = Contacts.people.whose({ id: INPUT.contactId })();
        if (matches.length === 0) return null;
        const p = matches[0];
        const emails = p.emails().map(e => {
          try { return { label: e.label() || null, value: e.value() || "" }; }
          catch (_) { return { label: null, value: "" }; }
        });
        const phones = p.phones().map(e => {
          try { return { label: e.label() || null, value: e.value() || "" }; }
          catch (_) { return { label: null, value: "" }; }
        });
        let addrs = [];
        try {
          addrs = p.addresses().map(a => ({
            label: (function(){ try { return a.label() || null; } catch (_) { return null; }})(),
            street: (function(){ try { return a.street() || null; } catch (_) { return null; }})(),
            city: (function(){ try { return a.city() || null; } catch (_) { return null; }})(),
            state: (function(){ try { return a.state() || null; } catch (_) { return null; }})(),
            zip: (function(){ try { return a.zip() || null; } catch (_) { return null; }})(),
            country: (function(){ try { return a.country() || null; } catch (_) { return null; }})(),
          }));
        } catch (_) {}
        let birth = null;
        try { const b = p.birthDate(); birth = b ? b.toISOString() : null; } catch (_) {}
        return {
          id: p.id(),
          name: p.name() || "",
          firstName: p.firstName() || null,
          lastName: p.lastName() || null,
          organization: p.organization() || null,
          jobTitle: p.jobTitle() || null,
          emails, phones, addresses: addrs,
          birthDate: birth,
          note: p.note() || null,
        };
      `,
    });

    if (!contact) {
      return errorResult(
        new Error(`No contact found with id '${params.contact_id}'`),
        "Use apple_search_contacts to discover valid IDs.",
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
/* apple_create_contact                                                     */
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
/* apple_update_contact                                                     */
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
/* apple_delete_contact                                                     */
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

export function registerContactTools(server: McpServer) {
  server.registerTool(
    "apple_search_contacts",
    {
      title: "Search Contacts",
      description:
        "Search Contacts.app for people whose name, organization, email, or phone matches the query (case-insensitive substring). Returns id, name, organization, job title, emails (with labels), phones (with labels), addresses, birth date, and note.",
      inputSchema: SearchContactsInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    searchContacts,
  );

  server.registerTool(
    "apple_get_contact",
    {
      title: "Get Contact",
      description:
        "Fetch a single contact by its vCard UID (the `id` returned by apple_search_contacts).",
      inputSchema: GetContactInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    getContact,
  );

  server.registerTool(
    "apple_create_contact",
    {
      title: "Create Contact",
      description:
        "Create a new contact card. At least one of first_name, last_name, organization, emails, or phones must be provided. Each email/phone entry takes a label ('work', 'home', 'mobile', etc.) and a value.",
      inputSchema: CreateContactInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    createContact,
  );

  server.registerTool(
    "apple_update_contact",
    {
      title: "Update Contact",
      description:
        "Update top-level fields of an existing contact (first_name, last_name, organization, job_title, note). Email and phone editing are not supported by this tool — delete and recreate the contact, or edit in Contacts.app.",
      inputSchema: UpdateContactInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    updateContact,
  );

  server.registerTool(
    "apple_delete_contact",
    {
      title: "Delete Contact",
      description:
        "Permanently delete a contact. This cannot be undone. You MUST pass confirm=true to acknowledge.",
      inputSchema: DeleteContactInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    deleteContact,
  );
}
