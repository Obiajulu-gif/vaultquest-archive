import { describe, it, expect } from "vitest";
import {
  RECOVERY_ACTIONS,
  RECOVERY_PATHS,
  RESULT_CODES,
  RESULT_SEMANTICS,
  canonicalRecoveryCorpus,
  generateRecoveryCorpus,
  generateRecoveryFixture,
  makeRng,
  validateRecoveryFixture,
  type RecoveryFixture,
} from "./recovery-fixture-generator";

describe("canonicalRecoveryCorpus (path + result-code coverage)", () => {
  const corpus = canonicalRecoveryCorpus();

  it("covers every required path (normal, retry, failure, authorization, recovery)", () => {
    const paths = new Set(corpus.map((f) => f.path));
    for (const p of RECOVERY_PATHS) expect(paths.has(p)).toBe(true);
  });

  it("produces only valid fixtures with unique ids", () => {
    for (const f of corpus) expect(validateRecoveryFixture(f)).toBe(true);
    expect(new Set(corpus.map((f) => f.id)).size).toBe(corpus.length);
  });

  it("exercises every result code defined in RESULT_SEMANTICS", () => {
    const seen = new Set(corpus.flatMap((f) => f.attempts.map((a) => a.resultCode)));
    for (const code of Object.keys(RESULT_SEMANTICS)) expect(seen.has(code as any)).toBe(true);
  });

  it("derives retryable/recoveryAction strictly from the semantics table", () => {
    for (const f of corpus) {
      for (const a of f.attempts) {
        const sem = RESULT_SEMANTICS[a.resultCode];
        expect(a.retryable).toBe(sem.retryable);
        expect(a.recoveryAction).toBe(sem.action);
      }
    }
  });
});

describe("Stellar result-code semantics (accuracy)", () => {
  it("maps each code to the Horizon-documented recovery action", () => {
    expect(RESULT_SEMANTICS[RESULT_CODES.SUCCESS]).toMatchObject({ retryable: false, action: RECOVERY_ACTIONS.NONE });
    expect(RESULT_SEMANTICS[RESULT_CODES.BAD_SEQ]).toMatchObject({ retryable: true, action: RECOVERY_ACTIONS.RESEQUENCE });
    expect(RESULT_SEMANTICS[RESULT_CODES.INSUFFICIENT_FEE]).toMatchObject({ retryable: true, action: RECOVERY_ACTIONS.BUMP_FEE });
    expect(RESULT_SEMANTICS[RESULT_CODES.TOO_LATE]).toMatchObject({ retryable: true, action: RECOVERY_ACTIONS.REBUILD_TIME_BOUNDS });
    expect(RESULT_SEMANTICS[RESULT_CODES.SUBMISSION_TIMEOUT]).toMatchObject({ retryable: true, action: RECOVERY_ACTIONS.RECHECK_BY_HASH });
    expect(RESULT_SEMANTICS[RESULT_CODES.RPC_UNAVAILABLE]).toMatchObject({ retryable: true, action: RECOVERY_ACTIONS.RESEND });
  });

  it("treats tx_bad_auth, tx_failed, and app_forbidden as permanent (non-retryable, abort)", () => {
    for (const code of [RESULT_CODES.BAD_AUTH, RESULT_CODES.FAILED, RESULT_CODES.APP_FORBIDDEN]) {
      expect(RESULT_SEMANTICS[code]).toMatchObject({ retryable: false, action: RECOVERY_ACTIONS.ABORT });
    }
  });

  it("uses the exact Horizon snake_case strings for on-chain codes", () => {
    expect(RESULT_CODES.SUCCESS).toBe("tx_success");
    expect(RESULT_CODES.BAD_SEQ).toBe("tx_bad_seq");
    expect(RESULT_CODES.BAD_AUTH).toBe("tx_bad_auth");
    expect(RESULT_CODES.TOO_LATE).toBe("tx_too_late");
    expect(RESULT_CODES.INSUFFICIENT_FEE).toBe("tx_insufficient_fee");
  });
});

