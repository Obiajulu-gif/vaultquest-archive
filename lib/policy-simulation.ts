/**
 * Policy simulation preview for irreversible or high-impact changes.
 *
 * Governance surfaces in VaultQuest (retention windows, notification
 * defaults, feature-flag rollouts, search rebuilds, session lifetimes) are
 * edited by maintainers but apply to many existing records and users at once.
 * This module makes those changes previewable before they are committed:
 *
 *  - every policy in the catalog declares validation bounds, affected data
 *    surfaces, expected side effects, and rollback constraints,
 *  - an injected impact source measures how many records and users a change
 *    would touch (a database count in production, a fixture in tests),
 *  - the preview aggregates impact, classifies risk, and produces a
 *    content-bound confirmation token,
 *  - `preparePolicyApplication` refuses to return an application plan without
 *    the exact token, without acknowledgement for irreversible changes, and
 *    never claims the change was activated — persistence stays with the
 *    caller so the preview can be stored, diffed, and replayed.
 *
 * Everything is pure and deterministic: the same requests, measurements, and
 * timestamp produce byte-identical previews.
 */

export type PolicyKind = "retention" | "notifications" | "feature_rollout" | "search" | "access";
export type PolicyValue = number | boolean;
export type PolicyRiskLevel = "none" | "low" | "medium" | "high";

export interface PolicyImpactThresholds {
  /** More affected records than this marks the change high impact. */
  records?: number;
  /** More affected users than this marks the change high impact. */
  users?: number;
}

export interface PolicySpec {
  id: string;
  title: string;
  kind: PolicyKind;
  description: string;
  unit?: string;
  current: PolicyValue;
  min?: number;
  max?: number;
  integer?: boolean;
  /** Data surfaces and services the value pushes into. */
  affectedSurfaces: string[];
  /** Human-readable consequences of applying the change. */
  sideEffects: string[];
  /** False when applied changes cannot be fully undone. */
  reversible: boolean;
  /** Constraints an operator must respect while rolling back. */
  rollbackConstraints: string[];
  impactThresholds?: PolicyImpactThresholds;
}

export const POLICY_CATALOG: PolicySpec[] = [
  {
    id: "retention.userDataExportDays",
    title: "User data export retention",
    kind: "retention",
    description: "How long a generated user-data export remains downloadable before it may be purged.",
    unit: "days",
    current: 30,
    min: 1,
    max: 3650,
    integer: true,
    affectedSurfaces: ["user_data_exports", "data export API", "retention purge job"],
    sideEffects: [
      "Shortening the window makes already-generated exports past the new cutoff eligible for purge.",
      "Longer windows keep more export payloads at rest and increase storage and privacy exposure.",
    ],
    reversible: false,
    rollbackConstraints: [
      "Once the retention purge job runs, purged export payloads are unrecoverable without a database restore.",
      "Extending the window after a purge cannot regenerate deleted payloads; users must request a fresh export.",
    ],
    impactThresholds: { records: 10_000, users: 1_000 },
  },
  {
    id: "notifications.optionalMuteDefaultDays",
    title: "Default optional-alert quiet period",
    kind: "notifications",
    description: "Default mute window applied to optional notifications for wallets without explicit preferences.",
    unit: "days",
    current: 0,
    min: 0,
    max: 90,
    integer: true,
    affectedSurfaces: ["notification preferences", "notification provider", "reminder jobs"],
    sideEffects: [
      "Optional alerts (reminders, confirmations, APY updates) are delayed for affected wallets.",
      "Mandatory lifecycle and security alerts are never muted by this policy.",
    ],
    reversible: true,
    rollbackConstraints: [
      "Clearing the default restores delivery on the next dispatch; alerts suppressed while muted are not re-sent retroactively.",
    ],
    impactThresholds: { users: 50_000 },
  },
  {
    id: "featureFlag.rolloutPercent",
    title: "Feature flag rollout percentage",
    kind: "feature_rollout",
    description: "Percent of eligible wallets that see the staged feature on their next session.",
    unit: "%",
    current: 0,
    min: 0,
    max: 100,
    integer: true,
    affectedSurfaces: ["feature_flags", "dashboard", "wallet flows"],
    sideEffects: [
      "Raising the percentage exposes the feature to the newly included cohort immediately.",
      "Lowering the percentage stops new sessions from using the feature but cannot undo completed actions.",
    ],
    reversible: true,
    rollbackConstraints: [
      "In-flight operations started under the flag must drain before rollback is complete.",
      "Data written by the feature while enabled remains; check consumers for compatibility before rollback.",
    ],
    impactThresholds: { users: 100_000 },
  },
  {
    id: "search.indexRebuildRequired",
    title: "Force search index rebuild",
    kind: "search",
    description: "Marks the search index stale so the repair job rebuilds every derived entry.",
    current: false,
    affectedSurfaces: ["search index", "derived_cache", "search routes"],
    sideEffects: [
      "Rebuild consumes read capacity while re-deriving index entries.",
      "Search results may briefly lag the latest data until the rebuild completes.",
    ],
    reversible: true,
    rollbackConstraints: [
      "Rebuilds are idempotent; a failed or partial run can be re-run without data loss.",
      "Disabling the flag mid-rebuild stops new rebuild batches but does not corrupt existing entries.",
    ],
    impactThresholds: { records: 500_000 },
  },
  {
    id: "access.walletSessionTtlHours",
    title: "Wallet session lifetime",
    kind: "access",
    description: "How long a wallet session stays valid before re-authentication is required.",
    unit: "hours",
    current: 72,
    min: 1,
    max: 720,
    integer: true,
    affectedSurfaces: ["wallet_sessions", "wallet auth API"],
    sideEffects: [
      "Shortening the lifetime signs out sessions whose expiry now falls inside the new window.",
      "Lengthening it reduces re-authentication prompts but widens the replay window for stolen tokens.",
    ],
    reversible: true,
    rollbackConstraints: [
      "Sessions already revoked by the shorter TTL stay revoked; rollback only affects future expirations.",
    ],
    impactThresholds: { users: 100_000 },
  },
];

