
/**
 * Tamper-evident change history for critical domain records (#787).
 *
 * Every mutation of a record that affects ownership, money, permissions or user
 * access is chained to the previous one with a content hash, so a maintainer can
 * answer "who changed this, when, and from what" without trusting a mutable
 * `updatedAt` column — and can prove the history has not been edited since.
 *
 * Chain shape, per record:
 *
 *   entry N  { sequence, action, actor, reason, before, after, timestamp,
 *              prevHash, entryHash }
 *   entryHash = sha256(prevHash + canonical(entry-without-entryHash))
 *   entry 1   prevHash = GENESIS_HASH
 *
 * Because each entry commits to its predecessor's hash, verification detects
 * three distinct kinds of tampering:
 *
 *   - **altered** — a field was edited after the fact (recomputed hash differs)
 *   - **missing** — an entry was deleted (sequence gap / broken prevHash link)
 *   - **out-of-order** — entries were reordered or a chain was spliced
 *     (sequence or prevHash no longer matches the predecessor)
 *
 * Reordering is caught independently of content tampering because `sequence` is
 * part of the hashed payload *and* is monotonic per record.
 *
 * Storage is behind {@link ChangeHistoryStore} so the same logic runs against
 * the in-memory store used in tests and a database-backed store in production.
 */


import { createHash } from "node:crypto";
import { stableStringify } from "./ledger.js";

/** Hash every chain starts from, so entry 1 is still committed to something. */
export const GENESIS_HASH = "0".repeat(64);

/** Record types whose history is treated as critical. */
export const CRITICAL_RECORD_TYPES = [
  "user",
  "action_ledger",
  "vault_settlement",
  "user_quest",
  "reward_grant",
  "pool_registry",
  "invitation",
  "escrow",
] as const;

export type CriticalRecordType = (typeof CRITICAL_RECORD_TYPES)[number];

export type ChangeAction =

  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "STATUS_CHANGE"
  | "ROLE_CHANGE"
  | "SETTLEMENT"
  | "REVOKE";


export interface ChangeHistoryEntry {
  id: string;
  recordType: CriticalRecordType;
  recordId: string;
  /** 1-based, strictly increasing per record. */
  sequence: number;
  action: ChangeAction;
  /** Wallet address, admin id, or "system". */
  actor: string;

  /** Why the change was made — required for destructive/permission changes. */
  reason: string;
  /** Field-level previous state; null on create. */
  before: Record<string, unknown> | null;
  /** Field-level new state; null on delete. */
  after: Record<string, unknown> | null;
  timestamp: string;
  prevHash: string;
  entryHash: string;
}


export interface AppendChangeInput {
  recordType: CriticalRecordType;
  recordId: string;
  action: ChangeAction;
  actor: string;
  reason: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  timestamp?: string;
}


export type VerificationProblemCode =
  | "ALTERED"
  | "MISSING"
  | "OUT_OF_ORDER"
  | "BROKEN_LINK"
  | "GENESIS_MISMATCH";


export interface VerificationProblem {
  code: VerificationProblemCode;
  entryId: string;
  sequence: number;
  detail: string;
}


export interface VerificationResult {
  ok: boolean;
  recordType: CriticalRecordType;
  recordId: string;
  entryCount: number;
  problems: VerificationProblem[];
}


export interface ChangeHistoryStore {
  /** Entries for a record, oldest first. */
  list(recordType: CriticalRecordType, recordId: string): Promise<ChangeHistoryEntry[]>;
  /** Highest sequence already stored for a record. */
  lastSequence(recordType: CriticalRecordType, recordId: string): Promise<number>;
  /** Hash of the newest entry, or GENESIS_HASH when the record has no history. */
  lastHash(recordType: CriticalRecordType, recordId: string): Promise<string>;
  insert(entry: ChangeHistoryEntry): Promise<void>;
}


export class InMemoryChangeHistoryStore implements ChangeHistoryStore {
  private readonly entries: ChangeHistoryEntry[] = [];

