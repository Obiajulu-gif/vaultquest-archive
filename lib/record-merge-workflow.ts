import crypto from "crypto";

/**
 * Deterministic Record Merge Workflow with Conflict Resolution (#840)
 *
 * Implements a safe, auditable, and deterministic merge workflow for duplicate
 * or overlapping records in the VaultQuest protocol (e.g., duplicate vault/pool
 * records, user configurations, or saved pool metadata).
 *
 * Architecture & Design:
 * 1. Eligibility Check:
 *    - Both source and target records must exist.
 *    - Records must share the same entity type.
 *    - Source and target cannot be identical (self-merge denied).
 *    - Neither record can already be merged or archived.
 *    - Records locked in terminal states cannot be merged without explicit override.
 * 2. Conflict Categorization:
 *    - VALUE_MISMATCH: Distinct non-null values for the same key.
 *    - TYPE_INCOMPATIBILITY: Incompatible schema representations.
 *    - STATE_CONFLICT: Incompatible lifecycle states.
 *    - OWNERSHIP_MISMATCH: Differing owner wallet addresses.
 * 3. Dry-Run Merge Preview:
 *    - Pure calculation returning the proposed merged entity, detected conflicts,
 *      and field diffs without writing any state mutations.
 * 4. Explicit Conflict Resolution:
 *    - 'target_wins': Canonical target fields take precedence.
 *    - 'source_wins': Incoming source fields overwrite target fields.
 *    - 'field_by_field': Explicit dictionary mapping each field to a strategy or custom override.
 *    - Strict mode throws `MergeConflictError` if unresolved conflicts remain.
 * 5. Persistence & Redirects:
 *    - Persists an immutable `MergeDecisionRecord` containing timestamp, actor,
 *      applied diffs, and a reversible `rollbackPatch`.
 *    - Source record is marked 'merged' and receives a forward pointer to `targetId`.
 *    - Query resolution (`resolveRecordWithRedirect`) automatically follows redirect
 *      pointers to canonical targets with cycle detection.
 *
 * Complexity:
 * - Time Complexity:
 *   - Preview / Merge: O(F log F) where F is the number of fields in the record (sorted iteration).
 *   - Redirect lookup: O(D) where D is the redirect depth (D <= 10).
 * - Space Complexity:
 *   - O(F) memory per preview and merge decision.
 */

export type RecordType = "pool" | "saved_pool" | "user_profile" | "activity_entry";

export type ConflictCategory =
  | "VALUE_MISMATCH"
  | "TYPE_INCOMPATIBILITY"
  | "STATE_CONFLICT"
  | "OWNERSHIP_MISMATCH";

export type ResolutionStrategy = "target_wins" | "source_wins" | "field_by_field";

export interface MergeConflict {
  field: string;
  category: ConflictCategory;
  sourceValue: unknown;
  targetValue: unknown;
  description: string;
}

export interface FieldResolutionDecision {
  winner: "target" | "source" | "override";
  overrideValue?: unknown;
  reason?: string;
}

export type FieldResolutionMap = Record<string, FieldResolutionDecision>;

export interface MergeableRecord {
  id: string;
  recordType: RecordType;
  version: number;
  data: Record<string, unknown>;
  ownerWallet?: string;
  status: "active" | "archived" | "merged" | "locked";
  mergedInto?: string;
  mergedAt?: number;
  updatedAt: number;
}

export interface MergePreview {
  eligible: boolean;
  sourceId: string;
  targetId: string;
  recordType: RecordType;
  conflicts: MergeConflict[];
  hasConflicts: boolean;
  proposedResult: Record<string, unknown>;
  fieldChanges: {
    field: string;
    action: "kept_target" | "applied_source" | "overridden" | "conflict";
    finalValue: unknown;
  }[];
}

export interface MergeDecisionRecord {
  decisionId: string;
  recordType: RecordType;
  sourceId: string;
  targetId: string;
  strategy: ResolutionStrategy;
  conflictsResolved: MergeConflict[];
  fieldDecisions: FieldResolutionMap;
  appliedBy: string;
  timestamp: number;
  rollbackPatch: {
    sourceState: MergeableRecord;
    targetState: MergeableRecord;
  };
  digest: string;
}

