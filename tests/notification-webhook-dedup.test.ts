import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDedupKey,
  computePayloadHash,
  DedupDeliveryError,
  DedupError,
  InMemoryDedupStore,
  NotificationWebhookDedupCoordinator,
  type DedupKeyInput,
  type DedupPrincipal
} from "../lib/notification-webhook-dedup.ts";

const servicePrincipal: DedupPrincipal = {
  actorId: "svc-dispatcher",
  role: "service",
  tenantId: "wallet-alpha"
};

const userPrincipal: DedupPrincipal = {
  actorId: "user-alpha",
  role: "user",
  tenantId: "wallet-alpha"
};

const adminPrincipal: DedupPrincipal = {
  actorId: "admin-ops",
  role: "admin",
  tenantId: "platform"
};

const notifKey: DedupKeyInput = {
  channel: "notification",
  tenantId: "wallet-alpha",
  eventType: "maturity",
  eventId: "evt-1001",
  target: "in-app"
};

const webhookKey: DedupKeyInput = {
  channel: "webhook_outbound",
  tenantId: "wallet-alpha",
  eventType: "pool.matured",
  eventId: "evt-1001",
  target: "https://hooks.example.com/vaultquest"
};

test("normal path: deduplicates repeated notification and webhook dispatches", async () => {
  let now = 1_700_000_000_000;
  const coordinator = new NotificationWebhookDedupCoordinator({ now: () => now });

  let notifCalls = 0;
  const firstNotif = await coordinator.dispatch({
    principal: userPrincipal,
    key: notifKey,
    payload: { poolId: "pool-1", amount: "100" },
    execute: async () => {
      notifCalls += 1;
      return { deliveredId: "n-1" };
    }
  });

  assert.equal(firstNotif.status, "executed");
  assert.equal(firstNotif.deduplicated, false);
  assert.equal(firstNotif.attempts, 1);
  assert.deepEqual(firstNotif.result, { deliveredId: "n-1" });

  // Duplicate notification with differently ordered JSON keys produces same payload hash
  const dupNotif = await coordinator.dispatch({
    principal: userPrincipal,
    key: notifKey,
    payload: { amount: "100", poolId: "pool-1" },
    execute: async () => {
      notifCalls += 1;
      return { deliveredId: "n-2" };
    }
  });

  assert.equal(dupNotif.status, "duplicate");
  assert.equal(dupNotif.deduplicated, true);
  assert.deepEqual(dupNotif.result, { deliveredId: "n-1" });
  assert.equal(notifCalls, 1);

  // Same eventId on webhook_outbound channel does NOT collide with notification channel
  let webhookCalls = 0;
  const firstWebhook = await coordinator.dispatch({
    principal: servicePrincipal,
    key: webhookKey,
    payload: { poolId: "pool-1" },
    execute: async () => {
      webhookCalls += 1;
      return { statusCode: 200 };
    }
  });

  assert.equal(firstWebhook.status, "executed");
  assert.equal(webhookCalls, 1);

  const dupWebhook = await coordinator.dispatch({
    principal: servicePrincipal,
    key: webhookKey,
    payload: { poolId: "pool-1" },
    execute: async () => {
      webhookCalls += 1;
      return { statusCode: 200 };
    }
  });

  assert.equal(dupWebhook.status, "duplicate");
  assert.equal(webhookCalls, 1);
});

test("failure path: detects payload fingerprint conflict on reused dedup key", async () => {
  const coordinator = new NotificationWebhookDedupCoordinator();

  await coordinator.dispatch({
    principal: servicePrincipal,
    key: webhookKey,
    payload: { poolId: "pool-1", amount: "100" },
    execute: async () => ({ ok: true })
  });

  await assert.rejects(
    () =>
      coordinator.dispatch({
        principal: servicePrincipal,
        key: webhookKey,
        payload: { poolId: "pool-1", amount: "999" },
        execute: async () => ({ ok: true })
      }),
    (err: unknown) => err instanceof DedupError && err.code === "PAYLOAD_CONFLICT" && err.httpStatus === 409
  );
});

test("retry path: transient failure retries and succeeds within maxAttempts", async () => {
  const coordinator = new NotificationWebhookDedupCoordinator({ defaultMaxAttempts: 3 });
  let calls = 0;

  const attempt1 = await coordinator.dispatch({
    principal: servicePrincipal,
    key: webhookKey,
    payload: { poolId: "pool-1" },
    execute: async () => {
      calls += 1;
      throw new DedupDeliveryError("503 Service Unavailable", true);
    }
  });
  assert.equal(attempt1.status, "failed_retryable");
  assert.equal(attempt1.attempts, 1);

  const attempt2 = await coordinator.dispatch({
    principal: servicePrincipal,
    key: webhookKey,
    payload: { poolId: "pool-1" },
    execute: async () => {
      calls += 1;
      return { statusCode: 202 };
    }
  });
  assert.equal(attempt2.status, "executed");
  assert.equal(attempt2.attempts, 2);
  assert.deepEqual(attempt2.result, { statusCode: 202 });
  assert.equal(calls, 2);
});

