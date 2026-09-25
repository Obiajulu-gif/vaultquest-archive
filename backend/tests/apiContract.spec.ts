import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { ERROR_CODES } from "../src/constants.js";
import { CONTRACTS, DOCUMENTED_ERROR_CODES, action, errorEnvelope, type ContractName } from "../src/contracts/apiContract.js";
import { ERROR_CATALOG } from "../src/errorTaxonomy.js";
import { InMemoryJobStore } from "../src/worker/jobStore.js";
import { JobWorker } from "../src/worker/jobWorker.js";

const DOC_PATH = resolve(__dirname, "../../docs/API.md");
const doc = readFileSync(DOC_PATH, "utf8");
const SECRET = "contract-secret";
const WALLET = "GABCDEF1234567890";
const KEY = "0b1f7e9e-3c1d-4d6e-8d55-0c5f6a3b2f10";
const ID = "5d3a8a4c-89a5-4b8a-9a1c-1f0d4b2c7e11";

function row(over: Record<string, unknown> = {}) {
  const t = new Date("2026-09-26T10:00:00.000Z");
  return {
    id: ID,
    idempotencyKey: KEY,
    walletAddress: WALLET,
    actionType: "deposit",
    actionPayload: { vault_id: "42", amount: "1000000", token: "USDC" },
    status: "pending",
    txHash: null,
    sorobanEventId: null,
    correlationId: "7f0c2f84-2f2b-4f38-9d8e-3b1f5c9a1a11",
    errorCode: null,
    errorDetail: null,
    retryCount: 0,
    createdAt: t,
    updatedAt: t,
    submittedAt: null,
    confirmedAt: null,
    redactedAt: null,
    ...over
  };
}

function parse(name: ContractName, body: unknown) {
  const r = CONTRACTS[name].safeParse(body);
  expect(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2)).toBe(true);
}

