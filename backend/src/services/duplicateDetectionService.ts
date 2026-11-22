/**
 * Duplicate detection for VaultQuest user-submitted records.
 *
 * This service detects duplicate records using canonical fields and a fuzzy
 * match layer. Exact duplicates are blocked deterministically; ambiguous
 * near-duplicates are routed to a warning or maintainer review state.
 *
 * Design decisions:
 * - Exact matches are computed from a canonical key built from normalized
 *   fields (lowercase, trimmed, whitespace-collapsed). This is deterministic
 *   and index-friendly for database lookups.
 * - Near matches use a normalized edit distance (Damerau-Levenshtein) combined
 *   with a token Jaccard similarity for multi-word fields. Thresholds are
 *   configurable so maintainers can tune sensitivity per deployment.
 * - Severity mapping:
 *     - EXACT: block the submission.
 *     - NEAR_DUPLICATE: warn the user and require maintainer review.
 *     - AMBIGUOUS: warn the user, allow submission but flag for review.
 *     - NONE: allow.
 * - The service is pure and deterministic given inputs; it does not touch the
 *   network or database directly. Callers pass in candidate records and a
 *   provider function that returns existing records. This keeps the module
 *   testable and easy to integrate with the existing VaultQuest architecture.
 */

export type DuplicateSeverity = 'none' | 'ambiguous' | 'near-duplicate' | 'exact';

export type DuplicateDecision = 'allow' | 'warn' | 'block';

export interface VaultQuestRecord {
  /** Stable identifier for the record (e.g. vault id, prize draw id). */
  id: string;
  /** Human-readable name or title of the record. */
  name: string;
  /** Optional description used for fuzzy matching. */
  description?: string;
  /** Optional associated wallet address. */
  walletAddress?: string;
  /** Optional canonical amount in the vault's base unit. */
  amount?: string;
  /** Optional category or type label. */
  category?: string;
  /** Optional external reference (e.g. transaction hash). */
  externalReference?: string;
  /** Free-form metadata attached to the record. */
  metadata?: Record<string, unknown>;
}

export interface DuplicateMatch {
  /** The existing record that matches the candidate. */
  existing: VaultQuestRecord;
  /** Severity of the match. */
  severity: DuplicateSeverity;
  /** Similarity score in [0, 1] for the best matching field. */
  score: number;
  /** Which canonical fields contributed to the match. */
  matchedFields: string[];
  /** Human-readable explanation of the match. */
  reason: string;
}

export interface DuplicateDetectionResult {
  /** The candidate record that was evaluated. */
  candidate: VaultQuestRecord;
  /** The canonical key derived from the candidate. */
  canonicalKey: string;
  /** The highest severity match found, if any. */
  severity: DuplicateSeverity;
  /** The decision the caller should apply. */
  decision: DuplicateDecision;
  /** All matches found, sorted by severity then score descending. */
  matches: DuplicateMatch[];
  /** Whether the record requires maintainer review. */
  requiresReview: boolean;
  /** Human-readable summary of the decision. */
  summary: string;
}

export interface DuplicateDetectionOptions {
  /** The minimum similarity score to consider a near duplicate. Default 0.85. */
  nearDuplicateThreshold?: number;
  /** The minimum similarity score to consider an ambiguous match. Default 0.65. */
  ambiguousThreshold?: number;
  /** Whether to include the description field in fuzzy matching. Default true. */
  includeDescription?: boolean;
  /** Whether to include the category field in fuzzy matching. Default false. */
  includeCategory?: boolean;
}

const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.85;
const DEFAULT_AMBIGUOUS_THRESHOLD = 0.65;

/**
 * Normalize a string for canonical comparison: lowercase, trim, collapse
 * whitespace, and strip non-alphanumeric characters except spaces.
 */
