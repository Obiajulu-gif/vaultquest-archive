/**
 * Signed activity receipts (#812).
 *
 * A receipt is a signed statement of "what was requested, what happened, and
 * when" for one critical user operation at one lifecycle stage.
 *
 * Which operations: every ActionLedger action whose type moves or commits
 * value — `deposit`, `withdraw`, `claim`, `create_vault`, `select_winner`
 * ({@link RECEIPT_OPERATIONS}). `compensating` actions are system-internal and
 * get none.
 *
 * Which stages: one receipt per (action, stage), where the stage mirrors the
 * ledger status — requested (pending), submitted, confirmed, failed, reverted,
 * orphaned. Earlier receipts are kept, so the set of receipts is the
 * operation's signed timeline.
 *
 * Stable payloads: the payload is derived *only* from the action row (no wall
 * clock, no random values), serialised with canonical JSON and identified by
 * `receiptId = sha256(actionId:stage)`. Re-deriving a receipt for the same
 * action and stage always yields byte-identical payload bytes, which is why:
 *   - a duplicate request (same Idempotency-Key) returns the existing receipt
 *     instead of creating a second one (`insertIfAbsent`), and
 *   - {@link ReceiptService.verifyAgainstLedger} can re-derive the payload
 *     from the ledger and detect a receipt or ledger row that changed.
 *
 * Verifiable: the signature is ed25519 over a domain-separated message
 * (`vaultquest-receipt:v1\n` + canonical payload) using a Stellar keypair
 * (RECEIPT_SIGNING_SECRET). `keyId` is the public G... address, published at
 * GET /receipts/public-key, so anyone can verify with stellar-sdk's
 * `Keypair.fromPublicKey(keyId).verify(message, signature)` without trusting
 * the API. Any change to any payload field invalidates the signature.
 *
 * What is NOT in a receipt: the raw action payload. `requestDigest` commits to
 * it (sha256 of the canonical request) without exposing it.
 */

import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { canonicalJson } from "../utils/canonicalJson.js";

export const RECEIPT_VERSION = 1 as const;
export const RECEIPT_ALGORITHM = "ed25519" as const;
export const RECEIPT_DOMAIN = "vaultquest-receipt:v1\n";

export const RECEIPT_OPERATIONS = ["deposit", "withdraw", "claim", "create_vault", "select_winner"] as const;
export type ReceiptOperation = (typeof RECEIPT_OPERATIONS)[number];

export const RECEIPT_STAGES = ["requested", "submitted", "confirmed", "failed", "reverted", "orphaned"] as const;
export type ReceiptStage = (typeof RECEIPT_STAGES)[number];

const STATUS_TO_STAGE: Readonly<Record<string, ReceiptStage>> = {
  pending: "requested",
  submitted: "submitted",
  confirmed: "confirmed",
  failed: "failed",
  reverted: "reverted",
  orphaned: "orphaned",
};

type Timestamp = Date | string | null | undefined;

/** The ActionLedger fields a receipt is derived from. */
export interface ReceiptActionSnapshot {
  id: string;
  idempotencyKey: string;
  walletAddress: string;
  actionType: string;
  actionPayload: unknown;
  status: string;
  txHash: string | null;
  sorobanEventId: string | null;
  correlationId: string;
  errorCode: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  submittedAt?: Timestamp;
  confirmedAt?: Timestamp;
}

export interface ReceiptPayload {
  version: typeof RECEIPT_VERSION;
  receiptId: string;
  operation: ReceiptOperation;
  stage: ReceiptStage;
  actionId: string;
  idempotencyKey: string;
  actor: { walletAddress: string };
  /** sha256 of the canonical request (wallet, type, payload, idempotency key). */
  requestDigest: string;
  requestedAt: string;
  /** When this stage was reached, taken from the ledger row. */
  occurredAt: string;
  externalRefs: {
    txHash: string | null;
    sorobanEventId: string | null;
    correlationId: string;
  };
  errorCode: string | null;
}

export interface SignedReceipt {
  payload: ReceiptPayload;
  algorithm: typeof RECEIPT_ALGORITHM;
  /** Signer's Stellar public key (G...). */
  keyId: string;
  /** Base64 ed25519 signature over RECEIPT_DOMAIN + canonicalJson(payload). */
  signature: string;
}