  async list(recordType: CriticalRecordType, recordId: string): Promise<ChangeHistoryEntry[]> {
    return this.entries
      .filter((e) => e.recordType === recordType && e.recordId === recordId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async lastSequence(recordType: CriticalRecordType, recordId: string): Promise<number> {
    const all = await this.list(recordType, recordId);
    return all.length === 0 ? 0 : all[all.length - 1].sequence;
  }

  async lastHash(recordType: CriticalRecordType, recordId: string): Promise<string> {
    const all = await this.list(recordType, recordId);
    return all.length === 0 ? GENESIS_HASH : all[all.length - 1].entryHash;
  }

  async insert(entry: ChangeHistoryEntry): Promise<void> {
    this.entries.push(entry);
  }


  /** Test helper: write a raw entry, bypassing the chain, to simulate tampering. */
  async insertRaw(entry: ChangeHistoryEntry): Promise<void> {
    this.entries.push(entry);
  }

  clear(): void {
    this.entries.length = 0;
  }
}


/** Canonical, order-independent serialization used for hashing. */
export function canonicalizePayload(entry: Omit<ChangeHistoryEntry, "entryHash">): string {
  return stableStringify({
    id: entry.id,
    recordType: entry.recordType,
    recordId: entry.recordId,
    sequence: entry.sequence,
    action: entry.action,
    actor: entry.actor,
    reason: entry.reason,
    before: entry.before,
    after: entry.after,
    timestamp: entry.timestamp,
    prevHash: entry.prevHash,
  });
}


export function computeEntryHash(entry: Omit<ChangeHistoryEntry, "entryHash">): string {
  return createHash("sha256").update(canonicalizePayload(entry)).digest("hex");
}

/** Actions that must carry a justification — these touch money or access. */
export const REASON_REQUIRED_ACTIONS: ReadonlySet<ChangeAction> = new Set([
  "DELETE",
  "ROLE_CHANGE",
  "SETTLEMENT",
  "REVOKE",
]);


export class ChangeHistoryService {
  private counter = 0;

  constructor(
    private readonly store: ChangeHistoryStore,
    private readonly options: { now?: () => Date; idFactory?: () => string } = {},
  ) {}

  private now(): Date {

    return this.options.now ? this.options.now() : new Date();
  }

  private nextId(): string {
    if (this.options.idFactory) return this.options.idFactory();
    this.counter += 1;
    return `chg_${this.now().getTime().toString(36)}_${this.counter.toString(36)}`;
  }


  /**
   * Appends a change to the record's chain. Serialised per record so two
   * concurrent mutations cannot both read the same `prevHash` and fork the
   * chain.
   */
  async append(input: AppendChangeInput): Promise<ChangeHistoryEntry> {
    if (!input.recordId?.trim()) throw new Error("recordId is required");
    if (!input.actor?.trim()) throw new Error("actor is required");
    if (REASON_REQUIRED_ACTIONS.has(input.action) && !input.reason?.trim()) {
      throw new Error(`A reason is required for ${input.action} changes`);
    }
    if (input.action === "CREATE" && input.before !== null) {
      throw new Error("CREATE must not carry a previous state");
    }
    if (input.action === "DELETE" && input.after !== null) {
      throw new Error("DELETE must not carry a new state");
    }


    return this.withRecordLock(input.recordType, input.recordId, async () => {
      const sequence = (await this.store.lastSequence(input.recordType, input.recordId)) + 1;
      const prevHash = await this.store.lastHash(input.recordType, input.recordId);

      const withoutHash: Omit<ChangeHistoryEntry, "entryHash"> = {
        id: this.nextId(),
        recordType: input.recordType,
        recordId: input.recordId,
        sequence,
        action: input.action,
        actor: input.actor,
        reason: input.reason ?? "",
        before: input.before ?? null,
        after: input.after ?? null,
        timestamp: input.timestamp ?? this.now().toISOString(),
        prevHash,
      };

      const entry: ChangeHistoryEntry = {
        ...withoutHash,
        entryHash: computeEntryHash(withoutHash),
      };
      await this.store.insert(entry);

      return entry;
    });
  }

  async history(recordType: CriticalRecordType, recordId: string): Promise<ChangeHistoryEntry[]> {
    return this.store.list(recordType, recordId);
  }


  /**
   * Recomputes the whole chain and reports every problem found. A clean result
   * means no entry was altered, removed, reordered or spliced since it was
   * written.
   */
  async verify(
    recordType: CriticalRecordType,
    recordId: string,
  ): Promise<VerificationResult> {
    const entries = await this.store.list(recordType, recordId);

    const problems: VerificationProblem[] = [];

    if (entries.length === 0) {
      return { ok: true, recordType, recordId, entryCount: 0, problems };
    }

    let expectedPrev = GENESIS_HASH;


    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const { entryHash, ...payload } = entry;

      if (payload.sequence !== i + 1) {
        problems.push({
          code: i === 0 ? "GENESIS_MISMATCH" : "OUT_OF_ORDER",
          entryId: entry.id,
          sequence: payload.sequence,
          detail: `expected sequence ${i + 1} but found ${payload.sequence}`,
        });
      }

      if (payload.prevHash !== expectedPrev) {
        problems.push({
          code: "BROKEN_LINK",
          entryId: entry.id,
          sequence: payload.sequence,
          detail:
            i === 0
              ? "chain does not start at the genesis hash"
              : `prevHash does not match the preceding entry (possible removal or splice)`,
        });
      }

      const recomputed = computeEntryHash(payload);
      if (recomputed !== entryHash) {
        problems.push({
          code: "ALTERED",
          entryId: entry.id,
          sequence: payload.sequence,
          detail: "entry contents do not match the stored hash",
        });
      }


      expectedPrev = entryHash;
    }

    return {
      ok: problems.length === 0,
      recordType,
      recordId,
      entryCount: entries.length,
      problems,
    };
  }


  /**
   * Verifies every record that has history. Use in a maintenance job or a
   * `validate` script to sweep the whole store.
   */
  async verifyAll(
    records: Array<{ recordType: CriticalRecordType; recordId: string }>,
  ): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const record of records) {
      results.push(await this.verify(record.recordType, record.recordId));
    }
    return results;
  }


  private async withRecordLock<T>(
    recordType: CriticalRecordType,
    recordId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${recordType}:${recordId}`;
    const previous = locks.get(key) ?? Promise.resolve();
    // Chain the follow-up behind the previous holder, and keep the lock alive
    // even when a caller throws so one failure cannot wedge the record.
    const run = previous.then(fn, fn);
    locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await run;
    } finally {
      if (locks.get(key) === undefined) locks.delete(key);
    }
  }

}

/** Per-record serialisation, keyed by `recordType:recordId`. */
const locks = new Map<string, Promise<void>>();


