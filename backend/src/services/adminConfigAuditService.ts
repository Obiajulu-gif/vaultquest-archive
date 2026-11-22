/**
 * Administrative Configuration Audit Evidence Service (#991).
 *
 * Implements tamper-evident, exportable audit evidence bundles for all administrative
 * configuration changes (protocol parameters, feature flags, governance thresholds,
 * and system limits).
 *
 * Guarantees:
 *  1. Append-only cryptographic hash chain:
 *     recordHash = sha256(canonicalJson(record - recordHash)), where payload includes prevRecordHash.
 *  2. Stringency validation and parameter simulation integration (lib/admin-parameter-simulation.js).
 *  3. Mandatory authorization check: only 'maintainer', 'admin', or 'system' actors may record changes.
 *  4. Mandatory justification rationale for high-risk or overridden changes.
 *  5. Merkle root verification and full chain integrity verification (ALTERED, BROKEN_LINK, SEQUENCE_GAP).
 *  6. Safe rollback evidence creation that restores previous parameters while preserving the hash chain.
 *  7. Multi-format exportable evidence (JSON, NDJSON, CSV) for audit inspections.
 *
 * Time & Space Complexity:
 *  - record: O(1) time, O(1) space
 *  - verifyEvidenceChain: O(N) time, O(1) space
 *  - exportEvidence: O(N) time, O(N) space
 */

import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../utils/canonicalJson.js";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import {
  getParameterSpec,
  simulateParameterChange,
  type RiskLevel,
} from "../../../lib/admin-parameter-simulation.js";

export const ADMIN_CONFIG_GENESIS_HASH = "0".repeat(64);
export const ADMIN_CONFIG_EXPORT_MAX_ROWS = 5000;

export type AdminConfigCategory =
  | "protocol_parameter"
  | "feature_flag"
  | "governance"
  | "system_limit";

export type AdminActorRole = "maintainer" | "admin" | "system" | "user";

export interface AdminConfigActor {
  subject: string;
  role: AdminActorRole;
}

export interface AdminConfigChangeInput {
  parameterId: string;
  proposedValue: unknown;
  actor: AdminConfigActor;
  rationale: string;
  category?: AdminConfigCategory;
  proposalId?: string | null;
  txHash?: string | null;
  ledgerSequence?: number | null;
  overrideBlocked?: boolean;
  metadata?: Record<string, unknown> | null;
  occurredAt?: string;
}

export interface AdminConfigAuditRecord {
  id: string;
  sequence: number;
  category: AdminConfigCategory;
  parameterId: string;
  label: string;
  group: string;
  unit: string;
  previousValue: unknown;
  newValue: unknown;
  delta: number | null;
  relativeChange: number | null;
  riskLevel: RiskLevel;
  riskMessage: string;
  validationIssues: Array<{ field: string; message: string }>;
  overridden: boolean;
  actor: AdminConfigActor;
  rationale: string;
  proposalId: string | null;
  txHash: string | null;
  ledgerSequence: number | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
  prevRecordHash: string;
  recordHash: string;
}

export type AdminConfigVerificationProblemCode =
  | "INVALID_GENESIS"
  | "ALTERED"
  | "BROKEN_LINK"
  | "SEQUENCE_GAP";

export interface AdminConfigVerificationResult {
  ok: boolean;
  checked: number;
  problems: Array<{
    code: AdminConfigVerificationProblemCode;
    sequence: number;
    detail: string;
  }>;
}

export interface AdminConfigExportBundle {
  schema: "vaultquest.admin-config-audit.v1";
  exportedAt: string;
  exportedBy: string;
  totalRecords: number;
  headRecordHash: string;
  merkleRoot: string;
  records: AdminConfigAuditRecord[];
}

export interface AdminConfigQuery {
  category?: AdminConfigCategory;
  parameterId?: string;
  actorSubject?: string;
  since?: string;
  until?: string;
  limit?: number;
  beforeSequence?: number;
}

export class AdminConfigSequenceConflictError extends Error {
  constructor(sequence: number) {
    super(`Admin configuration audit sequence ${sequence} already exists`);
    this.name = "AdminConfigSequenceConflictError";
  }
}

export interface AdminConfigAuditStore {
  head(): Promise<{ sequence: number; recordHash: string } | null>;
  append(record: AdminConfigAuditRecord): Promise<void>;
  getById(id: string): Promise<AdminConfigAuditRecord | null>;
  query(q: AdminConfigQuery): Promise<AdminConfigAuditRecord[]>;
  scan(afterSequence: number, limit: number): Promise<AdminConfigAuditRecord[]>;
  getCurrentParameterValue(parameterId: string): Promise<unknown | undefined>;
}

