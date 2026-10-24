import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { getPrisma } from "../src/db.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "child_process";
import { SCHEMA_VERSIONS } from "../src/constants.js";

describe("SchemaVersion E2E", () => {
  let container: StartedPostgreSqlContainer;
  let app: any;
  let prisma: any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:15-alpine").start();
    const dbUrl = container.getConnectionUri();
    
    // Run migrations manually
    execSync(`npx prisma migrate dev --name init`, {
      env: { ...process.env, DATABASE_URL: dbUrl },
      cwd: process.cwd()
    });

    prisma = getPrisma(dbUrl);
    app = buildApp({
      prisma,
      internalSecret: "test-secret",
      apiKey: "test-api-key-must-be-32-chars-long!",
      adminWalletAddresses: []
    });

    // Seed indexer checkpoint with a real version
    await prisma.indexerCheckpoint.create({
      data: {
        id: "singleton",
        latestLedger: 12345,
        lastSyncTime: new Date(),
        lastSuccessSyncTime: new Date(),
        indexerVersion: SCHEMA_VERSIONS.INDEXER,
      }
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await container?.stop();
  });

  it("GET /api/schema-version returns valid version info", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/schema-version",
      headers: { "X-Api-Key": "test-api-key-must-be-32-chars-long!" }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    
    expect(body.ok).toBe(true);
    expect(body.data.indexer.current).toBe(SCHEMA_VERSIONS.INDEXER);
    expect(body.data.indexer.expected).toBe(SCHEMA_VERSIONS.INDEXER);
  });
});
