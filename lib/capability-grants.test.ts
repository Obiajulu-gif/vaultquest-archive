import { describe, it, expect } from "vitest";
import {
  CAPABILITY_GRANT_REASONS,
  CAPABILITY_GRANT_STATES,
  CapabilityGrantError,
  CapabilityGrantRegistry,
  MAX_CAPABILITY_DURATION_MS,
  consumeCapabilityGrant,
  effectiveCapabilityState,
  expireCapabilityGrant,
  issueCapabilityGrant,
  revokeCapabilityGrant,
  type IssueCapabilityGrantParams,
} from "./capability-grants";

const T0 = 1_760_000_000_000;
const HOUR = 60 * 60 * 1000;

function baseParams(overrides: Partial<IssueCapabilityGrantParams> = {}): IssueCapabilityGrantParams {
  return {
    id: "cap-1",
    grantee: "operator-alice",
    approver: "security-bob",
    actions: ["pool.emergency_pause", "pool.force_withdraw"],
    resourceType: "pool",
    resourceId: "pool-42",
    reason: "Incident mitigation #901",
    durationMs: HOUR,
    maxUses: 1,
    ...overrides,
  };
}

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof CapabilityGrantError ? err.reasonCode : `unexpected:${String(err)}`;
  }
}

describe("Expiring capability grants for sensitive actions (#1108)", () => {
  it("issues a single-use capability grant and transitions to exhausted after one valid consumption", () => {
    const { grant, event } = issueCapabilityGrant(baseParams(), { now: T0 });
    expect(grant.state).toBe(CAPABILITY_GRANT_STATES.ACTIVE);
    expect(grant.usesRemaining).toBe(1);
    expect(grant.expiresAt).toBe(T0 + HOUR);
    expect(event.type).toBe("capability.issued");

    const consumed = consumeCapabilityGrant(
      grant,
      {
        actor: "operator-alice",
        action: "pool.emergency_pause",
        resourceType: "pool",
        resourceId: "pool-42",
        operationId: "op-100",
      },
      { now: T0 + 1000 },
    );

    expect(consumed.grant.state).toBe(CAPABILITY_GRANT_STATES.EXHAUSTED);
    expect(consumed.grant.usesRemaining).toBe(0);
    expect(consumed.event.type).toBe("capability.exhausted");
    expect(consumed.deduplicatedRetry).toBe(false);

    // A second distinct operation on an exhausted grant is rejected.
    expect(
      reasonOf(() =>
        consumeCapabilityGrant(
          consumed.grant,
          {
            actor: "operator-alice",
            action: "pool.emergency_pause",
            resourceType: "pool",
            resourceId: "pool-42",
            operationId: "op-101",
          },
          { now: T0 + 2000 },
        ),
      ),
    ).toBe(CAPABILITY_GRANT_REASONS.EXHAUSTED);
  });

  it("supports idempotent retries with the same operationId without double-consuming uses", () => {
    const { grant } = issueCapabilityGrant(baseParams({ maxUses: 1 }), { now: T0 });
    const first = consumeCapabilityGrant(
      grant,
      {
        actor: "operator-alice",
        action: "pool.emergency_pause",
        resourceType: "pool",
        resourceId: "pool-42",
        operationId: "retry-op-1",
      },
      { now: T0 + 500 },
    );

    const retry = consumeCapabilityGrant(
      first.grant,
      {
        actor: "operator-alice",
        action: "pool.emergency_pause",
        resourceType: "pool",
        resourceId: "pool-42",
        operationId: "retry-op-1",
      },
      { now: T0 + 1000 },
    );

    expect(retry.deduplicatedRetry).toBe(true);
    expect(retry.grant.usesConsumed).toBe(1);
    expect(retry.grant.usesRemaining).toBe(0);
  });

  it("enforces separation of duties, duration bounds, actor, action, and resource scope", () => {
    expect(
      reasonOf(() =>
        issueCapabilityGrant(baseParams({ grantee: "alice", approver: "alice" }), { now: T0 }),
      ),
    ).toBe(CAPABILITY_GRANT_REASONS.SELF_APPROVAL);

    expect(
      reasonOf(() =>
        issueCapabilityGrant(baseParams({ durationMs: MAX_CAPABILITY_DURATION_MS + 1 }), {
          now: T0,
        }),
      ),
    ).toBe(CAPABILITY_GRANT_REASONS.INVALID_DURATION);

    const { grant } = issueCapabilityGrant(baseParams({ maxUses: 2 }), { now: T0 });

    expect(
      reasonOf(() =>
        consumeCapabilityGrant(grant, {
          actor: "mallory",
          action: "pool.emergency_pause",
          resourceType: "pool",
          resourceId: "pool-42",
        }),
      ),
    ).toBe(CAPABILITY_GRANT_REASONS.FORBIDDEN_ACTOR);

    expect(
      reasonOf(() =>
        consumeCapabilityGrant(grant, {
          actor: "operator-alice",
          action: "treasury.drain",
          resourceType: "pool",
          resourceId: "pool-42",
        }),
      ),
    ).toBe(CAPABILITY_GRANT_REASONS.FORBIDDEN_ACTION);

    expect(
      reasonOf(() =>
        consumeCapabilityGrant(grant, {
          actor: "operator-alice",
          action: "pool.emergency_pause",
          resourceType: "pool",
          resourceId: "pool-99",
        }),
      ),
    ).toBe(CAPABILITY_GRANT_REASONS.FORBIDDEN_RESOURCE);
  });

  it("rejects consumption at or after expiresAt and supports revocation and registry audit", () => {
    const registry = new CapabilityGrantRegistry();
    registry.issue(baseParams({ id: "cap-exp", maxUses: 2 }), { now: T0 });

    expect(
      reasonOf(() =>
        registry.authorizeAndConsume(
          "cap-exp",
          {
            actor: "operator-alice",
            action: "pool.emergency_pause",
            resourceType: "pool",
            resourceId: "pool-42",
          },
          { now: T0 + HOUR },
        ),
      ),
    ).toBe(CAPABILITY_GRANT_REASONS.EXPIRED);

    // Issue another grant and revoke it mid-flight (rollback / emergency cut-off).
    registry.issue(baseParams({ id: "cap-rev", maxUses: 3 }), { now: T0 });
    expect(
      reasonOf(() => registry.revoke("cap-rev", "outsider-eve", "unauthorized", { now: T0 + 100 })),
    ).toBe(CAPABILITY_GRANT_REASONS.FORBIDDEN_REVOKE);

    const revoked = registry.revoke("cap-rev", "security-bob", "incident_resolved", {
      now: T0 + 200,
    });
    expect(revoked.grant.state).toBe(CAPABILITY_GRANT_STATES.REVOKED);
    expect(effectiveCapabilityState(revoked.grant, T0 + 300)).toBe(
      CAPABILITY_GRANT_STATES.REVOKED,
    );

    expect(
      reasonOf(() =>
        registry.authorizeAndConsume(
          "cap-rev",
          {
            actor: "operator-alice",
            action: "pool.emergency_pause",
            resourceType: "pool",
            resourceId: "pool-42",
          },
          { now: T0 + 400 },
        ),
      ),
    ).toBe(CAPABILITY_GRANT_REASONS.REVOKED);

    // Audit history authorization
    expect(reasonOf(() => registry.getAuditTrail("outsider-eve"))).toBe(
      CAPABILITY_GRANT_REASONS.FORBIDDEN_AUDIT,
    );
    expect(registry.getAuditTrail("security-bob").length).toBeGreaterThanOrEqual(4);
    expect(expireCapabilityGrant(revoked.grant, { now: T0 + HOUR * 2 })).toBeNull();
  });
});
