/**
 * Immutable audit trail (#814), shared by pending-action recovery (#813) and
 * operation-limit overrides (#815).
 *
 * Every access-changing action — invitations, wallet/admin sessions, role,
 * permission and ownership changes, limit overrides — appends one record with
 * the actor, the target, the reason and the structured before/after state.
 *
 * How the "immutable" and "no secrets" guarantees are enforced:
 *
 *  1. **Append-only API.** {@link AuditTrailStore} has no update or delete
 *     method, and the Postgres table is protected by a trigger that rejects
 *     UPDATE/DELETE (see the `add_audit_receipts_recovery_limits` migration).
 *  2. **Hash chain.** Records carry a global, gap-free `sequence` and
 *     `recordHash = sha256(canonicalJson(record-without-recordHash))`, where the
 *     hashed payload includes `prevHash`. {@link AuditTrailService.verify}
 *     recomputes the chain and reports edited (ALTERED), removed or reordered
 *     (SEQUENCE_GAP / BROKEN_LINK) records, so tampering that bypasses the
 *     trigger (e.g. a superuser) is still detected.
 *  3. **Redaction before hashing.** `before`, `after` and `metadata` pass
 *     through {@link sanitizeAuditState}, which replaces secrets (tokens,
 *     signatures, passwords, seeds, nonces, API keys, Stellar secret seeds,
 *     JWTs, bearer strings) with "[REDACTED]" and hidden payloads (raw
 *     request/event/action payloads, headers, bodies) with "[OMITTED]". The
 *     redacted paths are listed in `redactedFields`, so a reader can tell a
 *     value was withheld rather than absent. Nothing secret ever reaches the
 *     store, so it can't leak through query or export either.
 */

import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../utils/canonicalJson.js";

export const AUDIT_GENESIS_HASH = "0".repeat(64);

export const AUDIT_CATEGORIES = ["access", "recovery", "limits"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** Access-changing actions (#814). The `access` category only accepts these. */
export const ACCESS_AUDIT_ACTIONS = [
  "invitation.create",
  "invitation.accept",
  "invitation.revoke",
  "invitation.expire",
  "session.issue",
  "session.refresh",
  "session.revoke",
  "session.revoke_all",
  "admin_session.issue",
  "admin_session.revoke",
  "admin_session.revoke_role",
  "role.grant",
  "role.revoke",
  "permission.grant",
  "permission.revoke",
  "ownership.transfer",
] as const;
export type AccessAuditAction = (typeof ACCESS_AUDIT_ACTIONS)[number];

/** Actions that change privilege or override a control must say why. */
export const REASON_REQUIRED_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  "role.grant",
  "role.revoke",
  "permission.grant",
  "permission.revoke",
  "ownership.transfer",
  "admin_session.revoke_role",
  "recovery.resolve",
  "recovery.escalate",
  "limits.override.grant",
  "limits.override.revoke",
  "limits.reset",
]);

export type AuditActorRole = "user" | "maintainer" | "service" | "system";

export interface AuditActor {
  /** Wallet address, service name or "system" — never a credential. */
  subject: string;
  role: AuditActorRole;
}

export interface AuditTarget {
  /** e.g. "wallet_session", "invitation", "vault", "limit_override". */
  type: string;
  id: string;
}

export type AuditState = Record<string, unknown>;

export interface AuditRecordInput {
  category: AuditCategory;
  action: string;
  actor: AuditActor;
  target: AuditTarget;
  reason?: string | null;
  before?: AuditState | null;
  after?: AuditState | null;
  metadata?: AuditState | null;
  /** Defaults to the service clock. */
  occurredAt?: string;
}

export interface AuditRecord {
  id: string;
  /** Global, 1-based, gap-free. */
  sequence: number;
  category: AuditCategory;
  action: string;
  actor: AuditActor;
  target: AuditTarget;
  reason: string | null;
  before: AuditState | null;
  after: AuditState | null;
  metadata: AuditState | null;
  /** Paths (e.g. "after.token") whose values were redacted or omitted. */
  redactedFields: string[];
  occurredAt: string;
  prevHash: string;
  recordHash: string;
}

/** Minimal interface services depend on, so they can be tested with a stub. */
export interface AuditRecorder {
  record(input: AuditRecordInput): Promise<unknown>;
}

