/**
 * Fixture generators for rare failure and recovery paths (#998).
 *
 * Rare paths — a sequence-number clash that must be re-sequenced, a fee surge, a
 * permanent auth failure, a submission that times out and later turns out to
 * have succeeded on-chain — are exactly the ones that are painful to reproduce
 * by hand and easy to leave untested. This module *generates* a deterministic
 * corpus of such scenarios so recovery/reconciliation code has stable,
 * reviewable fixtures to run against.
 *
 * Accuracy: failure codes are the real Stellar/Horizon transaction result codes
 * (plus two clearly-labelled transport/application-layer pseudo-codes for the
 * paths that never reach consensus), and each code's `retryable` flag and
 * recovery action follow the Horizon result-code reference. A `tx_bad_seq`
 * becomes valid only after re-sequencing, `tx_insufficient_fee` only after a fee
 * bump, `tx_too_late` only after new time bounds, while `tx_bad_auth` (wrong
 * network) and `tx_failed` are permanent. This matches the codes the repo's own
 * sandbox already emits (`backend/src/sandbox/escrowAdapters.ts` returns
 * `resultCode: "tx_bad_seq" | "tx_bad_auth" | "tx_success"`). See
 * docs/RECOVERY_FIXTURES.md for sources.
 *
 * Complexity: every helper is linear in the attempt count `k` of the fixture it
 * touches; the corpus builders are O(F·k̄) time / O(F·k̄) space for `F`
 * fixtures of mean length `k̄`. No helper reads a clock or global RNG, so output
 * is byte-identical for identical inputs (the committed corpus is a golden
 * artifact — see scripts/generate-recovery-fixtures.ts `--check`).
 */

/**
 * Transaction result codes a submission can resolve to.
 *
 *  - On-chain (Horizon `tx_*`): the transaction reached consensus with this
 *    result. Strings match Horizon's `result_codes.transaction`.
 *  - Transport: the submission never produced an on-chain result (RPC down, or
 *    no confirmation observed). Not Horizon codes; named without the `tx_`
 *    prefix to keep the distinction explicit.
 *  - Application: rejected by VaultQuest's own authorization gate before a
 *    transaction was ever built.
 */
export const RESULT_CODES = {
  // on-chain
  SUCCESS: "tx_success",
  FAILED: "tx_failed",
  BAD_SEQ: "tx_bad_seq",
  INSUFFICIENT_FEE: "tx_insufficient_fee",
  TOO_LATE: "tx_too_late",
  BAD_AUTH: "tx_bad_auth",
  // transport
  RPC_UNAVAILABLE: "rpc_unavailable",
  SUBMISSION_TIMEOUT: "submission_timeout",
  // application
  APP_FORBIDDEN: "app_forbidden",
} as const;

export type ResultCode = (typeof RESULT_CODES)[keyof typeof RESULT_CODES];

/** The recovery action an operator/reconciler must take for a result code. */
export const RECOVERY_ACTIONS = {
  /** No recovery needed (success). */
  NONE: "none",
  /** Rebuild the transaction with a fresh sequence number, then resubmit. */
  RESEQUENCE: "resequence",
  /** Rebuild with a higher fee (or fee-bump), then resubmit. */
  BUMP_FEE: "bump_fee",
  /** Rebuild with new time bounds; the signed envelope is expired. */
  REBUILD_TIME_BOUNDS: "rebuild_time_bounds",
  /** Safe to resubmit the same signed envelope (transport-only failure). */
  RESEND: "resend",
  /** Confirm the outcome on-chain by hash before resubmitting (avoid double-apply). */
  RECHECK_BY_HASH: "recheck_by_hash",
  /** Permanent: do not retry; fix inputs/authorization and start a new action. */
  ABORT: "abort",
  /** A side effect was applied and must be reversed to restore consistency. */
  COMPENSATE: "compensate",
} as const;

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[keyof typeof RECOVERY_ACTIONS];

