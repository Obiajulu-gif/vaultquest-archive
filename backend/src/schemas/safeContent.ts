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

/**
 * VaultQuest bulk import dry-run schemas.
 *
 * Import rows are validated against the same untrusted-content policy as the
 * rest of the API so that a dry run cannot be used to smuggle markup, unsafe
 * URLs, or invisible/bidi characters past validation. The dry-run result
 * schemas intentionally expose only counts and non-secret conflict metadata
 * (row index, field name, reason) so callers can build actionable reports
 * without leaking secrets or raw payloads.
 */

export const importRowStatus = z.enum(["create", "update", "skip", "duplicate", "error"]);

export const importRowInput = z
  .object({
    vaultId: safeRequiredText(128),
    label: safeRequiredText(128),
    amount: z.string().regex(/^\d+(\.\d+)?$/, { message: "must be a non-negative decimal string" }),
    destination: safeUrl({ allowRelative: false }),
    memo: safeText(512, { multiline: true }).optional(),
  })
  .strict();

export const importRowConflict = z.object({
  rowIndex: z.number().int().nonnegative(),
  field: z.string().min(1).max(64),
  reason: z.string().min(1).max(256),
});

export const importRowError = z.object({
  rowIndex: z.number().int().nonnegative(),
  field: z.string().min(1).max(64),
  message: z.string().min(1).max(256),
});

export const importDryRunCounts = z.object({
  create: z.number().int().nonnegative(),
  update: z.number().int().nonnegative(),
  skip: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
});

export const importDryRunResult = z.object({
  dryRun: z.literal(true),
  counts: importDryRunCounts,
  conflicts: z.array(importRowConflict).max(10_000),
  errors: z.array(importRowError).max(10_000),
});

export type ImportRowInput = z.infer<typeof importRowInput>;
export type ImportRowConflict = z.infer<typeof importRowConflict>;
export type ImportRowError = z.infer<typeof importRowError>;
export type ImportDryRunCounts = z.infer<typeof importDryRunCounts>;
export type ImportDryRunResult = z.infer<typeof importDryRunResult>;