export const POLICY_INDEX: Record<string, PolicySpec> = Object.fromEntries(
  POLICY_CATALOG.map((spec) => [spec.id, spec]),
);

export function getPolicySpec(policyId: string): PolicySpec | undefined {
  return POLICY_INDEX[policyId];
}

export interface PolicyChangeRequest {
  policyId: string;
  from: PolicyValue;
  to: PolicyValue;
  rationale?: string;
  effectiveAt?: string;
}

export interface PolicyImpactMeasurement {
  affectedRecords: number;
  affectedUsers: number;
  /** Opaque record identifiers for spot-checking (optional, bounded by caller). */
  sampleRecords?: string[];
  detail?: Record<string, number>;
  measuredAt: string;
}

export interface PolicyImpactSource {
  measure(change: PolicyChangeRequest, spec: PolicySpec): PolicyImpactMeasurement | Promise<PolicyImpactMeasurement>;
}

export interface PolicyValidationIssue {
  field: "policy" | "value" | "type" | "stale" | "impact";
  message: string;
}

export type PolicyChangeState = "valid" | "blocked";

export interface PolicyChangePreview {
  request: PolicyChangeRequest;
  title: string;
  kind: PolicyKind;
  unit?: string;
  validated: boolean;
  state: PolicyChangeState;
  issues: PolicyValidationIssue[];
  impact: PolicyImpactMeasurement | null;
  sideEffects: string[];
  affectedSurfaces: string[];
  rollback: {
    reversible: boolean;
    steps: string[];
    constraints: string[];
  };
  risk: PolicyRiskLevel;
  riskMessage: string;
  highImpact: boolean;
  requiresConfirmation: boolean;
  requiresApproval: boolean;
}

export interface PolicyRollbackPlan {
  reversible: boolean;
  steps: string[];
  constraints: string[];
  warning?: string;
}

export interface PolicyPreview {
  schema: "vaultquest.policy-simulation.v1";
  id: string;
  createdAt: string;
  author: string;
  changes: PolicyChangePreview[];
  summary: {
    total: number;
    valid: number;
    blocked: number;
    highImpact: number;
    irreversible: number;
    totalAffectedRecords: number;
    totalAffectedUsers: number;
  };
  rollbackPlan: PolicyRollbackPlan;
  /** Content-bound confirmation over the changes *and* the measured impact. */
  confirmationToken: string;
}