describe("recovery/rollback invariants", () => {
  const byId = Object.fromEntries(canonicalRecoveryCorpus().map((f) => [f.id, f] as const));

  it("ties compensations to rollbackRequired for every fixture", () => {
    for (const f of canonicalRecoveryCorpus()) {
      expect(f.recovery.compensations.length > 0).toBe(f.recovery.rollbackRequired);
    }
  });

  it("models a bad-seq retry that succeeds without rollback", () => {
    const f = byId["retry-bad-seq-resequenced"];
    expect(f.terminalState).toBe("succeeded");
    expect(f.recovery.rollbackRequired).toBe(false);
    expect(f.recovery.resumable).toBe(true);
    expect(f.attempts[0].recoveryAction).toBe(RECOVERY_ACTIONS.RESEQUENCE);
    expect(f.attempts.at(-1)!.resultCode).toBe(RESULT_CODES.SUCCESS);
  });

  it("models retry exhaustion that must roll back", () => {
    const f = byId["retry-exhausted-rollback"];
    expect(f.attempts).toHaveLength(f.maxAttempts);
    expect(f.terminalState).toBe("failed");
    expect(f.recovery.rollbackRequired).toBe(true);
    expect(f.recovery.compensations.length).toBeGreaterThan(0);
  });

  it("models permanent failures as terminal, non-retryable, no compensation", () => {
    for (const id of ["failure-bad-auth-permanent", "failure-op-revert", "failure-too-late-expired"]) {
      const f = byId[id];
      expect(f.terminalState).toBe("failed");
      expect(f.attempts[0].retryable).toBe(f.attempts[0].resultCode === RESULT_CODES.TOO_LATE); // too_late is retryable-by-rebuild but abandoned here
      expect(f.recovery.rollbackRequired).toBe(false);
    }
  });

  it("models an authorization rejection with no side effect", () => {
    const f = byId["authorization-forbidden-actor"];
    expect(f.actor.authorized).toBe(false);
    expect(f.attempts[0].resultCode).toBe(RESULT_CODES.APP_FORBIDDEN);
    expect(f.recovery.rollbackRequired).toBe(false);
  });

  it("models a timeout/divergence that is compensated by reconciliation", () => {
    const f = byId["recovery-timeout-divergence-compensated"];
    expect(f.terminalState).toBe("compensated");
    expect(f.recovery.rollbackRequired).toBe(true);
    expect(f.attempts[0].recoveryAction).toBe(RECOVERY_ACTIONS.RECHECK_BY_HASH);
  });
});

describe("determinism", () => {
  it("canonical corpus is byte-stable across calls", () => {
    expect(JSON.stringify(canonicalRecoveryCorpus())).toBe(JSON.stringify(canonicalRecoveryCorpus()));
  });

  it("seeded variants are reproducible and seed-sensitive", () => {
    const a = generateRecoveryCorpus({ seed: "s1", retryVariants: 10 });
    const b = generateRecoveryCorpus({ seed: "s1", retryVariants: 10 });
    const c = generateRecoveryCorpus({ seed: "s2", retryVariants: 10 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    expect(a).toHaveLength(canonicalRecoveryCorpus().length + 10);
    for (const f of a) expect(validateRecoveryFixture(f)).toBe(true);
  });

  it("makeRng yields a fixed sequence for a given seed", () => {
    const r1 = makeRng(42);
    const r2 = makeRng(42);
    const seq1 = [r1(), r1(), r1()];
    const seq2 = [r2(), r2(), r2()];
    expect(seq1).toEqual(seq2);
    expect(seq1.every((n) => n >= 0 && n < 1)).toBe(true);
  });
});

describe("validateRecoveryFixture (contract guard)", () => {
  const good = canonicalRecoveryCorpus()[0];

  it("rejects non-objects and unknown paths", () => {
    expect(validateRecoveryFixture(null)).toBe(false);
    expect(validateRecoveryFixture({ ...good, path: "bogus" })).toBe(false);
  });

  it("rejects compensations that disagree with rollbackRequired", () => {
    const bad: RecoveryFixture = {
      ...good,
      recovery: { rollbackRequired: true, compensations: [], resumable: false },
    };
    expect(validateRecoveryFixture(bad)).toBe(false);
  });

  it("rejects attempts out of order or exceeding maxAttempts", () => {
    expect(
      validateRecoveryFixture({ ...good, maxAttempts: 1, attempts: [good.attempts[0], good.attempts[0]] }),
    ).toBe(false);
  });

  it("rejects an attempt whose policy fields contradict the semantics table", () => {
    const f = generateRecoveryFixture({
      id: "x",
      path: "failure",
      description: "d",
      actor: { id: "a", role: "user", authorized: true },
      idempotencyKey: "k",
      maxAttempts: 1,
      results: [RESULT_CODES.BAD_AUTH],
      terminalState: "failed",
      recovery: { rollbackRequired: false, compensations: [], resumable: false },
    });
    expect(validateRecoveryFixture(f)).toBe(true);
    // tamper: claim a permanent code is retryable
    expect(validateRecoveryFixture({ ...f, attempts: [{ ...f.attempts[0], retryable: true }] })).toBe(false);
    // tamper: unknown result code
    expect(validateRecoveryFixture({ ...f, attempts: [{ ...f.attempts[0], resultCode: "nope" }] })).toBe(false);
  });
});
