import { describe, it, expect } from "vitest";
import {
  DEFAULT_RETENTION_RULES,
  RETENTION_REASONS,
  RETENTION_RECORD_STATES,
  RetentionEnforcementEngine,
  RetentionEnforcementError,
  type SecondaryStoreProbe,
} from "./retention-enforcement";

const T0 = 1_760_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof RetentionEnforcementError ? err.reasonCode : `unexpected:${String(err)}`;
  }
}

describe("Data retention enforcement and deletion verification (#1118)", () => {
  it("quarantines expired records, respects legal holds, and issues a verified deletion certificate after grace period", () => {
    const engine = new RetentionEnforcementEngine();

    engine.registerRecord({
      id: "log-expired",
      category: "logs",
      createdAt: T0,
      payload: { ip: "10.0.0.1", msg: "login" },
    });
    engine.registerRecord({
      id: "log-held",
      category: "logs",
      createdAt: T0,
      payload: { ip: "10.0.0.2", msg: "disputed tx" },
      legalHold: true,
      legalHoldReason: "Dispute #404",
    });
    engine.registerRecord({
      id: "log-fresh",
      category: "logs",
      createdAt: T0 + 25 * DAY_MS,
      payload: { ip: "10.0.0.3", msg: "fresh" },
    });

    const afterTtl = T0 + DEFAULT_RETENTION_RULES.logs.retentionMs + 1000;
    const sweep = engine.quarantineExpired("retention_worker", afterTtl);

    expect(sweep.quarantinedIds).toEqual(["log-expired"]);
    expect(sweep.skippedLegalHoldIds).toEqual(["log-held"]);
    expect(engine.getRecord("log-expired")?.state).toBe(RETENTION_RECORD_STATES.QUARANTINED);
    expect(engine.getRecord("log-held")?.state).toBe(RETENTION_RECORD_STATES.ACTIVE);
    expect(engine.getRecord("log-fresh")?.state).toBe(RETENTION_RECORD_STATES.ACTIVE);

    // After quarantine grace window, hard-purge and verify deletion.
    const afterGrace = afterTtl + DEFAULT_RETENTION_RULES.logs.quarantineGraceMs + 1000;
    const cert = engine.purgeAndVerify({
      runId: "run-1",
      actor: "retention_worker",
      now: afterGrace,
    });

    expect(cert.verified).toBe(true);
    expect(cert.purgedIds).toEqual(["log-expired"]);
    expect(cert.verifiedAbsentIds).toEqual(["log-expired"]);
    expect(cert.residualLeakIds).toEqual([]);
    expect(cert.verificationHash).toMatch(/^[0-9a-f]{64}$/);

    const purgedRecord = engine.getRecord("log-expired");
    expect(purgedRecord?.state).toBe(RETENTION_RECORD_STATES.PURGED);
    expect(purgedRecord?.payload).toBeNull();
    expect(purgedRecord?.tombstoneHash).toMatch(/^[0-9a-f]{64}$/);

    // Idempotent retry with the same runId returns the same verified certificate.
    const retryCert = engine.purgeAndVerify({
      runId: "run-1",
      actor: "retention_worker",
      now: afterGrace + 5000,
    });
    expect(retryCert).toEqual(cert);
  });

  it("allows rollback restoration during quarantine grace window and rejects restoration after hard purge", () => {
    const engine = new RetentionEnforcementEngine();
    engine.registerRecord({
      id: "temp-1",
      category: "temp",
      createdAt: T0,
      payload: { token: "ephemeral" },
    });

    const tQuarantine = T0 + DEFAULT_RETENTION_RULES.temp.retentionMs + 100;
    engine.quarantineExpired("admin", tQuarantine);
    expect(engine.getRecord("temp-1")?.state).toBe(RETENTION_RECORD_STATES.QUARANTINED);

    // Restore while quarantined succeeds
    const restored = engine.restoreQuarantinedRecord("temp-1", "admin");
    expect(restored.state).toBe(RETENTION_RECORD_STATES.ACTIVE);
    expect(restored.payload).toEqual({ token: "ephemeral" });

    // Re-quarantine and hard-purge, then confirm restore is rejected
    engine.quarantineExpired("admin", tQuarantine + 100);
    const tPurge = tQuarantine + 100 + DEFAULT_RETENTION_RULES.temp.quarantineGraceMs + 100;
    engine.purgeAndVerify({ runId: "run-temp", actor: "admin", now: tPurge });

    expect(reasonOf(() => engine.restoreQuarantinedRecord("temp-1", "admin"))).toBe(
      RETENTION_REASONS.ALREADY_PURGED,
    );
  });

  it("detects residual data leaks in secondary stores and succeeds on retry after eviction", () => {
    const searchIndex = new Set<string>(["cache-1"]);
    const probe: SecondaryStoreProbe = {
      name: "search-index",
      hasRecord: (id) => searchIndex.has(id),
      evictRecord: (id) => searchIndex.delete(id),
    };

    const engine = new RetentionEnforcementEngine({}, [probe]);
    engine.registerRecord({
      id: "cache-1",
      category: "cache",
      createdAt: T0,
      payload: { key: "k1" },
    });

    const tQuarantine = T0 + DEFAULT_RETENTION_RULES.cache.retentionMs + 100;
    engine.quarantineExpired("system", tQuarantine);
    const tPurge = tQuarantine + DEFAULT_RETENTION_RULES.cache.quarantineGraceMs + 100;

    // Simulate a failed secondary eviction (`evictSecondary: false`) -> residual leak detected!
    expect(
      reasonOf(() =>
        engine.purgeAndVerify({
          runId: "run-leak",
          actor: "system",
          now: tPurge,
          evictSecondary: false,
        }),
      ),
    ).toBe(RETENTION_REASONS.RESIDUAL_DATA_DETECTED);

    engine.registerRecord({ id: "cache-2", category: "cache", createdAt: T0, payload: { key: "k2" } });
    engine.quarantineExpired("system", tQuarantine);

    // Retry with secondary eviction enabled -> cleans index and issues verified certificate!
    const recoveredCert = engine.purgeAndVerify({
      runId: "run-leak",
      actor: "system",
      now: tPurge + 1000,
      evictSecondary: true,
    });
    expect(recoveredCert.verified).toBe(true);
    expect(recoveredCert.verifiedAbsentIds).toEqual(["cache-1"]);
    expect(recoveredCert.purgedIds).toEqual(["cache-1"]);
  });

  it("keeps deletion certificates scoped to the records purged by each run", () => {
    const engine = new RetentionEnforcementEngine();
    engine.registerRecord({ id: "old-run-record", category: "temp", createdAt: T0, payload: { v: 1 } });
    const afterTtl = T0 + DEFAULT_RETENTION_RULES.temp.retentionMs + 100;
    const afterGrace = afterTtl + DEFAULT_RETENTION_RULES.temp.quarantineGraceMs + 100;
    engine.quarantineExpired("retention_worker", afterTtl);
    const first = engine.purgeAndVerify({ runId: "run-old", actor: "retention_worker", now: afterGrace });
    expect(first.purgedIds).toEqual(["old-run-record"]);

    engine.registerRecord({ id: "new-run-record", category: "temp", createdAt: T0, payload: { v: 2 } });
    engine.quarantineExpired("retention_worker", afterTtl);
    const second = engine.purgeAndVerify({ runId: "run-new", actor: "retention_worker", now: afterGrace });

    expect(second.purgedIds).toEqual(["new-run-record"]);
    expect(second.verifiedAbsentIds).toEqual(["new-run-record"]);
  });

  it("rejects unauthorized actors across quarantine, purge, restore, and legal-hold operations", () => {
    const engine = new RetentionEnforcementEngine();
    engine.registerRecord({
      id: "rec-1",
      category: "logs",
      createdAt: T0,
      payload: { a: 1 },
    });

    expect(reasonOf(() => engine.quarantineExpired("guest-user", T0))).toBe(
      RETENTION_REASONS.UNAUTHORIZED_ACTOR,
    );
    expect(reasonOf(() => engine.setLegalHold("rec-1", "guest-user", true))).toBe(
      RETENTION_REASONS.UNAUTHORIZED_ACTOR,
    );
    expect(
      reasonOf(() => engine.purgeAndVerify({ runId: "r-unauth", actor: "guest-user", now: T0 })),
    ).toBe(RETENTION_REASONS.UNAUTHORIZED_ACTOR);
  });
});