export function normalizeString(value: unknown | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a deterministic canonical key from the stable identity fields of a
 * record. Two records with the same canonical key are exact duplicates.
 */
export function canonicalKey(record: VaultQuestRecord): string {
  const parts = [
    normalizeString(record.name),
    normalizeString(record.walletAddress),
    normalizeString(record.amount),
    normalizeString(record.externalReference),
  ];
  return parts.join('|');
}

/**
 * Damerau-Levenshtein edit distance between two strings. Returns the number of
 * single-character edits required to transform a into b.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const previousRow = new Array<number>(b.length + 1);
  const currentRow = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) {
    previousRow[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    currentRow[0] = i;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const bChar = b.charCodeAt(j - 1);
      const cost = aChar === bChar ? 0 : 1;
      const insertion = currentRow[j - 1] + 1;
      const deletion = previousRow[j] + 1;
      const substitution = previousRow[j - 1] + cost;
      currentRow[j] = Math.min(insertion, deletion, substitution);
    }
    for (let j = 0; j <= b.length; j++) {
      previousRow[j] = currentRow[j];
    }
  }

  return previousRow[b.length];
}

/**
 * Normalized similarity in [0, 1] derived from the Damerau-Levenshtein
 * distance. 1 means identical, 0 means maximally different.
 */
export function editSimilarity(a: string, b: string): number {
  const normA = normalizeString(a);
  const normB = normalizeString(b);
  if (normA.length === 0 && normB.length === 0) {
    return 1;
  }
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) {
    return 1;
  }
  const distance = levenshteinDistance(normA, normB);
  return 1 - distance / maxLen;
}

/**
 * Token Jaccard similarity between two strings. Useful for multi-word
 * descriptions where word order may vary.
 */
export function tokenJaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeString(a).split(' '));
  const tokensB = new Set(normalizeString(b).split(' '));
  if (tokensA.size === 0 && tokensB.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection++;
    }
  }
  const union = tokensA.size + tokensB.size - intersection;
  if (union === 0) {
    return 1;
  }
  return intersection / union;
}

/**
 * Combined similarity for a field: the maximum of edit similarity and token
 * Jaccard similarity. This handles both typos and word reordering.
 */
export function fieldSimilarity(a: string, b: string): number {
  const normA = normalizeString(a);
  const normB = normalizeString(b);
  if (normA.length === 0 || normB.length === 0) {
    return normA === normB ? 1 : 0;
  }
  return Math.max(editSimilarity(normA, normB), tokenJaccardSimilarity(normA, normB));
}

const SEVERITY_RANK: Record<DuplicateSeverity, number> = {
  none: 0,
  ambiguous: 1,
  'near-duplicate': 2,
  exact: 3,
};

function maxSeverity(a: DuplicateSeverity, b: DuplicateSeverity): DuplicateSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function decisionForSeverity(severity: DuplicateSeverity): DuplicateDecision {
  switch (severity) {
    case 'exact':
      return 'block';
    case 'near-duplicate':
      return 'warn';
    case 'ambiguous':
      return 'warn';
    default:
      return 'allow';
  }
}

function requiresReviewForSeverity(severity: DuplicateSeverity): boolean {
  return severity === 'exact' || severity === 'near-duplicate' || severity === 'ambiguous';
}

function compareMatches(a: DuplicateMatch, b: DuplicateMatch): number {
  const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (rankDiff !== 0) {
    return rankDiff;
  }
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  return a.existing.id.localeCompare(b.existing.id);
}

/**
 * Evaluate a single candidate record against a collection of existing records.
 * Returns a deterministic result with the highest severity match and the
 * recommended decision.
 */
