/* eslint-disable @typescript-eslint/no-explicit-any -- PrismaClient test doubles */
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { requirePermission, walletSessionResolver } from "../src/middleware/rbac.js";
import { chainPreHandlers, enforceOperationLimit } from "../src/middleware/operationLimit.js";
import { actionsRoutes } from "../src/routes/actions.js";
import { receiptsRoutes } from "../src/routes/receipts.js";
import { recoveryRoutes } from "../src/routes/recovery.js";
import { auditTrailRoutes } from "../src/routes/auditTrail.js";
import { operationLimitsRoutes } from "../src/routes/operationLimits.js";
import { AuditTrailService, InMemoryAuditTrailStore } from "../src/services/auditTrail.js";
import {
  InMemoryReceiptStore,
  ReceiptService,
  StellarReceiptSigner,
  type ReceiptActionSnapshot,
} from "../src/services/receipts.js";
import {
  InMemoryRecoveryCaseStore,
  PendingRecoveryService,
  type PendingActionSnapshot,
} from "../src/services/pendingRecovery.js";
import {
  InMemoryLimitCounterStore,
  InMemoryLimitOverrideStore,
  OperationLimitService,
  resolveOperationPolicies,
} from "../src/services/operationLimits.js";

// HTTP contract for #812–#815: permissions are enforced server-side on every route.

const ADMIN = "GADMIN";
const OWNER = "GOWNER";
const OTHER = "GOTHER";
const ACTION_ID = "11111111-1111-4111-8111-111111111111";
const T0 = Date.parse("2026-09-29T10:00:00.000Z");

const sessions: Record<string, { walletAddress: string }> = {
  "admin-token": { walletAddress: ADMIN },
  "owner-token": { walletAddress: OWNER },
  "other-token": { walletAddress: OTHER },
};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function actionRow(overrides: Partial<ReceiptActionSnapshot & PendingActionSnapshot> = {}) {
  return {
    id: ACTION_ID,
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    walletAddress: OWNER,
    actionType: "deposit",
    actionPayload: { vault_id: "v1", amount: "50" },
    status: "submitted",
    txHash: "ab".repeat(32),
    sorobanEventId: null,
    correlationId: "33333333-3333-4333-8333-333333333333",
    errorCode: null,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    submittedAt: new Date(T0).toISOString(),
    confirmedAt: null,
    ...overrides,
  };
}

