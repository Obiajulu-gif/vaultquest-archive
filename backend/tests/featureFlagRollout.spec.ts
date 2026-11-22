import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { FEATURE_FLAGS, FeatureFlagService } from "../src/services/featureFlagService.js";
import {
  FeatureFlagRolloutGuard,
  InMemoryFlagRolloutStore,
  SYSTEM_ACTOR,
  withdrawalSubmissionsHaltedCheck,
  type RollbackCheck,
} from "../src/services/featureFlagRollout.js";
import { featureFlagRolloutRoutes } from "../src/routes/featureFlagRollouts.js";

const FLAG = FEATURE_FLAGS.WITHDRAWAL_SUBMISSION_ENABLED;
const TTL = 30_000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");

/** Real FeatureFlagService (with its 30s cache) reading the in-memory store's rows. */
function flagServiceOver(store: InMemoryFlagRolloutStore) {
  const prisma = {
    featureFlag: {
      findUnique: vi.fn(async ({ where }: any) => {
        const row = store.rows.get(`${where.key_scope.key}:${where.key_scope.scope}`);
        return row ? { enabled: row.enabled } : null;
      }),
    },
  };
  return new FeatureFlagService(prisma as any);
}

function setup(opts: { checks?: RollbackCheck[]; autoReverify?: boolean } = {}) {
  const store = new InMemoryFlagRolloutStore();
  const flags = flagServiceOver(store);
  const guard = new FeatureFlagRolloutGuard({
    store,
    flags,
    now: () => Date.now(),
    autoReverify: opts.autoReverify ?? false,
    checks: opts.checks ? { [FLAG]: opts.checks } : undefined,
  });
  return {
    store,
    flags,
    guard,
    advance: (ms: number) => vi.setSystemTime(Date.now() + ms),
  };
}

const startInput = { actor: "maintainer:alice", reason: "canary withdrawals", guardrails: { minSamples: 10, maxErrorRate: 0.2 } };

async function feed(guard: FeatureFlagRolloutGuard, scope: string, ok: number, failed: number) {
  let last = null;
  for (let i = 0; i < ok; i++) last = (await guard.record(FLAG, scope, "success")) ?? last;
  for (let i = 0; i < failed; i++) last = (await guard.record(FLAG, scope, "failure")) ?? last;
  return last;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FeatureFlagRolloutGuard — scoping", () => {
  it("enables the flag only in the rollout scope and remembers the previous value", async () => {
    const { guard, flags, store } = setup();
    const rollout = await guard.start(FLAG, "wallet:GABC", startInput);

    expect(rollout).toMatchObject({ state: "active", previousEnabled: false, scope: "wallet:GABC" });
    expect(await flags.isEnabled(FLAG, { wallet: "GABC" })).toBe(true);
    expect(await flags.isEnabled(FLAG)).toBe(false);
    expect(await flags.isEnabled(FLAG, { wallet: "GOTHER" })).toBe(false);
    expect(store.audits).toEqual([
      expect.objectContaining({ previousValue: false, newValue: true, actor: "maintainer:alice", reason: expect.stringContaining(rollout.id) }),
    ]);
  });

  it("refuses to start when the flag is already on, a rollout is open, or the scope is malformed", async () => {
    const { guard, store } = setup();
    await expect(guard.start(FLAG, "vault", startInput)).rejects.toMatchObject({ code: "INVALID_SCOPE" });

    store.rows.set(`${FLAG}:global`, { enabled: true, metadata: {} });
    await expect(guard.start(FLAG, "global", startInput)).rejects.toMatchObject({ code: "ALREADY_ENABLED" });

    await guard.start(FLAG, "vault:v1", startInput);
    await expect(guard.start(FLAG, "vault:v1", startInput)).rejects.toMatchObject({ code: "IN_PROGRESS" });
  });
});