/** A receipt as stored; `issuedAt` is informational and not signed. */
export interface StoredReceipt extends SignedReceipt {
  issuedAt: string;
}

export type ReceiptVerificationFailure =
  | "MALFORMED"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_KEY"
  | "BAD_SIGNATURE"
  | "NOT_ISSUED"
  | "STORED_COPY_MISMATCH"
  | "LEDGER_MISMATCH";

export interface ReceiptVerification {
  valid: boolean;
  reason?: ReceiptVerificationFailure;
}

// ─── Signing ─────────────────────────────────────────────────────────────────

export interface ReceiptSigner {
  readonly keyId: string;
  /** True when the key was generated at boot (no RECEIPT_SIGNING_SECRET). */
  readonly ephemeral: boolean;
  sign(message: Buffer): string;
}

export class StellarReceiptSigner implements ReceiptSigner {
  private constructor(
    private readonly keypair: Keypair,
    readonly ephemeral: boolean,
  ) {}

  /** `secret` is a Stellar secret seed (S...). */
  static fromSecret(secret: string): StellarReceiptSigner {
    return new StellarReceiptSigner(Keypair.fromSecret(secret.trim()), false);
  }

  /** Dev/test fallback. Receipts stay verifiable only while this process runs. */
  static ephemeral(): StellarReceiptSigner {
    return new StellarReceiptSigner(Keypair.random(), true);
  }

  get keyId(): string {
    return this.keypair.publicKey();
  }

  sign(message: Buffer): string {
    return this.keypair.sign(message).toString("base64");
  }
}

export function receiptMessage(payload: ReceiptPayload): Buffer {
  return Buffer.from(RECEIPT_DOMAIN + canonicalJson(payload), "utf8");
}

export function receiptIdFor(actionId: string, stage: ReceiptStage): string {
  return `rcpt_${createHash("sha256").update(`${actionId}:${stage}`).digest("hex").slice(0, 40)}`;
}

