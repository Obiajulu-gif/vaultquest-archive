import { describe, it, expect, vi } from "vitest";
import {
  CANONICAL_POOL_STATES,
  CONTRACT_POOL_STATUSES,
  InvalidPoolTransitionError,
  POOL_STATES,
  POOL_STATE_INPUTS,
  POOL_TRANSITION_REASON_CODE,
  POOL_TRANSITIONS,
  allowedPoolTransitions,
  assertPoolTransition,
  canTransitionPool,
  isTerminalPoolState,
  normalizePoolState,
  transitionPool,
} from "./pool-lifecycle";
import {
  REJECTION_EXPLANATIONS,
  VAULT_REJECTION_REASONS,
  getRejectionExplanation,
} from "./rejectionReasons";
import { poolTransitionNotification } from "./pool-lifecycle-notifications";

describe("normalizePoolState", () => {
  it("is an identity mapping for every canonical state", () => {
    for (const state of CANONICAL_POOL_STATES) {
      expect(normalizePoolState(state)).toBe(state);
    }
  });

  it("resolves on-chain and legacy aliases to canonical states", () => {
    expect(normalizePoolState("open")).toBe(POOL_STATES.ACTIVE);
    expect(normalizePoolState("locked")).toBe(POOL_STATES.PAUSED);
    expect(normalizePoolState("drawing")).toBe(POOL_STATES.SETTLING);
    expect(normalizePoolState("settled")).toBe(POOL_STATES.COMPLETED);
    expect(normalizePoolState("closed")).toBe(POOL_STATES.COMPLETED);
    expect(normalizePoolState("pending")).toBe(POOL_STATES.UPCOMING);
    expect(normalizePoolState("canceled")).toBe(POOL_STATES.CANCELLED);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizePoolState("  ACTIVE ")).toBe(POOL_STATES.ACTIVE);
    expect(normalizePoolState("Locked")).toBe(POOL_STATES.PAUSED);
  });

  it("returns null (not draft) for unknown/empty input", () => {
    expect(normalizePoolState("mythical")).toBeNull();
    expect(normalizePoolState("")).toBeNull();
    expect(normalizePoolState(null)).toBeNull();
    expect(normalizePoolState(undefined)).toBeNull();
  });

  it("keeps the API input vocabulary aligned with the canonical states + aliases", () => {
    for (const state of CANONICAL_POOL_STATES) {
      expect(POOL_STATE_INPUTS).toContain(state);
    }
    for (const token of CONTRACT_POOL_STATUSES) {
      expect(POOL_STATE_INPUTS).toContain(token);
      expect(normalizePoolState(token)).not.toBeNull();
    }
  });
});

describe("POOL_TRANSITIONS coverage", () => {
  it("only lists canonical target states and is keyed by every canonical state", () => {
    expect(Object.keys(POOL_TRANSITIONS).sort()).toEqual([...CANONICAL_POOL_STATES].sort());
    for (const targets of Object.values(POOL_TRANSITIONS)) {
      for (const target of targets) {
        expect(CANONICAL_POOL_STATES).toContain(target);
      }
    }
  });

  it("accepts every allowed transition and emits a correct audit event", () => {
    for (const [from, targets] of Object.entries(POOL_TRANSITIONS) as [
      (typeof CANONICAL_POOL_STATES)[number],
      readonly string[],
    ][]) {
      for (const to of targets) {
        expect(canTransitionPool(from, to)).toBe(true);

        const onTransition = vi.fn();
        const input = { id: "pool-1", status: from, extra: 42 };
        const { record, event } = transitionPool(input, to, {
          actor: "admin",
          now: 1_700_000_000_000,
          reason: "test edge",
          onTransition,
        });

        expect(record.status).toBe(to);
        expect(record).not.toBe(input);
        expect(input.status).toBe(from);
        expect(record.id).toBe("pool-1");
        expect((record as { extra: number }).extra).toBe(42);

        expect(event).toEqual({
          type: "pool.status_changed",
          from,
          to,
          actor: "admin",
          at: 1_700_000_000_000,
          reason: "test edge",
        });
        expect(onTransition).toHaveBeenCalledTimes(1);
        expect(onTransition).toHaveBeenCalledWith(event);
      }
    }
  });

  it("normalizes alias source/target tokens before checking the edge", () => {
    // open -> active, locked -> paused
    expect(canTransitionPool("open", "locked")).toBe(true);
    // drawing -> settling, settled -> completed (terminal sink reached via settling)
    expect(canTransitionPool("drawing", "settled")).toBe(true);
    expect(canTransitionPool("active", "paused")).toBe(true);

    const { event } = transitionPool({ status: "open" }, "locked", { now: 5 });
    expect(event.from).toBe(POOL_STATES.ACTIVE);
    expect(event.to).toBe(POOL_STATES.PAUSED);
  });

  it("returns the normalized pair from assertPoolTransition", () => {
    expect(assertPoolTransition("open", "paused")).toEqual({
      from: POOL_STATES.ACTIVE,
      to: POOL_STATES.PAUSED,
    });
  });

  it("allows settlement failure recovery: settling -> active, but not settling -> paused", () => {
    expect(canTransitionPool("settling", "active")).toBe(true);
    expect(canTransitionPool("drawing", "active")).toBe(true);
    expect(canTransitionPool("settling", "paused")).toBe(false);
  });
});