export class UnknownPolicyError extends Error {}
export class PolicyConfirmationRequiredError extends Error {
  constructor(message = "Explicit confirmation of the current policy preview is required.") {
    super(message);
    this.name = "PolicyConfirmationRequiredError";
  }
}
export class IrreversiblePolicyError extends Error {
  constructor(message = "The preview contains irreversible changes; acknowledge them before applying.") {
    super(message);
    this.name = "IrreversiblePolicyError";
  }
}
export class PolicyPreviewStaleError extends Error {
  constructor(message = "The confirmation token does not match the current preview; re-run the simulation.") {
    super(message);
    this.name = "PolicyPreviewStaleError";
  }
}
export class PolicyImpactUnavailableError extends Error {
  constructor(message = "Impact measurement failed; the preview cannot be trusted.") {
    super(message);
    this.name = "PolicyImpactUnavailableError";
  }
}

/** Validates a proposed value against the catalog bounds. */
export function validatePolicyValue(policyId: string, value: PolicyValue): PolicyValidationIssue[] {
  const spec = getPolicySpec(policyId);
  if (!spec) return [{ field: "policy", message: `Unknown policy "${policyId}".` }];

  const issues: PolicyValidationIssue[] = [];
  if (typeof spec.current === "boolean") {
    if (typeof value !== "boolean") issues.push({ field: "type", message: `${spec.title} must be a boolean.` });
    return issues;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ field: "type", message: `${spec.title} must be a finite number.` });
    return issues;
  }
  if (spec.integer && !Number.isInteger(value)) {
    issues.push({ field: "type", message: `${spec.title} must be a whole number.` });
  }
  if (spec.min !== undefined && value < spec.min) {
    issues.push({ field: "value", message: `${spec.title} may not go below ${spec.min}${spec.unit ? ` ${spec.unit}` : ""}.` });
  }
  if (spec.max !== undefined && value > spec.max) {
    issues.push({ field: "value", message: `${spec.title} may not exceed ${spec.max}${spec.unit ? ` ${spec.unit}` : ""}.` });
  }
  return issues;
}

function relativeMagnitude(from: PolicyValue, to: PolicyValue): number {
  if (typeof from === "boolean" || typeof to === "boolean") return from === to ? 0 : 1;
  return Math.abs(to - from) / Math.max(Math.abs(from), Number.EPSILON);
}

function baseRisk(from: PolicyValue, to: PolicyValue): { risk: PolicyRiskLevel; message: string } {
  if (from === to) return { risk: "none", message: "No change from the current value." };
  const magnitude = relativeMagnitude(from, to);
  if (typeof from === "boolean") return { risk: "medium", message: "State flip; verify consumers cannot observe a partial rollout." };
  if (magnitude <= 0.1) return { risk: "low", message: "Small adjustment within normal operating variance." };
  if (magnitude <= 0.5) return { risk: "medium", message: "Material adjustment; requires governance review." };
  return { risk: "high", message: "Large adjustment; high operational impact." };
}

function exceedsThresholds(spec: PolicySpec, impact: PolicyImpactMeasurement): boolean {
  const thresholds = spec.impactThresholds;
  if (!thresholds) return false;
  if (thresholds.records !== undefined && impact.affectedRecords > thresholds.records) return true;
  if (thresholds.users !== undefined && impact.affectedUsers > thresholds.users) return true;
  return false;
}

function riskRank(risk: PolicyRiskLevel): number {
  return { none: 0, low: 1, medium: 2, high: 3 }[risk];
}

function maxRisk(a: PolicyRiskLevel, b: PolicyRiskLevel): PolicyRiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b;
}

/**
 * Simulates one policy change against a measured impact.
 *
 * The preview never mutates anything. `state` is `"blocked"` when the value is
 * invalid, the `from` value is stale (does not match the catalog), or the
 * impact source could not measure the change.
 */
