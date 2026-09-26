import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { register } from "prom-client";
import { LedgerService } from "../src/services/ledger.js";
import { WalletAuthService } from "../src/services/walletAuth.js";
import { DrawProofService } from "../src/services/drawProofService.js";
import { AppError } from "../src/errors.js";
import correlation from "../src/middleware/correlation.js";
import {
  ACTOR_TYPES,
  OPERATIONS,
  configureTelemetry,
  currentCorrelationId,
  recordOperation,
  runWithCorrelation,
  subscribeTelemetry,
  withTelemetry,
  type OperationEvent
} from "../src/services/telemetry.js";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const TX = "a".repeat(64);
const REQUIRED_FIELDS = ["event", "operation", "actor_type", "result", "latency_ms", "correlation_id"] as const;

let events: OperationEvent[] = [];
let unsubscribe: () => void;

beforeEach(() => {
  events = [];
  unsubscribe = subscribeTelemetry((e) => events.push(e));
});
afterEach(() => {
  unsubscribe();
  configureTelemetry({});
});

async function metric(name: string, labels: Record<string, string>): Promise<number> {
  const found = (await register.getMetricsAsJSON()).find((m) => m.name === name) as any;
  const hit = found?.values?.find((v: any) =>
    Object.entries(labels).every(([k, val]) => v.labels?.[k] === val) &&
    (v.metricName === undefined || v.metricName === name || v.metricName === `${name}_count`)
  );
  return hit?.value ?? 0;
}

describe("withTelemetry", () => {
  it("records success with allow-listed fields", async () => {
    const out = await withTelemetry({ operation: "action.create", actorType: "user", correlationId: "c-1" }, async () => 42);
    expect(out).toBe(42);
    expect(events).toHaveLength(1);
    const e = events[0];
    for (const f of REQUIRED_FIELDS) expect(e).toHaveProperty(f);
    expect(e).toMatchObject({ operation: "action.create", actor_type: "user", result: "success", correlation_id: "c-1" });
    expect(e.latency_ms).toBeGreaterThanOrEqual(0);
    expect(e.error_code).toBeUndefined();
  });

  it("records failures with a stable code and rethrows the original error", async () => {
    const err = AppError.notFound("action secret-id not found");
    await expect(withTelemetry({ operation: "action.cancel", actorType: "user" }, async () => { throw err; })).rejects.toBe(err);
    expect(events[0]).toMatchObject({ result: "failure", error_code: "NOT_FOUND", error_category: "not_found" });
    expect(JSON.stringify(events[0])).not.toContain("secret-id");
  });

  it("classifies unknown errors as INTERNAL without leaking the message", async () => {
    await expect(
      withTelemetry({ operation: "worker.job", actorType: "worker", detail: "indexer" }, async () => {
        throw new Error(`db password=hunter2 wallet=${WALLET}`);
      })
    ).rejects.toThrow("hunter2");
    expect(events[0]).toMatchObject({ error_code: "INTERNAL", error_category: "internal", detail: "indexer" });
    const raw = JSON.stringify(events[0]);
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain(WALLET);
  });

  it("uses the ambient correlation id when none is passed", async () => {
    await runWithCorrelation("ambient-9", () =>
      withTelemetry({ operation: "action.create", actorType: "user" }, async () => {
        expect(currentCorrelationId()).toBe("ambient-9");
      })
    );
    expect(events[0].correlation_id).toBe("ambient-9");
    await withTelemetry({ operation: "action.create", actorType: "user" }, async () => {});
    expect(events[1].correlation_id).toBeNull();
  });

  it("writes info on success and warn on failure to the configured logger", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() } as any;
    configureTelemetry({ logger });
    await withTelemetry({ operation: "action.create", actorType: "user" }, async () => {});
    await withTelemetry({ operation: "action.create", actorType: "user" }, async () => { throw new Error("x"); }).catch(() => {});
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatchObject({ result: "failure", error_code: "INTERNAL" });
  });

  it("never lets a broken listener break the operation", async () => {
    const off = subscribeTelemetry(() => { throw new Error("listener bug"); });
    await expect(withTelemetry({ operation: "action.create", actorType: "user" }, async () => "ok")).resolves.toBe("ok");
    off();
  });

  it("emits Prometheus counters, histogram, and failure code", async () => {
    const before = await metric("vaultquest_operations_total", { operation: "action.cancel", actor_type: "user", result: "failure" });
    const beforeFail = await metric("vaultquest_operation_failures_total", { operation: "action.cancel", error_code: "FORBIDDEN" });
    await withTelemetry({ operation: "action.cancel", actorType: "user" }, async () => { throw AppError.forbidden(); }).catch(() => {});
    expect(await metric("vaultquest_operations_total", { operation: "action.cancel", actor_type: "user", result: "failure" })).toBe(before + 1);
    expect(await metric("vaultquest_operation_failures_total", { operation: "action.cancel", error_code: "FORBIDDEN" })).toBe(beforeFail + 1);
    const hist = (await register.getMetricsAsJSON()).find((m) => m.name === "vaultquest_operation_duration_seconds");
    expect(hist).toBeDefined();
  });

  it("recordOperation defaults the failure code to INTERNAL", async () => {
    const before = await metric("vaultquest_operation_failures_total", { operation: "worker.job", error_code: "INTERNAL" });
    recordOperation({ event: "operation", operation: "worker.job", actor_type: "worker", result: "failure", latency_ms: 5, correlation_id: null });
    expect(await metric("vaultquest_operation_failures_total", { operation: "worker.job", error_code: "INTERNAL" })).toBe(before + 1);
  });

  it("exposes bounded operation and actor catalogs", () => {
    expect(OPERATIONS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(OPERATIONS).size).toBe(OPERATIONS.length);
    expect(ACTOR_TYPES).toContain("worker");
  });
});

