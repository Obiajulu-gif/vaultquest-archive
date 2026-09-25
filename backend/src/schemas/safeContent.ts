import { z } from "zod";
import { sanitizeText, sanitizeUrl, type SanitizeUrlOptions } from "../../../lib/safe-content.js";

/**
 * Untrusted-content policy (#774): free text is *stripped* of markup and
 * invisible/bidi characters (and must still be non-empty afterwards); URLs are
 * *rejected* outright when unsafe, never silently rewritten.
 */
export const safeText = (max: number, options: { multiline?: boolean } = {}) =>
  z
    .string()
    .max(max * 4) // hard cap before sanitizing so markup can't be used to inflate work
    .transform((value) => sanitizeText(value, { maxLength: max, multiline: options.multiline }));

export const safeRequiredText = (max: number) =>
  safeText(max).refine((value) => value.length > 0, { message: "must not be empty after sanitization" });

export const safeUrl = (options: SanitizeUrlOptions = {}) =>
  z
    .string()
    .refine((value) => sanitizeUrl(value, options) !== null, { message: "unsafe or invalid URL" })
    .transform((value) => sanitizeUrl(value, options) as string);