interface ResultSemantics {
  readonly retryable: boolean;
  readonly action: RecoveryAction;
  readonly summary: string;
}

/**
 * Single source of truth mapping each result code to its recovery semantics,
 * derived from the Horizon transaction result-code reference. Every attempt's
 * `retryable`/`recoveryAction` is read from here, so a fixture can never claim a
 * policy that contradicts the protocol.
 */
export const RESULT_SEMANTICS: Readonly<Record<ResultCode, ResultSemantics>> = {
  [RESULT_CODES.SUCCESS]: { retryable: false, action: RECOVERY_ACTIONS.NONE, summary: "Applied on-chain." },
  [RESULT_CODES.BAD_SEQ]: {
    retryable: true,
    action: RECOVERY_ACTIONS.RESEQUENCE,
    summary: "Sequence number did not match; valid only after re-sequencing.",
  },
  [RESULT_CODES.INSUFFICIENT_FEE]: {
    retryable: true,
    action: RECOVERY_ACTIONS.BUMP_FEE,
    summary: "Fee too small for the surge; resubmit with a higher fee.",
  },
  [RESULT_CODES.TOO_LATE]: {
    retryable: true,
    action: RECOVERY_ACTIONS.REBUILD_TIME_BOUNDS,
    summary: "Ledger close time passed maxTime; the envelope is expired and must be rebuilt.",
  },
  [RESULT_CODES.RPC_UNAVAILABLE]: {
    retryable: true,
    action: RECOVERY_ACTIONS.RESEND,
    summary: "RPC transport error; no on-chain result, safe to resend the same envelope.",
  },
  [RESULT_CODES.SUBMISSION_TIMEOUT]: {
    retryable: true,
    action: RECOVERY_ACTIONS.RECHECK_BY_HASH,
    summary: "No confirmation observed; confirm by hash before resending to avoid double-apply.",
  },
  [RESULT_CODES.BAD_AUTH]: {
    // Horizon: "too few valid signatures, or the wrong network". The missing-
    // signature sub-case is resolved by re-signing; this models the wrong-network
    // case, which is permanent — the conservative default (never blind-retry auth).
    retryable: false,
    action: RECOVERY_ACTIONS.ABORT,
    summary: "Wrong network passphrase (unsignable as-is); treated as permanent.",
  },
  [RESULT_CODES.FAILED]: {
    // Horizon: "one operation failed, so none were applied". Retryability depends
    // on the operation; modelled as permanent (fix inputs/state, start a new action).
    retryable: false,
    action: RECOVERY_ACTIONS.ABORT,
    summary: "An operation failed; nothing applied. Fix inputs/state before retrying.",
  },
  [RESULT_CODES.APP_FORBIDDEN]: {
    retryable: false,
    action: RECOVERY_ACTIONS.ABORT,
    summary: "Rejected by authorization before submission; not retryable.",
  },
};

/** The four acceptance-criteria paths, plus the explicit recovery/rollback path. */
export const RECOVERY_PATHS = ["normal", "retry", "failure", "authorization", "recovery"] as const;
export type RecoveryPath = (typeof RECOVERY_PATHS)[number];

/** Terminal outcome of a scenario, aligned with `RecoveryCheckpoint.state`. */
export type RecoveryTerminalState = "succeeded" | "failed" | "compensated" | "pending";

export interface AttemptFixture {
  /** 1-based attempt number. */
  readonly attempt: number;
  readonly resultCode: ResultCode;
  /** Whether a (correctly rebuilt) retry may succeed — read from RESULT_SEMANTICS. */
  readonly retryable: boolean;
  /** The recovery action for this result — read from RESULT_SEMANTICS. */
  readonly recoveryAction: RecoveryAction;
}