describe("correlation plugin binds telemetry context", () => {
  it("makes the request correlation id visible inside the handler", async () => {
    const app = Fastify();
    app.register(correlation);
    app.get("/x", async () => withTelemetry({ operation: "action.create", actorType: "user" }, async () => "done"));
    const res = await app.inject({ method: "GET", url: "/x", headers: { "correlation-id": "req-77" } });
    expect(res.statusCode).toBe(200);
    expect(events.at(-1)?.correlation_id).toBe("req-77");
  });
});

describe("core operations emit telemetry (success and failure paths)", () => {
  it("action.create: success and idempotency conflict", async () => {
    const row = { id: "1", idempotencyKey: "k", walletAddress: WALLET, actionType: "deposit", actionPayload: { a: 1 } };
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    const prisma = { actionLedger: { findUnique, create: vi.fn().mockResolvedValue(row) } } as any;
    const svc = new LedgerService(prisma);
    await svc.createAction({ idempotencyKey: "k", walletAddress: WALLET, actionType: "deposit", actionPayload: { a: 1 } } as any);
    await expect(
      svc.createAction({ idempotencyKey: "k", walletAddress: WALLET, actionType: "deposit", actionPayload: { a: 2 } } as any)
    ).rejects.toThrow();
    expect(events.map((e) => [e.operation, e.result, e.error_code])).toEqual([
      ["action.create", "success", undefined],
      ["action.create", "failure", "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"]
    ]);
    expect(events[0].actor_type).toBe("user");
  });

  it("action.cancel: failure when the action does not exist", async () => {
    const prisma = { actionLedger: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    await expect(new LedgerService(prisma).cancelAction("nope", "WALLET_REJECTED")).rejects.toThrow();
    expect(events[0]).toMatchObject({ operation: "action.cancel", result: "failure", error_code: "NOT_FOUND" });
  });

  it("action.attach_tx: failure is reported without the tx hash", async () => {
    const prisma = {
      $transaction: vi.fn(async (fn: any) => fn({ actionLedger: { findUnique: vi.fn().mockResolvedValue(null) } }))
    } as any;
    await expect(new LedgerService(prisma).attachTxHash("missing", TX, { workerId: "w" })).rejects.toThrow();
    expect(events[0]).toMatchObject({ operation: "action.attach_tx", actor_type: "service", result: "failure" });
    expect(JSON.stringify(events[0])).not.toContain(TX);
  });

  it("action.reconcile_event: unmatched event is a success", async () => {
    const tx = { actionLedger: { findFirst: vi.fn().mockResolvedValue(null) }, pendingEvent: { upsert: vi.fn() } };
    const prisma = { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
    const out = await new LedgerService(prisma).reconcileEvent({
      txHash: TX,
      sorobanEventId: "e1",
      eventPayload: {},
      statusHint: "confirmed"
    } as any);
    expect(out).toEqual({ matched: false });
    expect(events[0]).toMatchObject({ operation: "action.reconcile_event", actor_type: "system", result: "success" });
    expect(JSON.stringify(events[0])).not.toContain(TX);
  });

  it("wallet.verify_challenge: unknown challenge fails as UNAUTHORIZED", async () => {
    const prisma = { walletChallenge: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    await expect(
      new WalletAuthService(prisma).verifyChallenge({ challengeId: "c", publicKey: WALLET, network: "testnet", signature: "s", payload: "p" } as any)
    ).rejects.toThrow();
    expect(events[0]).toMatchObject({ operation: "wallet.verify_challenge", result: "failure", error_code: "UNAUTHORIZED" });
    expect(JSON.stringify(events[0])).not.toContain(WALLET);
  });

  it("draw_proof.generate: missing action resolves null and still reports success", async () => {
    const prisma = { actionLedger: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    await expect(new DrawProofService(prisma, null).generateProof({ actionId: "a" })).resolves.toBeNull();
    expect(events[0]).toMatchObject({ operation: "draw_proof.generate", actor_type: "worker", result: "success" });
  });

  it("emits every required field for at least five distinct core operations", async () => {
    const row = { id: "1", idempotencyKey: "k", walletAddress: WALLET, actionType: "deposit", actionPayload: {} };
    const tx = { actionLedger: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) }, pendingEvent: { upsert: vi.fn() } };
    const prisma = {
      actionLedger: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(row) },
      walletChallenge: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (fn: any) => fn(tx))
    } as any;
    const ledger = new LedgerService(prisma);
    await runWithCorrelation("corr-5", async () => {
      await ledger.createAction({ idempotencyKey: "k", walletAddress: WALLET, actionType: "deposit", actionPayload: {} } as any);
      await ledger.cancelAction("x", "WALLET_REJECTED").catch(() => {});
      await ledger.attachTxHash("x", TX, { workerId: "w" }).catch(() => {});
      await ledger.reconcileEvent({ txHash: TX, sorobanEventId: "e", eventPayload: {}, statusHint: "confirmed" } as any);
      await new WalletAuthService(prisma).verifyChallenge({ challengeId: "c" } as any).catch(() => {});
      await new DrawProofService(prisma, null).generateProof({ actionId: "a" });
    });
    expect(new Set(events.map((e) => e.operation)).size).toBeGreaterThanOrEqual(5);
    for (const e of events) {
      for (const f of REQUIRED_FIELDS) expect(e, `${e.operation}.${f}`).toHaveProperty(f);
      expect(e.correlation_id).toBe("corr-5");
      expect(ACTOR_TYPES).toContain(e.actor_type);
      expect(OPERATIONS as readonly string[]).toContain(e.operation);
      expect(JSON.stringify(e)).not.toContain(WALLET);
      expect(JSON.stringify(e)).not.toContain(TX);
    }
  });
});
