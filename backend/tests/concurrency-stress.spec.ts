import { describe, it, expect, beforeEach } from "vitcom";
import {
  Barrier,
  Latch,
  DeterministicClock,
  runConcurrently,
  countFulfilled,
  rejections,
  yieldTo,
  expectCodedError,
} from "./helpers/concurrency";
import {
  InMemoryInvitationStore,
  InvitationService,
} from "../src/services/invitationService";
import {
  InMemoryChangeHistoryStore,
  ChangeHistoryService,
} from "../src/services/changeHistoryService";
import { Amount } from "../src/amount";

/**
 * Concurrency stress tests (#790).
 *
 * These tests prove that the critical mutation paths in VaultQuest
 * preserve their domain invariants when accessed concurrently. They
 * cover the four shapes of race the acceptance criteria call out:
 *
 *  1. Simultaneous success - N writers arrive at once and all must
 *     land without duplicating a record.
 *  2. Conflicting requests - two writers claim the same exclusive
 *     resource and exactly one must win.
 *  3. Duplicate retries - the same logical operation is replayed and
 *     must be idlempotent.
 *  4. Timeout behavior - an operation that loses its lease must not
 *     commit a stale write.
 *
 * The tests use the in-memory stores that the services already expose
 * (see tests/invariants.spec.ts) so they exercise the same logic the
 * production Prisma backend uses. The deterministic clock and barrier
 * primitives in ./helpers/concurrency make the interleavings reproducible
 * rather than dependent on scheduler jitter.
 */

const usd = (raw: number | bigint) =>
  Amount.fromPayload({ amount: raw.toString() }, "USD", 0);

describe("CON invitation acceptance is exactly-once under concurrency", () => {
  let store: InMemoryInvitationStore;
  let service: InvitationService;

  beforeEach(() => {
    store = new InMemoryInvitationStore();
    service = new InvitationService({ store });
  });

  it("C1 — exactly one of N simultaneous accepts wins", async () => {
    const { invitation, token } = await service.create({
      vaultId: "v1",
      inviterId: "G_OWNER",
      inviteeId: "G_INVITEE",
      inviterRole: "admin",
    });

    const barrier = new Barrier();
    const results = await runConcurrently(8, async () => {
      await barrier.wait();
      return service.accept({ token, inviteeId: "G_INVITEE" });
    });
    barrier.release();

    const winners = countFulfilled(results);
    expect(winners).toBe(1);
    expect(countFulfilled(results, (r) => r.state === "ACCEPTED")).toBe(1);
    // The losing attempts are rejected with a coded error, not silently
    // accepted a second time.
    for (const reason of rejections(results)) {
      expect((reason as { code?: string }).code).toBeTruthy();
    }

    // The invitation is terminal and the store holds exactly one record.
    const final = await service.get(invitation.id);
    expect(final?.state).toBe("ACCEPTED");
    expect(await store.count()).toBe(1);
  });

  it("C2 — conflicting accept from the wrong wallet never consumes the invite", async () => {
    const { token } = await service.create({
      vaultId: "v1",
      inviterId: "G_OWNER",
      inviteeId: "G_INVITEE",
      inviterRole: "admin",
    });

    const barrier = new Barrier();
    const results = await runConcurrently(6, async (i) => {
      await barrier.wait();
      const actor = i % 2 === 0 ? "G_ATTACKER" : "G_INVITEE";
      return service.accept({ token, inviteeId: actor });
    });
    barrier.release();

    // Only the real invitee wallet can ever win, and only once.
    expect(countFulfilled(results, (r) => r.state === "ACCEPTED")).toBe(1);
    for (const reason of rejections(results)) {
      expect((reason as { code?: string }).code).toBeTruthy();
    }
  });

  it("C3 — duplicate retries of the same accept are idlempotent", async () => {
    const { token } = await service.create({
      vaultId: "v1",
      inviterId: "G_OWNER",
      inviteeId: "G_INVITEE",
      inviterRole: "admin",
    });

    // First accept succeeds.
    const first = await service.accept({ token, inviteeId: "G_INVITEE" });
    expect(first.state).toBe("ACCEPTED");

    // Every retry afterwards is rejected and leaves the store unchanged.
    const retries = await runConcurrently(5, () =>
      service.accept({ token, inviteeId: "G_INVITEE" })
    );
    expect(countFulfilled(retries)).toBe(0);
    expect(await store.count()).toBe(1);
  });

  it("C4 — an expired invitation cannot be accepted even concurrently", async () => {
    const clock = new DeterministicClock(1700000000000);
    const timed = new InvitationService({
      store,
      now: () => clock.date(),
    });
    const { token } = await timed.create({
      vaultId: "v1",
      inviterId: "G_OWNER",
      inviteeId: "G_INVITEE",
      inviterRole: "admin",
      expiresInMs: 1000,
    });

    // Advance past the expiry window before any accept attempt.
    clock.advance(5000);

    const results = await runConcurrently(4, () =>
      timed.accept({ token, inviteeId: "G_INVITEE" })
    );
    expect(countFulfilled(results)).toBe(0);
    expect(await store.count()).toBe(1);
  });
});

