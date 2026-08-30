/**
 * Admin parameter simulation, risk, and diff preview (#649).
 *
 * The admin settings page is governance-controlled and read-only, so proposed
 * changes are validated and *simulated* before any write is drafted. This
 * module:
 *
 *  - catalogs live protocol parameters with numeric bounds (stringents such as
 *    the 0.5 bp treasury fee floor),
 *  - validates proposed values against bounds / integer rules / cross-parameter
 *    invariants (max deposit >= min deposit),
 *  - assesses risk from relative magnitude of the change,
 *  - produces an ordered before→after diff preview plus a download-ready JSON
 *    payload for the governance proposal.
 *
 * Everything is pure and deterministic (pinned `createdAt` ⇔ identical bytes).
 */

export type RiskLevel = "none" | "low" | "medium" | "high";
export type ParamGroup = "Schedule" | "Deposits" | "Treasury" | "Governance" | "Failsafe";

export interface ParameterSpec {
  id: string;
  label: string;
  group: ParamGroup;
  unit: string;
  description: string;
  current: number;
  min?: number;
  max?: number;
  /** Values must be whole numbers when true. */
  integer?: boolean;
  /** Services / contracts the value is pushed to. */
  affectedServices: string[];
  /** Short human summary of the ripple effect of a change. */
  projection: string;
  /** Bounds message shown to operators (stringent explanation). */
  boundaryNote?: string;
}

export interface ParameterProposal {
  paramId: string;
  proposedValue: number;
  rationale?: string;
}

export interface ValidationIssue {
  field: "value" | "range" | "cross-parameter" | "type";
  message: string;
}

export interface SimulationResult {
  paramId: string;
  label: string;
  group: ParamGroup;
  unit: string;
  fromValue: number;
  toValue: number;
  delta: number;
  /** Signed relative change (from → to). */
  relativeChange: number;
  validated: boolean;
  issues: ValidationIssue[];
  riskLevel: RiskLevel;
  riskMessage: string;
  affectedServices: string[];
  projection: string;
  /** True when the change was force-approved past a blocked stringency. */
  overridden?: boolean;
  /** True when the change is blocked by an invariant unless overridden. */
  blocked: boolean;
  blockedReason?: string;
  needsConfirmation: boolean;
}

export interface DiffPreview {
  id: string;
  schema: "vaultquest.admin.param-simulation.v1";
  createdAt: string;
  author: string;
  proposals: ParameterProposal[];
  results: SimulationResult[];
  conflicts: string[];
  summary: {
    total: number;
    valid: number;
    blocked: number;
    highRisk: number;
    noneToHigh: number;
  };
}

export const PROTOCOL_PARAMETER_CATALOG: ParameterSpec[] = [
  {
    id: "roundCadenceDays",
    label: "Round duration",
    group: "Schedule",
    unit: "days",
    description: "New rounds auto-open on this cadence.",
    current: 7,
    min: 1,
    max: 90,
    integer: true,
    affectedServices: ["smart contract", "backend api", "notification relay"],
    projection: "Shifts every round's open/lock/draw deadline and the drafting schedule.",
    boundaryNote: "Cadence must stay within 1–90 days.",
  },
  {
    id: "minDepositUnits",
    label: "Minimum deposit",
    group: "Deposits",
    unit: "XLM",
    description: "Keeps operational churn low for small deposits.",
    current: 100,
    min: 1,
    affectedServices: ["smart contract", "backend api"],
    projection: "Smaller/ larger deposits become eligible at the contract layer for new rounds.",
    boundaryNote: "Must stay below the maximum deposit per vault.",
  },
  {
    id: "maxDepositPerVaultUnits",
    label: "Maximum deposit per vault",
    group: "Deposits",
    unit: "XLM",
    description: "Prevents single-wallet concentration risk.",
    current: 250000,
    min: 1,
    max: 1000000000,
    integer: true,
    affectedServices: ["smart contract", "backend api"],
    projection: "Caps the eligible deposit a single wallet can route into a vault.",
    boundaryNote: "Must stay above the minimum deposit per vault.",
  },
  {
    id: "treasuryFeeBps",
    label: "Treasury fee",
    group: "Treasury",
    unit: "bps",
    description: "Applied to routed yield before prize allocation.",
    current: 75,
    min: 0.5,
    max: 100,
    affectedServices: ["smart contract", "backend api", "indexer"],
    projection: "Higher fee → more treasury, less prize pool; lower fee is the inverse.",
    boundaryNote: "Hard floor of 0.5 bp (0.005%) — fee may not go below it.",
  },
  {
    id: "settlementQuorumOfFive",
    label: "Settlement quorum",
    group: "Governance",
    unit: "of 5",
    description: "Requires multisig approval for admin writes.",
    current: 3,
    min: 1,
    max: 5,
    integer: true,
    affectedServices: ["backend api", "notification relay"],
    projection: "Changes how many signers must approve settlement before execution.",
    boundaryNote: "Must stay within 1–5 signers.",
  },
  {
    id: "emergencyPauseThresholdAttempts",
    label: "Emergency pause threshold",
    group: "Failsafe",
    unit: "failed attempts",
    description: "Triggers manual review before retrying settlement.",
    current: 2,
    min: 1,
    max: 10,
    integer: true,
    affectedServices: ["smart contract", "notification relay", "backend api"],
    projection: "Lower values pause more aggressively; higher values defer the review.",
    boundaryNote: "Must stay within 1–10 failed attempts.",
  },
];

