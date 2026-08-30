import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const WALLET = "GEXPORTINTEGRITYWALLET00000000000000000000000000000";

describe("Activity Export Integrity & Tamper Detection", () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret: "test-secret" });
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  it("exports JSON with correct metadata, omitted internal fields, and valid checksum", async () => {
    // Seed some actions
    await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": randomUUID(), "content-type": "application/json" },
      payload: { wallet_address: WALLET, action_type: "deposit", action_payload: { vault_id: "v1", amount: "100", token: "USDC" } }
    });

    const res = await app.inject({ method: "GET", url: `/actions/export?wallet=${WALLET}&format=json` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const payload = JSON.parse(res.body);
    expect(payload.metadata).toBeDefined();
    expect(payload.metadata.wallet).toBe(WALLET);
    expect(payload.metadata.network).toBeDefined();
    expect(payload.metadata.checksum).toBeDefined();
    expect(payload.metadata.generatedAt).toBeDefined();

    expect(payload.data).toBeDefined();
    expect(payload.data).toHaveLength(1);

    // Verify sensitive/internal fields are omitted
    const record = payload.data[0];
    expect(record.correlation_id).toBeUndefined();
    expect(record.soroban_event_id).toBeUndefined();
    expect(record.updated_at).toBeUndefined();
    expect(record.retry_count).toBeUndefined();

    // Verify correct public fields
    expect(record.id).toBeDefined();
    expect(record.action_type).toBe("deposit");
    expect(record.pool_id).toBe("v1");
    expect(record.asset).toBe("USDC");
    expect(record.amount).toBe("100");

    // Validate checksum matches data block
    const computedChecksum = createHash("sha256").update(JSON.stringify(payload.data)).digest("hex");
    expect(payload.metadata.checksum).toBe(computedChecksum);
  });

  it("exports CSV with prepended commented metadata and matching checksum", async () => {
    await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": randomUUID(), "content-type": "application/json" },
      payload: { wallet_address: WALLET, action_type: "deposit", action_payload: { vault_id: "v1", amount: "100", token: "USDC" } }
    });

    const res = await app.inject({ method: "GET", url: `/actions/export?wallet=${WALLET}&format=csv` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");

    const lines = res.body.split("\n");
    
    // Check comments
    expect(lines[0]).toContain(`# wallet: ${WALLET}`);
    expect(lines[1]).toContain("# network:");
    expect(lines[2]).toContain("# range:");
    expect(lines[3]).toContain("# generatedAt:");
    expect(lines[4]).toContain("# checksum:");

    // Extract checksum from comment
    const checksumMatch = lines[4]?.match(/# checksum: ([0-9a-f]{64})/);
    expect(checksumMatch).not.toBeNull();
    const checksum = checksumMatch![1];

    // Reconstruct data rows
    const dataLines = lines.slice(5).filter((l) => l.trim().length > 0);
    const dataContent = dataLines.join("\n");

    const computedChecksum = createHash("sha256").update(dataContent).digest("hex");
    expect(checksum).toBe(computedChecksum);
  });

  it("detects tampering when data records are altered", async () => {
    await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": randomUUID(), "content-type": "application/json" },
      payload: { wallet_address: WALLET, action_type: "deposit", action_payload: { vault_id: "v1", amount: "100", token: "USDC" } }
    });

    const res = await app.inject({ method: "GET", url: `/actions/export?wallet=${WALLET}&format=json` });
    const payload = JSON.parse(res.body);
    const originalChecksum = payload.metadata.checksum;

    // Tamper with data record amount
    payload.data[0].amount = "999999";

    const recomputedChecksum = createHash("sha256").update(JSON.stringify(payload.data)).digest("hex");
    expect(recomputedChecksum).not.toBe(originalChecksum);
  });
});