function iso(value: Timestamp, fallback?: Timestamp): string {
  const v = value ?? fallback;
  if (v === null || v === undefined) throw new Error("receipt timestamp missing");
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

export function isReceiptOperation(actionType: string): actionType is ReceiptOperation {
  return (RECEIPT_OPERATIONS as readonly string[]).includes(actionType);
}

/**
 * Derives the canonical payload for the action's *current* stage, or null when
 * the action is not a critical operation. Pure: same row, same payload.
 */
export function buildReceiptPayload(action: ReceiptActionSnapshot): ReceiptPayload | null {
  if (!isReceiptOperation(action.actionType)) return null;
  const stage = STATUS_TO_STAGE[action.status];
  if (!stage) return null;

  const occurredAt =
    stage === "requested"
      ? iso(action.createdAt)
      : stage === "submitted"
        ? iso(action.submittedAt, action.updatedAt)
        : stage === "confirmed"
          ? iso(action.confirmedAt, action.updatedAt)
          : iso(action.updatedAt);

  return {
    version: RECEIPT_VERSION,
    receiptId: receiptIdFor(action.id, stage),
    operation: action.actionType,
    stage,
    actionId: action.id,
    idempotencyKey: action.idempotencyKey,
    actor: { walletAddress: action.walletAddress },
    requestDigest: createHash("sha256")
      .update(
        canonicalJson({
          walletAddress: action.walletAddress,
          actionType: action.actionType,
          actionPayload: action.actionPayload ?? null,
          idempotencyKey: action.idempotencyKey,
        }),
      )
      .digest("hex"),
    requestedAt: iso(action.createdAt),
    occurredAt,
    externalRefs: {
      txHash: action.txHash ?? null,
      sorobanEventId: action.sorobanEventId ?? null,
      correlationId: action.correlationId,
    },
    errorCode: stage === "requested" || stage === "submitted" || stage === "confirmed" ? null : action.errorCode ?? null,
  };
}

/**
 * Stateless signature check. `trustedKeyIds` is the current key plus any
 * retired keys still accepted after a rotation.
 */
export function verifyReceiptSignature(receipt: unknown, trustedKeyIds: readonly string[]): ReceiptVerification {
  const r = receipt as Partial<SignedReceipt> | null;
  if (
    !r ||
    typeof r !== "object" ||
    !r.payload ||
    typeof r.payload !== "object" ||
    typeof r.signature !== "string" ||
    typeof r.keyId !== "string" ||
    r.algorithm !== RECEIPT_ALGORITHM
  ) {
    return { valid: false, reason: "MALFORMED" };
  }
  if (r.payload.version !== RECEIPT_VERSION) return { valid: false, reason: "UNSUPPORTED_VERSION" };
  if (!trustedKeyIds.includes(r.keyId)) return { valid: false, reason: "UNKNOWN_KEY" };

  let ok = false;
  try {
    ok = Keypair.fromPublicKey(r.keyId).verify(receiptMessage(r.payload), Buffer.from(r.signature, "base64"));
  } catch {
    return { valid: false, reason: "MALFORMED" };
  }
  return ok ? { valid: true } : { valid: false, reason: "BAD_SIGNATURE" };
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface ReceiptStore {
  /** Inserts unless `receiptId` exists; returns whichever row is stored. */
  insertIfAbsent(receipt: StoredReceipt): Promise<{ receipt: StoredReceipt; created: boolean }>;
  get(receiptId: string): Promise<StoredReceipt | null>;
  /** Oldest first. */
  listByAction(actionId: string): Promise<StoredReceipt[]>;
}

export class InMemoryReceiptStore implements ReceiptStore {
  private readonly rows = new Map<string, StoredReceipt>();

  async insertIfAbsent(receipt: StoredReceipt): Promise<{ receipt: StoredReceipt; created: boolean }> {
    const existing = this.rows.get(receipt.payload.receiptId);
    if (existing) return { receipt: structuredClone(existing), created: false };
    this.rows.set(receipt.payload.receiptId, structuredClone(receipt));
    return { receipt: structuredClone(receipt), created: true };
  }

  async get(receiptId: string): Promise<StoredReceipt | null> {
    const row = this.rows.get(receiptId);
    return row ? structuredClone(row) : null;
  }

  async listByAction(actionId: string): Promise<StoredReceipt[]> {
    return [...this.rows.values()]
      .filter((r) => r.payload.actionId === actionId)
      .sort((a, b) => RECEIPT_STAGES.indexOf(a.payload.stage) - RECEIPT_STAGES.indexOf(b.payload.stage))
      .map((r) => structuredClone(r));
  }

  /** Test helper: simulate a row edited outside the API. */
  tamperForTest(receiptId: string, mutate: (r: StoredReceipt) => void): void {
    const row = this.rows.get(receiptId);
    if (!row) throw new Error(`no receipt ${receiptId}`);
    mutate(row);
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface ReceiptActionSource {
  getAction(id: string): Promise<ReceiptActionSnapshot | null>;
  findByTxHash(txHash: string): Promise<ReceiptActionSnapshot | null>;
}

/** Who is asking. `canReadAny` is true for maintainers (admin.receipts.read). */
export interface ReceiptViewer {
  walletAddress?: string;
  canReadAny: boolean;
}

export class ReceiptAccessError extends Error {
  constructor() {
    super("receipt belongs to another wallet");
    this.name = "ReceiptAccessError";
  }
}

export interface ReceiptServiceOptions {
  store: ReceiptStore;
  signer: ReceiptSigner;
  actions: ReceiptActionSource;
  /** Retired public keys still trusted for verification after a rotation. */
  previousKeyIds?: readonly string[];
  now?: () => Date;
}

function sameWallet(a: string | undefined, b: string): boolean {
  return !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class ReceiptService {
  constructor(private readonly options: ReceiptServiceOptions) {}

  get keyId(): string {
    return this.options.signer.keyId;
  }

  get ephemeralKey(): boolean {
    return this.options.signer.ephemeral;
  }

  get trustedKeyIds(): string[] {
    return [this.options.signer.keyId, ...(this.options.previousKeyIds ?? [])];
  }

  /**
   * Issues the receipt for the action's current stage. Idempotent: a repeat
   * call (duplicate request, retried hook, lazy re-issue) returns the stored
   * receipt with `created: false`. Returns null for non-critical actions.
   */
  async issueForAction(action: ReceiptActionSnapshot): Promise<{ receipt: StoredReceipt; created: boolean } | null> {
    const payload = buildReceiptPayload(action);
    if (!payload) return null;
    const receipt: StoredReceipt = {
      payload,
      algorithm: RECEIPT_ALGORITHM,
      keyId: this.options.signer.keyId,
      signature: this.options.signer.sign(receiptMessage(payload)),
      issuedAt: (this.options.now ? this.options.now() : new Date()).toISOString(),
    };
    return this.options.store.insertIfAbsent(receipt);
  }

  async issueForActionId(actionId: string) {
    const action = await this.options.actions.getAction(actionId);
    return action ? this.issueForAction(action) : null;
  }

  async issueForTxHash(txHash: string) {
    const action = await this.options.actions.findByTxHash(txHash);
    return action ? this.issueForAction(action) : null;
  }

  /** Receipt lookup with ownership check. Null when it doesn't exist. */
  async get(receiptId: string, viewer: ReceiptViewer): Promise<StoredReceipt | null> {
    const receipt = await this.options.store.get(receiptId);
    if (!receipt) return null;
    if (!viewer.canReadAny && !sameWallet(viewer.walletAddress, receipt.payload.actor.walletAddress)) {
      throw new ReceiptAccessError();
    }
    return receipt;
  }

  /**
   * All receipts for an action, oldest stage first. Issues the current stage's
   * receipt first if it's missing (e.g. an issuance hook failed), so lookups
   * are self-healing. Null when the action doesn't exist.
   */
  async listForAction(actionId: string, viewer: ReceiptViewer): Promise<StoredReceipt[] | null> {
    const action = await this.options.actions.getAction(actionId);
    if (!action) return null;
    if (!viewer.canReadAny && !sameWallet(viewer.walletAddress, action.walletAddress)) {
      throw new ReceiptAccessError();
    }
    await this.issueForAction(action);
    return this.options.store.listByAction(actionId);
  }

  /**
   * Full verification of a presented receipt: signature, then that it matches
   * the copy we issued. Public — it reveals nothing the holder doesn't have.
   */
  async verify(receipt: unknown): Promise<ReceiptVerification> {
    const signature = verifyReceiptSignature(receipt, this.trustedKeyIds);
    if (!signature.valid) return signature;
    const presented = receipt as SignedReceipt;
    const stored = await this.options.store.get(presented.payload.receiptId);
    if (!stored) return { valid: false, reason: "NOT_ISSUED" };
    if (canonicalJson(stored.payload) !== canonicalJson(presented.payload) || stored.signature !== presented.signature) {
      return { valid: false, reason: "STORED_COPY_MISMATCH" };
    }
    return { valid: true };
  }

  /**
   * Maintainer check that a stored receipt still matches the ledger: re-derives
   * the payload from the action row and compares. Detects a tampered receipt
   * row *and* a ledger row edited after the receipt was issued.
   */
  async verifyAgainstLedger(receiptId: string): Promise<ReceiptVerification> {
    const stored = await this.options.store.get(receiptId);
    if (!stored) return { valid: false, reason: "NOT_ISSUED" };
    const signature = verifyReceiptSignature(stored, this.trustedKeyIds);
    if (!signature.valid) return signature;
    const action = await this.options.actions.getAction(stored.payload.actionId);
    if (!action) return { valid: false, reason: "LEDGER_MISMATCH" };
    // Re-derive the payload for the receipt's stage, not the action's current one.
    const derived = buildReceiptPayload({ ...action, status: stageToStatus(stored.payload.stage) });
    if (!derived) return { valid: false, reason: "LEDGER_MISMATCH" };
    // Only facts that can never legitimately change after the stage was
    // reached are compared: who asked, for what (requestDigest covers wallet,
    // type, payload and idempotency key), when, and — once submitted — which
    // transaction. Later-stage fields (event id, error code, timestamps of
    // later stages) are filled in over time and are therefore excluded.
    const comparable = (p: ReceiptPayload) =>
      canonicalJson({
        receiptId: p.receiptId,
        operation: p.operation,
        stage: p.stage,
        actionId: p.actionId,
        idempotencyKey: p.idempotencyKey,
        actor: p.actor,
        requestDigest: p.requestDigest,
        requestedAt: p.requestedAt,
        txHash: p.stage === "requested" ? null : p.externalRefs.txHash,
      });
    return comparable(derived) === comparable(stored.payload) ? { valid: true } : { valid: false, reason: "LEDGER_MISMATCH" };
  }
}

function stageToStatus(stage: ReceiptStage): string {
  return stage === "requested" ? "pending" : stage;
}
