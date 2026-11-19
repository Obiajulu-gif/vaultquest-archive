import { describe, it, expect, vi } from "vitest";
import {
  MAX_TRANSFER_DURATION_MS,
  OWNERSHIP_TRANSFER_REASONS,
  OwnershipTransferError,
  OwnershipTransferRegistry,
  TRANSFER_STATES,
  acceptOwnershipTransfer,
  cancelOwnershipTransfer,
  createOwnershipTransfer,
  declineOwnershipTransfer,
  effectiveTransferState,
  expireOwnershipTransfer,
  isTerminalTransferState,
  type CreateTransferParams,
} from "./ownership-transfer";

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function baseParams(overrides: Partial<CreateTransferParams> = {}): CreateTransferParams {
  return {
    id: "xfer-1",
    resourceType: "saved_pool",
    resourceId: "pool-42",
    from: "alice",
    to: "bob",
    durationMs: HOUR,
    ...overrides,
  };
}

/** Reason thrown by `fn`, or `undefined` if it did not throw. */
function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof OwnershipTransferError ? err.reasonCode : `unexpected:${String(err)}`;
  }
}

describe("createOwnershipTransfer (normal path)", () => {
  it("creates a pending offer with an expiry derived from the injected clock", () => {
    const { transfer, event } = createOwnershipTransfer(baseParams(), { now: T0 });
    expect(transfer.state).toBe(TRANSFER_STATES.PENDING);
    expect(transfer.createdAt).toBe(T0);
    expect(transfer.expiresAt).toBe(T0 + HOUR);
    expect(transfer.resolvedAt).toBeNull();
    expect(event.type).toBe("ownership.transfer_initiated");
    expect(event.actor).toBe("alice");
    expect(event.owner).toBeNull();
  });

  it("invokes the onEvent sink exactly once and never mutates nothing in place", () => {
    const onEvent = vi.fn();
    const { transfer } = createOwnershipTransfer(baseParams(), { now: T0, onEvent });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(transfer)).toBe(false); // plain object, but each step returns a fresh copy
  });
});

describe("createOwnershipTransfer (validation / failure paths)", () => {
  it("rejects a self-transfer", () => {
    expect(reasonOf(() => createOwnershipTransfer(baseParams({ to: "alice" })))).toBe(
      OWNERSHIP_TRANSFER_REASONS.SELF_TRANSFER,
    );
  });

  it("rejects empty participants or resource identity", () => {
    expect(reasonOf(() => createOwnershipTransfer(baseParams({ from: "  " })))).toBe(
      OWNERSHIP_TRANSFER_REASONS.INVALID_PARTICIPANT,
    );
    expect(reasonOf(() => createOwnershipTransfer(baseParams({ resourceId: "" })))).toBe(
      OWNERSHIP_TRANSFER_REASONS.INVALID_PARTICIPANT,
    );
  });

  it("rejects a non-positive or over-ceiling duration", () => {
    expect(reasonOf(() => createOwnershipTransfer(baseParams({ durationMs: 0 })))).toBe(
      OWNERSHIP_TRANSFER_REASONS.INVALID_DURATION,
    );
    expect(reasonOf(() => createOwnershipTransfer(baseParams({ durationMs: -1 })))).toBe(
      OWNERSHIP_TRANSFER_REASONS.INVALID_DURATION,
    );
    expect(
      reasonOf(() => createOwnershipTransfer(baseParams({ durationMs: MAX_TRANSFER_DURATION_MS + 1 }))),
    ).toBe(OWNERSHIP_TRANSFER_REASONS.INVALID_DURATION);
  });
});