describe("FeatureFlagRolloutGuard — monitoring", () => {
  it("does not trust an error rate until minSamples outcomes arrived", async () => {
    const { guard } = setup();
    await guard.start(FLAG, "global", startInput);
    // 9 straight failures, but under minSamples (10).
    expect(await feed(guard, "global", 0, 9)).toBeNull();
    expect((await guard.get(FLAG, "global")).health).toMatchObject({ samples: 9, failures: 9, breached: false });
  });

  it("does not roll back when failures stay under the error-rate guardrail", async () => {
    const { guard } = setup();
    await guard.start(FLAG, "global", startInput);
    // 5/55 ≈ 9% < 20%.
    expect(await feed(guard, "global", 50, 5)).toBeNull();
    const { rollout, health } = await guard.get(FLAG, "global");
    expect(rollout?.state).toBe("active");
    expect(health).toMatchObject({ samples: 55, failures: 5, breached: false });
  });

  it("drops outcomes that fall out of the window", async () => {
    const { guard, advance } = setup();
    await guard.start(FLAG, "global", { ...startInput, guardrails: { ...startInput.guardrails, windowMs: 60_000 } });
    await feed(guard, "global", 0, 9);
    advance(61_000);
    expect(await feed(guard, "global", 10, 1)).toBeNull();
    expect((await guard.get(FLAG, "global")).health).toMatchObject({ samples: 11, failures: 1 });
  });

  it("is a no-op when nothing is being rolled out", async () => {
    const { guard } = setup();
    expect(await guard.record(FLAG, "global", "failure")).toBeNull();
  });
});

