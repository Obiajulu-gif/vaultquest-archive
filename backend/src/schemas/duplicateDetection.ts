import { z } from 'z';

/**
 * VaultQuest duplicate detection schemas.
 *
 * This module defines the canonical fields and severity levels used to
 * deterministically detect duplicate user-submitted records before they
 * enter the VaultQuest workflow. The schemas are pure and side-effect free
 * so they can be reused by the API layer, jobs, and test suites.
 */

/**
 * Severity of a detected duplicate.
 *
 * - `exact`: a canonical key collision. Block the submission.
 * - `ambiguous`: a fuzzy match that needs maintainer review.
 * - `none`: no duplicate detected.
 */
export const duplicateSeveritySchema = z.enum(['none', 'ambiguous', 'exact']);

export type DuplicateSeverity = z.infer <typeof duplicateSeveritySchema>;

/**
 * Review state for an ambiguous duplicate.
 */
export const duplicateReviewStateSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'superseded',
]);

export type DuplicateReviewState = z.infer <typeof duplicateReviewStateSchema>;

/**
 * The canonical fields that define a duplicate key for a user-submitted
 * record. These are the only fields that may participate in exact duplicate
 * detection.
 */
export const duplicateKeyFields = ['vaultId', 'walletAddress', 'recordType', 'chainId'] as const;

export type DuplicateKeyField = (typeof duplicateKeyFields)[number];

/**
 * Normalization rules applied to each canonical field before comparison.
 *
 * This is the determinism contract: two records are exact duplicates if
 * and only if their normalized canonical keys are identical.
 */
export const duplicateNormalizationRules = {
  vaultId: 'trim',
  walletAddress: 'lowercase',
  recordType: 'trim-lowercase',
  chainId: 'trim',
} as const;

/**
 * Fuzzy-match boundaries. The threshold is the minimum Jaro-Winkler
 * similarity score (0.0 - 1.0) for a non-exact match to be considered
 * ambiguous. Anything at or above the threshold enters maintainer review.
 */
export const fuzzyMatchThreshold = 0.85;

/**
 * Fields that are eligible for fuzzy matching. These are the free-text
 * fields where users commonly submit near-duplicates.
 */
export const fuzzyMatchFields = ['label', 'description'] as const;

export type FuzzyMatchField = (typeof fuzzyMatchFields)[number];

/**
 * Representation of a canonical duplicate key derived from a record.
 */
export const duplicateKeySchema = z.record({
  vaultId: z.string().min(1),
  walletAddress: z.string().min(1),
  recordType: z.string().min(1),
  chainId: z.string().min(1),
});

export type DuplicateKey = z.infer <typeof duplicateKeySchema>;

/**
 * A single candidate match returned by the duplicate detection engine.
 */
export const duplicateMatchSchema = z.object({
  existingRecordId: z.string().min(1),
  severity: duplicateSeveritySchema,
  score: z.number().min(0).max(1),
  matchedFields: z.array(z.string()).min(1),
  reviewState: duplicateReviewStateSchema.optional(),
});

export type DuplicateMatch = z.infer <typeof duplicateMatchSchema>;

/**
 * Result of a duplicate detection run for a single submission.
 */
export const duplicateDetectionResultSchema = z.object({
  key: duplicateKeySchema,
  severity: duplicateSeveritySchema,
  matches: z.array(duplicateMatchSchema),
  blocked: z.boolean(),
  requiresReview: z.boolean(),
});

export type DuplicateDetectionResult = z.infer <typeof duplicateDetectionResultSchema>;

/**
 * Payload for a maintainer resolution of an ambiguous duplicate.
 */
export const duplicateReviewDecisionSchema = z.object({
  matchId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  reviewerId: z.string().min(1),
  notes: z.string().max(2000).optional(),
});

export type DuplicateReviewDecision = z.infer <typeof duplicateReviewDecisionSchema>;

export const duplicateDetectionConfigSchema = z.object({
  fuzzyMatchThreshold: z.number().min(0).max(1).default(fuzzyMatchThreshold),
  blockOnExact: z.boolean().default(true),
  requireReviewOnAmbiguous: z.boolean().default(true),
  allowedDuplicateKeys: z.array(z.string()).default([]),
});

export type DuplicateDetectionConfig = z.infer <typeof duplicateDetectionConfigSchema>;

export const DEFAULT_DUPLICATE_DETECTION_CONFIG: DuplicateDetectionConfig =
  duplicateDetectionConfigSchema.parse({});