export function simulatePolicyChange(
  request: PolicyChangeRequest,
  impact: PolicyImpactMeasurement | null,
  options: { impactError?: string } = {},
): PolicyChangePreview {
  const spec = getPolicySpec(request.policyId);

  if (!spec) {
    return {
      request,
      title: request.policyId,
      kind: "retention",
      validated: false,
      state: "blocked",
      issues: [{ field: "policy", message: `Unknown policy "${request.policyId}".` }],
      impact: null,
      sideEffects: [],
      affectedSurfaces: [],
      rollback: { reversible: false, steps: [], constraints: ["Unknown policies cannot be rolled back."] },
      risk: "high",
      riskMessage: "Unknown policy — cannot be applied.",
      highImpact: false,
      requiresConfirmation: true,
      requiresApproval: true,
    };
  }

  const issues: PolicyValidationIssue[] = [];
  if (request.from !== spec.current) {
    issues.push({
      field: "stale",
      message: `${spec.title} changed since this preview was composed (expected ${spec.current}, got ${request.from}).`,
    });
  }
  issues.push(...validatePolicyValue(spec.id, request.to));
  if (!impact && options.impactError) {
    issues.push({ field: "impact", message: `Impact measurement failed: ${options.impactError}` });
  }

  const blocked = issues.length > 0;
  const risk = blocked
    ? "high"
    : (() => {
        const base = baseRisk(request.from, request.to);
        const escalated = impact && exceedsThresholds(spec, impact) ? "high" : base.risk;
        return maxRisk(base.risk, escalated);
      })();

  const base = baseRisk(request.from, request.to);
  const highImpact = !!impact && exceedsThresholds(spec, impact);
  const riskMessage = blocked
    ? "Blocked: resolve the issues below before applying."
    : highImpact
      ? "Measured impact exceeds the configured threshold; requires governance confirmation."
      : base.message;

  return {
    request,
    title: spec.title,
    kind: spec.kind,
    unit: spec.unit,
    validated: !blocked,
    state: blocked ? "blocked" : "valid",
    issues,
    impact,
    sideEffects: spec.sideEffects,
    affectedSurfaces: spec.affectedSurfaces,
    rollback: {
      reversible: spec.reversible,
      steps: spec.reversible
        ? [`Set ${spec.title} back to ${String(request.from)}${spec.unit ? ` ${spec.unit}` : ""}.`]
        : [],
      constraints: spec.rollbackConstraints,
    },
    risk,
    riskMessage,
    highImpact,
    requiresConfirmation: !blocked && (risk === "medium" || risk === "high" || highImpact || !spec.reversible),
    requiresApproval: risk === "high" || highImpact || !spec.reversible,
  };
}

