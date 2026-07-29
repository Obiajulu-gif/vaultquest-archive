import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

export function getPrisma(databaseUrl?: string): PrismaClient {
  if (client) return client;
  client = new PrismaClient(
    databaseUrl
      ? { datasources: { db: { url: databaseUrl } } }
      : undefined
  );
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

/**
 * Lightweight connectivity probe (#indexer). The indexer daemon calls this
 * before each poll so it skips a tick — rather than fetching Horizon events it
 * cannot persist — when the database is temporarily unreachable.
 */
export async function pingDatabase(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