describe("FeatureFlagRolloutGuard — automatic rollback and verification", () => {
  it("rolls back on a breach, then verifies once every replica cache has expired", async () => {
    const { guard, flags, store, advance } = setup();
    // Warm this process's cache with the enabled value, as a live replica would.
    await guard.start(FLAG, "global", startInput);
    expect(await flags.isEnabled(FLAG)).toBe(true);

    const rolled = await feed(guard, "global", 7, 3); // 3/10 = 30% > 20%
    expect(rolled).toMatchObject({ state: "rollback_unverified", automatic: true, endedBy: SYSTEM_ACTOR });
    expect(rolled!.trigger).toMatchObject({ samples: 10, failures: 3 });
    expect(store.rows.get(`${FLAG}:global`)!.enabled).toBe(false);
    // The local cache was invalidated, so this process already serves the restored value.
    expect(await flags.isEnabled(FLAG)).toBe(false);

    const checks = Object.fromEntries(rolled!.verification!.checks.map((c) => [c.name, c.status]));
    expect(checks).toEqual({
      stored_value_restored: "pass",
      local_cache_consistent: "pass",
      replica_caches_expired: "pending",
    });

    advance(TTL);
    const verified = await guard.verify(FLAG, "global");
    expect(verified.state).toBe("rolled_back");
    expect(verified.verification!.status).toBe("verified");
    // Flip audited exactly twice: rollout on, rollback off.
    expect(store.audits.map((a) => a.newValue)).toEqual([true, false]);
  });

  it("re-verifies on its own after the cache TTL when autoReverify is on", async () => {
    const { guard } = setup({ autoReverify: true });
    await guard.start(FLAG, "global", startInput);
    await feed(guard, "global", 0, 10);
    expect((await guard.get(FLAG, "global")).rollout!.state).toBe("rollback_unverified");

    await vi.advanceTimersByTimeAsync(TTL + 1_000);
    expect((await guard.get(FLAG, "global")).rollout!.state).toBe("rolled_back");
    guard.close();
  });

  it("collapses concurrent rollbacks into a single write", async () => {
    const { guard, store } = setup();
    await guard.start(FLAG, "global", startInput);
    await feed(guard, "global", 0, 9); // one short of minSamples
    const results = await Promise.all([
      guard.rollback(FLAG, "global", { actor: "maintainer:a", reason: "manual stop" }),
      guard.rollback(FLAG, "global", { actor: "maintainer:b", reason: "manual stop" }),
      guard.record(FLAG, "global", "failure"), // the breaching outcome races the manual rollbacks
    ]);
    const [a, b, racing] = results;
    expect(a).toBe(b); // the second manual call joined the first attempt
    expect(a!.state).toBe("rollback_unverified");
    // The racing outcome lands after the rollout left `active`, so it triggers nothing new.
    expect(racing === null || racing.id === a!.id).toBe(true);
    expect(store.audits.filter((a) => a.newValue === false)).toHaveLength(1);
  });

  it("lets only one of two replicas restore the flag", async () => {
    const { guard, store } = setup();
    await guard.start(FLAG, "global", startInput);
    const replicaB = new FeatureFlagRolloutGuard({ store, flags: flagServiceOver(store) });
    const [a, b] = await Promise.all([
      guard.rollback(FLAG, "global", { actor: "replica:a", reason: "breach" }),
      replicaB.rollback(FLAG, "global", { actor: "replica:b", reason: "breach" }),
    ]);
    expect(a.id).toBe(b.id);
    expect(store.audits.filter((x) => x.newValue === false)).toEqual([expect.objectContaining({ actor: "replica:a" })]);
  });

  it("is idempotent once verified", async () => {
    const { guard, store, advance } = setup();
    await guard.start(FLAG, "global", startInput);
    await guard.rollback(FLAG, "global", { actor: "maintainer:a", reason: "stop" });
    advance(TTL);
    await guard.verify(FLAG, "global");
    const again = await guard.rollback(FLAG, "global", { actor: "maintainer:a", reason: "stop again" });
    expect(again.state).toBe("rolled_back");
    expect(store.audits).toHaveLength(2);
  });

  it("re-asserts the restored value if the flag was re-enabled behind the guard's back", async () => {
    const { guard, store, advance } = setup();
    await guard.start(FLAG, "global", startInput);
    await guard.rollback(FLAG, "global", { actor: "maintainer:a", reason: "stop" });
    // e.g. a manual `UPDATE feature_flags SET enabled = true` during the incident
    store.rows.get(`${FLAG}:global`)!.enabled = true;
    advance(TTL);

    const verify = await guard.verify(FLAG, "global");
    expect(verify.state).toBe("rollback_unverified");
    expect(verify.verification!.checks.find((c) => c.name === "stored_value_restored")!.status).toBe("fail");

    const fixed = await guard.rollback(FLAG, "global", { actor: "maintainer:a", reason: "re-assert" });
    expect(fixed.state).toBe("rolled_back");
    expect(store.rows.get(`${FLAG}:global`)!.enabled).toBe(false);
  });

  it("blocks a new rollout until the previous rollback is verified", async () => {
    const { guard, advance } = setup();
    await guard.start(FLAG, "global", startInput);
    await guard.rollback(FLAG, "global", { actor: "maintainer:a", reason: "stop" });
    await expect(guard.start(FLAG, "global", startInput)).rejects.toMatchObject({ code: "IN_PROGRESS" });
    advance(TTL);
    await guard.verify(FLAG, "global");
    await expect(guard.start(FLAG, "global", startInput)).resolves.toMatchObject({ state: "active" });
  });

  it("survives a process restart: a fresh guard rolls back to the persisted previous value", async () => {
    const { store, guard } = setup();
    await guard.start(FLAG, "vault:v9", startInput);

    const restarted = new FeatureFlagRolloutGuard({ store, flags: flagServiceOver(store) });
    const rolled = await restarted.rollback(FLAG, "vault:v9", { actor: "maintainer:a", reason: "after restart" });
    expect(rolled).toMatchObject({ state: "rollback_unverified", previousEnabled: false });
    expect(store.rows.get(`${FLAG}:vault:v9`)!.enabled).toBe(false);
    vi.setSystemTime(Date.now() + TTL);
    expect((await restarted.verify(FLAG, "vault:v9")).state).toBe("rolled_back");
  });

  it("keeps watching and retries when the store is unavailable", async () => {
    const { guard, store } = setup();
    await guard.start(FLAG, "global", startInput);
    const mutate = vi.spyOn(store, "mutate").mockRejectedValueOnce(new Error("db down"));

    // The breaching outcome cannot roll back, but record() never throws into the hot path.
    expect(await feed(guard, "global", 0, 10)).toBeNull();
    expect(store.rows.get(`${FLAG}:global`)!.enabled).toBe(true);

    const rolled = await guard.record(FLAG, "global", "failure");
    expect(rolled?.state).toBe("rollback_unverified");
    expect(store.rows.get(`${FLAG}:global`)!.enabled).toBe(false);
    mutate.mockRestore();
  });

  it("refuses to roll back a completed rollout and leaves the flag on", async () => {
    const { guard, store } = setup();
    await guard.start(FLAG, "global", startInput);
    const done = await guard.complete(FLAG, "global", { actor: "maintainer:a", reason: "healthy for 24h" });
    expect(done.state).toBe("completed");
    expect(await guard.record(FLAG, "global", "failure")).toBeNull();
    await expect(guard.rollback(FLAG, "global", { actor: "maintainer:a", reason: "x" })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(store.rows.get(`${FLAG}:global`)!.enabled).toBe(true);
  });
});

describe("domain verification checks", () => {
  it("fails verification when withdrawals keep being submitted after the rollback", async () => {
    const counter = vi.fn(async () => 2);
    const { guard, advance } = setup({ checks: [withdrawalSubmissionsHaltedCheck(counter)] });
    await guard.start(FLAG, "wallet:GABC", startInput);
    const rolled = await guard.rollback(FLAG, "wallet:GABC", { actor: "maintainer:a", reason: "stop" });
    expect(rolled.verification!.checks.at(-1)).toMatchObject({ name: "withdrawal_submissions_halted", status: "pending" });
    expect(counter).not.toHaveBeenCalled();

    advance(TTL);
    const verified = await guard.verify(FLAG, "wallet:GABC");
    expect(verified.state).toBe("rollback_unverified");
    expect(verified.verification!.checks.at(-1)).toMatchObject({ status: "fail" });
    expect(counter).toHaveBeenCalledWith(new Date(T0 + TTL), "GABC");

    counter.mockResolvedValue(0);
    expect((await guard.verify(FLAG, "wallet:GABC")).state).toBe("rolled_back");
  });

  it("skips vault scopes and treats a throwing check as a failure", async () => {
    const boom: RollbackCheck = { name: "boom", run: async () => { throw new Error("rpc unreachable"); } };
    const { guard, advance } = setup({ checks: [withdrawalSubmissionsHaltedCheck(async () => 0), boom] });
    await guard.start(FLAG, "vault:v1", startInput);
    await guard.rollback(FLAG, "vault:v1", { actor: "maintainer:a", reason: "stop" });
    advance(TTL);
    const v = await guard.verify(FLAG, "vault:v1");
    expect(v.verification!.checks.slice(-2)).toEqual([
      expect.objectContaining({ name: "withdrawal_submissions_halted", status: "skipped" }),
      { name: "boom", status: "fail", detail: "check errored: rpc unreachable" },
    ]);
    expect(v.state).toBe("rollback_unverified");
  });
});

describe("rollout admin routes", () => {
  function buildApp() {
    const { guard } = setup();
    const app = Fastify();
    app.setErrorHandler(errorHandler as any);
    const asMaintainer = async (req: any) => {
      req.principal = { subject: "alice", role: "maintainer" };
    };
    app.register(featureFlagRolloutRoutes(guard, { read: asMaintainer, write: asMaintainer }));
    return app;
  }
  const url = `/admin/feature-flags/${FLAG}/rollout`;

  it("runs a rollout through start, conflict, rollback and verify", async () => {
    const app = buildApp();
    const start = await app.inject({ method: "POST", url, payload: { scope: "vault:v1", reason: "canary", guardrails: { min_samples: 5 } } });
    expect(start.statusCode).toBe(201);
    expect(start.json().data).toMatchObject({ state: "active", startedBy: "maintainer:alice", guardrails: { minSamples: 5 } });

    const dup = await app.inject({ method: "POST", url, payload: { scope: "vault:v1", reason: "canary" } });
    expect(dup.statusCode).toBe(409);

    const rb = await app.inject({ method: "POST", url: `${url}/rollback`, payload: { scope: "vault:v1", reason: "errors" } });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().data.state).toBe("rollback_unverified");

    const get = await app.inject({ method: "GET", url: `${url}?scope=vault:v1` });
    expect(get.json().data).toMatchObject({ enabled: false, rollout: { state: "rollback_unverified" } });
    await app.close();
  });

  it("rejects unknown flags, bad scopes and missing rollouts", async () => {
    const app = buildApp();
    expect((await app.inject({ method: "POST", url: "/admin/feature-flags/nope/rollout", payload: { reason: "abc" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, payload: { scope: "bogus", reason: "abc" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${url}/verify`, payload: { scope: "global" } })).statusCode).toBe(404);
    await app.close();
  });
});