export class InMemoryAdminConfigAuditStore implements AdminConfigAuditStore {
  private records: AdminConfigAuditRecord[] = [];
  private parameterCurrentValues = new Map<string, unknown>();

  async head(): Promise<{ sequence: number; recordHash: string } | null> {
    const last = this.records[this.records.length - 1];
    return last ? { sequence: last.sequence, recordHash: last.recordHash } : null;
  }

  async append(record: AdminConfigAuditRecord): Promise<void> {
    if (this.records.some((r) => r.sequence === record.sequence)) {
      throw new AdminConfigSequenceConflictError(record.sequence);
    }
    this.records.push(structuredClone(record));
    this.records.sort((a, b) => a.sequence - b.sequence);
    this.parameterCurrentValues.set(record.parameterId, record.newValue);
  }

  async getById(id: string): Promise<AdminConfigAuditRecord | null> {
    const found = this.records.find((r) => r.id === id);
    return found ? structuredClone(found) : null;
  }

  async query(q: AdminConfigQuery): Promise<AdminConfigAuditRecord[]> {
    const limit = Math.min(q.limit ?? 25, ADMIN_CONFIG_EXPORT_MAX_ROWS);
    return this.records
      .filter((r) => {
        if (q.beforeSequence !== undefined && r.sequence >= q.beforeSequence) return false;
        if (q.category && r.category !== q.category) return false;
        if (q.parameterId && r.parameterId !== q.parameterId) return false;
        if (q.actorSubject && r.actor.subject !== q.actorSubject) return false;
        if (q.since && r.occurredAt < q.since) return false;
        if (q.until && r.occurredAt >= q.until) return false;
        return true;
      })
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, limit);
  }

  async scan(afterSequence: number, limit: number): Promise<AdminConfigAuditRecord[]> {
    return this.records
      .filter((r) => r.sequence > afterSequence)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async getCurrentParameterValue(parameterId: string): Promise<unknown | undefined> {
    return this.parameterCurrentValues.get(parameterId);
  }

  /** Test helper: simulate altered data */
  tamperForTest(sequence: number, mutate: (record: AdminConfigAuditRecord) => void): void {
    const index = this.records.findIndex((r) => r.sequence === sequence);
    if (index < 0) throw new Error(`No record with sequence ${sequence}`);
    const copy = structuredClone(this.records[index]!);
    mutate(copy);
    this.records[index] = copy;
  }

  /** Test helper: simulate deleted row */
  deleteForTest(sequence: number): void {
    this.records = this.records.filter((r) => r.sequence !== sequence);
  }
}

export function computeAdminConfigRecordHash(
  record: Omit<AdminConfigAuditRecord, "recordHash">
): string {
  return createHash("sha256").update(canonicalJson(record as unknown as Record<string, unknown>)).digest("hex");
}

export function computeMerkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return createHash("sha256").update("EMPTY_TREE").digest("hex");
  let currentLayer = [...hashes];
  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i]!;
      const right = i + 1 < currentLayer.length ? currentLayer[i + 1]! : left;
      const combined = createHash("sha256").update(left + right).digest("hex");
      nextLayer.push(combined);
    }
    currentLayer = nextLayer;
  }
  return currentLayer[0]!;
}

export interface AdminConfigAuditServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  maxAppendRetries?: number;
}

export class AdminConfigAuditService {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: AdminConfigAuditStore = new InMemoryAdminConfigAuditStore(),
    private readonly options: AdminConfigAuditServiceOptions = {}
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private nextId(): string {
    return this.options.idFactory ? this.options.idFactory() : randomUUID();
  }

