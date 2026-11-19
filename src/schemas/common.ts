/**
 * Shared Zod fragments reused across tool input schemas.
 */

import { z } from "zod";
import { ResponseFormat } from "../services/format.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Output format: 'markdown' for human-readable, 'json' for machine-readable.",
  );

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`Maximum number of items to return (1-${MAX_LIMIT}).`);

const ISO_DATE_MESSAGE =
  "Must be an ISO 8601 date or datetime string (e.g. '2026-05-26' or '2026-05-26T14:00:00').";

/** Reject well-formed strings naming an impossible date or time (2026-02-30, T25:00). */
function isRealDate(value: string): boolean {
  const [, y, mo, d, h = "0", mi = "0", s = "0"] =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value) ?? [];
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  return (
    date.getUTCMonth() === +mo - 1 &&
    date.getUTCDate() === +d &&
    +h <= 23 &&
    +mi <= 59 &&
    +s <= 59
  );
}

export const isoDateField = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
    ISO_DATE_MESSAGE,
  )
  .refine(isRealDate, ISO_DATE_MESSAGE)
  .describe("ISO 8601 date or datetime string.");

export const optionalIsoDateField = isoDateField.optional();