export function detectDuplicates(
  candidate: VaultQuestRecord,
  existing: readonly VaultQuestRecord[],
  options: DuplicateDetectionOptions = {},
): DuplicateDetectionResult {
  const nearThreshold = options.nearDuplicateThreshold ?? DEFAULT_NEAR_DUPLICATE_THRESHOLD;
  const ambiguousThreshold = options.ambiguousThreshold ?? DEFAULT_AMBIGUOUS_THRESHOLD;
  if (ambiguousThreshold > nearThreshold) {
    throw new Error('ambiguousThreshold must be less than or equal to nearDuplicateThreshold');
  }
  if (nearThreshold > 1 || ambiguousThreshold < 0) {
    throw new Error('duplicate thresholds must be within [0, 1]');
  }

  const includeDescription = options.includeDescription ?? true;
  const includeCategory = options.includeCategory ?? false;

  const candidateKey = canonicalKey(candidate);
  const matches: DuplicateMatch[] = [];

  for (const record of existing) {
    if (record.id === candidate.id) {
      // Skip self-matches when updating an existing record.
      continue;
    }

    const existingKey = canonicalKey(record);
    if (existingKey === candidateKey) {
      matches.push({
        existing: record,
        severity: 'exact',
        score: 1,
        matchedFields: ['canonicalKey'],
        reason: 'Exact canonical key match',
      });
      continue;
    }

    const fieldScores: Array<{ field: string; score: number }> = [];
    fieldScores.push({ field: 'name', score: fieldSimilarity(candidate.name, record.name) });
    if (includeDescription) {
      fieldScores.push({
        field: 'description',
        score: fieldSimilarity(candidate.description ?? '', record.description ?? ''),
      });
    }
    if (includeCategory) {
      fieldScores.push({
        field: 'category',
        score: fieldSimilarity(candidate.category ?? '', record.category ?? ''),
      });
    }

    const best = fieldScores.reduce((acc, cur) => (cur.score > acc.score ? cur : acc), fieldScores[0]);
    if (!best) {
      continue;
    }

    let severity: DuplicateSeverity = 'none';
    if (best.score >= nearThreshold) {
      severity = 'near-duplicate';
    } else if (best.score >= ambiguousThreshold) {
      severity = 'ambiguous';
    }

    if (severity === 'none') {
      continue;
    }

    const matchedFields = fieldScores
      .filter((entry) => entry.score >= ambiguousThreshold)
      .map((entry) => entry.field);

    matches.push({
      existing: record,
      severity,
      score: best.score,
      matchedFields: matchedFields.length > 0 ? matchedFields : [best.field],
      reason:
        severity === 'near-duplicate'
          ? `Near duplicate on "${best.field}" (similarity ${best.score.toFixed(3)})`
          : `Ambiguous match on "${best.field}" (similarity ${best.score.toFixed(3)})`,
    });
  }

  matches.sort(compareMatches);

  const highestSeverity = matches.reduce<DuplicateSeverity>(
    (acc, match) => maxSeverity(acc, match.severity),
    'none',
  );

  const decision = decisionForSeverity(highestSeverity);
  const requiresReview = requiresReviewForSeverity(highestSeverity);

  const summary = buildSummary(highestSeverity, decision, matches);

  return {
    candidate,
    canonicalKey: candidateKey,
    severity: highestSeverity,
    decision,
    matches,
    requiresReview,
    summary,
  };
}

function buildSummary(
  severity: DuplicateSeverity,
  decision: DuplicateDecision,
  matches: DuplicateMatch[],
): string {
  if (matches.length === 0) {
    return 'No duplicates detected.';
  }
  const top = matches[0];
  return `${matches.length} match(es) found; highest severity ${severity} (${decision}). Top match against "${top.existing.name}" (${top.score.toFixed(3)}).`;
}

/**
 * Convenience wrapper that accepts a provider function for existing records.
 * This keeps the service pure while also being easy to integrate with a
 * database or repository layer.
 */
export async function detectDuplicatesAsync(
  candidate: VaultQuestRecord,
  listExisting: () => Promise<readonly VaultQuestRecord[]> | readonly VaultQuestRecord[],
  options: DuplicateDetectionOptions = {},
): Promise<DuplicateDetectionResult> {
  const existing = await listExisting();
  return detectDuplicates(candidate, existing, options);
}

export const __internals = {
  DEFAULT_NEAR_DUPLICATE_THRESHOLD,
  DEFAULT_AMBIGUOUS_THRESHOLD,
  SEVERITY_RANK,
  maxSeverity,
  decisionForSeverity,
  requiresReviewForSeverity,
} as const;