export interface AuditQuery {
  category?: AuditCategory;
  action?: string;
  actorSubject?: string;
  targetType?: string;
  targetId?: string;
  /** Inclusive ISO lower bound on occurredAt. */
  since?: string;
  /** Exclusive ISO upper bound on occurredAt. */
  until?: string;
}

export class AuditSequenceConflictError extends Error {
  constructor(sequence: number) {
    super(`audit sequence ${sequence} already exists`);
    this.name = "AuditSequenceConflictError";
  }
}

export interface AuditTrailStore {
  /** Newest record's sequence and hash, or null when the trail is empty. */
  head(): Promise<{ sequence: number; recordHash: string } | null>;
  /** Must throw {@link AuditSequenceConflictError} if `sequence` is taken. */
  append(record: AuditRecord): Promise<void>;
  /** Newest first; `beforeSequence` is an exclusive cursor. */
  query(query: AuditQuery & { beforeSequence?: number; limit: number }): Promise<AuditRecord[]>;
  /** Oldest first, sequence > afterSequence; used by verification. */
  scan(afterSequence: number, limit: number): Promise<AuditRecord[]>;
}

// ─── Sanitization ────────────────────────────────────────────────────────────

const SECRET_KEY_PATTERN =
  /(secret|passw(or)?d|token|signature|private[-_]?key|seed|mnemonic|nonce|challenge|api[-_]?key|authorization|cookie|credential|session[-_]?id)/i;
const HIDDEN_KEY_PATTERN =
  /^(payload|action[-_]?payload|event[-_]?payload|verified[-_]?payload|raw|body|headers)$/i;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^S[A-Z2-7]{55}$/, // Stellar secret seed
  /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, // JWT
  /^bearer\s+/i,
];
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 1024;

export const REDACTED = "[REDACTED]";
export const OMITTED = "[OMITTED]";

/**
 * Returns a JSON-safe copy of `state` with secrets and hidden payloads
 * removed, plus the list of paths that were withheld.
 */
export function sanitizeAuditState(
  state: AuditState | null | undefined,
  rootPath: string,
): { value: AuditState | null; redacted: string[] } {
  if (state === null || state === undefined) return { value: null, redacted: [] };
  const redacted: string[] = [];
  const value = sanitizeValue(state, rootPath, 0, redacted) as AuditState;
  return { value, redacted };
}

function sanitizeValue(value: unknown, path: string, depth: number, redacted: string[]): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERNS.some((re) => re.test(value.trim()))) {
      redacted.push(path);
      return REDACTED;
    }
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (typeof value !== "object") return null; // functions, symbols
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item, i) => sanitizeValue(item, `${path}[${i}]`, depth + 1, redacted));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    const childPath = `${path}.${key}`;
    if (HIDDEN_KEY_PATTERN.test(key)) {
      redacted.push(childPath);
      out[key] = OMITTED;
    } else if (SECRET_KEY_PATTERN.test(key)) {
      redacted.push(childPath);
      out[key] = REDACTED;
    } else {
      out[key] = sanitizeValue(child, childPath, depth + 1, redacted);
    }
  }
  return out;
}

