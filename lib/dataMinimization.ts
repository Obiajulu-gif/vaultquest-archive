/**
 * Data minimization review for stored operational metadata (#853).
 *
 * Reviews operational metadata (logs, analytics, error reports, audit trails)
 * for excess personal data collection and recommends or applies minimization
 * policies. Ensures only necessary data is retained and PII is properly
 * anonymized or removed after retention periods.
 *
 * Pure TypeScript/JS — fully unit-testable without the DOM.
 */

export type DataCategory = "logs" | "analytics" | "errors" | "audit" | "cache" | "temp";

export type MinimizationAction = "allow" | "anonymize" | "truncate" | "expire" | "delete";

export interface DataField {
  name: string;
  category: DataCategory;
  /** True if this field contains personally identifiable information. */
  containsPii: boolean;
  /** Maximum retention period in days. */
  retentionDays: number;
  /** Current size estimate in bytes. */
  sizeBytes: number;
  /** Whether this field is essential for operations. */
  essential: boolean;
}

export interface MinimizationReview {
  timestamp: string;
  totalFields: number;
  piiFields: number;
  totalSizeBytes: number;
  recommendations: MinimizationRecommendation[];
  complianceScore: number; // 0-100
}

export interface MinimizationRecommendation {
  field: string;
  category: DataCategory;
  action: MinimizationAction;
  reason: string;
  estimatedSavingsBytes: number;
}

export interface MinimizationPolicy {
  /** Fields that must never be stored. */
  forbiddenFields: string[];
  /** Maximum PII retention days. */
  maxPiiRetentionDays: number;
  /** Maximum total storage in bytes. */
  maxTotalSizeBytes: number;
  /** Fields exempt from minimization (essential for operations). */
  exemptFields: string[];
}

const DEFAULT_POLICY: MinimizationPolicy = {
  forbiddenFields: ["password", "privateKey", "secretKey", "seedPhrase", "ssn", "creditCard"],
  maxPiiRetentionDays: 90,
  maxTotalSizeBytes: 1024 * 1024 * 1024, // 1 GB
  exemptFields: ["transactionHash", "blockNumber", "timestamp", "status"],
};

/**
 * Reviews a list of data fields against minimization policies.
 */
export function reviewDataMinimization(
  fields: DataField[],
  policy: MinimizationPolicy = DEFAULT_POLICY,
  now: Date = new Date(),
): MinimizationReview {
  const recommendations: MinimizationRecommendation[] = [];
  let totalSize = 0;
  let piiCount = 0;

  for (const field of fields) {
    totalSize += field.sizeBytes;
    if (field.containsPii) piiCount++;

    // Check for forbidden fields
    if (policy.forbiddenFields.some((f) => field.name.toLowerCase().includes(f.toLowerCase()))) {
      recommendations.push({
        field: field.name,
        category: field.category,
        action: "delete",
        reason: "Field is in the forbidden list and must never be stored",
        estimatedSavingsBytes: field.sizeBytes,
      });
      continue;
    }

    // Check PII retention
    if (field.containsPii && field.retentionDays > policy.maxPiiRetentionDays) {
      recommendations.push({
        field: field.name,
        category: field.category,
        action: "expire",
        reason: `PII retention exceeds maximum of ${policy.maxPiiRetentionDays} days`,
        estimatedSavingsBytes: field.sizeBytes * 0.3,
      });
    }

    // Check non-essential large fields
    if (!field.essential && field.sizeBytes > 1024 * 1024) {
      recommendations.push({
        field: field.name,
        category: field.category,
        action: "truncate",
        reason: "Non-essential field exceeds 1MB",
        estimatedSavingsBytes: field.sizeBytes * 0.5,
      });
    }

    // Recommend anonymization for non-essential PII
    if (field.containsPii && !field.essential && !policy.exemptFields.includes(field.name)) {
      recommendations.push({
        field: field.name,
        category: field.category,
        action: "anonymize",
        reason: "PII field is non-essential and should be anonymized",
        estimatedSavingsBytes: field.sizeBytes * 0.2,
      });
    }
  }

  // Calculate compliance score
  const totalSavings = recommendations.reduce((sum, r) => sum + r.estimatedSavingsBytes, 0);
  const complianceScore = totalSize > 0 ? Math.max(0, Math.round(100 - (totalSavings / totalSize) * 100)) : 100;

  return {
    timestamp: now.toISOString(),
    totalFields: fields.length,
    piiFields: piiCount,
    totalSizeBytes: totalSize,
    recommendations,
    complianceScore,
  };
}

/**
 * Anonymizes a string by replacing it with a hash or placeholder.
 */
export function anonymizeValue(value: string, preserveLength: boolean = false): string {
  if (!value) return "";
  if (preserveLength) {
    return "*".repeat(Math.min(value.length, 8));
  }
  return "[REDACTED]";
}

/**
 * Truncates a string to a maximum length.
 */
export function truncateValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.substring(0, maxLength) + "...";
}

/**
 * Applies a minimization action to a field value.
 */
export function applyMinimization(
  value: string,
  action: MinimizationAction,
  maxLength?: number,
): string {
  switch (action) {
    case "anonymize":
      return anonymizeValue(value);
    case "truncate":
      return truncateValue(value, maxLength ?? 256);
    case "delete":
    case "expire":
      return "";
    case "allow":
    default:
      return value;
  }
}

/**
 * Generates a minimization report in JSON format.
 */
export function generateReport(review: MinimizationReview): string {
  return JSON.stringify(review, null, 2);
}

/**
 * Checks if data is within retention period.
 */
export function isWithinRetention(
  createdAt: Date,
  retentionDays: number,
  now: Date = new Date(),
): boolean {
  const ageMs = now.getTime() - createdAt.getTime();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  return ageMs <= retentionMs;
}

/**
 * Filters out expired data entries.
 */
export function filterExpiredData<T extends { createdAt: Date; retentionDays: number }>(
  data: T[],
  now: Date = new Date(),
): T[] {
  return data.filter((item) => isWithinRetention(item.createdAt, item.retentionDays, now));
}
