import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { provenanceManager, type RecordProvenance } from "../../lib/record-provenance.js";
import { DataImportService, type ImportTarget } from "../src/services/dataImport.js";
import { importsRoutes } from "../src/routes/imports.js";
import type { SavedPoolInput, SavedPoolRecord } from "../src/services/savedPools.js";
import { AppError } from "../src/errors.js";

const SIGNING_KEYS = {
  "key-v1": "super-secret-signing-key-v1-32bytes!",
  "key-v2": "rotated-secret-signing-key-v2-32bytes!",
};

function makePoolPayload(overrides: Record<string, unknown> = {}) {
  return {
    pool_id: "pool-1",
    pool_name: "Alpha Vault",
    status: "open",
    tvl: "10000",
    asset: "USDC",
    participant_count: 12,
    expected_yield: "5.2%",
    prize: "500",
    opens_at: "2026-01-01T00:00:00.000Z",
    locks_at: "2026-02-01T00:00:00.000Z",
    draws_at: "2026-02-02T00:00:00.000Z",
    ...overrides,
  };
}

function createInMemoryTarget(options: { failNextWrite?: boolean } = {}) {
  const store = new Map<string, SavedPoolRecord>();
  let shouldFail = Boolean(options.failNextWrite);

  const target: ImportTarget & {
    store: Map<string, SavedPoolRecord>;
    savedInputs: SavedPoolInput[];
    setFailNextWrite: (v: boolean) => void;
  } = {
    store,
    savedInputs: [],
    setFailNextWrite(v: boolean) {
      shouldFail = v;
    },
    async findByPoolIds(walletAddress: string, poolIds: string[]) {
      return poolIds
        .map((id) => store.get(`${walletAddress}:${id}`))
        .filter((r): r is SavedPoolRecord => Boolean(r));
    },
    async savePool(input: SavedPoolInput) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("simulated transient DB error");
      }
      target.savedInputs.push(input);
      const key = `${input.walletAddress}:${input.pool.poolId}`;
      const existed = store.has(key);
      const record: SavedPoolRecord = {
        id: `saved-${input.pool.poolId}`,
        walletAddress: input.walletAddress,
        ...input.pool,
        provenance: input.provenance,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as SavedPoolRecord;
      store.set(key, record);
      return { record, created: !existed };
    },
  };

  return target;
}