describe("rejected transitions", () => {
  const rejected: Array<[string | null, string, string]> = [
    ["completed", "active", "terminal state cannot leave"],
    ["cancelled", "draft", "terminal state cannot be reopened"],
    ["draft", "matured", "maturity must be reached from active"],
    ["active", "completed", "settlement must pass through matured -> settling"],
    ["paused", "matured", "no paused -> matured edge"],
    ["settled", "active", "settled aliases to terminal completed"],
    ["mythical", "active", "unknown source token"],
    ["active", "active", "same-state is not a transition"],
  ];

  it.each(rejected)("rejects %s -> %s (%s)", (from, to) => {
    expect(canTransitionPool(from, to)).toBe(false);

    expect(() => assertPoolTransition(from, to)).toThrow(InvalidPoolTransitionError);

    try {
      assertPoolTransition(from, to);
      throw new Error("expected assertPoolTransition to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPoolTransitionError);
      const typed = error as InvalidPoolTransitionError;
      expect(typed.reasonCode).toBe(POOL_TRANSITION_REASON_CODE);
      expect(typed.reasonCode).toBe(
        VAULT_REJECTION_REASONS.INVALID_STATE_TRANSITION,
      );
      expect(typed.from).toBe(String(from));
      expect(typed.to).toBe(to);
    }
  });

  it("does not mutate the record or call the sink when a transition is rejected", () => {
    const onTransition = vi.fn();
    const input = { id: "pool-2", status: "completed" };

    expect(() =>
      transitionPool(input, "active", { onTransition }),
    ).toThrow(InvalidPoolTransitionError);

    expect(input.status).toBe("completed");
    expect(onTransition).not.toHaveBeenCalled();
  });

  it("exposes a stable, explained rejection reason code", () => {
    expect(POOL_TRANSITION_REASON_CODE).toBe("VAULT_INVALID_STATE_TRANSITION");
    const explanation = getRejectionExplanation(POOL_TRANSITION_REASON_CODE);
    expect(explanation.reasonCode).toBe(POOL_TRANSITION_REASON_CODE);
    expect(explanation.category).toBe("policy");
    expect(REJECTION_EXPLANATIONS[VAULT_REJECTION_REASONS.INVALID_STATE_TRANSITION]).toBe(
      explanation,
    );
  });
});

describe("terminal states", () => {
  it("flags completed and cancelled (and their aliases) as terminal", () => {
    expect(isTerminalPoolState("completed")).toBe(true);
    expect(isTerminalPoolState("cancelled")).toBe(true);
    expect(isTerminalPoolState("settled")).toBe(true);
    expect(isTerminalPoolState("canceled")).toBe(true);
    expect(isTerminalPoolState("active")).toBe(false);
    expect(isTerminalPoolState("matured")).toBe(false);
    expect(isTerminalPoolState("mythical")).toBe(false);
  });

  it("has no outgoing edges from terminal states", () => {
    expect(allowedPoolTransitions("completed")).toEqual([]);
    expect(allowedPoolTransitions("cancelled")).toEqual([]);
    expect(allowedPoolTransitions("mythical")).toEqual([]);
  });
});

describe("poolTransitionNotification", () => {
  const event = {
    type: "pool.status_changed" as const,
    from: POOL_STATES.ACTIVE,
    to: POOL_STATES.PAUSED,
    actor: "admin",
    at: Date.parse("2026-06-15T12:00:00Z"),
  };

  it("maps a pause transition onto the vault_pause notification convention", () => {
    const notification = poolTransitionNotification(event, { poolId: "pool-9" });
    expect(notification.type).toBe("vault_pause");
    expect(notification.scope).toBe("vault");
    expect(notification.subject).toBe("pool-9");
    expect(notification.eventId).toBe("pool-9:paused");
    expect(notification.date).toBe("2026-06-15T12:00:00.000Z");
  });

  it("maps maturity onto the maturity convention and stays global without a pool id", () => {
    const notification = poolTransitionNotification({
      ...event,
      from: POOL_STATES.ACTIVE,
      to: POOL_STATES.MATURED,
    });
    expect(notification.type).toBe("maturity");
    expect(notification.scope).toBe("global");
  });
});
