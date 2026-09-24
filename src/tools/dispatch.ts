/**
 * Shared helpers for the consolidated, action-dispatched tools.
 *
 * Each app (Calendar, Reminders, Contacts, Mail, iMessage) is exposed as a
 * SINGLE MCP tool that takes an `action` discriminator plus the union of every
 * action's parameters (all optional at the outer layer). The outer schema can't
 * make per-action fields conditionally required, so we keep the original
 * per-action Zod schemas as *internal validators* and re-parse here:
 *
 *   - `consolidatedShape()` builds the permissive outer shape the MCP host sees.
 *   - `parseAction()` strips `action`, re-validates the rest against the precise
 *     per-action schema (so e.g. `confirm: z.literal(true)` is still enforced),
 *     and throws a readable error the handler's try/catch turns into errorResult.
 */

import { z } from "zod";

/**
 * Build the permissive outer shape for a consolidated tool: an `action` enum
 * plus every per-action schema's fields, made optional. Pass `action` already
 * constructed (with its enum + description) and the list of per-action schemas.
 *
 * Later schemas win on key collisions, which is fine because shared fields
 * (`response_format`, ids, etc.) are defined identically across actions.
 */
export function consolidatedShape(
  action: z.ZodTypeAny,
  schemas: z.AnyZodObject[],
): z.ZodRawShape {
  let shape: z.ZodRawShape = { action };
  for (const s of schemas) {
    shape = { ...shape, ...s.partial().shape };
  }
  return shape;
}

/**
 * Strip the `action` key, validate the remaining params against the precise
 * per-action schema, and return the parsed value. Throws an Error with a
 * concise, agent-readable message if validation fails (missing `confirm`,
 * missing required field, wrong type, …).
 */
export function parseAction<S extends z.ZodTypeAny>(
  schema: S,
  raw: Record<string, unknown>,
): z.infer<S> {
  const { action, ...rest } = raw;
  const result = schema.safeParse(rest);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(param)"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Invalid parameters for action "${String(action)}": ${detail}`,
    );
  }
  return result.data;
}