export const PROTOCOL_PARAMETER_INDEX: Record<string, ParameterSpec> = Object.fromEntries(
  PROTOCOL_PARAMETER_CATALOG.map((spec) => [spec.id, spec]),
);

export function getParameterSpec(paramId: string): ParameterSpec | undefined {
  return PROTOCOL_PARAMETER_INDEX[paramId];
}

const RISK_STEPS: { upTo: number; level: RiskLevel; message: string }[] = [
  { upTo: 0.1, level: "none", message: "Small, within normal operating variance." },
  { upTo: 0.3, level: "low", message: "Noticeable but bounded change; monitor after push." },
  { upTo: 0.5, level: "medium", message: "Material change; requires governance review." },
  { upTo: Infinity, level: "high", message: "Large change; high operational impact." },
];

function relativeRisk(fromValue: number, toValue: number): { level: RiskLevel; message: string } {
  const magnitude = Math.abs(toValue - fromValue) / Math.max(Math.abs(fromValue), Number.EPSILON);
  return RISK_STEPS.find((step) => magnitude <= step.upTo) ?? RISK_STEPS[RISK_STEPS.length - 1];
}

/** Bounds check + type check + cross-parameter invariants for one proposal. */
export function validateProposedParameter(
  paramId: string,
  proposedValue: number,
  options: { otherProposals?: ParameterProposal[] } = {},
): { valid: boolean; issues: ValidationIssue[] } {
  const spec = getParameterSpec(paramId);
  if (!spec) {
    return { valid: false, issues: [{ field: "type", message: `Unknown parameter "${paramId}".` }] };
  }
  const issues: ValidationIssue[] = [];
  const value = Number(proposedValue);
  if (!Number.isFinite(value)) {
    issues.push({ field: "type", message: "Proposed value must be a finite number." });
  }
  if (spec.integer && Number.isFinite(value) && !Number.isInteger(value)) {
    issues.push({ field: "type", message: `${spec.label} must be a whole number.` });
  }
  if (spec.min !== undefined && value < spec.min) {
    issues.push({ field: "range", message: `${spec.label} may not go below ${spec.min} ${spec.unit}.` });
  }
  if (spec.max !== undefined && value > spec.max) {
    issues.push({ field: "range", message: `${spec.label} may not exceed ${spec.max} ${spec.unit}.` });
  }

  const others = options.otherProposals ?? [];
  const minProposal = others.find((p) => p.paramId === "minDepositUnits");
  if (paramId === "maxDepositPerVaultUnits" && minProposal && value < minProposal.proposedValue) {
    issues.push({ field: "cross-parameter", message: "Maximum deposit may not fall below the proposed minimum deposit." });
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Simulates one parameter change and formats the before→after diff. A proposal
 * that violates a stringency is `blocked` unless `override` is supplied; the
 * diff preview still records it so operators can see what was rejected.
 */
export function simulateParameterChange(
  proposal: ParameterProposal,
  options: { overrideBlocked?: boolean } = {},
): SimulationResult {
  const spec = getParameterSpec(proposal.paramId);
  if (!spec) {
    return {
      paramId: proposal.paramId,
      label: proposal.paramId,
      group: "Governance",
      unit: "",
      fromValue: NaN,
      toValue: proposal.proposedValue,
      delta: NaN,
      relativeChange: NaN,
      validated: false,
      issues: [{ field: "type", message: `Unknown parameter "${proposal.paramId}".` }],
      riskLevel: "high",
      riskMessage: "Unknown parameter — cannot be applied.",
      affectedServices: [],
      projection: "",
      blocked: true,
      blockedReason: "Unknown parameter.",
      needsConfirmation: false,
    };
  }

  const fromValue = spec.current;
  const toValue = Number(proposal.proposedValue);
  const { valid, issues } = validateProposedParameter(proposal.paramId, toValue);
  const relativeChange = Math.abs(fromValue - toValue) / Math.max(Math.abs(fromValue), Number.EPSILON);
  const risk = relativeRisk(fromValue, toValue);

  // Stringency-driven blocking rules beyond plain bounds.
  let blocked = false;
  let blockedReason: string | undefined;
  const hardIssue = issues.find((issue) => issue.field === "range" || issue.field === "type" || issue.field === "cross-parameter");
  if (valid === false && hardIssue) {
    blocked = true;
    blockedReason = hardIssue.message;
  }
  if (proposal.paramId === "treasuryFeeBps" && toValue < 0.5) {
    blocked = true;
    blockedReason = "Treasury fee may not go below the 0.5 bp stringency.";
  } else if (proposal.paramId === "maxDepositPerVaultUnits" && toValue < fromValue * 0.5) {
    blocked = true;
    blockedReason = "Halving the per-vault cap mid-round risks failed deposits; requires override.";
  }

  const overridden = blocked && options.overrideBlocked === true;
  if (overridden) blocked = false;

  return {
    paramId: spec.id,
    label: spec.label,
    group: spec.group,
    unit: spec.unit,
    fromValue,
    toValue,
    delta: toValue - fromValue,
    relativeChange,
    validated: valid,
    issues,
    riskLevel: risk.level,
    riskMessage: risk.message,
    affectedServices: spec.affectedServices,
    projection: spec.projection,
    overridden,
    blocked,
    blockedReason,
    needsConfirmation: !valid || blocked || risk.level === "high" || risk.level === "medium",
  };
}

/** Rounds a value to the parameter's sensible display precision. */
export function formatSimulatedValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—";
  const precision = Number.isInteger(value) ? 0 : Math.min(2, String(value).split(".")[1]?.length ?? 0);
  return `${value.toFixed(precision).replace(/\.0+$/, "")} ${unit}`.trim();
}

/**
 * Builds the diff preview across one or more proposals. Conflicting proposals
 * (same parameter twice, or a max-deposit below a min-deposit) are surfaced.
 */
export function createParameterDiffPreview(
  proposals: ParameterProposal[],
  options: { createdAt?: string; author?: string; overrideBlocked?: boolean } = {},
): DiffPreview {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const author = options.author ?? "maintainer";

  const results = proposals.map((proposal) =>
    simulateParameterChange(proposal, { overrideBlocked: options.overrideBlocked }),
  );

  const conflicts: string[] = [];
  const seen = new Map<string, number>();
  for (const proposal of proposals) {
    if (!getParameterSpec(proposal.paramId)) continue;
    if (seen.has(proposal.paramId)) {
      conflicts.push(`Parameter "${proposal.paramId}" is proposed more than once.`);
    }
    seen.set(proposal.paramId, proposal.proposedValue);
  }
  if (
    seen.has("maxDepositPerVaultUnits") &&
    seen.has("minDepositUnits") &&
    seen.get("maxDepositPerVaultUnits")! < seen.get("minDepositUnits")!
  ) {
    conflicts.push("Proposed maximum deposit is below the proposed minimum deposit.");
  }

  const sortedResults = [...results].sort((a, b) => a.label.localeCompare(b.label));

  const summary = {
    total: results.length,
    valid: results.filter((r) => r.validated).length,
    blocked: results.filter((r) => r.blocked).length,
    highRisk: results.filter((r) => r.riskLevel === "high").length,
    noneToHigh: results.filter((r) => r.riskLevel !== "none").length,
  };

  return {
    id: `sim-${hashForPreview(JSON.stringify(proposals), createdAt)}`,
    schema: "vaultquest.admin.param-simulation.v1",
    createdAt,
    author,
    proposals,
    results: sortedResults,
    conflicts,
    summary,
  };
}

function hashForPreview(input: string, salt: string): string {
  let hash = 2166136261;
  const combined = `${input}|${salt}`;
  for (let i = 0; i < combined.length; i += 1) {
    hash ^= combined.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Serializes the preview as a download-ready JSON payload. */
export function serializeDiffPreview(preview: DiffPreview): string {
  return `${JSON.stringify(preview, null, 2)}\n`;
}

/** Parses a diff preview payload; returns null for malformed input. */
export function parseDiffPreview(raw: string): DiffPreview | null {
  try {
    const parsed = JSON.parse(raw) as DiffPreview;
    if (parsed.schema !== "vaultquest.admin.param-simulation.v1") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function riskLevelRank(level: RiskLevel): number {
  return { none: 0, low: 1, medium: 2, high: 3 }[level];
}