test("failure & recovery path: non-retryable or exhausted failure becomes terminal until admin requeues or rolls back", async () => {
  const coordinator = new NotificationWebhookDedupCoordinator({ defaultMaxAttempts: 2 });
  let calls = 0;

  const terminal = await coordinator.dispatch({
    principal: servicePrincipal,
    key: webhookKey,
    payload: { poolId: "pool-1" },
    execute: async () => {
      calls += 1;
      throw new DedupDeliveryError("400 Bad Request", false);
    }
  });
  assert.equal(terminal.status, "failed_terminal");
  assert.equal(calls, 1);

  // Subsequent automatic retry is blocked
  const blocked = await coordinator.dispatch({
    principal: servicePrincipal,
    key: webhookKey,
    payload: { poolId: "pool-1" },
    execute: async () => {
      calls += 1;
      return { ok: true };
    }
  });
  assert.equal(blocked.status, "failed_terminal");
  assert.equal(blocked.deduplicated, true);
  assert.equal(calls, 1);

  // Admin requeues for recovery -> retry now executes
  await coordinator.requeueForRecovery(adminPrincipal, webhookKey);
  const recovered = await coordinator.dispatch({
    principal: servicePrincipal,
    key: webhookKey,
    payload: { poolId: "pool-1" },
    execute: async () => {
      calls += 1;
      return { recovered: true };
    }
  });
  assert.equal(recovered.status, "executed");
  assert.equal(recovered.attempts, 1);
  assert.equal(calls, 2);

  // Admin rollback deletes record so a fresh payload can be processed
  const deleted = await coordinator.rollbackEntry(adminPrincipal, webhookKey);
  assert.equal(deleted, true);
  const afterRollback = await coordinator.inspect(adminPrincipal, webhookKey);
  assert.equal(afterRollback, null);
});

test("retry & crash recovery: active in-flight lease blocks duplicates, expired lease allows takeover", async () => {
  let now = 1_700_000_000_000;
  const store = new InMemoryDedupStore();
  const coordinator = new NotificationWebhookDedupCoordinator({
    store,
    now: () => now,
    defaultLeaseMs: 10_000
  });

  // Simulate a crashed worker that left a record in_flight
  const dedupKey = buildDedupKey(webhookKey);
  await store.set({
    id: "rec-crash",
    dedupKey,
    channel: webhookKey.channel,
    tenantId: webhookKey.tenantId,
    eventType: webhookKey.eventType,
    eventId: webhookKey.eventId,
    target: webhookKey.target,
    payloadHash: computePayloadHash({ poolId: "pool-1" }),
    status: "in_flight",
    attempts: 1,
    maxAttempts: 3,
    leaseExpiresAt: now + 10_000,
    expiresAt: now + 60_000,
    createdAt: now,
    updatedAt: now
  });

  // While lease is active, duplicate sees in_flight
  const duringLease = await coordinator.dispatch({
    principal: servicePrincipal,
    key: webhookKey,
    payload: { poolId: "pool-1" },
    execute: async () => ({ shouldNotRun: true })
  });
  assert.equal(duringLease.status, "in_flight");
  assert.equal(duringLease.deduplicated, true);

  // Advance clock past lease expiry -> worker takeover succeeds
  now += 15_000;
  const takeover = await coordinator.dispatch({
    principal: servicePrincipal,
    key: webhookKey,
    payload: { poolId: "pool-1" },
    execute: async () => ({ takenOver: true })
  });
  assert.equal(takeover.status, "executed");
  assert.equal(takeover.attempts, 2);
  assert.deepEqual(takeover.result, { takenOver: true });
});

test("TTL expiration and pruning allow fresh delivery after window elapses", async () => {
  let now = 1_700_000_000_000;
  const coordinator = new NotificationWebhookDedupCoordinator({
    now: () => now,
    notificationTtlMs: 60_000
  });

  await coordinator.dispatch({
    principal: userPrincipal,
    key: notifKey,
    payload: { v: 1 },
    execute: async () => ({ run: 1 })
  });

  now += 61_000;
  const pruned = await coordinator.pruneExpired(adminPrincipal);
  assert.equal(pruned, 1);

  const fresh = await coordinator.dispatch({
    principal: userPrincipal,
    key: notifKey,
    payload: { v: 2 },
    execute: async () => ({ run: 2 })
  });
  assert.equal(fresh.status, "executed");
  assert.deepEqual(fresh.result, { run: 2 });
});

test("authorization paths: enforces authentication, tenant isolation, channel scope, and admin-only recovery", async () => {
  const coordinator = new NotificationWebhookDedupCoordinator();

  // 401 Unauthenticated
  await assert.rejects(
    () =>
      coordinator.dispatch({
        principal: { actorId: "", role: "user", tenantId: "" },
        key: notifKey,
        payload: {},
        execute: async () => ({})
      }),
    (err: unknown) => err instanceof DedupError && err.code === "UNAUTHENTICATED" && err.httpStatus === 401
  );

  // 403 Cross-tenant access denied
  await assert.rejects(
    () =>
      coordinator.dispatch({
        principal: { actorId: "user-beta", role: "user", tenantId: "wallet-beta" },
        key: notifKey,
        payload: {},
        execute: async () => ({})
      }),
    (err: unknown) => err instanceof DedupError && err.code === "UNAUTHORIZED" && err.httpStatus === 403
  );

  // 403 User role cannot dispatch webhooks
  await assert.rejects(
    () =>
      coordinator.dispatch({
        principal: userPrincipal,
        key: webhookKey,
        payload: {},
        execute: async () => ({})
      }),
    (err: unknown) => err instanceof DedupError && err.code === "UNAUTHORIZED" && err.httpStatus === 403
  );

  // 403 Non-admin cannot requeue, rollback, or prune
  await assert.rejects(
    () => coordinator.requeueForRecovery(servicePrincipal, webhookKey),
    (err: unknown) => err instanceof DedupError && err.code === "UNAUTHORIZED" && err.httpStatus === 403
  );
  await assert.rejects(
    () => coordinator.rollbackEntry(userPrincipal, notifKey),
    (err: unknown) => err instanceof DedupError && err.code === "UNAUTHORIZED" && err.httpStatus === 403
  );
  await assert.rejects(
    () => coordinator.pruneExpired(servicePrincipal),
    (err: unknown) => err instanceof DedupError && err.code === "UNAUTHORIZED" && err.httpStatus === 403
  );
});
