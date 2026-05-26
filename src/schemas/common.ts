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

export const isoDateField = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
    "Must be an ISO 8601 date or datetime string (e.g. '2026-05-26' or '2026-05-26T14:00:00').",
  )
  .describe("ISO 8601 date or datetime string.");

export const optionalIsoDateField = isoDateField.optional();