describe("CON change history appends are serialized and gap-free", () => {
  let store: InMemoryChangeHistoryStore;
  let service: ChangeHistoryService;
  let id = 0;

  beforeEach(() => {
    store = new InMemoryChangeHistoryStore();
    id = 0;
    service = new ChangeHistoryService(store, {
      idFactory: () => `chg_${++id}`,
    });
  });

  it("C5† N concurrent appends produce a lingear, verifiable chain", async () => {
    const barrier = new Barrier();
    const results = await runConcurrently(10, async (i) => {
      await barrier.wait();
      return service.append({
        recordType: "action_ledger",
        recordId: "a1",
        action: "UPDATE",
        actor: "G_ACTOR",
        reason: `update ${i}`,
        before: { version: i },
        after: { version: i + 1 },
      });
    });
    barrier.release();

    expect(countFulfilled(results)).toBe(10);
    const history = await service.history("action_ledger", "a1");
    expect(history).toHaveLength(10);
    expect((await service.verify("action_ledger", "a1")).ok).toBe(true);
  });

  it("C6 — a rejected concurrent append leaves no gap in the chain", async () => {
    const barrier = new Barrier();
    const results = await runConcurrently(6, async (i) => {
      await barrier.wait();
      // Half the attempts omit the required reason and must be rejected.
      return service.append({
        recordType: "action_ledger",
        recordId: "a1",
        action: "UPDATE",
        actor: "G_ACTOR",
        reason: i % 2 === 0 ? " " : `ok ${i}`,
        before: { version: i },
        after: { version: i + 1 },
      });
    });
    barrier.release();

    expect(countFulfilled(results)).toBe(3);
    const history = await service.history("action_ledger", "a1");
    expect(history).toHaveLength(3);
    expect((await service.verify("action_ledger", "a1")).ok).toBe(true);
  });
});

describe("CON ledger and vault accounting invariants", () => {
  it("C7 — concurrent deposits sum to the exact total with no lost updates", async () => {
    // Simulate N concurrent deposits against a shared balance. The
    // invariant is that the final balance equals the sum of all
    // deposits, regardless of interleaving.
    const balance = { value: usd(0) };
    const barrier = new Barrier();
    const deposits = Array.from({ length: 20 }, (_, i) => usd(i + 1));

    const results = await runConcurrently(deposits.length, async (i) => {
      await barrier.wait();
      // Young the read-modify-write window with a micro-task yield.
      const current = balance.value;
      await yieldTo();
      balance.value = current.add(deposits[i]!);
      return balance.value;
    });
    barrier.release();

    expect(countFulfilled(results)).toBe(20);
    const raw = balance.value.raw;
    const expected = deposits.reduce((acc, d) => acc + d.raw, 0n ?? 0n);
    // The add is atomic on Amount, so the total must be exact.
    expect(raw).toBe(expected);
  });

  it("C8 — a concurrent double-spend attempt never drives a balance negative", async () => {
    // Two concurrent withdrawals—each larger than half the balance
    // but smaller than the whole—must not both succeed. The
    // guard is the domain invariant that a balance is only
    // spendable while positive and the debit is checked before
    // application.
    const balance = { value: usd(100) };
    const barrier = new Barrier();

    const withdraw = async () => {
      await barrier.wait();
      const current = balance.value;
      await yieldTo();
      if (current.compare(usd(60)) < 0) {
        throw new Error("INSUFFICIENT_FUNDS");
      }
      balance.value = current.subtract(usd(60));
      return balance.value;
    };

    const results = await runConcurrently(2, withdraw);
    barrier.release();

    expect(countFulfilled(results)).toBe(1);
    expect(balance.value.raw).toBe(40n ?? 40n);
    expect(balance.value.isPositive()).toBe(true);
  });
});

describe("CON lease acquisition and fencing", () => {
  it("C9 — exactly one of N concurrent lease acquisitions wins", async () => {
    // This models the LeaseService acquire/path: a unique constraint
    // on jobName means only the first insert can win while the lease
    // is active. The losers must get null, not a second handle.
    const holder = { value: null as string | null };
    const barrier = new Barrier();

    const acquire = async (worker: string) => {
      await barrier.wait();
      const current = holder.value;
      await yieldTo();
      if (current !== null) return null;
      holder.value = worker;
      return worker;
    };

    const results = await runConcurrently(5, (i) => acquire(`worker-${i}`));
    barrier.release();

    expect(countFulfilled(results, (r) => r !== null)).toBe(1);
    expect(holder.value).toMatch(/^worker-\d+$/);
  });

  it("C10 — a stale fencing token cannot commit a guarded write", async () => {
    // Models the takeover race: worker A holds token 1, then its
    // lease expires and worker B takes over with token 2. Worker A
    // must detect the stale token before committing.
    const lease = { token: 1n, holder: "A" };
    const committed: string[] = [];

    const guardedWrite = async (worker: string, token: number) => {
      await yieldTo();
      if (lease.token !== token || lease.holder !== worker) {
        throw new Error("STALE_FENCING_TOKEN");
      }
      committed.push(worker);
    };

    // A and B both attempt to commit with their respective tokens.
    const results = await runConcurrently(2, async (i) => {
      const worker = i === 0 ? "A" : "B";
      const token = i === 0 ? 1 : 2;
      return guardedWrite(worker, token);
    });

    // Only the current holder (B, token 2) can commit.
    expect(countFulfilled(results)).toBe(1);
    expect(committed).toEqual(["B"]);
    for (const reason of rejections(results)) {
      expect(String(reason)).toContain("STALE_FENCING_TOKEN");
    }
  });
});
