import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  SyntheticMonitor,
  classifyBlame,
  getSyntheticMonitor,
  syntheticWalletFor,
  type JourneyClient,
  type JourneyStepResponse
} from "../src/services/syntheticMonitor.js";

type FakeOverrides = Partial<JourneyClient>;

function fakeClient(overrides: FakeOverrides = {}): JourneyClient {
  const ok: JourneyStepResponse = { ok: true, status_code: 200 };
  const base: JourneyClient = {
    createIntent: async () => ({ ...ok, status_code: 201, actionId: "action-1" }),
    attachTx: async () => ok,
    reconcile: async () => ok,
    readDashboard: async () => ok,
    scrub: async () => ok
  };
  return { ...base, ...overrides };
}

describe("synthetic wallet generation", () => {
  it("is deterministic, Stellar-shaped, and unique per run id", () => {
    const a = syntheticWalletFor("run-a");
    expect(a).toBe(syntheticWalletFor("run-a"));
    expect(a).toMatch(/^G[A-Z2-7]{55}$/);
    expect(syntheticWalletFor("run-b")).not.toBe(a);
  });
});

describe("blame classification", () => {
  it("maps status codes to dependencies", () => {
    expect(classifyBlame("indexer_reconcile", { ok: false, status_code: 500 })).toBe("indexer");
    expect(classifyBlame("create_intent", { ok: false, status_code: 500 })).toBe("ledger_api");
    expect(classifyBlame("create_intent", { ok: false, status_code: 429 })).toBe("rate_limit");
    expect(classifyBlame("create_intent", { ok: false, status_code: 401 })).toBe("auth_config");
    expect(
      classifyBlame("create_intent", { ok: false, status_code: 403, error: "Invalid or missing CSRF token" })
    ).toBe("middleware_csrf");
    expect(
      classifyBlame("indexer_reconcile", { ok: false, status_code: 0, error: "network_error" })
    ).toBe("network");
  });
});

describe("synthetic monitor (fake client)", () => {
  it("passes the happy path and reports per-step latency", async () => {
    const result = await new SyntheticMonitor({ client: fakeClient() }).run();

    expect(result.status).toBe("pass");
    expect(result.blame).toBeNull();
    expect(result.budget_exceeded).toBe(false);
    expect(result.steps.map((step) => step.name)).toEqual([
      "create_intent",
      "attach_tx",
      "indexer_reconcile",
      "dashboard_confirmation",
      "cleanup"
    ]);
    for (const step of result.steps) {
      expect(step.ok).toBe(true);
      expect(step.duration_ms).toBeGreaterThanOrEqual(0);
    }
    expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.slowest_step).not.toBeNull();
    expect(result.summary).toContain("pass");
  });

  it("blames the indexer when reconciliation fails and skips the rest", async () => {
    const scrub = vi.fn(async () => ({ ok: true, status_code: 200 }) as JourneyStepResponse);
    const client = fakeClient({
      reconcile: async () => ({ ok: false, status_code: 500, error: "reconcile exploded" }),
      scrub
    });

    const result = await new SyntheticMonitor({ client }).run();

    expect(result.status).toBe("fail");
    expect(result.blame).toBe("indexer");
    const byName = Object.fromEntries(result.steps.map((step) => [step.name, step]));
    expect(byName["indexer_reconcile"]?.ok).toBe(false);
    expect(byName["indexer_reconcile"]?.blame).toBe("indexer");
    expect(byName["dashboard_confirmation"]?.skipped).toBe(true);
    // Cleanup still runs even after a failure.
    expect(byName["cleanup"]?.ok).toBe(true);
    expect(scrub).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain("indexer");
  });

  it("blames the ledger API when the intent cannot be created", async () => {
    const client = fakeClient({
      createIntent: async () => ({ ok: false, status_code: 409, error: "conflict" }),
      scrub: async () => ({ ok: true, status_code: 200 })
    });

    const result = await new SyntheticMonitor({ client }).run();
    expect(result.status).toBe("fail");
    expect(result.blame).toBe("ledger_api");
    const skipped = result.steps.filter((step) => step.skipped).map((step) => step.name);
    expect(skipped).toEqual(["attach_tx", "indexer_reconcile", "dashboard_confirmation"]);
  });

  it("reports degraded (not failed) when the latency budget is exceeded", async () => {
    let tick = 0;
    const monitor = new SyntheticMonitor({
      client: fakeClient(),
      latencyBudgetMs: 50,
      monotonicNow: () => {
        tick += 20;
        return tick;
      }
    });

    const result = await monitor.run();
    expect(result.status).toBe("degraded");
    expect(result.budget_exceeded).toBe(true);
    expect(result.blame).toBeNull();
    expect(result.summary).toContain("degraded");
  });

  it("records a network blame when the client throws", async () => {
    const client = fakeClient({
      attachTx: async () => {
        throw new Error("ECONNREFUSED");
      }
    });

    const result = await new SyntheticMonitor({ client }).run();
    expect(result.status).toBe("fail");
    expect(result.blame).toBe("network");
  });
});

describe("synthetic monitor (app integration)", () => {
  let db: TestDb;
  let app: FastifyInstance;
  const internalSecret = "monitor-secret-1234567890";

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({
      prisma: db.prisma,
      internalSecret,
      monitorClientIp: "10.254.255.1",
      monitorLatencyBudgetMs: 10_000
    });
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  it("runs the real deposit → reconcile → dashboard journey end to end", async () => {
    const runner = getSyntheticMonitor(app);
    expect(runner).not.toBeNull();

    const result = await (runner as NonNullable<typeof runner>).run();

    expect(result.status).toBe("pass");
    for (const step of result.steps) {
      expect(step.ok, `${step.name}: ${step.detail ?? ""}`).toBe(true);
    }

    // The ledger row reached `confirmed` through the real indexer endpoint…
    const row = await db.prisma.actionLedger.findFirst({
      where: { walletAddress: result.wallet }
    });
    expect(row?.status).toBe("confirmed");
    expect(row?.txHash).toBe(result.tx_hash);

    // …and cleanup privacy-scrubbed the synthetic payload.
    expect(row?.redactedAt).not.toBeNull();
    expect(row?.actionPayload).toBeNull();

    // No other actions were left behind.
    const count = await db.prisma.actionLedger.count();
    expect(count).toBe(1);
  });

  it("exposes run + status endpoints behind the internal secret", async () => {
    const unauthorized = await app.inject({
      method: "POST",
      url: "/internal/synthetic-monitor/run",
      remoteAddress: "10.10.10.1"
    });
    expect(unauthorized.statusCode).toBe(401);

    const run = await app.inject({
      method: "POST",
      url: "/internal/synthetic-monitor/run",
      headers: { "x-internal-secret": internalSecret },
      remoteAddress: "10.10.10.2"
    });
    expect(run.statusCode).toBe(200);
    const runBody = run.json().data;
    expect(runBody.status).toBe("pass");

    const status = await app.inject({
      method: "GET",
      url: "/internal/synthetic-monitor/status",
      headers: { "x-internal-secret": internalSecret },
      remoteAddress: "10.10.10.3"
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.run_id).toBe(runBody.run_id);
    expect(status.json().data.total_duration_ms).toBeTypeOf("number");
  });
});