describe("Cryptographic provenance for imported records", () => {
  describe("RecordProvenanceManager cryptographic signing & verification", () => {
    it("normal path: attaches and verifies HMAC-SHA256 provenance proof deterministically", () => {
      const payload = makePoolPayload();
      const attached = provenanceManager.attachCryptographicImportProvenance(
        { id: "pool-1" },
        {
          importBatchId: "batch-100",
          transformVersion: "1.0.0",
          actor: "GAAA1111",
          payload,
          signingSecret: SIGNING_KEYS["key-v1"],
          keyId: "key-v1",
          timestamp: "2026-11-21T00:00:00.000Z",
        },
      );

      expect(attached.provenance.cryptographicProof).toBeDefined();
      expect(attached.provenance.cryptographicProof?.algorithm).toBe("hmac-sha256");
      expect(attached.provenance.cryptographicProof?.keyId).toBe("key-v1");

      // Equivalent payload with reordered keys verifies identically
      const reorderedPayload = {
        draws_at: payload.draws_at,
        asset: payload.asset,
        pool_id: payload.pool_id,
        pool_name: payload.pool_name,
        status: payload.status,
        tvl: payload.tvl,
        participant_count: payload.participant_count,
        expected_yield: payload.expected_yield,
        prize: payload.prize,
        opens_at: payload.opens_at,
        locks_at: payload.locks_at,
      };

      const verified = provenanceManager.verifyCryptographicProvenance(attached, {
        payload: reorderedPayload,
        keys: SIGNING_KEYS,
        expectedActor: "GAAA1111",
      });
      expect(verified.valid).toBe(true);
      expect(verified.status).toBe("verified");
      expect(verified.keyId).toBe("key-v1");
    });

    it("failure paths: detects tampered payload, metadata envelope, forged signature, and unknown keyId", () => {
      const payload = makePoolPayload();
      const attached = provenanceManager.attachCryptographicImportProvenance(
        { id: "pool-1" },
        {
          importBatchId: "batch-101",
          transformVersion: "1.0.0",
          actor: "GAAA1111",
          payload,
          signingSecret: SIGNING_KEYS["key-v1"],
          keyId: "key-v1",
        },
      );

      // 1. Tampered payload
      const tamperedPayload = provenanceManager.verifyCryptographicProvenance(attached, {
        payload: { ...payload, tvl: "999999" },
        keys: SIGNING_KEYS,
      });
      expect(tamperedPayload.valid).toBe(false);
      expect(tamperedPayload.status).toBe("payload_hash_mismatch");

      // 2. Tampered provenance metadata envelope
      const tamperedEnvelope = structuredClone(attached);
      tamperedEnvelope.provenance.importBatchId = "batch-forged";
      const envelopeRes = provenanceManager.verifyCryptographicProvenance(tamperedEnvelope, {
        payload,
        keys: SIGNING_KEYS,
      });
      expect(envelopeRes.valid).toBe(false);
      expect(envelopeRes.status).toBe("envelope_hash_mismatch");

      // 3. Forged signature
      const forgedSig = structuredClone(attached);
      forgedSig.provenance.cryptographicProof!.signature = "0".repeat(64);
      const sigRes = provenanceManager.verifyCryptographicProvenance(forgedSig, {
        payload,
        keys: SIGNING_KEYS,
      });
      expect(sigRes.valid).toBe(false);
      expect(sigRes.status).toBe("invalid_signature");

      // 4. Unknown / revoked keyId
      const unknownKeyRes = provenanceManager.verifyCryptographicProvenance(attached, {
        payload,
        keys: { "key-v2": SIGNING_KEYS["key-v2"] },
      });
      expect(unknownKeyRes.valid).toBe(false);
      expect(unknownKeyRes.status).toBe("unknown_key_id");
    });

    it("migration & legacy compatibility: handles unsigned legacy records and preserves proof across updates", () => {
      const legacy = provenanceManager.attachImportProvenance(
        { id: "pool-legacy" },
        "batch-old",
        "1.0.0",
        "GAAA1111",
      );

      const strictRes = provenanceManager.verifyCryptographicProvenance(legacy, {
        keys: SIGNING_KEYS,
      });
      expect(strictRes.valid).toBe(false);
      expect(strictRes.status).toBe("legacy_unsigned");

      const migrationRes = provenanceManager.verifyCryptographicProvenance(legacy, {
        keys: SIGNING_KEYS,
        allowLegacyUnsigned: true,
      });
      expect(migrationRes.valid).toBe(true);
      expect(migrationRes.status).toBe("legacy_unsigned");

      // Ordinary updates preserve original cryptographicProof
      const signed = provenanceManager.attachCryptographicImportProvenance(
        { id: "pool-2" },
        {
          importBatchId: "batch-2",
          transformVersion: "1.0.0",
          actor: "GAAA1111",
          payload: makePoolPayload({ pool_id: "pool-2" }),
          signingSecret: SIGNING_KEYS["key-v1"],
          keyId: "key-v1",
        },
      );
      const updated = provenanceManager.updateRecordPreservingProvenance(
        signed,
        {},
        "GAAA1111",
      );
      expect(updated.provenance.history).toHaveLength(2);
      expect(updated.provenance.cryptographicProof).toEqual(signed.provenance.cryptographicProof);

      const report = provenanceManager.exportProvenanceReport([legacy, updated]);
      expect(report.summary.recordsWithProvenance).toBe(2);
      expect(report.summary.cryptographicallySignedRecords).toBe(1);
    });
  });

  describe("DataImportService integration (normal, failure, retry, key rotation)", () => {
    it("signs imported records and supports idempotent retry without re-writing", async () => {
      const target = createInMemoryTarget();
      const svc = new DataImportService(target, {
        keyId: "key-v2",
        signingSecret: SIGNING_KEYS["key-v2"],
        verificationKeys: { "key-v1": SIGNING_KEYS["key-v1"] },
      });

      const rec = makePoolPayload();
      const firstRun = await svc.run({
        wallet: "GAAA1111",
        records: [rec],
        dryRun: false,
        importBatchId: "batch-sync-1",
      });

      expect(firstRun.provenance_signed).toBe(true);
      expect(firstRun.summary.create).toBe(1);
      expect(firstRun.rows[0].provenance_proof?.keyId).toBe("key-v2");

      const saved = target.store.get("GAAA1111:pool-1")!;
      const verified = svc.verifyProvenance({
        recordId: "pool-1",
        provenance: saved.provenance as RecordProvenance,
        payload: rec,
        expectedActor: "GAAA1111",
      });
      expect(verified.valid).toBe(true);
      expect(verified.status).toBe("verified");

      // Idempotent retry skips unchanged record
      const retryRun = await svc.run({
        wallet: "GAAA1111",
        records: [rec],
        dryRun: false,
        importBatchId: "batch-sync-1",
      });
      expect(retryRun.summary.skip).toBe(1);
      expect(retryRun.rows[0].reason).toBe("unchanged");
      expect(target.savedInputs).toHaveLength(1);
    });

    it("handles transient write failure and recovers cleanly on retry", async () => {
      const target = createInMemoryTarget({ failNextWrite: true });
      const svc = new DataImportService(target, {
        keyId: "key-v1",
        signingSecret: SIGNING_KEYS["key-v1"],
      });
      const rec = makePoolPayload();

      const failedRun = await svc.run({
        wallet: "GAAA1111",
        records: [rec],
        dryRun: false,
      });
      expect(failedRun.summary.error).toBe(1);
      expect(failedRun.rows[0].reason).toBe("write_failed");

      const retryRun = await svc.run({
        wallet: "GAAA1111",
        records: [rec],
        dryRun: false,
      });
      expect(retryRun.summary.create).toBe(1);
      expect(retryRun.rows[0].provenance_proof).toBeDefined();
    });

    it("fails closed with provenance_failed when signing secret is invalid", async () => {
      const target = createInMemoryTarget();
      const svc = new DataImportService(target, {
        keyId: "key-v1",
        signingSecret: "   ",
      });

      const report = await svc.run({
        wallet: "GAAA1111",
        records: [makePoolPayload()],
        dryRun: false,
      });
      expect(report.summary.error).toBe(1);
      expect(report.rows[0].reason).toBe("provenance_failed");
      expect(target.savedInputs).toHaveLength(0);
    });
  });

  describe("HTTP verification endpoint & authorization paths", () => {
    function buildApp(svc: DataImportService, principal: { walletAddress?: string; role?: string } | null) {
      const app = Fastify();
      app.setErrorHandler((err, _req, reply) => {
        if (err instanceof AppError) {
          reply.status(err.status).send({ ok: false, error: { code: err.code, message: err.message } });
          return;
        }
        reply.status(500).send({ ok: false, error: { message: err.message } });
      });
      const guard = async (req: any) => {
        req.principal = principal ?? undefined;
      };
      app.register(importsRoutes(svc, guard));
      return app;
    }

    it("enforces wallet ownership and allows maintainer cross-wallet verification", async () => {
      const target = createInMemoryTarget();
      const svc = new DataImportService(target, {
        keyId: "key-v1",
        signingSecret: SIGNING_KEYS["key-v1"],
      });
      const rec = makePoolPayload();
      await svc.run({ wallet: "GWALLET_A", records: [rec], dryRun: false });
      const saved = target.store.get("GWALLET_A:pool-1")!;

      // 1. Unauthenticated caller -> 403
      const unauthApp = buildApp(svc, null);
      const unauthRes = await unauthApp.inject({
        method: "POST",
        url: "/imports/saved-pools/verify-provenance",
        payload: { record_id: "pool-1", provenance: saved.provenance, payload: rec },
      });
      expect(unauthRes.statusCode).toBe(403);

      // 2. Different wallet -> 403 forbidden
      const otherWalletApp = buildApp(svc, { walletAddress: "GWALLET_B", role: "user" });
      const otherRes = await otherWalletApp.inject({
        method: "POST",
        url: "/imports/saved-pools/verify-provenance",
        payload: { record_id: "pool-1", provenance: saved.provenance, payload: rec },
      });
      expect(otherRes.statusCode).toBe(403);

      // 3. Owning wallet -> 200 verified
      const ownerApp = buildApp(svc, { walletAddress: "GWALLET_A", role: "user" });
      const ownerRes = await ownerApp.inject({
        method: "POST",
        url: "/imports/saved-pools/verify-provenance",
        payload: { record_id: "pool-1", provenance: saved.provenance, payload: rec },
      });
      expect(ownerRes.statusCode).toBe(200);
      expect(ownerRes.json().data).toMatchObject({ valid: true, status: "verified", key_id: "key-v1" });

      // 4. Maintainer -> 200 verified across wallets
      const maintainerApp = buildApp(svc, { walletAddress: "GADMIN_1", role: "maintainer" });
      const maintRes = await maintainerApp.inject({
        method: "POST",
        url: "/imports/saved-pools/verify-provenance",
        payload: { record_id: "pool-1", provenance: saved.provenance, payload: rec },
      });
      expect(maintRes.statusCode).toBe(200);
      expect(maintRes.json().data).toMatchObject({ valid: true, status: "verified" });
    });
  });
});