describe("accept / decline / cancel (normal + authorization paths)", () => {
  it("accepts by the named recipient and settles ownership to them", () => {
    const { transfer } = createOwnershipTransfer(baseParams(), { now: T0 });
    const { transfer: accepted, event } = acceptOwnershipTransfer(transfer, "bob", { now: T0 + HOUR / 2 });
    expect(accepted.state).toBe(TRANSFER_STATES.ACCEPTED);
    expect(accepted.resolvedBy).toBe("bob");
    expect(event.owner).toBe("bob");
    // input is not mutated
    expect(transfer.state).toBe(TRANSFER_STATES.PENDING);
  });

  it("forbids anyone but the recipient from accepting or declining", () => {
    const { transfer } = createOwnershipTransfer(baseParams(), { now: T0 });
    expect(reasonOf(() => acceptOwnershipTransfer(transfer, "mallory", { now: T0 }))).toBe(
      OWNERSHIP_TRANSFER_REASONS.FORBIDDEN_ACCEPTOR,
    );
    expect(reasonOf(() => acceptOwnershipTransfer(transfer, "alice", { now: T0 }))).toBe(
      OWNERSHIP_TRANSFER_REASONS.FORBIDDEN_ACCEPTOR,
    );
    expect(reasonOf(() => declineOwnershipTransfer(transfer, "alice", { now: T0 }))).toBe(
      OWNERSHIP_TRANSFER_REASONS.FORBIDDEN_ACCEPTOR,
    );
  });

  it("forbids anyone but the initiator from cancelling", () => {
    const { transfer } = createOwnershipTransfer(baseParams(), { now: T0 });
    expect(reasonOf(() => cancelOwnershipTransfer(transfer, "bob", { now: T0 }))).toBe(
      OWNERSHIP_TRANSFER_REASONS.FORBIDDEN_INITIATOR,
    );
    const { transfer: cancelled } = cancelOwnershipTransfer(transfer, "alice", { now: T0 });
    expect(cancelled.state).toBe(TRANSFER_STATES.CANCELLED);
  });

  it("rejects acting on an already-terminal offer", () => {
    const { transfer } = createOwnershipTransfer(baseParams(), { now: T0 });
    const { transfer: accepted } = acceptOwnershipTransfer(transfer, "bob", { now: T0 });
    expect(reasonOf(() => acceptOwnershipTransfer(accepted, "bob", { now: T0 }))).toBe(
      OWNERSHIP_TRANSFER_REASONS.NOT_PENDING,
    );
  });
});

describe("expiry path", () => {
  it("reads a pending offer past its deadline as expired without mutation", () => {
    const { transfer } = createOwnershipTransfer(baseParams(), { now: T0 });
    expect(effectiveTransferState(transfer, T0 + HOUR - 1)).toBe(TRANSFER_STATES.PENDING);
    expect(effectiveTransferState(transfer, T0 + HOUR)).toBe(TRANSFER_STATES.EXPIRED);
  });

  it("refuses a late accept with EXPIRED, not NOT_PENDING", () => {
    const { transfer } = createOwnershipTransfer(baseParams(), { now: T0 });
    const err = reasonOf(() => acceptOwnershipTransfer(transfer, "bob", { now: T0 + HOUR }));
    expect(err).toBe(OWNERSHIP_TRANSFER_REASONS.EXPIRED);
  });

  it("formally expires a lapsed offer, attributing it to the deadline, and is idempotent", () => {
    const { transfer } = createOwnershipTransfer(baseParams(), { now: T0 });
    const expired = expireOwnershipTransfer(transfer, { now: T0 + 2 * HOUR });
    expect(expired).not.toBeNull();
    expect(expired!.transfer.state).toBe(TRANSFER_STATES.EXPIRED);
    expect(expired!.transfer.resolvedAt).toBe(T0 + HOUR); // the real deadline, not the sweep time
    expect(expired!.event.actor).toBe("system");
    // sweeping a still-pending offer early, or a terminal one, is a no-op
    expect(expireOwnershipTransfer(transfer, { now: T0 })).toBeNull();
    expect(expireOwnershipTransfer(expired!.transfer, { now: T0 + 3 * HOUR })).toBeNull();
  });
});

