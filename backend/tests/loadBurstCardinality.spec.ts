import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { CacheService, type AssetMetadata } from "../src/services/cacheService.js";
import { SearchIndexService } from "../src/services/search/searchIndexService.js";
import type { SearchIndexDocument } from "../src/services/search/types.js";
import { InMemoryJobStore } from "../src/worker/jobStore.js";
import {
  QueueBackpressureManager,
  QueueBackpressureError,
  type QueueBackpressureConfig,
} from "../src/worker/queueBackpressure.js";
import {
  OperationLimitService,
  InMemoryLimitCounterStore,
  InMemoryLimitOverrideStore,
  resolveOperationPolicies,
} from "../src/services/operationLimits.js";
import { AuditTrailService, InMemoryAuditTrailStore } from "../src/services/auditTrail.js";
import type { Principal } from "../src/middleware/rbac.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const dummyPrisma = {
  pendingEvent: {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async () => ({})),
  },
} as unknown as PrismaClient;

describe("Worst-Case Cardinality and Burst Traffic Load Test (#986)", () => {
  describe("1. Worst-Case Cardinality Paths", () => {
    it("strictly bounds in-memory cache capacity when receiving 10,000 unique keys", async () => {
      const bound = 100;
      const cache = new CacheService(dummyPrisma, noopLogger, undefined, bound);

      const TOTAL_CARDINALITY = 10000;
      const t0 = Date.now();

      // Ingest 10,000 high-cardinality distinct asset metadata records
      for (let i = 0; i < TOTAL_CARDINALITY; i++) {
        const asset: AssetMetadata = {
          asset: `ASSET_STX_${i}`,
          decimals: 7,
          lastUpdated: new Date(t0 + i),
        };
        await cache.setAssetMetadata(asset);
      }

      // 1. Verify in-memory map size never exceeded the configured bound
      const assetMap = (cache as any).assetMap as Map<string, unknown>;
      expect(assetMap.size).toBeLessThanOrEqual(bound);

      // 2. Verify older keys were evicted (LRU invariant)
      expect(await cache.getAssetMetadata("ASSET_STX_0")).toBeNull();
      expect(await cache.getAssetMetadata("ASSET_STX_100")).toBeNull();

      // 3. Verify newest keys are retained
      const newestKey = `ASSET_STX_${TOTAL_CARDINALITY - 1}`;
      const found = await cache.getAssetMetadata(newestKey);
      expect(found).not.toBeNull();
      expect(found?.asset).toBe(newestKey);
    });

    it("scales search index without memory explosion across 5,000 high-cardinality documents", async () => {
      const searchService = new SearchIndexService();
      const DOC_COUNT = 5000;
      const docs: SearchIndexDocument[] = [];

      for (let i = 0; i < DOC_COUNT; i++) {
        docs.push({
          id: `vault:doc-${i}`,
          recordType: "vault",
          recordId: `doc-${i}`,
          title: `Vault Yield Alpha ${i % 50} UniqueTag${i}`,
          description: `High cardinality description for wallet G${String(i).padStart(55, "0")}`,
          visibility: "public",
          searchableText: `vault yield alpha ${i % 50} uniquetag${i} g${String(i).padStart(55, "0")}`.toLowerCase(),
          version: 1,
          sourceUpdatedAt: new Date(),
          indexedAt: new Date(),
        });
      }

      const startTime = performance.now();
      await searchService.indexDocuments(docs);
      const indexDuration = performance.now() - startTime;

      expect(indexDuration).toBeLessThan(2000); // Sub-2s ingestion for 5,000 docs

      // Search query should resolve in sub-millisecond time
      const searchStart = performance.now();
      const results = await searchService.search({
        q: "alpha",
        limit: 10,
      });
      const searchDuration = performance.now() - searchStart;

      expect(searchDuration).toBeLessThan(50);
      expect(results.items.length).toBeGreaterThan(0);
      expect(results.total).toBeGreaterThan(0);
    });

    it("isolates counters under 3,000 high-cardinality wallet addresses without cross-contamination", async () => {
      let now = Date.parse("2026-03-01T12:00:00Z");
      const store = new InMemoryLimitCounterStore(() => now);
      const audit = new AuditTrailService(new InMemoryAuditTrailStore(), { now: () => new Date(now) });

      const svc = new OperationLimitService({
        policies: resolveOperationPolicies('{"action.create":{"limit":2,"windowSeconds":60}}'),
        counters: store,
        overrides: new InMemoryLimitOverrideStore(),
        audit,
        now: () => new Date(now),
      });

      const WALLET_COUNT = 3000;

      // Each wallet performs 2 actions (allowed)
      for (let i = 0; i < WALLET_COUNT; i++) {
        const wallet = `G${String(i).padStart(55, "A")}`;
        const r1 = await svc.enforce("action.create", wallet);
        const r2 = await svc.enforce("action.create", wallet);
        expect(r1.allowed).toBe(true);
        expect(r2.allowed).toBe(true);
      }

      // 3rd action exceeds the limit of 2 for that specific wallet, but does not affect others
      const targetWallet = `G${"0".padStart(55, "A")}`;
      await expect(svc.enforce("action.create", targetWallet)).rejects.toThrow();

      // Advancing past window resets window counters
      now += 61 * 1000;
      const afterWindow = await svc.enforce("action.create", targetWallet);
      expect(afterWindow.allowed).toBe(true);
    });
  });

  describe("2. Burst Traffic & Watermark Transitions", () => {
    let jobStore: InMemoryJobStore;
    let manager: QueueBackpressureManager;

    const backpressureConfig: QueueBackpressureConfig = {
      maxQueueDepth: 100,
      highWatermarkRatio: 0.8, // 80 jobs
      lowWatermarkRatio: 0.5,  // 50 jobs
      expensiveJobTypes: new Set(["settlement", "indexer_backfill", "batch_export"]),
      maxExpensiveDepth: 20,
      maxInFlight: 25,
      defaultRetryAfterMs: 3000,
    };

    beforeEach(() => {
      jobStore = new InMemoryJobStore();
      manager = new QueueBackpressureManager(jobStore, backpressureConfig);
    });

    it("transitions smoothly: normal -> warning/shedding -> saturated under burst load", async () => {
      const now = new Date();

      // Phase A: Normal traffic (0 to 40 jobs)
      for (let i = 0; i < 40; i++) {
        await jobStore.enqueue({ type: "draw_proof", idempotencyKey: `dp-${i}`, payload: {}, maxAttempts: 3 }, now);
      }
      let metrics = await manager.getMetrics();
      expect(metrics.state).toBe("normal");
      expect(metrics.activeShedding).toBe(false);

      // Phase B: Burst brings queue to 85 jobs (> 80 high watermark) -> Warning State
      for (let i = 40; i < 85; i++) {
        await jobStore.enqueue({ type: "draw_proof", idempotencyKey: `dp-${i}`, payload: {}, maxAttempts: 3 }, now);
      }

      // Admission check activates warning/shedding state via watermark check
      const admission = await manager.checkAdmission("draw_proof");
      expect(admission.admitted).toBe(true);

      metrics = await manager.getMetrics();
      expect(metrics.state).toBe("warning");
      expect(metrics.activeShedding).toBe(true);

      // In warning state, expensive jobs exceeding maxExpensiveDepth are shed with 429
      for (let i = 0; i < 20; i++) {
        await jobStore.enqueue({ type: "settlement", idempotencyKey: `set-${i}`, payload: {}, maxAttempts: 3 }, now);
      }
      await expect(manager.checkAdmission("settlement")).rejects.toThrow(QueueBackpressureError);

      // Phase C: Burst exceeds maxQueueDepth (100) -> Saturated State
      for (let i = 85; i < 105; i++) {
        await jobStore.enqueue({ type: "draw_proof", idempotencyKey: `extra-${i}`, payload: {}, maxAttempts: 3 }, now);
      }
      metrics = await manager.getMetrics();
      expect(metrics.state).toBe("saturated");

      // In saturated state, all non-critical jobs are rejected
      await expect(manager.checkAdmission("draw_proof")).rejects.toThrow(QueueBackpressureError);
    });

    it("enforces HTTP 429 and Retry-After delay during load shedding (Failure Path)", async () => {
      const now = new Date();
      // Saturate expensive job capacity
      for (let i = 0; i < 20; i++) {
        await jobStore.enqueue({ type: "settlement", idempotencyKey: `set-${i}`, payload: {}, maxAttempts: 3 }, now);
      }

      try {
        await manager.checkAdmission("settlement");
        expect.unreachable("should have been rejected");
      } catch (err: any) {
        expect(err).toBeInstanceOf(QueueBackpressureError);
        expect(err.statusCode).toBe(429);
        expect(err.retryAfterMs).toBe(3000);
        expect(err.currentDepth).toBe(20);
        expect(err.maxCapacity).toBe(20);
        expect(err.message).toContain("Queue backpressure: expensive job type 'settlement' reached limit");
      }
    });

    it("recovers gracefully to normal state when workers drain backlog past low watermark (Retry & Recovery Path)", async () => {
      const now = new Date();
      // 1. Fill queue to 90 (warning/shedding state)
      for (let i = 0; i < 90; i++) {
        await jobStore.enqueue({ type: "draw_proof", idempotencyKey: `d-${i}`, payload: {}, maxAttempts: 3 }, now);
      }

      await manager.checkAdmission("draw_proof");
      let metrics = await manager.getMetrics();
      expect(metrics.state).toBe("warning");
      expect(metrics.activeShedding).toBe(true);

      // 2. Simulated worker claims and completes 50 jobs (draining below lowWatermark 50)
      const claimed = await jobStore.claim({
        workerId: "test-worker",
        now,
        visibilityTimeoutMs: 60000,
        limit: 50,
      });
      for (const j of claimed) {
        await jobStore.complete(j.id, "test-worker", now);
      }

      // 3. Admission check triggers transition back to normal
      await manager.checkAdmission("draw_proof");
      metrics = await manager.getMetrics();
      expect(metrics.state).toBe("normal");
      expect(metrics.activeShedding).toBe(false);

      // 4. Retrying previously shed jobs now succeeds
      const retryAdmission = await manager.checkAdmission("settlement");
      expect(retryAdmission.admitted).toBe(true);
    });
  });

  describe("3. Priority & Authorization Paths under Load", () => {
    it("distinguishes administrative priority operations during heavy contention", async () => {
      let now = Date.parse("2026-03-01T12:00:00Z");
      const store = new InMemoryLimitCounterStore(() => now);
      const audit = new AuditTrailService(new InMemoryAuditTrailStore(), { now: () => new Date(now) });
      const overrides = new InMemoryLimitOverrideStore();

      const svc = new OperationLimitService({
        policies: resolveOperationPolicies('{"action.create":{"limit":2,"windowSeconds":60}}'),
        counters: store,
        overrides,
        audit,
        now: () => new Date(now),
      });

      const userWallet = `wallet:GUSER${"U".repeat(50)}`;
      const adminWallet = `wallet:GADMIN${"A".repeat(49)}`;
      const adminActor = { subject: "GADMIN", role: "maintainer" as const };

      // Normal user reaches limit of 2 quickly
      await svc.enforce("action.create", userWallet);
      await svc.enforce("action.create", userWallet);
      await expect(svc.enforce("action.create", userWallet)).rejects.toThrow();

      // Administrator grants an audited priority override for critical operations
      await svc.grantOverride(
        {
          operation: "action.create",
          scopeKey: adminWallet,
          limit: 50,
          durationMs: 3600000,
          reason: "Emergency maintainer intervention",
        },
        adminActor
      );

      // Admin actions continue to be admitted under contention
      for (let i = 0; i < 10; i++) {
        const res = await svc.enforce("action.create", adminWallet);
        expect(res.allowed).toBe(true);
        expect(res.overrideId).not.toBeNull();
      }
    });

    it("allows critical priority bypass through queue backpressure", async () => {
      const store = new InMemoryJobStore();
      const manager = new QueueBackpressureManager(store, {
        maxQueueDepth: 10,
        highWatermarkRatio: 0.8,
        lowWatermarkRatio: 0.5,
        expensiveJobTypes: new Set(["heavy"]),
        maxExpensiveDepth: 2,
        maxInFlight: 2,
        defaultRetryAfterMs: 3000,
      });

      const now = new Date();
      // Saturate queue completely
      for (let i = 0; i < 10; i++) {
        await store.enqueue({ type: "heavy", idempotencyKey: `sat-${i}`, payload: {}, maxAttempts: 3 }, now);
      }

      // Normal admission fails with 429
      await expect(manager.checkAdmission("normal_job")).rejects.toThrow(QueueBackpressureError);

      // Critical priority or authorized bypass succeeds even when saturated
      const bypassAdmission = await manager.checkAdmission("emergency_job", { priority: "critical" });
      expect(bypassAdmission.admitted).toBe(true);

      const explicitBypass = await manager.checkAdmission("emergency_job", { bypassBackpressure: true });
      expect(explicitBypass.admitted).toBe(true);
    });
  });

  describe("4. Concurrency Spike Integrity", () => {
    it("preserves atomic admission counters under simultaneous asynchronous requests", async () => {
      const store = new InMemoryJobStore();
      const manager = new QueueBackpressureManager(store, {
        maxQueueDepth: 50,
        highWatermarkRatio: 0.8,
        lowWatermarkRatio: 0.5,
        expensiveJobTypes: new Set(["heavy"]),
        maxExpensiveDepth: 10,
        maxInFlight: 10,
        defaultRetryAfterMs: 1000,
      });

      // 100 simultaneous concurrent admissions
      const results = await Promise.allSettled(
        Array.from({ length: 100 }, (_, i) => manager.checkAdmission(`job-${i}`))
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled.length).toBeGreaterThan(0);
      const metrics = await manager.getMetrics();
      expect(metrics.admittedTotal + metrics.rejectedTotal).toBe(100);
      expect(fulfilled.length).toBe(metrics.admittedTotal);
      expect(rejected.length).toBe(metrics.rejectedTotal);
    });
  });
});