/** Short, non-reversible fingerprint for identifiers that are themselves credentials. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

export function computeAuditRecordHash(record: Omit<AuditRecord, "recordHash">): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

// ─── In-memory store ─────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function matches(record: AuditRecord, q: AuditQuery): boolean {
  if (q.category && record.category !== q.category) return false;
  if (q.action && record.action !== q.action) return false;
  if (q.actorSubject && record.actor.subject !== q.actorSubject) return false;
  if (q.targetType && record.target.type !== q.targetType) return false;
  if (q.targetId && record.target.id !== q.targetId) return false;
  if (q.since && record.occurredAt < q.since) return false;
  if (q.until && record.occurredAt >= q.until) return false;
  return true;
}

export class InMemoryAuditTrailStore implements AuditTrailStore {
  private records: AuditRecord[] = [];

  async head(): Promise<{ sequence: number; recordHash: string } | null> {
    const last = this.records[this.records.length - 1];
    return last ? { sequence: last.sequence, recordHash: last.recordHash } : null;
  }

  async append(record: AuditRecord): Promise<void> {
    if (this.records.some((r) => r.sequence === record.sequence)) {
      throw new AuditSequenceConflictError(record.sequence);
    }
    // Stored copies are frozen: the in-memory store is as immutable as the table.
    this.records.push(deepFreeze(structuredClone(record)));
    this.records.sort((a, b) => a.sequence - b.sequence);
  }

  async query(q: AuditQuery & { beforeSequence?: number; limit: number }): Promise<AuditRecord[]> {
    return this.records
      .filter((r) => (q.beforeSequence === undefined || r.sequence < q.beforeSequence) && matches(r, q))
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, q.limit);
  }

  async scan(afterSequence: number, limit: number): Promise<AuditRecord[]> {
    return this.records.filter((r) => r.sequence > afterSequence).slice(0, limit);
  }

  /** Test helper: simulate someone editing a stored row outside the API. */
  tamperForTest(sequence: number, mutate: (record: AuditRecord) => void): void {
    const index = this.records.findIndex((r) => r.sequence === sequence);
    if (index < 0) throw new Error(`no record ${sequence}`);
    const copy = structuredClone(this.records[index]!);
    mutate(copy);
    this.records[index] = copy;
  }

  /** Test helper: simulate a deleted row. */
  deleteForTest(sequence: number): void {
    this.records = this.records.filter((r) => r.sequence !== sequence);
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export type AuditVerificationProblemCode = "ALTERED" | "BROKEN_LINK" | "SEQUENCE_GAP";

export interface AuditVerificationResult {
  ok: boolean;
  checked: number;
  problems: Array<{ code: AuditVerificationProblemCode; sequence: number; detail: string }>;
}

export interface AuditTrailServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  /** Appends retried after a cross-process sequence conflict. */
  maxAppendRetries?: number;
}

export const AUDIT_EXPORT_MAX_ROWS = 5000;