export interface RecoveryFixture {
  readonly id: string;
  readonly path: RecoveryPath;
  readonly description: string;
  /** Who attempted the operation and whether they were authorized to. */
  readonly actor: { readonly id: string; readonly role: string; readonly authorized: boolean };
  /** De-dupe key the runtime uses to make retries idempotent. */
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
  readonly attempts: readonly AttemptFixture[];
  readonly terminalState: RecoveryTerminalState;
  readonly recovery: {
    /** A side effect was applied that must be undone. */
    readonly rollbackRequired: boolean;
    /** Operator/compensation steps, in order. Non-empty iff rollbackRequired. */
    readonly compensations: readonly string[];
    /** Whether a resumable retry from the last checkpoint is expected to work. */
    readonly resumable: boolean;
  };
}

/** Builds one attempt, deriving its policy from {@link RESULT_SEMANTICS} (O(1)). */
function makeAttempt(n: number, resultCode: ResultCode): AttemptFixture {
  const sem = RESULT_SEMANTICS[resultCode];
  return { attempt: n, resultCode, retryable: sem.retryable, recoveryAction: sem.action };
}

export interface ScenarioSpec {
  id: string;
  path: RecoveryPath;
  description: string;
  actor: { id: string; role: string; authorized: boolean };
  idempotencyKey: string;
  maxAttempts: number;
  /** Ordered result codes, one per attempt; length must be >= 1 and <= maxAttempts. */
  results: readonly ResultCode[];
  terminalState: RecoveryTerminalState;
  recovery: {
    rollbackRequired: boolean;
    compensations: readonly string[];
    resumable: boolean;
  };
}

/**
 * Builds one fixture from an explicit spec. Pure and total — no clock, no RNG —
 * so the same spec always yields the same fixture. O(k) in the attempt count.
 */
export function generateRecoveryFixture(spec: ScenarioSpec): RecoveryFixture {
  return {
    id: spec.id,
    path: spec.path,
    description: spec.description,
    actor: { ...spec.actor },
    idempotencyKey: spec.idempotencyKey,
    maxAttempts: spec.maxAttempts,
    attempts: spec.results.map((code, i) => makeAttempt(i + 1, code)),
    terminalState: spec.terminalState,
    recovery: {
      rollbackRequired: spec.recovery.rollbackRequired,
      compensations: [...spec.recovery.compensations],
      resumable: spec.recovery.resumable,
    },
  };
}

function isResultCode(value: unknown): value is ResultCode {
  return typeof value === "string" && value in RESULT_SEMANTICS;
}

/**
 * Validates a value against the fixture contract (O(k)), the same guard shape as
 * `validateRepairScenario`. Used by the `--check` CLI and by any consumer that
 * loads a hand-edited corpus.
 */
export function validateRecoveryFixture(value: unknown): value is RecoveryFixture {
  if (!value || typeof value !== "object") return false;
  const f = value as Partial<RecoveryFixture>;
  if (typeof f.id !== "string" || !f.id) return false;
  if (!RECOVERY_PATHS.includes(f.path as RecoveryPath)) return false;
  if (typeof f.description !== "string" || !f.description) return false;
  if (!f.actor || typeof f.actor.id !== "string" || typeof f.actor.authorized !== "boolean") return false;
  if (typeof f.idempotencyKey !== "string" || !f.idempotencyKey) return false;
  if (typeof f.maxAttempts !== "number" || f.maxAttempts < 1) return false;
  if (!Array.isArray(f.attempts) || f.attempts.length < 1 || f.attempts.length > f.maxAttempts) return false;
  const attemptsOk = f.attempts.every((a, i) => {
    if (!a || a.attempt !== i + 1 || !isResultCode(a.resultCode)) return false;
    const sem = RESULT_SEMANTICS[a.resultCode];
    // Policy fields must agree with the authoritative semantics table.
    return a.retryable === sem.retryable && a.recoveryAction === sem.action;
  });
  if (!attemptsOk) return false;
  if (!["succeeded", "failed", "compensated", "pending"].includes(f.terminalState as string)) return false;
  const r = f.recovery;
  if (!r || typeof r.rollbackRequired !== "boolean" || typeof r.resumable !== "boolean") return false;
  if (!Array.isArray(r.compensations)) return false;
  // Contract invariant: compensations are present exactly when a rollback is required.
  if (r.rollbackRequired !== r.compensations.length > 0) return false;
  return true;
}