function hash(input: string): string {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

function canonicalMeasurements(changes: PolicyChangePreview[]): string {
  return JSON.stringify(
    changes.map((change) => [
      change.request.policyId,
      change.request.from,
      change.request.to,
      change.impact?.affectedRecords ?? null,
      change.impact?.affectedUsers ?? null,
      change.impact?.measuredAt ?? null,
    ]),
  );
}

/**
 * Builds a full preview across one or more changes, measuring impact through
 * the injected source. A measurement failure marks that change blocked with
 * the error surfaced — the preview fails loudly instead of guessing.
 */
export async function createPolicyPreview(
  requests: PolicyChangeRequest[],
  impactSource: PolicyImpactSource,
  options: { createdAt?: string; author?: string } = {},
): Promise<PolicyPreview> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const author = options.author ?? "maintainer";

  const changes: PolicyChangePreview[] = [];
  for (const request of requests) {
    const spec = getPolicySpec(request.policyId);
    if (!spec) {
      changes.push(simulatePolicyChange(request, null));
      continue;
    }
    try {
      const impact = await impactSource.measure(request, spec);
      changes.push(simulatePolicyChange(request, impact));
    } catch (error) {
      changes.push(
        simulatePolicyChange(request, null, {
          impactError: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const sorted = [...changes].sort((a, b) => a.title.localeCompare(b.title));
  const valid = sorted.filter((change) => change.state === "valid");
  const irreversible = valid.filter((change) => !change.rollback.reversible);

  const rollbackSteps: string[] = [];
  const rollbackConstraints: string[] = [];
  for (const change of valid) {
    rollbackSteps.push(...change.rollback.steps);
    rollbackConstraints.push(...change.rollback.constraints);
  }

  const summary = {
    total: sorted.length,
    valid: valid.length,
    blocked: sorted.length - valid.length,
    highImpact: valid.filter((change) => change.highImpact).length,
    irreversible: irreversible.length,
    totalAffectedRecords: valid.reduce((sum, change) => sum + (change.impact?.affectedRecords ?? 0), 0),
    totalAffectedUsers: valid.reduce((sum, change) => sum + (change.impact?.affectedUsers ?? 0), 0),
  };

  const rollbackPlan: PolicyRollbackPlan = {
    reversible: irreversible.length === 0,
    steps: [...new Set(rollbackSteps)],
    constraints: [...new Set(rollbackConstraints)],
  };
  if (!rollbackPlan.reversible) {
    rollbackPlan.warning =
      "This plan contains irreversible changes. Confirmation authorizes the change; it does not make the change reversible.";
  }

  const confirmationToken = hash(
    JSON.stringify([sorted.map((change) => [change.request.policyId, change.request.to, change.state]), canonicalMeasurements(sorted)]),
  );

  return {
    schema: "vaultquest.policy-simulation.v1",
    id: `policy-sim-${hash(JSON.stringify(canonicalMeasurements(sorted)))}-${hash(createdAt)}`,
    createdAt,
    author,
    changes: sorted,
    summary,
    rollbackPlan,
    confirmationToken,
  };
}

export interface PolicyApplicationPlan {
  schema: "vaultquest.policy-application-plan.v1";
  previewId: string;
  createdAt: string;
  author: string;
  changes: Array<{ policyId: string; from: PolicyValue; to: PolicyValue }>;
  irreversibleAcknowledged: boolean;
  /** Always false: persistence is the caller's responsibility. */
  activated: false;
  /** Steps the operator/backend must perform after (or instead of) persisting. */
  rollbackSteps: string[];
}

export interface PreparePolicyApplicationOptions {
  author?: string;
  confirmedToken?: string;
  /** Explicit acknowledgement for previews containing irreversible changes. */
  acknowledgeIrreversible?: boolean;
}

/**
 * Validates a preview and returns a plan the caller may persist. Refuses when:
 *
 *  - any change is blocked,
 *  - the preview requires confirmation and the exact token is missing/stale,
 *  - the preview contains irreversible changes without explicit acknowledgement.
 *
 * The returned plan is never marked activated; the caller records activation
 * and must replay `rollbackSteps` from the preview if the change is reverted.
 */
export function preparePolicyApplication(
  preview: PolicyPreview,
  options: PreparePolicyApplicationOptions = {},
): PolicyApplicationPlan {
  const blocked = preview.changes.filter((change) => change.state === "blocked");
  if (blocked.length > 0) {
    throw new UnknownPolicyError(
      `Cannot apply a blocked preview: ${blocked.map((change) => change.title).join(", ")}.`,
    );
  }
  const requiresConfirmation = preview.changes.some((change) => change.requiresConfirmation) || !preview.rollbackPlan.reversible;
  if (requiresConfirmation && options.confirmedToken !== preview.confirmationToken) {
    if (options.confirmedToken === undefined) throw new PolicyConfirmationRequiredError();
    throw new PolicyPreviewStaleError();
  }
  if (!preview.rollbackPlan.reversible && options.acknowledgeIrreversible !== true) {
    throw new IrreversiblePolicyError();
  }

  return {
    schema: "vaultquest.policy-application-plan.v1",
    previewId: preview.id,
    createdAt: options.author ? preview.createdAt : preview.createdAt,
    author: options.author ?? preview.author,
    changes: preview.changes.map((change) => ({
      policyId: change.request.policyId,
      from: change.request.from,
      to: change.request.to,
    })),
    irreversibleAcknowledged: !preview.rollbackPlan.reversible,
    activated: false,
    rollbackSteps: preview.rollbackPlan.steps,
  };
}

/** Serializes a preview as a download-ready JSON payload. */
export function serializePolicyPreview(preview: PolicyPreview): string {
  return `${JSON.stringify(preview, null, 2)}\n`;
}

/** Parses a preview payload; returns null for malformed input. */
export function parsePolicyPreview(raw: string): PolicyPreview | null {
  try {
    const parsed = JSON.parse(raw) as PolicyPreview;
    if (parsed.schema !== "vaultquest.policy-simulation.v1") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function policyRiskRank(risk: PolicyRiskLevel): number {
  return { none: 0, low: 1, medium: 2, high: 3 }[risk];
}