  /**
   * Records an administrative configuration change with simulation, validation,
   * authorization check, and cryptographic hash chain link.
   * Time Complexity: O(1). Space Complexity: O(1).
   */
  async recordConfigChange(input: AdminConfigChangeInput): Promise<AdminConfigAuditRecord> {
    // 1. Authorization check
    if (input.actor.role !== "maintainer" && input.actor.role !== "admin" && input.actor.role !== "system") {
      throw AppError.forbidden(
        "Only maintainers or administrators may record administrative configuration changes"
      );
    }

    // 2. Justification requirement
    const trimmedRationale = (input.rationale ?? "").trim();
    if (!trimmedRationale) {
      throw AppError.badRequest(
        ERROR_CODES.INVALID_PAYLOAD,
        "Rationale is mandatory for all administrative configuration changes"
      );
    }

    // 3. Serialized append to guarantee gap-free sequence and head consistency
    const run = this.tail.then(
      () => this.appendWithRetry(input),
      () => this.appendWithRetry(input)
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async appendWithRetry(input: AdminConfigChangeInput): Promise<AdminConfigAuditRecord> {
    const maxAttempts = Math.max(1, this.options.maxAppendRetries ?? 5);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const record = await this.buildRecord(input);
      try {
        await this.store.append(record);
        return record;
      } catch (err) {
        if (err instanceof AdminConfigSequenceConflictError) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new Error("Failed to append configuration audit record after max retries");
  }

  private async buildRecord(input: AdminConfigChangeInput): Promise<AdminConfigAuditRecord> {
    const head = await this.store.head();
    const sequence = head ? head.sequence + 1 : 1;
    const prevRecordHash = head ? head.recordHash : ADMIN_CONFIG_GENESIS_HASH;
    const occurredAt = input.occurredAt ?? this.now().toISOString();

    const spec = getParameterSpec(input.parameterId);
    const storedVal = await this.store.getCurrentParameterValue(input.parameterId);
    const previousValue = storedVal !== undefined ? storedVal : (spec ? spec.current : null);

    let label = spec?.label ?? input.parameterId;
    let group = spec?.group ?? "Governance";
    let unit = spec?.unit ?? "";
    let category: AdminConfigCategory = input.category ?? (spec ? "protocol_parameter" : "governance");
    let delta: number | null = null;
    let relativeChange: number | null = null;
    let riskLevel: RiskLevel = "low";
    let riskMessage = "Administrative configuration update";
    let validationIssues: Array<{ field: string; message: string }> = [];
    let overridden = false;

    if (spec && typeof input.proposedValue === "number") {
      const sim = simulateParameterChange(
        { paramId: input.parameterId, proposedValue: input.proposedValue },
        { overrideBlocked: input.overrideBlocked }
      );

      if (sim.blocked && !input.overrideBlocked) {
        throw AppError.badRequest(
          ERROR_CODES.INVALID_PAYLOAD,
          sim.blockedReason ?? `Proposed change to "${input.parameterId}" violates safety bounds`
        );
      }

      delta = sim.delta;
      relativeChange = sim.relativeChange;
      riskLevel = sim.riskLevel;
      riskMessage = sim.riskMessage;
      validationIssues = sim.issues;
      overridden = sim.overridden ?? false;
      label = sim.label;
      group = sim.group;
      unit = sim.unit;
    } else if (typeof input.proposedValue === "number" && typeof previousValue === "number") {
      delta = input.proposedValue - previousValue;
      relativeChange = Math.abs(delta) / Math.max(Math.abs(previousValue), Number.EPSILON);
      if (relativeChange > 0.5) riskLevel = "high";
      else if (relativeChange > 0.2) riskLevel = "medium";
    }

    const baseRecord: Omit<AdminConfigAuditRecord, "recordHash"> = {
      id: this.nextId(),
      sequence,
      category,
      parameterId: input.parameterId,
      label,
      group,
      unit,
      previousValue,
      newValue: input.proposedValue,
      delta,
      relativeChange,
      riskLevel,
      riskMessage,
      validationIssues,
      overridden,
      actor: input.actor,
      rationale: input.rationale,
      proposalId: input.proposalId ?? null,
      txHash: input.txHash ?? null,
      ledgerSequence: input.ledgerSequence ?? null,
      metadata: input.metadata ?? null,
      occurredAt,
      prevRecordHash,
    };

    const recordHash = computeAdminConfigRecordHash(baseRecord);

    return {
      ...baseRecord,
      recordHash,
    };
  }

  /**
   * Safely roll back a past administrative configuration change.
   * Restores the previous value while appending a verified rollback record.
   * Time Complexity: O(1). Space Complexity: O(1).
   */
  async createRollbackEvidence(
    targetEvidenceId: string,
    actor: AdminConfigActor,
    rationale: string
  ): Promise<AdminConfigAuditRecord> {
    const target = await this.store.getById(targetEvidenceId);
    if (!target) {
      throw AppError.notFound(`Administrative configuration record "${targetEvidenceId}" not found`);
    }

    return this.recordConfigChange({
      parameterId: target.parameterId,
      proposedValue: target.previousValue,
      actor,
      rationale: `Rollback of change ${target.id}: ${rationale}`,
      category: target.category,
      overrideBlocked: target.overridden,
      metadata: {
        rollbackOf: target.id,
        targetRecordHash: target.recordHash,
        targetSequence: target.sequence,
      },
    });
  }

  /**
   * Recomputes and verifies the complete hash chain from genesis to head.
   * Detects modified records (ALTERED), broken links, or deleted records (SEQUENCE_GAP).
   * Time Complexity: O(N). Space Complexity: O(1).
   */
  async verifyEvidenceChain(): Promise<AdminConfigVerificationResult> {
    let checked = 0;
    const problems: AdminConfigVerificationResult["problems"] = [];
    let expectedSequence = 1;
    let expectedPrevHash = ADMIN_CONFIG_GENESIS_HASH;

    let scanCursor = 0;
    const batchSize = 100;

    while (true) {
      const records = await this.store.scan(scanCursor, batchSize);
      if (records.length === 0) break;

      for (const record of records) {
        checked++;

        // 1. Check sequence monotonicity and gaps
        if (record.sequence !== expectedSequence) {
          problems.push({
            code: "SEQUENCE_GAP",
            sequence: record.sequence,
            detail: `Expected sequence ${expectedSequence} but encountered ${record.sequence}`,
          });
        }

        // 2. Check hash chain link
        if (record.prevRecordHash !== expectedPrevHash) {
          problems.push({
            code: record.sequence === 1 ? "INVALID_GENESIS" : "BROKEN_LINK",
            sequence: record.sequence,
            detail: `prevRecordHash ${record.prevRecordHash} does not match expected hash ${expectedPrevHash}`,
          });
        }

        // 3. Recompute record hash to detect tampering
        const { recordHash: storedHash, ...withoutHash } = record;
        const recomputedHash = computeAdminConfigRecordHash(withoutHash);
        if (recomputedHash !== storedHash) {
          problems.push({
            code: "ALTERED",
            sequence: record.sequence,
            detail: `Record hash mismatch at sequence ${record.sequence}: recomputed ${recomputedHash} !== stored ${storedHash}`,
          });
        }

        expectedSequence = record.sequence + 1;
        expectedPrevHash = record.recordHash;
        scanCursor = record.sequence;
      }
    }

    return {
      ok: problems.length === 0,
      checked,
      problems,
    };
  }

  /**
   * Exports administrative configuration evidence in JSON, NDJSON, or CSV format.
   * Time Complexity: O(N). Space Complexity: O(N).
   */
  async exportEvidence(
    query: AdminConfigQuery = {},
    format: "json" | "ndjson" | "csv" = "json",
    exportedBy: string = "system"
  ): Promise<string> {
    const records = await this.store.query({
      ...query,
      limit: ADMIN_CONFIG_EXPORT_MAX_ROWS,
    });

    const nowIso = this.now().toISOString();
    const sortedAsc = [...records].sort((a, b) => a.sequence - b.sequence);
    const hashes = sortedAsc.map((r) => r.recordHash);
    const merkleRoot = computeMerkleRoot(hashes);
    const headHash = sortedAsc.length > 0 ? sortedAsc[sortedAsc.length - 1]!.recordHash : ADMIN_CONFIG_GENESIS_HASH;

    if (format === "json") {
      const bundle: AdminConfigExportBundle = {
        schema: "vaultquest.admin-config-audit.v1",
        exportedAt: nowIso,
        exportedBy,
        totalRecords: sortedAsc.length,
        headRecordHash: headHash,
        merkleRoot,
        records: sortedAsc,
      };
      return JSON.stringify(bundle, null, 2);
    }

    if (format === "ndjson") {
      const header = JSON.stringify({
        _meta: "vaultquest.admin-config-audit.header.v1",
        exportedAt: nowIso,
        exportedBy,
        totalRecords: sortedAsc.length,
        merkleRoot,
        headRecordHash: headHash,
      });
      const lines = [header, ...sortedAsc.map((r) => JSON.stringify(r))];
      return lines.join("\n") + "\n";
    }

    // CSV format (RFC 4180 compliant)
    const headers = [
      "sequence",
      "id",
      "occurred_at",
      "category",
      "parameter_id",
      "label",
      "group",
      "previous_value",
      "new_value",
      "delta",
      "risk_level",
      "overridden",
      "actor_subject",
      "actor_role",
      "rationale",
      "tx_hash",
      "ledger_sequence",
      "prev_record_hash",
      "record_hash",
    ];

    const escapeCsv = (val: unknown): string => {
      if (val === null || val === undefined) return "";
      const str = typeof val === "object" ? JSON.stringify(val) : String(val);
      if (str.includes(",") || str.includes("\"") || str.includes("\n") || str.includes("\r")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const csvRows = sortedAsc.map((r) =>
      [
        r.sequence,
        r.id,
        r.occurredAt,
        r.category,
        r.parameterId,
        r.label,
        r.group,
        r.previousValue,
        r.newValue,
        r.delta ?? "",
        r.riskLevel,
        r.overridden,
        r.actor.subject,
        r.actor.role,
        r.rationale,
        r.txHash ?? "",
        r.ledgerSequence ?? "",
        r.prevRecordHash,
        r.recordHash,
      ]
        .map(escapeCsv)
        .join(",")
    );

    return [headers.join(","), ...csvRows].join("\n") + "\n";
  }
}