export class AuditTrailService implements AuditRecorder {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: AuditTrailStore,
    private readonly options: AuditTrailServiceOptions = {},
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  /**
   * Appends a record. Appends are serialised in-process so two writers never
   * read the same head; across processes the store's unique sequence rejects
   * the loser, which re-reads the head and retries.
   */
  record(input: AuditRecordInput): Promise<AuditRecord> {
    try {
      validateInput(input);
    } catch (err) {
      return Promise.reject(err);
    }
    const run = this.tail.then(
      () => this.appendWithRetry(input),
      () => this.appendWithRetry(input),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async appendWithRetry(input: AuditRecordInput): Promise<AuditRecord> {
    const attempts = Math.max(1, this.options.maxAppendRetries ?? 5);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const record = await this.build(input);
      try {
        await this.store.append(record);
        return record;
      } catch (err) {
        if (!(err instanceof AuditSequenceConflictError)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  private async build(input: AuditRecordInput): Promise<AuditRecord> {
    const head = await this.store.head();
    const before = sanitizeAuditState(input.before, "before");
    const after = sanitizeAuditState(input.after, "after");
    const metadata = sanitizeAuditState(input.metadata, "metadata");
    const withoutHash: Omit<AuditRecord, "recordHash"> = {
      id: this.options.idFactory ? this.options.idFactory() : randomUUID(),
      sequence: (head?.sequence ?? 0) + 1,
      category: input.category,
      action: input.action,
      actor: { subject: input.actor.subject, role: input.actor.role },
      target: { type: input.target.type, id: input.target.id },
      reason: input.reason?.trim() ? input.reason.trim() : null,
      before: before.value,
      after: after.value,
      metadata: metadata.value,
      redactedFields: [...before.redacted, ...after.redacted, ...metadata.redacted],
      // Normalised to the exact form the database returns (ms precision, Z),
      // so the hash still matches after a round trip.
      occurredAt: (input.occurredAt ? new Date(input.occurredAt) : this.now()).toISOString(),
      prevHash: head?.recordHash ?? AUDIT_GENESIS_HASH,
    };
    return { ...withoutHash, recordHash: computeAuditRecordHash(withoutHash) };
  }

  /** Newest first, cursor = the last seen `sequence`. */
  async list(
    query: AuditQuery & { cursor?: string | null; limit: number },
  ): Promise<{ items: AuditRecord[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const beforeSequence = query.cursor ? Number(query.cursor) : undefined;
    if (beforeSequence !== undefined && (!Number.isInteger(beforeSequence) || beforeSequence < 1)) {
      throw new Error("invalid audit cursor");
    }
    const rows = await this.store.query({ ...query, beforeSequence, limit: limit + 1 });
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? String(items[items.length - 1]!.sequence) : null;
    return { items, nextCursor };
  }

  /**
   * Maintainer export. Records are exported whole (including hashes), so an
   * exported file can be re-verified offline with {@link computeAuditRecordHash}.
   */
  async export(query: AuditQuery, format: "ndjson" | "csv", maxRows = AUDIT_EXPORT_MAX_ROWS): Promise<string> {
    const rows: AuditRecord[] = [];
    let cursor: number | undefined;
    while (rows.length < maxRows) {
      const page = await this.store.query({ ...query, beforeSequence: cursor, limit: Math.min(500, maxRows - rows.length) });
      if (page.length === 0) break;
      rows.push(...page);
      cursor = page[page.length - 1]!.sequence;
    }
    return format === "csv" ? toCsv(rows) : rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  }

  /** Recomputes the whole chain and reports every inconsistency. */
  async verify(pageSize = 500): Promise<AuditVerificationResult> {
    const problems: AuditVerificationResult["problems"] = [];
    let expectedSequence = 1;
    let expectedPrev = AUDIT_GENESIS_HASH;
    let checked = 0;
    let after = 0;

    for (;;) {
      const page = await this.store.scan(after, pageSize);
      if (page.length === 0) break;
      for (const record of page) {
        const { recordHash, ...payload } = record;
        if (record.sequence !== expectedSequence) {
          problems.push({
            code: "SEQUENCE_GAP",
            sequence: record.sequence,
            detail: `expected sequence ${expectedSequence}; records may have been removed or reordered`,
          });
        }
        if (record.prevHash !== expectedPrev) {
          problems.push({
            code: "BROKEN_LINK",
            sequence: record.sequence,
            detail: "prevHash does not match the preceding record",
          });
        }
        if (computeAuditRecordHash(payload) !== recordHash) {
          problems.push({
            code: "ALTERED",
            sequence: record.sequence,
            detail: "record contents do not match its hash",
          });
        }
        expectedSequence = record.sequence + 1;
        expectedPrev = recordHash;
        checked += 1;
      }
      after = page[page.length - 1]!.sequence;
    }

    return { ok: problems.length === 0, checked, problems };
  }
}

function validateInput(input: AuditRecordInput): void {
  if (!AUDIT_CATEGORIES.includes(input.category)) throw new Error(`unknown audit category: ${input.category}`);
  if (!input.action?.trim() || input.action.length > 100) throw new Error("audit action is required");
  if (input.category === "access" && !(ACCESS_AUDIT_ACTIONS as readonly string[]).includes(input.action)) {
    throw new Error(`unknown access audit action: ${input.action}`);
  }
  if (!input.actor?.subject?.trim()) throw new Error("audit actor is required");
  if (!input.target?.type?.trim() || !input.target?.id?.trim()) throw new Error("audit target is required");
  if (input.occurredAt !== undefined && Number.isNaN(new Date(input.occurredAt).getTime())) {
    throw new Error("audit occurredAt must be an ISO timestamp");
  }
  if (REASON_REQUIRED_AUDIT_ACTIONS.has(input.action) && !input.reason?.trim()) {
    throw new Error(`a reason is required for ${input.action}`);
  }
}

const CSV_COLUMNS = [
  "sequence", "id", "occurred_at", "category", "action", "actor_subject", "actor_role",
  "target_type", "target_id", "reason", "before", "after", "metadata", "redacted_fields",
  "prev_hash", "record_hash",
] as const;

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows: AuditRecord[]): string {
  const lines = rows.map((r) =>
    [
      r.sequence, r.id, r.occurredAt, r.category, r.action, r.actor.subject, r.actor.role,
      r.target.type, r.target.id, r.reason, r.before, r.after, r.metadata, r.redactedFields,
      r.prevHash, r.recordHash,
    ].map(csvCell).join(","),
  );
  return [CSV_COLUMNS.join(","), ...lines].join("\n") + "\n";
}
