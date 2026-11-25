import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CORRELATION_HEADER,
  CorrelationAuthorizationError,
  CorrelationContextError,
  CorrelationTraceRegistry,
  PARENT_SPAN_HEADER,
  buildDownstreamCorrelationHeaders,
  extractOrCreateCorrelationContext,
} from "../../src/lib/request-correlation.mjs";

describe("end-to-end request correlation IDs (#1105)", () => {
  const admin = { id: "admin-1", role: "admin" };
  const alice = { id: "user-alice", role: "user" };
  const bob = { id: "user-bob", role: "user" };

  it("normal path: preserves valid inbound correlation ID and propagates parent/child spans downstream", () => {
    const inbound = extractOrCreateCorrelationContext(
      { [CORRELATION_HEADER]: "vq-trace-2026-abcdef12" },
      { actorId: alice.id, service: "gateway" }
    );

    assert.equal(inbound.correlationId, "vq-trace-2026-abcdef12");
    assert.equal(inbound.sanitizedFromInvalid, false);
    assert.ok(inbound.spanId.startsWith("span-"));

    const { headers, childContext } = buildDownstreamCorrelationHeaders(inbound);
    assert.equal(headers[CORRELATION_HEADER], "vq-trace-2026-abcdef12");
    assert.equal(headers[PARENT_SPAN_HEADER], inbound.spanId);
    assert.equal(childContext.parentSpanId, inbound.spanId);
    assert.notEqual(childContext.spanId, inbound.spanId);
  });

  it("failure & sanitization path: rejects malformed or injection-bearing correlation headers and rolls back failed operations with lineage", async () => {
    const poisoned = extractOrCreateCorrelationContext(
      { [CORRELATION_HEADER]: "bad\nheader\r\ninjected" },
      { actorId: alice.id }
    );

    assert.equal(poisoned.sanitizedFromInvalid, true);
    assert.notEqual(poisoned.correlationId, "bad\nheader\r\ninjected");
    assert.equal(poisoned.rejectedHeaderValue, "bad\nheader\r\ninjected");

    const registry = new CorrelationTraceRegistry();
    let rolledBackCorrelationId = null;

    await assert.rejects(
      () =>
        registry.executeCorrelatedOperation(poisoned, {
          stage: "vault_deposit",
          maxRetries: 0,
          operationFn: async () => {
            throw new Error("soroban submission rejected");
          },
          rollbackFn: async (ctx) => {
            rolledBackCorrelationId = ctx.correlationId;
          },
        }),
      /soroban submission rejected/
    );

    assert.equal(rolledBackCorrelationId, poisoned.correlationId);
    const hops = registry.queryTrace(alice, poisoned.correlationId);
    assert.equal(hops.length, 3);
    assert.equal(hops[2].stage, "vault_deposit:rollback");
    assert.equal(hops[2].status, "rolled_back");

    assert.throws(
      () => buildDownstreamCorrelationHeaders({ correlationId: "short" }),
      (err) => err instanceof CorrelationContextError && err.code === "INVALID_CORRELATION_CONTEXT"
    );
  });

  it("retry path: preserves root correlationId across transient retries while rotating attempt numbers and span IDs", async () => {
    const ctx = extractOrCreateCorrelationContext({}, { actorId: alice.id });
    const registry = new CorrelationTraceRegistry();
    let calls = 0;

    const outcome = await registry.executeCorrelatedOperation(ctx, {
      stage: "indexer_sync",
      maxRetries: 2,
      operationFn: async (attemptCtx) => {
        calls += 1;
        if (calls < 2) {
          const err = new Error("transient rpc timeout");
          err.retryable = true;
          throw err;
        }
        return { ledger: 9001, attempt: attemptCtx.attempt };
      },
    });

    assert.equal(outcome.correlationId, ctx.correlationId);
    assert.equal(outcome.attemptsUsed, 2);
    assert.deepEqual(outcome.result, { ledger: 9001, attempt: 2 });

    const hops = registry.queryTrace(alice, ctx.correlationId);
    assert.equal(hops.filter((h) => h.status === "retrying").length, 1);
    assert.equal(hops[hops.length - 1].status, "completed");
    assert.equal(hops[hops.length - 1].attempt, 2);
  });

  it("authorization path: enforces tenant isolation on trace inspection while allowing privileged roles", () => {
    const ctx = extractOrCreateCorrelationContext({}, { actorId: alice.id });
    const registry = new CorrelationTraceRegistry();
    registry.recordHop(ctx, { stage: "withdrawal_request", status: "ok" });

    // Owner can query their own trace
    assert.equal(registry.queryTrace(alice, ctx.correlationId).length, 1);

    // Another regular user is blocked with 403
    assert.throws(
      () => registry.queryTrace(bob, ctx.correlationId),
      (err) => err instanceof CorrelationAuthorizationError && err.statusCode === 403
    );

    // Admin can query any trace
    assert.equal(registry.queryTrace(admin, ctx.correlationId).length, 1);
  });
});