describe("documented route index", () => {
  let app: FastifyInstance;
  const registered = new Set<string>();

  beforeAll(async () => {
    app = buildApp({ prisma: {} as any, internalSecret: SECRET, jobStore: new InMemoryJobStore() });
    app.addHook("onRoute", (r) => {
      for (const m of ([] as string[]).concat(r.method as string | string[])) {
        if (m !== "HEAD" && m !== "OPTIONS") registered.add(`${m} ${r.url}`);
      }
    });
    await app.ready();
  });
  afterAll(() => app.close());

  function documented(): Set<string> {
    const m = doc.match(/<!-- route-index:start -->([\s\S]*?)<!-- route-index:end -->/);
    expect(m, "docs/API.md must contain a route-index block").toBeTruthy();
    return new Set(
      [...m![1].matchAll(/^\|\s*`(GET|POST|PUT|PATCH|DELETE)`\s*\|\s*`([^`]+)`/gm)].map((x) => `${x[1]} ${x[2]}`)
    );
  }

  it("lists every registered route in docs/API.md, and nothing else", () => {
    expect(registered.size).toBeGreaterThan(30);
    const docs = documented();
    const undocumented = [...registered].filter((r) => !docs.has(r)).sort();
    const stale = [...docs].filter((r) => !registered.has(r)).sort();
    expect({ undocumented, stale }).toEqual({ undocumented: [], stale: [] });
  });

  it("documents exactly the error codes the API can return", () => {
    const section = doc.split("## Standard errors")[1]?.split("\n## ")[0] ?? "";
    const codes = new Set([...section.matchAll(/^\|\s*`([A-Z_]+)`/gm)].map((m) => m[1]));
    expect([...codes].sort()).toEqual([...DOCUMENTED_ERROR_CODES].sort());
  });

  it("documents the same category and retryability as the error catalog", () => {
    const section = doc.split("### Error codes")[1]?.split("\n---")[0] ?? "";
    const rows = [...section.matchAll(/^\|\s*`([A-Z_]+)`\s*\|\s*(\w+)\s*\|\s*(yes|no)\s*\|/gm)];
    expect(rows.length).toBe(DOCUMENTED_ERROR_CODES.length);
    for (const [, code, category, retryable] of rows) {
      const d = ERROR_CATALOG[code as keyof typeof ERROR_CATALOG];
      expect({ code, category, retryable }).toEqual({ code, category: d.category, retryable: d.retryable ? "yes" : "no" });
    }
  });
});

describe("documentation examples", () => {
  const blocks = [...doc.matchAll(/```json contract=([\w-]+)\n([\s\S]*?)```/g)];

  it("has at least one success and one failure example", () => {
    const names = blocks.map((b) => b[1]);
    expect(names).toContain("action");
    expect(names).toContain("error");
    expect(names).toContain("action-list");
  });

  it.each(blocks.map((b) => [b[1], b[2]] as const))("example for contract=%s matches its schema", (name, body) => {
    expect(name in CONTRACTS, `unknown contract ${name}`).toBe(true);
    parse(name as ContractName, JSON.parse(body));
  });
});

describe("live responses match the contract", () => {
  const headers = { "x-internal-secret": SECRET };

  function build(prisma: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return buildApp({ prisma: prisma as any, internalSecret: SECRET, ...extra });
  }

  /** Double-submit CSRF headers, obtained the way a browser client does: from any GET. */
  async function csrf(app: FastifyInstance, extra: Record<string, string> = {}) {
    const res = await app.inject({ method: "GET", url: "/health" });
    const token = res.headers["x-csrf-token"] as string;
    return { "x-csrf-token": token, cookie: `csrf-token=${token}`, ...extra };
  }

  it("GET /health", async () => {
    const app = build({});
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    parse("health", res.json());
    await app.close();
  });

  it("POST /actions: 201 created, 200 replay, 409 conflict, 400 validation", async () => {
    const created = row();
    const findUnique = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(created);
    const app = build({ actionLedger: { findUnique, create } });
    const payload = { wallet_address: WALLET, action_type: "deposit", action_payload: created.actionPayload };

    const first = await app.inject({ method: "POST", url: "/actions", headers: await csrf(app, { "idempotency-key": KEY }), payload });
    expect(first.statusCode).toBe(201);
    parse("action", first.json());
    expect(first.json().data).toMatchObject({ status: "pending", wallet_address: WALLET, tx_hash: null });

    findUnique.mockResolvedValue(created);
    const replay = await app.inject({ method: "POST", url: "/actions", headers: await csrf(app, { "idempotency-key": KEY }), payload });
    expect(replay.statusCode).toBe(200);
    parse("action", replay.json());
    expect(replay.json().data.id).toBe(first.json().data.id);

    const conflict = await app.inject({
      method: "POST",
      url: "/actions",
      headers: await csrf(app, { "idempotency-key": KEY }),
      payload: { ...payload, action_payload: { vault_id: "other" } }
    });
    expect(conflict.statusCode).toBe(409);
    parse("error", conflict.json());
    expect(conflict.json().error).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      category: "conflict",
      retryable: false
    });

    const noKey = await app.inject({ method: "POST", url: "/actions", headers: await csrf(app), payload });
    expect(noKey.statusCode).toBe(400);
    parse("error", noKey.json());
    expect(noKey.json().error.code).toBe("INVALID_PAYLOAD");

    const badBody = await app.inject({ method: "POST", url: "/actions", headers: await csrf(app, { "idempotency-key": KEY }), payload: { wallet_address: WALLET } });
    expect(badBody.statusCode).toBe(400);
    parse("error", badBody.json());
    expect(badBody.json().error.issues.length).toBeGreaterThan(0);
    const noCsrf = await app.inject({ method: "POST", url: "/actions", headers: { "idempotency-key": KEY }, payload });
    expect(noCsrf.statusCode).toBe(403);
    parse("error", noCsrf.json());
    expect(noCsrf.json().error).toMatchObject({ code: "FORBIDDEN", category: "authorization" });
    expect(noCsrf.json().error.message).toContain("CSRF");
    await app.close();
  });

  it("GET /actions/:id: 200 and 404", async () => {
    const findUnique = vi.fn().mockResolvedValueOnce(row({ status: "confirmed", txHash: "abc123", confirmedAt: new Date("2026-09-26T10:05:00.000Z") })).mockResolvedValue(null);
    const app = build({ actionLedger: { findUnique } });
    const ok = await app.inject({ method: "GET", url: `/actions/${ID}` });
    expect(ok.statusCode).toBe(200);
    parse("action", ok.json());
    const missing = await app.inject({ method: "GET", url: `/actions/${ID}` });
    expect(missing.statusCode).toBe(404);
    parse("error", missing.json());
    expect(missing.json().error).toMatchObject({ code: "NOT_FOUND", category: "not_found" });
    await app.close();
  });

  it("GET /actions: paginated with cursor, and validation failure", async () => {
    const rows = [row({ id: "a0000000-0000-4000-8000-000000000001" }), row({ id: "a0000000-0000-4000-8000-000000000002" }), row({ id: "a0000000-0000-4000-8000-000000000003" })];
    const findMany = vi.fn().mockResolvedValue(rows);
    const checkpoint = vi
      .fn()
      .mockResolvedValueOnce({ latestLedger: 1234567, lastSuccessSyncTime: new Date("2026-09-26T10:04:30.000Z") })
      .mockResolvedValueOnce(null);
    const app = build({ actionLedger: { findMany }, indexerCheckpoint: { findUnique: checkpoint } });
    const res = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET}&limit=2` });
    expect(res.statusCode).toBe(200);
    parse("action-list", res.json());
    expect(res.json().data).toHaveLength(2);
    expect(res.json().meta.pagination).toEqual({ next_cursor: rows[1].id, limit: 2, has_more: true });
    expect(res.json().meta.watermark).toEqual({ latest_ledger: 1234567, as_of: "2026-09-26T10:04:30.000Z" });

    // Before the indexer has synced, the watermark is present but null.
    const cold = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET}&limit=2` });
    parse("action-list", cold.json());
    expect(cold.json().meta.watermark).toEqual({ latest_ledger: null, as_of: null });

    const bad = await app.inject({ method: "GET", url: "/actions?limit=2" });
    expect(bad.statusCode).toBe(400);
    parse("error", bad.json());
    const tooBig = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET}&limit=1000` });
    expect(tooBig.statusCode).toBe(400);
    await app.close();
  });

  it("POST /actions/:id/cancel: 200, 404 and 409", async () => {
    const findUnique = vi.fn().mockResolvedValueOnce(row()).mockResolvedValueOnce(null).mockResolvedValueOnce(row({ status: "confirmed" }));
    const update = vi.fn().mockResolvedValue(row({ status: "failed", errorCode: "WALLET_REJECTED" }));
    const app = build({ actionLedger: { findUnique, update } });
    const body = { error_code: "WALLET_REJECTED" };
    const h = await csrf(app);
    const done = await app.inject({ method: "POST", url: `/actions/${ID}/cancel`, headers: h, payload: body });
    expect(done.statusCode).toBe(200);
    parse("action", done.json());
    expect(done.json().data).toMatchObject({ status: "failed", error_code: "WALLET_REJECTED" });
    expect((await app.inject({ method: "POST", url: `/actions/${ID}/cancel`, headers: h, payload: body })).statusCode).toBe(404);
    const illegal = await app.inject({ method: "POST", url: `/actions/${ID}/cancel`, headers: h, payload: body });
    expect(illegal.statusCode).toBe(409);
    parse("error", illegal.json());
    expect(illegal.json().error.code).toBe("ILLEGAL_TRANSITION");
    await app.close();
  });

  it("internal endpoints: 401 without the secret, and job inspection", async () => {
    const app = build({}, { jobStore: new InMemoryJobStore() });
    const denied = await app.inject({ method: "GET", url: "/internal/jobs" });
    expect(denied.statusCode).toBe(401);
    parse("error", denied.json());
    expect(denied.json().error).toMatchObject({ code: "UNAUTHORIZED", category: "authorization" });

    const { job } = await app.jobQueue!.enqueue({ type: "unknown.type", payload: { actionId: "a" }, idempotencyKey: "k", correlationId: "corr-1" });
    await new JobWorker({ queue: app.jobQueue!, handlers: {} }).runOnce();
    const list = await app.inject({ method: "GET", url: "/internal/jobs?status=dead", headers });
    expect(list.statusCode).toBe(200);
    parse("job-list", list.json());
    const one = await app.inject({ method: "GET", url: `/internal/jobs/${job.id}`, headers });
    parse("job", one.json());
    expect(one.json().data.status).toBe("dead");
    await app.close();
  });

  it("every error response is a valid error envelope carrying the correlation id", async () => {
    const app = build({ actionLedger: { findUnique: vi.fn().mockResolvedValue(null) } });
    const res = await app.inject({ method: "GET", url: `/actions/${ID}`, headers: { "correlation-id": "support-case-42" } });
    const body = errorEnvelope.parse(res.json());
    expect(body.error.error_id).toBe("support-case-42");
    expect(res.headers["correlation-id"]).toBe("support-case-42");
    await app.close();
  });
});

describe("drift detection", () => {
  it("rejects a response with a renamed, removed or extra field", () => {
    const good = {
      id: ID, idempotency_key: KEY, wallet_address: WALLET, action_type: "deposit", action_payload: {}, status: "pending",
      tx_hash: null, soroban_event_id: null, correlation_id: "c", error_code: null, error_detail: null, retry_count: 0,
      created_at: "2026-09-26T10:00:00.000Z", updated_at: "2026-09-26T10:00:00.000Z", submitted_at: null, confirmed_at: null, redacted_at: null
    };
    expect(action.safeParse(good).success).toBe(true);
    const { status: _status, ...removed } = good;
    expect(action.safeParse(removed).success).toBe(false);
    expect(action.safeParse({ ...good, wallet: WALLET }).success).toBe(false);
    expect(action.safeParse({ ...good, retry_count: "0" }).success).toBe(false);
    expect(action.safeParse({ ...good, status: "unknown" }).success).toBe(false);
  });

  it("covers every ERROR_CODE in the taxonomy", () => {
    expect(new Set(DOCUMENTED_ERROR_CODES)).toEqual(new Set(Object.values(ERROR_CODES)));
  });
});