/**
 * Tiny deterministic PRNG (mulberry32), O(1) per draw. Seeded so generated
 * variants are reproducible; never used for anything cryptographic.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The canonical, hand-specified corpus: one representative fixture per rare
 * path/result code. These are the scenarios recovery code must handle; the
 * generator guarantees they are always present and internally consistent.
 */
export function canonicalRecoveryCorpus(): RecoveryFixture[] {
  const user = { id: "user:alice", role: "user", authorized: true };
  const specs: ScenarioSpec[] = [
    {
      id: "normal-single-success",
      path: "normal",
      description: "A single submission is applied on the first attempt.",
      actor: user,
      idempotencyKey: "idem-normal-1",
      maxAttempts: 3,
      results: [RESULT_CODES.SUCCESS],
      terminalState: "succeeded",
      recovery: { rollbackRequired: false, compensations: [], resumable: false },
    },
    {
      id: "retry-bad-seq-resequenced",
      path: "retry",
      description: "tx_bad_seq on the first attempt; re-sequenced and applied on retry.",
      actor: user,
      idempotencyKey: "idem-retry-badseq",
      maxAttempts: 4,
      results: [RESULT_CODES.BAD_SEQ, RESULT_CODES.SUCCESS],
      terminalState: "succeeded",
      recovery: { rollbackRequired: false, compensations: [], resumable: true },
    },
    {
      id: "retry-fee-surge-bumped",
      path: "retry",
      description: "tx_insufficient_fee during a fee surge; resubmitted with a higher fee.",
      actor: user,
      idempotencyKey: "idem-retry-fee",
      maxAttempts: 3,
      results: [RESULT_CODES.INSUFFICIENT_FEE, RESULT_CODES.SUCCESS],
      terminalState: "succeeded",
      recovery: { rollbackRequired: false, compensations: [], resumable: true },
    },
    {
      id: "retry-rpc-transient-resend",
      path: "retry",
      description: "Two RPC transport failures (no on-chain result) followed by a resend that applies.",
      actor: user,
      idempotencyKey: "idem-retry-rpc",
      maxAttempts: 4,
      results: [RESULT_CODES.RPC_UNAVAILABLE, RESULT_CODES.RPC_UNAVAILABLE, RESULT_CODES.SUCCESS],
      terminalState: "succeeded",
      recovery: { rollbackRequired: false, compensations: [], resumable: true },
    },
    {
      id: "retry-exhausted-rollback",
      path: "retry",
      description: "Repeated tx_bad_seq exhausts the retry budget; reserved resources are released.",
      actor: user,
      idempotencyKey: "idem-retry-exhausted",
      maxAttempts: 3,
      results: [RESULT_CODES.BAD_SEQ, RESULT_CODES.BAD_SEQ, RESULT_CODES.BAD_SEQ],
      terminalState: "failed",
      recovery: {
        rollbackRequired: true,
        compensations: [
          "Mark the action-ledger entry as failed with the last result code.",
          "Release any liquidity reserved for the pending submission.",
        ],
        resumable: false,
      },
    },
    {
      id: "failure-too-late-expired",
      path: "failure",
      description: "tx_too_late: the time bounds lapsed before inclusion; the intent was abandoned.",
      actor: user,
      idempotencyKey: "idem-failure-toolate",
      maxAttempts: 2,
      results: [RESULT_CODES.TOO_LATE],
      terminalState: "failed",
      recovery: { rollbackRequired: false, compensations: [], resumable: false },
    },
    {
      id: "failure-bad-auth-permanent",
      path: "failure",
      description: "tx_bad_auth (wrong network passphrase): permanent, non-retryable, nothing applied.",
      actor: user,
      idempotencyKey: "idem-failure-badauth",
      maxAttempts: 3,
      results: [RESULT_CODES.BAD_AUTH],
      terminalState: "failed",
      recovery: { rollbackRequired: false, compensations: [], resumable: false },
    },
    {
      id: "failure-op-revert",
      path: "failure",
      description: "tx_failed: an operation failed so the transaction was not applied; non-retryable.",
      actor: user,
      idempotencyKey: "idem-failure-opfail",
      maxAttempts: 3,
      results: [RESULT_CODES.FAILED],
      terminalState: "failed",
      recovery: { rollbackRequired: false, compensations: [], resumable: false },
    },
    {
      id: "authorization-forbidden-actor",
      path: "authorization",
      description: "An unauthorized actor is rejected before any transaction is built; terminal.",
      actor: { id: "user:mallory", role: "user", authorized: false },
      idempotencyKey: "idem-authz-1",
      maxAttempts: 1,
      results: [RESULT_CODES.APP_FORBIDDEN],
      terminalState: "failed",
      recovery: { rollbackRequired: false, compensations: [], resumable: false },
    },
    {
      id: "recovery-timeout-divergence-compensated",
      path: "recovery",
      description:
        "submission_timeout: locally marked failed, but reconciliation found the tx applied on-chain; local state compensated.",
      actor: { id: "service:reconciler", role: "service", authorized: true },
      idempotencyKey: "idem-recovery-divergence",
      maxAttempts: 2,
      results: [RESULT_CODES.SUBMISSION_TIMEOUT],
      terminalState: "compensated",
      recovery: {
        rollbackRequired: true,
        compensations: [
          "Confirm the transaction outcome on-chain by hash.",
          "Reconcile the local ledger/projection to match the applied on-chain result.",
        ],
        resumable: false,
      },
    },
  ];
  return specs.map(generateRecoveryFixture);
}

