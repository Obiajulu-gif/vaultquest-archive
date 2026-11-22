import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { parseCsv } from "../src/services/csv.js";

const WALLET_OP = `G${"A".repeat(55)}`;
const WALLET_WIN = `G${"B".repeat(55)}`;
const internalSecret = "imports-secret-1234567890";

const VALID_CSV = [
  "vault_id,wallet_address,winner_wallet,amount,token,round",
  `vault-1,${WALLET_OP},${WALLET_WIN},1000,USDC,1`,
  `vault-2,${WALLET_OP},${WALLET_WIN},=1+1,USDC,2`,
  `vault-3,${WALLET_OP},${WALLET_WIN},0,USDC,3`,
  `vault-4,${WALLET_OP},${WALLET_WIN},100,usdc,4`,
  `vault-5,${WALLET_OP},not-a-wallet,100,USDC,5`,
  `vault-6,${WALLET_OP},${WALLET_WIN},100,USDC,zero`,
  `vault-1,${WALLET_OP},${WALLET_WIN},1000,USDC,1`
].join("\n");

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.30.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

describe("csv parser", () => {
  it("parses quoted fields, embedded commas, CRLF and BOM", () => {
    const parsed = parseCsv('\uFEFFa,b\n"x,1","line1\nline2"\r\n"say ""hi""",2\n');
    expect(parsed.error).toBeUndefined();
    expect(parsed.headers).toEqual(["a", "b"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.cells).toEqual(["x,1", "line1\nline2"]);
    expect(parsed.rows[1]?.cells).toEqual(['say "hi"', "2"]);
  });

  it("skips blank lines and rejects unterminated quotes", () => {
    const parsed = parseCsv("a,b\n\n1,2\n");
    expect(parsed.rows).toHaveLength(1);
    expect(parseCsv('a,b\n"oops').error).toContain("unterminated");
  });

  it("enforces the row cap", () => {
    const rows = ["a,b", ...Array.from({ length: 11 }, (_, i) => `${i},x`)].join("\n");
    expect(parseCsv(rows, { maxRows: 10 }).error).toContain("more than 10 data rows");
  });
});

describe("secure import pipeline", () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret });
  });
  afterAll(async () => {
    await app.close();
    await db.stop();
  });
  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  async function preview(content: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/internal/imports/preview",
      headers: { "x-internal-secret": internalSecret, "content-type": "application/json" },
      remoteAddress: nextIp(),
      payload: {
        kind: "prize_winners",
        content,
        created_by: "ops-1",
        source_name: "round-42.csv",
        ...extra
      }
    });
  }

  async function commit(batchId: string) {
    return app.inject({
      method: "POST",
      url: `/internal/imports/${batchId}/commit`,
      headers: { "x-internal-secret": internalSecret },
      remoteAddress: nextIp()
    });
  }

  async function rollback(batchId: string) {
    return app.inject({
      method: "POST",
      url: `/internal/imports/${batchId}/rollback`,
      headers: { "x-internal-secret": internalSecret },
      remoteAddress: nextIp()
    });
  }

  async function getBatch(batchId: string) {
    return app.inject({
      method: "GET",
      url: `/internal/imports/${batchId}`,
      headers: { "x-internal-secret": internalSecret },
      remoteAddress: nextIp()
    });
  }

  it("requires the service secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/imports/preview",
      remoteAddress: nextIp(),
      payload: {}
    });
    expect(res.statusCode).toBe(401);
  });

  it("previews and quarantines unsafe rows without touching the ledger", async () => {
    const res = await preview(VALID_CSV);
    expect(res.statusCode).toBe(201);

    const batch = res.json().data.batch;
    expect(batch.status).toBe("preview");
    expect(batch.total_rows).toBe(7);
    expect(batch.accepted_rows).toBe(1);
    expect(batch.quarantined_rows).toBe(6);
    expect(batch.next_actions.length).toBeGreaterThan(0);

    const reasons = batch.rows
      .filter((row: { status: string }) => row.status === "quarantined")
      .map((row: { quarantine_reason: string }) => row.quarantine_reason);
    expect(reasons).toEqual([
      "unsafe_content",
      "invalid_amount",
      "invalid_token",
      "invalid_wallet",
      "invalid_round",
      "duplicate_row"
    ]);

    const accepted = batch.rows.find((row: { status: string }) => row.status === "accepted");
    expect(accepted.payload.vault_id).toBe("vault-1");

    // Preview must not write business data.
    const actions = await db.prisma.actionLedger.count();
    expect(actions).toBe(0);
  });

  it("is idempotent on idempotency_key and conflicts on different content", async () => {
    const key = randomUUID();
    const first = await preview(VALID_CSV, { idempotency_key: key });
    expect(first.statusCode).toBe(201);

    const replay = await preview(VALID_CSV, { idempotency_key: key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.batch.id).toBe(first.json().data.batch.id);

    const conflicting = await preview(`${VALID_CSV}\n`, { idempotency_key: key });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"
    );
  });

  it("rejects unknown or missing columns, oversized files and too many rows", async () => {
    const unknown = await preview(
      `vault_id,wallet_address,winner_wallet,amount,token,round,extra\nvault-1,${WALLET_OP},${WALLET_WIN},1,USDC,1,x`
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toContain("unknown: extra");

    const missing = await preview(
      `vault_id,wallet_address,winner_wallet,amount,token\nvault-1,${WALLET_OP},${WALLET_WIN},1,USDC`
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain("missing: round");

    const oversized = await preview("x".repeat(600_000));
    expect(oversized.statusCode).toBe(400);

    const tooMany = [
      "vault_id,wallet_address,winner_wallet,amount,token,round",
      ...Array.from(
        { length: 1001 },
        (_, i) => `vault-${i},${WALLET_OP},${WALLET_WIN},1,USDC,${i + 1}`
      )
    ].join("\n");
    const tooManyRes = await preview(tooMany);
    expect(tooManyRes.statusCode).toBe(400);
  });

  it("commits accepted rows as traceable pending actions and is retry-safe", async () => {
    const created = await preview(VALID_CSV);
    const batchId = created.json().data.batch.id;

    const committed = await commit(batchId);
    expect(committed.statusCode).toBe(200);
    const batch = committed.json().data.batch;
    expect(batch.status).toBe("committed");
    expect(batch.applied_rows).toBe(1);
    expect(batch.quarantined_rows).toBe(6);

    const actions = await db.prisma.actionLedger.findMany();
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.actionType).toBe("select_winner");
    expect(action?.walletAddress).toBe(WALLET_OP);
    expect(action?.status).toBe("pending");
    expect(action?.actionPayload).toMatchObject({
      vault_id: "vault-1",
      winner_wallet: WALLET_WIN,
      amount: "1000",
      token: "USDC",
      round: "1",
      origin: "import",
      import_batch_id: batchId,
      import_source: "round-42.csv"
    });

    // Replaying commit never duplicates work.
    const replay = await commit(batchId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.already_committed).toBe(true);
    expect(await db.prisma.actionLedger.count()).toBe(1);
  });

  it("rolls back pending actions and reports on-chain blocked rows", async () => {
    const created = await preview(VALID_CSV);
    const batchId = created.json().data.batch.id;
    await commit(batchId);

    const rolledBack = await rollback(batchId);
    expect(rolledBack.statusCode).toBe(200);
    const batch = rolledBack.json().data.batch;
    expect(batch.status).toBe("rolled_back");
    expect(batch.rolled_back_rows).toBe(1);

    const action = await db.prisma.actionLedger.findFirst();
    expect(action?.status).toBe("failed");
    expect(action?.errorCode).toBe("IMPORT_ROLLBACK");

    // Retry is idempotent.
    const retry = await rollback(batchId);
    expect(retry.json().data.already_rolled_back).toBe(true);
  });

  it("never claims to roll back actions that already reached the chain", async () => {
    const created = await preview(VALID_CSV);
    const batchId = created.json().data.batch.id;
    await commit(batchId);

    // Simulate the operator broadcasting the intent.
    const action = await db.prisma.actionLedger.findFirst();
    await db.prisma.actionLedger.update({
      where: { id: action!.id },
      data: { status: "submitted", txHash: "tx-import-1", submittedAt: new Date() }
    });

    const rolledBack = await rollback(batchId);
    expect(rolledBack.statusCode).toBe(200);
    const batch = rolledBack.json().data.batch;
    expect(batch.status).toBe("partially_rolled_back");
    expect(batch.next_actions.join(" ")).toContain("on-chain");

    const blocked = batch.rows.find(
      (row: { status: string }) => row.status === "rollback_blocked"
    );
    expect(blocked).toBeDefined();
    expect(blocked.quarantine_detail).toContain("submitted");

    const untouched = await db.prisma.actionLedger.findFirst();
    expect(untouched?.status).toBe("submitted");
  });

  it("keeps everything traceable from CSV row to ledger action", async () => {
    const created = await preview(VALID_CSV);
    const batchId = created.json().data.batch.id;
    await commit(batchId);

    const fetched = await getBatch(batchId);
    expect(fetched.statusCode).toBe(200);
    const applied = fetched
      .json()
      .data.rows.find((row: { status: string }) => row.status === "applied");
    expect(applied.applied_ref).toBeDefined();

    const action = await app.inject({
      method: "GET",
      url: `/actions/${applied.applied_ref}`,
      remoteAddress: nextIp()
    });
    expect(action.statusCode).toBe(200);
    expect(action.json().data.action_payload.import_batch_id).toBe(batchId);
    expect(action.json().data.action_payload.import_row).toBe(applied.row_number);
  });

  it("rejects illegal transitions with actionable errors", async () => {
    const missing = await commit("00000000-0000-4000-8000-000000000000");
    expect(missing.statusCode).toBe(404);

    const created = await preview(VALID_CSV);
    const batchId = created.json().data.batch.id;

    // Cannot roll back a preview.
    const early = await rollback(batchId);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("ILLEGAL_TRANSITION");

    // Cannot commit twice via a reformatted batch (unknown id).
    const bogus = await commit("not-a-uuid");
    expect(bogus.statusCode).toBe(400);
  });
});