function build() {
  let now = T0 + 60 * 60_000; // one hour later: the action above is stale
  const rows = new Map<string, ReturnType<typeof actionRow>>([[ACTION_ID, actionRow()]]);
  const actions = {
    getAction: async (id: string) => rows.get(id) ?? null,
    findByTxHash: async (tx: string) => [...rows.values()].find((r) => r.txHash === tx) ?? null,
    listStale: async (cutoff: Date, limit: number) =>
      [...rows.values()]
        .filter((r) => ["pending", "submitted"].includes(r.status) && new Date(r.updatedAt) <= cutoff)
        .slice(0, limit),
    countStale: async (cutoff: Date) =>
      [...rows.values()].filter((r) => ["pending", "submitted"].includes(r.status) && new Date(r.updatedAt) <= cutoff).length,
  };

  const auditStore = new InMemoryAuditTrailStore();
  const audit = new AuditTrailService(auditStore, { now: () => new Date(now) });
  const receipts = new ReceiptService({
    store: new InMemoryReceiptStore(),
    signer: StellarReceiptSigner.fromSecret(Keypair.random().secret()),
    actions,
  });
  const recovery = new PendingRecoveryService({
    store: new InMemoryRecoveryCaseStore(),
    actions,
    audit,
    ledger: {
      markFailed: async (id) => {
        rows.set(id, { ...rows.get(id)!, status: "failed" });
      },
    },
    staleAfterMs: 30 * 60_000,
    now: () => new Date(now),
  });
  const limits = new OperationLimitService({
    policies: resolveOperationPolicies('{"receipt.verify":{"limit":2,"windowSeconds":60}}'),
    counters: new InMemoryLimitCounterStore(() => now),
    overrides: new InMemoryLimitOverrideStore(),
    audit,
    now: () => new Date(now),
  });

  const wallet = walletSessionResolver({ validateSession: async (t: string) => sessions[t] ?? null }, [ADMIN]);
  const perm = (p: Parameters<typeof requirePermission>[0]) => requirePermission(p, [wallet]);

  const app = Fastify();
  app.setErrorHandler(errorHandler as never);
  app.register(
    receiptsRoutes(receipts, {
      read: perm("own.receipts.read"),
      admin: perm("admin.receipts.read"),
      verifyLimit: enforceOperationLimit(limits, "receipt.verify"),
    }),
  );
  app.register(
    recoveryRoutes(recovery, {
      ownRead: perm("own.data.read"),
      ownRetry: chainPreHandlers(perm("own.data.read"), enforceOperationLimit(limits, "recovery.retry")),
      adminRead: perm("admin.recovery.read"),
      adminWrite: perm("admin.recovery.write"),
    }),
  );
  app.register(
    auditTrailRoutes(audit, {
      read: perm("admin.audit_trail.read"),
      export: chainPreHandlers(perm("admin.audit_trail.export"), enforceOperationLimit(limits, "audit.export")),
    }),
  );
  app.register(operationLimitsRoutes(limits, { read: perm("admin.limits.read"), write: perm("admin.limits.write") }));
  return { app, receipts, rows, auditStore, setNow: (ms: number) => (now = ms) };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("receipt routes (#812)", () => {
  it("publishes the verification key", async () => {
    const ctx = build();
    app = ctx.app;
    const res = await app.inject({ method: "GET", url: "/receipts/public-key" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ algorithm: "ed25519", key_id: ctx.receipts.keyId, ephemeral: false, version: 1 });
  });

  it("enforces ownership on lookup: 401 anonymous, 403 other wallet, 200 owner/maintainer", async () => {
    const ctx = build();
    app = ctx.app;
    const { receipt } = (await ctx.receipts.issueForActionId(ACTION_ID))!;
    const url = `/receipts/${receipt.payload.receiptId}`;

    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const denied = await app.inject({ method: "GET", url, headers: auth("other-token") });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");

    const owner = await app.inject({ method: "GET", url, headers: auth("owner-token") });
    expect(owner.statusCode).toBe(200);
    // Returned verbatim so the signature still verifies client-side.
    expect(owner.json().data).toEqual(receipt);
    expect((await app.inject({ method: "GET", url, headers: auth("admin-token") })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/receipts/rcpt_nope", headers: auth("owner-token") })).statusCode).toBe(404);
  });

  it("lists an action's receipts for its owner only", async () => {
    const ctx = build();
    app = ctx.app;
    const url = `/actions/${ACTION_ID}/receipts`;
    const res = await app.inject({ method: "GET", url, headers: auth("owner-token") });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((r: any) => r.payload.stage)).toEqual(["submitted"]);
    expect((await app.inject({ method: "GET", url, headers: auth("other-token") })).statusCode).toBe(403);
  });

  it("verifies presented receipts publicly, flags tampering, and is rate limited", async () => {
    const ctx = build();
    app = ctx.app;
    const { receipt } = (await ctx.receipts.issueForActionId(ACTION_ID))!;
    const ok = await app.inject({ method: "POST", url: "/receipts/verify", payload: { receipt } });
    expect(ok.json().data).toEqual({ valid: true, reason: null });

    const tampered = structuredClone(receipt);
    tampered.payload.operation = "withdraw";
    const bad = await app.inject({ method: "POST", url: "/receipts/verify", payload: { receipt: tampered } });
    expect(bad.json().data).toEqual({ valid: false, reason: "BAD_SIGNATURE" });

    const limited = await app.inject({ method: "POST", url: "/receipts/verify", payload: { receipt } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("OPERATION_LIMIT_EXCEEDED");
  });

  it("admin ledger verification requires the maintainer permission", async () => {
    const ctx = build();
    app = ctx.app;
    const { receipt } = (await ctx.receipts.issueForActionId(ACTION_ID))!;
    const url = `/admin/receipts/${receipt.payload.receiptId}/verify`;
    expect((await app.inject({ method: "GET", url, headers: auth("owner-token") })).statusCode).toBe(403);
    const res = await app.inject({ method: "GET", url, headers: auth("admin-token") });
    expect(res.json().data).toMatchObject({ valid: true });
  });
});

describe("recovery routes (#813)", () => {
  it("owner sees a user-safe state and can retry; other wallets cannot", async () => {
    const ctx = build();
    app = ctx.app;
    const view = await app.inject({ method: "GET", url: `/actions/${ACTION_ID}/recovery`, headers: auth("owner-token") });
    expect(view.statusCode).toBe(200);
    expect(view.json().data).toMatchObject({ state: "retryable", can_retry: true, max_attempts: 3 });
    expect(view.json().data.message).toMatch(/taking longer/);

    expect((await app.inject({ method: "GET", url: `/actions/${ACTION_ID}/recovery`, headers: auth("other-token") })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/actions/${ACTION_ID}/recovery/retry`, headers: auth("other-token") })).statusCode).toBe(403);

    const retry = await app.inject({ method: "POST", url: `/actions/${ACTION_ID}/recovery/retry`, headers: auth("owner-token") });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data).toMatchObject({ state: "retryable", attempts: 1 });
  });

  it("maintainer diagnostics, escalation and manual resolution", async () => {
    const ctx = build();
    app = ctx.app;
    expect((await app.inject({ method: "GET", url: "/admin/recovery/diagnostics", headers: auth("owner-token") })).statusCode).toBe(403);
    const diag = await app.inject({ method: "GET", url: "/admin/recovery/diagnostics", headers: auth("admin-token") });
    expect(diag.json().data.stale).toMatchObject({ count: 1 });

    const scan = await app.inject({ method: "POST", url: "/admin/recovery/scan", headers: auth("admin-token"), payload: {} });
    const caseId = scan.json().data.opened[0].id;

    const badResolve = await app.inject({
      method: "POST",
      url: `/admin/recovery/cases/${caseId}/resolve`,
      headers: auth("admin-token"),
      payload: { outcome: "confirmed", reason: "x" },
    });
    expect(badResolve.statusCode).toBe(400);

    const esc = await app.inject({
      method: "POST",
      url: `/admin/recovery/cases/${caseId}/escalate`,
      headers: auth("admin-token"),
      payload: { reason: "tx not on chain" },
    });
    expect(esc.json().data.state).toBe("manual_review");

    const resolved = await app.inject({
      method: "POST",
      url: `/admin/recovery/cases/${caseId}/resolve`,
      headers: auth("admin-token"),
      payload: { outcome: "failed", reason: "user abandoned signing" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data).toMatchObject({ state: "resolved", resolution: { kind: "manual", outcome: "failed" } });
    expect(ctx.rows.get(ACTION_ID)!.status).toBe("failed");

    const again = await app.inject({
      method: "POST",
      url: `/admin/recovery/cases/${caseId}/resolve`,
      headers: auth("admin-token"),
      payload: { outcome: "failed", reason: "again" },
    });
    expect(again.statusCode).toBe(409);

    const audited = (await ctx.auditStore.scan(0, 20)).map((r) => [r.action, r.actor.subject]);
    // The scan was triggered by the maintainer, so detection is attributed to them.
    expect(audited).toEqual([
      ["recovery.detect", ADMIN],
      ["recovery.escalate", ADMIN],
      ["recovery.resolve", ADMIN],
    ]);
  });
});

describe("audit trail routes (#814)", () => {
  it("is maintainer-only and supports list, export and verify", async () => {
    const ctx = build();
    app = ctx.app;
    await app.inject({ method: "POST", url: "/admin/recovery/scan", headers: auth("admin-token"), payload: {} });

    expect((await app.inject({ method: "GET", url: "/admin/audit-trail", headers: auth("owner-token") })).statusCode).toBe(403);
    const list = await app.inject({ method: "GET", url: "/admin/audit-trail?category=recovery&limit=10", headers: auth("admin-token") });
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0]).toMatchObject({ sequence: 1, action: "recovery.detect", record_hash: expect.any(String) });
    expect(list.json().meta.pagination).toMatchObject({ has_more: false });

    const csv = await app.inject({ method: "GET", url: "/admin/audit-trail/export?format=csv", headers: auth("admin-token") });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toContain("record_hash");
    const ndjson = await app.inject({ method: "GET", url: "/admin/audit-trail/export", headers: auth("admin-token") });
    expect(ndjson.headers["content-type"]).toContain("application/x-ndjson");

    const verify = await app.inject({ method: "GET", url: "/admin/audit-trail/verify", headers: auth("admin-token") });
    expect(verify.json().data).toEqual({ ok: true, checked: 1, problems: [] });

    expect((await app.inject({ method: "GET", url: "/admin/audit-trail?cursor=abc", headers: auth("admin-token") })).statusCode).toBe(400);
  });
});

describe("operation limit admin routes (#815)", () => {
  it("lists policies, grants/revokes overrides and resets counters — maintainer only", async () => {
    const ctx = build();
    app = ctx.app;
    expect((await app.inject({ method: "GET", url: "/admin/limits", headers: auth("owner-token") })).statusCode).toBe(403);
    const policies = await app.inject({ method: "GET", url: "/admin/limits", headers: auth("admin-token") });
    expect(policies.json().data.policies.map((p: any) => p.operation)).toContain("action.create");

    const grantBody = { operation: "receipt.verify", scope_key: "ip:127.0.0.1", limit: 10, duration_seconds: 600, reason: "partner integration test" };
    const grant = await app.inject({ method: "POST", url: "/admin/limits/overrides", headers: auth("admin-token"), payload: grantBody });
    expect(grant.statusCode).toBe(201);
    const id = grant.json().data.id;
    expect(grant.json().data).toMatchObject({ limit: 10, granted_by: ADMIN });

    const dup = await app.inject({ method: "POST", url: "/admin/limits/overrides", headers: auth("admin-token"), payload: grantBody });
    expect(dup.statusCode).toBe(409);
    const invalid = await app.inject({ method: "POST", url: "/admin/limits/overrides", headers: auth("admin-token"), payload: { ...grantBody, limit: 0 } });
    expect(invalid.statusCode).toBe(400);

    const usage = await app.inject({ method: "GET", url: "/admin/limits/usage?operation=receipt.verify&scope_key=ip:127.0.0.1", headers: auth("admin-token") });
    expect(usage.json().data).toMatchObject({ limit: 10, override_id: id });

    const revoke = await app.inject({ method: "POST", url: `/admin/limits/overrides/${id}/revoke`, headers: auth("admin-token"), payload: { reason: "test finished" } });
    expect(revoke.json().data.revoked_by).toBe(ADMIN);

    const reset = await app.inject({
      method: "POST",
      url: "/admin/limits/reset",
      headers: auth("admin-token"),
      payload: { operation: "receipt.verify", scope_key: "ip:127.0.0.1", reason: "false positive" },
    });
    expect(reset.json().data).toMatchObject({ used: 0, limit: 2 });

    const actions = (await ctx.auditStore.scan(0, 20)).map((r) => r.action);
    expect(actions).toEqual(["limits.override.grant", "limits.override.revoke", "limits.reset"]);
  });
});

describe("POST /actions duplicate requests share one receipt (#812)", () => {
  it("issues the receipt once even when the same Idempotency-Key is replayed", async () => {
    const receipts = new ReceiptService({
      store: new InMemoryReceiptStore(),
      signer: StellarReceiptSigner.fromSecret(Keypair.random().secret()),
      actions: { getAction: async () => null, findByTxHash: async () => null },
    });
    const row = { ...actionRow({ status: "pending", txHash: null, submittedAt: null }), createdAt: new Date(T0), updatedAt: new Date(T0) };
    let created = false;
    const ledger = {
      findByIdempotencyKey: vi.fn(async () => (created ? row : null)),
      createAction: vi.fn(async () => {
        created = true;
        return row;
      }),
    };
    const issued: boolean[] = [];
    app = Fastify();
    app.setErrorHandler(errorHandler as never);
    app.register(
      actionsRoutes(ledger as never, (async () => {}) as preHandlerHookHandler, {
        onActionChanged: async (a) => {
          const r = await receipts.issueForAction(a);
          issued.push(r!.created);
        },
      }),
    );

    const payload = { wallet_address: OWNER, action_type: "deposit", action_payload: { vault_id: "v1", amount: "50" } };
    const headers = { "idempotency-key": row.idempotencyKey };
    const first = await app.inject({ method: "POST", url: "/actions", payload, headers });
    const second = await app.inject({ method: "POST", url: "/actions", payload, headers });
    expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
    expect(issued).toEqual([true, false]);
  });
});