/** Retryable codes a generated variant may pick before its terminal success. */
const RETRYABLE_VARIANT_CODES: readonly ResultCode[] = [
  RESULT_CODES.BAD_SEQ,
  RESULT_CODES.INSUFFICIENT_FEE,
  RESULT_CODES.RPC_UNAVAILABLE,
];

export interface CorpusOptions {
  /** Seed for the deterministic extra variants. Defaults to a fixed string. */
  seed?: string;
  /** Extra deterministic retry variants to append (0 = canonical corpus only). */
  retryVariants?: number;
}

/**
 * The full generated corpus: the canonical set, plus `retryVariants` additional
 * retry scenarios whose transient-failure code and count are chosen
 * deterministically from `seed`. Re-running with the same options yields
 * byte-identical output. O(F·k̄ + v·k̄) time and space.
 */
export function generateRecoveryCorpus(options: CorpusOptions = {}): RecoveryFixture[] {
  const { seed = "vaultquest-recovery-v1", retryVariants = 0 } = options;
  const corpus = canonicalRecoveryCorpus();
  if (retryVariants <= 0) return corpus;

  const rng = makeRng(hashSeed(seed));
  const maxAttempts = 5;
  for (let i = 0; i < retryVariants; i++) {
    const code = RETRYABLE_VARIANT_CODES[Math.floor(rng() * RETRYABLE_VARIANT_CODES.length)];
    const failures = 1 + Math.floor(rng() * (maxAttempts - 1)); // 1..maxAttempts-1
    const results: ResultCode[] = [
      ...Array.from({ length: failures }, () => code),
      RESULT_CODES.SUCCESS,
    ];
    corpus.push(
      generateRecoveryFixture({
        id: `retry-variant-${String(i + 1).padStart(3, "0")}`,
        path: "retry",
        description: `Generated retry variant: ${failures}× ${code} then success.`,
        actor: { id: "user:generated", role: "user", authorized: true },
        idempotencyKey: `idem-variant-${i + 1}`,
        maxAttempts,
        results,
        terminalState: "succeeded",
        recovery: { rollbackRequired: false, compensations: [], resumable: true },
      }),
    );
  }
  return corpus;
}