describe("isTerminalTransferState", () => {
  it("classifies every state", () => {
    expect(isTerminalTransferState(TRANSFER_STATES.PENDING)).toBe(false);
    for (const s of [
      TRANSFER_STATES.ACCEPTED,
      TRANSFER_STATES.DECLINED,
      TRANSFER_STATES.CANCELLED,
      TRANSFER_STATES.EXPIRED,
    ]) {
      expect(isTerminalTransferState(s)).toBe(true);
    }
  });
});

describe("OwnershipTransferRegistry (end-to-end + retry path)", () => {
  function seeded(): OwnershipTransferRegistry {
    const reg = new OwnershipTransferRegistry();
    reg.setInitialOwner("saved_pool", "pool-42", "alice");
    return reg;
  }

  it("moves ownership only after the recipient accepts", () => {
    const reg = seeded();
    reg.initiate(baseParams(), { now: T0 });
    expect(reg.ownerOf("saved_pool", "pool-42")).toBe("alice"); // still alice while pending
    reg.accept("xfer-1", "bob", { now: T0 + HOUR / 2 });
    expect(reg.ownerOf("saved_pool", "pool-42")).toBe("bob");
  });

  it("forbids a non-owner from initiating", () => {
    const reg = seeded();
    expect(reasonOf(() => reg.initiate(baseParams({ from: "mallory" }), { now: T0 }))).toBe(
      OWNERSHIP_TRANSFER_REASONS.NOT_OWNER,
    );
  });

  it("allows only one pending offer per resource", () => {
    const reg = seeded();
    reg.initiate(baseParams(), { now: T0 });
    expect(
      reasonOf(() => reg.initiate(baseParams({ id: "xfer-2", to: "carol" }), { now: T0 + 1 })),
    ).toBe(OWNERSHIP_TRANSFER_REASONS.DUPLICATE_PENDING);
  });

  it("lets the owner re-initiate after an expiry (retry path)", () => {
    const reg = seeded();
    reg.initiate(baseParams(), { now: T0 });
    // bob lets it lapse; alice retries to carol after the window closes
    const retry = reg.initiate(baseParams({ id: "xfer-2", to: "carol" }), { now: T0 + HOUR + 1 });
    expect(retry.transfer.to).toBe("carol");
    expect(reg.getTransfer("xfer-1")!.state).toBe(TRANSFER_STATES.EXPIRED);
    reg.accept("xfer-2", "carol", { now: T0 + HOUR + 2 });
    expect(reg.ownerOf("saved_pool", "pool-42")).toBe("carol");
  });

  it("supports rollback by a reverse transfer back to the prior owner", () => {
    const reg = seeded();
    reg.initiate(baseParams(), { now: T0 });
    reg.accept("xfer-1", "bob", { now: T0 });
    // bob (now owner) hands it back to alice; alice accepts
    reg.initiate(baseParams({ id: "rollback-1", from: "bob", to: "alice" }), { now: T0 + HOUR });
    reg.accept("rollback-1", "alice", { now: T0 + HOUR });
    expect(reg.ownerOf("saved_pool", "pool-42")).toBe("alice");
  });

  it("sweepExpired expires every lapsed offer and returns their events", () => {
    const reg = seeded();
    reg.setInitialOwner("saved_pool", "pool-99", "dave");
    reg.initiate(baseParams(), { now: T0 });
    reg.initiate(baseParams({ id: "xfer-2", resourceId: "pool-99", from: "dave" }), { now: T0 });
    const events = reg.sweepExpired({ now: T0 + 2 * HOUR });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "ownership.transfer_expired")).toBe(true);
    expect(reg.listPending(T0 + 2 * HOUR)).toHaveLength(0);
  });

  it("raises NOT_FOUND for an unknown transfer id", () => {
    const reg = seeded();
    expect(reasonOf(() => reg.accept("nope", "bob"))).toBe(OWNERSHIP_TRANSFER_REASONS.NOT_FOUND);
  });

  it("maintains a chronological audit history for each resource across lifecycle states", () => {
    const reg = seeded();
    reg.initiate(baseParams({ id: "xfer-1", from: "alice", to: "bob" }), { now: T0 });
    reg.accept("xfer-1", "bob", { now: T0 + HOUR / 2 });

    // Bob now transfers to carol, but cancels
    reg.initiate(baseParams({ id: "xfer-2", from: "bob", to: "carol" }), { now: T0 + HOUR });
    reg.cancel("xfer-2", "bob", { now: T0 + HOUR + 100 });

    // Bob transfers to dave, but dave declines
    reg.initiate(baseParams({ id: "xfer-3", from: "bob", to: "dave" }), { now: T0 + 2 * HOUR });
    reg.decline("xfer-3", "dave", { now: T0 + 2 * HOUR + 100 });

    // Bob transfers to eve, which expires
    reg.initiate(baseParams({ id: "xfer-4", from: "bob", to: "eve" }), { now: T0 + 3 * HOUR });
    reg.sweepExpired({ now: T0 + 5 * HOUR });

    const history = reg.getAuditHistory("saved_pool", "pool-42");
    expect(history.map((e) => e.type)).toEqual([
      "ownership.transfer_initiated",
      "ownership.transfer_accepted",
      "ownership.transfer_initiated",
      "ownership.transfer_cancelled",
      "ownership.transfer_initiated",
      "ownership.transfer_declined",
      "ownership.transfer_initiated",
      "ownership.transfer_expired",
    ]);

    expect(history[0].actor).toBe("alice");
    expect(history[1].actor).toBe("bob");
    expect(history[1].owner).toBe("bob");
    expect(history[7].actor).toBe("system");

    // listTransfersForResource returns all 4 transfers
    const transfers = reg.listTransfersForResource("saved_pool", "pool-42");
    expect(transfers).toHaveLength(4);
    expect(transfers.map((t) => t.id)).toEqual(["xfer-1", "xfer-2", "xfer-3", "xfer-4"]);
  });

  it("enforces authorization on inspecting audit history", () => {
    const reg = seeded();
    reg.initiate(baseParams({ id: "xfer-1", from: "alice", to: "bob" }), { now: T0 });
    reg.accept("xfer-1", "bob", { now: T0 + HOUR / 2 });

    // Alice (past owner & initiator) is authorized
    expect(reg.getAuditHistory("saved_pool", "pool-42", { actor: "alice" })).toHaveLength(2);

    // Bob (current owner & recipient) is authorized
    expect(reg.getAuditHistory("saved_pool", "pool-42", { actor: "bob" })).toHaveLength(2);

    // Admin / system is authorized
    expect(reg.getAuditHistory("saved_pool", "pool-42", { actor: "admin" })).toHaveLength(2);
    expect(reg.getAuditHistory("saved_pool", "pool-42", { actor: "system" })).toHaveLength(2);

    // Mallory (unrelated actor) is rejected
    expect(() => reg.getAuditHistory("saved_pool", "pool-42", { actor: "mallory" })).toThrowError(
      OwnershipTransferError,
    );
    expect(reasonOf(() => reg.getAuditHistory("saved_pool", "pool-42", { actor: "mallory" }))).toBe(
      OWNERSHIP_TRANSFER_REASONS.FORBIDDEN_AUDIT,
    );
  });

  it("respects limit and returns immutable copies from audit history", () => {
    const reg = seeded();
    reg.initiate(baseParams({ id: "xfer-1", from: "alice", to: "bob" }), { now: T0 });
    reg.accept("xfer-1", "bob", { now: T0 + HOUR / 2 });

    const limited = reg.getAuditHistory("saved_pool", "pool-42", { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].type).toBe("ownership.transfer_accepted");

    // Mutating returned object does not alter registry internal state
    (limited[0] as any).type = "tampered";
    const fresh = reg.getAuditHistory("saved_pool", "pool-42");
    expect(fresh[1].type).toBe("ownership.transfer_accepted");
  });
});