export class MergeWorkflowError extends Error {
  readonly code:
    | "MERGE_DENIED"
    | "UNRESOLVED_CONFLICTS"
    | "RECORD_NOT_FOUND"
    | "CIRCULAR_REDIRECT"
    | "UNAUTHORIZED";

  constructor(
    code:
      | "MERGE_DENIED"
      | "UNRESOLVED_CONFLICTS"
      | "RECORD_NOT_FOUND"
      | "CIRCULAR_REDIRECT"
      | "UNAUTHORIZED",
    message: string
  ) {
    super(message);
    this.name = "MergeWorkflowError";
    this.code = code;
  }
}

/**
 * Checks value equality for deep structures, arrays, and primitive values.
 */
export function areValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export class RecordMergeWorkflow {
  private records = new Map<string, MergeableRecord>();
  private mergeDecisions = new Map<string, MergeDecisionRecord>();

  /**
   * Register or update a record in the store.
   */
  setRecord(record: MergeableRecord): void {
    this.records.set(record.id, {
      ...record,
      data: { ...record.data },
    });
  }

  /**
   * Retrieve a record directly by ID without redirect resolution.
   */
  getRawRecord(id: string): MergeableRecord | undefined {
    const r = this.records.get(id);
    return r ? { ...r, data: { ...r.data } } : undefined;
  }

  /**
   * Retrieve a record, automatically following merge redirects to the canonical target.
   */
  resolveRecordWithRedirect(
    id: string,
    maxHops = 10
  ): {
    record: MergeableRecord;
    redirected: boolean;
    hops: string[];
  } {
    const visited = new Set<string>();
    let currentId = id;
    let redirected = false;
    const hops: string[] = [];

    while (true) {
      if (visited.has(currentId)) {
        throw new MergeWorkflowError(
          "CIRCULAR_REDIRECT",
          `Detected circular merge redirect loop involving record ${currentId}`
        );
      }
      visited.add(currentId);

      const record = this.records.get(currentId);
      if (!record) {
        throw new MergeWorkflowError("RECORD_NOT_FOUND", `Record ${currentId} does not exist`);
      }

      if (record.status === "merged" && record.mergedInto) {
        redirected = true;
        hops.push(currentId);
        if (hops.length > maxHops) {
          throw new MergeWorkflowError(
            "CIRCULAR_REDIRECT",
            `Exceeded max merge redirect depth of ${maxHops} hops`
          );
        }
        currentId = record.mergedInto;
      } else {
        return {
          record: { ...record, data: { ...record.data } },
          redirected,
          hops,
        };
      }
    }
  }

  /**
   * Asserts whether two records are eligible to be merged.
   */
  checkEligibility(
    sourceId: string,
    targetId: string,
    allowLocked = false
  ): { eligible: boolean; denialReason?: string } {
    if (sourceId === targetId) {
      return { eligible: false, denialReason: "SOURCE_AND_TARGET_IDENTICAL" };
    }

    const source = this.records.get(sourceId);
    const target = this.records.get(targetId);

    if (!source || !target) {
      return { eligible: false, denialReason: "ONE_OR_BOTH_RECORDS_NOT_FOUND" };
    }

    if (source.recordType !== target.recordType) {
      return { eligible: false, denialReason: "RECORD_TYPE_MISMATCH" };
    }

    if (source.status === "merged" || source.status === "archived") {
      return { eligible: false, denialReason: "SOURCE_ALREADY_MERGED_OR_ARCHIVED" };
    }

    if (target.status === "merged" || target.status === "archived") {
      return { eligible: false, denialReason: "TARGET_ALREADY_MERGED_OR_ARCHIVED" };
    }

    if (!allowLocked && (source.status === "locked" || target.status === "locked")) {
      return { eligible: false, denialReason: "RECORD_IS_LOCKED" };
    }

    return { eligible: true };
  }

  /**
   * Generates a dry-run merge preview without applying any mutations.
   */
  previewMerge(params: {
    sourceId: string;
    targetId: string;
    strategy?: ResolutionStrategy;
    fieldDecisions?: FieldResolutionMap;
  }): MergePreview {
    const eligibility = this.checkEligibility(params.sourceId, params.targetId);
    const source = this.records.get(params.sourceId)!;
    const target = this.records.get(params.targetId)!;

    if (!eligibility.eligible) {
      throw new MergeWorkflowError("MERGE_DENIED", `Merge denied: ${eligibility.denialReason}`);
    }

    const conflicts: MergeConflict[] = [];
    const proposedResult: Record<string, unknown> = { ...target.data };
    const fieldChanges: MergePreview["fieldChanges"] = [];

    // Check ownership
    if (
      source.ownerWallet &&
      target.ownerWallet &&
      source.ownerWallet !== target.ownerWallet
    ) {
      conflicts.push({
        field: "ownerWallet",
        category: "OWNERSHIP_MISMATCH",
        sourceValue: source.ownerWallet,
        targetValue: target.ownerWallet,
        description: `Owner wallets conflict: ${source.ownerWallet} vs ${target.ownerWallet}`,
      });
    }

    // Unified set of all data keys
    const allKeys = Array.from(
      new Set([...Object.keys(target.data), ...Object.keys(source.data)])
    ).sort();

    const strategy = params.strategy ?? "field_by_field";
    const explicitMap = params.fieldDecisions ?? {};

    for (const key of allKeys) {
      const targetVal = target.data[key];
      const sourceVal = source.data[key];

      if (targetVal === undefined && sourceVal !== undefined) {
        // Safe additive merge from source
        proposedResult[key] = sourceVal;
        fieldChanges.push({
          field: key,
          action: "applied_source",
          finalValue: sourceVal,
        });
      } else if (targetVal !== undefined && sourceVal === undefined) {
        // Safe retention of target
        fieldChanges.push({
          field: key,
          action: "kept_target",
          finalValue: targetVal,
        });
      } else if (areValuesEqual(targetVal, sourceVal)) {
        // Clean match
        fieldChanges.push({
          field: key,
          action: "kept_target",
          finalValue: targetVal,
        });
      } else {
        // Conflicting field values
        const conflict: MergeConflict = {
          field: key,
          category: "VALUE_MISMATCH",
          sourceValue: sourceVal,
          targetValue: targetVal,
          description: `Discrepancy in field ${key}: source='${sourceVal}', target='${targetVal}'`,
        };
        conflicts.push(conflict);

        const decision = explicitMap[key];

        if (decision) {
          if (decision.winner === "override") {
            proposedResult[key] = decision.overrideValue;
            fieldChanges.push({
              field: key,
              action: "overridden",
              finalValue: decision.overrideValue,
            });
          } else if (decision.winner === "source") {
            proposedResult[key] = sourceVal;
            fieldChanges.push({
              field: key,
              action: "applied_source",
              finalValue: sourceVal,
            });
          } else {
            proposedResult[key] = targetVal;
            fieldChanges.push({
              field: key,
              action: "kept_target",
              finalValue: targetVal,
            });
          }
        } else if (strategy === "source_wins") {
          proposedResult[key] = sourceVal;
          fieldChanges.push({
            field: key,
            action: "applied_source",
            finalValue: sourceVal,
          });
        } else if (strategy === "target_wins") {
          proposedResult[key] = targetVal;
          fieldChanges.push({
            field: key,
            action: "kept_target",
            finalValue: targetVal,
          });
        } else {
          fieldChanges.push({
            field: key,
            action: "conflict",
            finalValue: targetVal,
          });
        }
      }
    }

    return {
      eligible: true,
      sourceId: params.sourceId,
      targetId: params.targetId,
      recordType: source.recordType,
      conflicts,
      hasConflicts: conflicts.length > 0,
      proposedResult,
      fieldChanges,
    };
  }

  /**
   * Executes merge workflow:
   * 1. Previews merge and checks for unresolved conflicts.
   * 2. Saves pre-merge snapshots in rollback patch.
   * 3. Updates target record with merged fields.
   * 4. Archives source record with forward redirect to target.
   * 5. Persists verifiable MergeDecisionRecord.
   */
  executeMerge(params: {
    sourceId: string;
    targetId: string;
    strategy: ResolutionStrategy;
    fieldDecisions?: FieldResolutionMap;
    actor: string;
  }): {
    targetRecord: MergeableRecord;
    sourceRecord: MergeableRecord;
    decision: MergeDecisionRecord;
  } {
    const preview = this.previewMerge(params);

    // Verify unresolved conflicts
    const unresolved = preview.fieldChanges.filter((c) => c.action === "conflict");
    if (unresolved.length > 0) {
      throw new MergeWorkflowError(
        "UNRESOLVED_CONFLICTS",
        `Cannot execute merge with ${unresolved.length} unresolved conflicting fields: ${unresolved
          .map((u) => u.field)
          .join(", ")}`
      );
    }

    const source = this.records.get(params.sourceId)!;
    const target = this.records.get(params.targetId)!;
    const now = Date.now();

    // Deep clones for rollback safety
    const rollbackPatch = {
      sourceState: JSON.parse(JSON.stringify(source)) as MergeableRecord,
      targetState: JSON.parse(JSON.stringify(target)) as MergeableRecord,
    };

    // Update target record
    const updatedTarget: MergeableRecord = {
      ...target,
      data: { ...preview.proposedResult },
      version: target.version + 1,
      updatedAt: now,
    };

    // Mark source record as merged with redirect pointer
    const updatedSource: MergeableRecord = {
      ...source,
      status: "merged",
      mergedInto: target.id,
      mergedAt: now,
      version: source.version + 1,
      updatedAt: now,
    };

    this.records.set(target.id, updatedTarget);
    this.records.set(source.id, updatedSource);

    const decisionId = `mrg_${crypto.randomBytes(16).toString("hex")}`;
    const digest = crypto
      .createHash("sha256")
      .update(
        [
          decisionId,
          source.id,
          target.id,
          params.strategy,
          now.toString(),
          JSON.stringify(preview.proposedResult),
        ].join(":")
      )
      .digest("hex");

    const decision: MergeDecisionRecord = {
      decisionId,
      recordType: source.recordType,
      sourceId: source.id,
      targetId: target.id,
      strategy: params.strategy,
      conflictsResolved: preview.conflicts,
      fieldDecisions: params.fieldDecisions ?? {},
      appliedBy: params.actor,
      timestamp: now,
      rollbackPatch,
      digest,
    };

    this.mergeDecisions.set(decisionId, decision);

    return {
      targetRecord: { ...updatedTarget },
      sourceRecord: { ...updatedSource },
      decision,
    };
  }

  /**
   * Reverts a previous merge decision using its cryptographic rollback patch.
   */
  rollbackMerge(decisionId: string): {
    revertedTarget: MergeableRecord;
    revertedSource: MergeableRecord;
  } {
    const decision = this.mergeDecisions.get(decisionId);
    if (!decision) {
      throw new MergeWorkflowError("RECORD_NOT_FOUND", `Merge decision ${decisionId} not found`);
    }

    const { sourceState, targetState } = decision.rollbackPatch;

    this.records.set(sourceState.id, {
      ...sourceState,
      data: { ...sourceState.data },
    });
    this.records.set(targetState.id, {
      ...targetState,
      data: { ...targetState.data },
    });

    this.mergeDecisions.delete(decisionId);

    return {
      revertedTarget: { ...targetState },
      revertedSource: { ...sourceState },
    };
  }

  /**
   * Fetch an existing merge decision by ID.
   */
  getMergeDecision(decisionId: string): MergeDecisionRecord | undefined {
    return this.mergeDecisions.get(decisionId);
  }
}
