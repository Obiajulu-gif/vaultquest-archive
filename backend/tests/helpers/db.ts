import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TestDb = {
  prisma: PrismaClient;
  databaseUrl: string;
  stop: () => Promise<void>;
};

export async function startTestDb(): Promise<TestDb> {
  const backendDir = fileURLToPath(new URL("../../", import.meta.url));
  const prismaCliPath = resolve(backendDir, "node_modules/prisma/build/index.js");
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("vaultquest_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  const databaseUrl = container.getConnectionUri();

  execFileSync(process.execPath, [prismaCliPath, "migrate", "deploy"], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit"
  });

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  return {
    prisma,
    databaseUrl,
    stop: async () => {
      await prisma.$disconnect();
      await container.stop();
    }
  };
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.repairAudit.deleteMany({});
  await prisma.repairQuarantine.deleteMany({});
  await prisma.actionLease.deleteMany({});
  await prisma.pendingEvent.deleteMany({});
  await prisma.savedPool.deleteMany({});
  await prisma.userQuest.deleteMany({});
  await prisma.vaultSettlement.deleteMany({});
  await prisma.actionLedger.deleteMany({});
}
