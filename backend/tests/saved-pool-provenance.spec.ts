import { describe, expect, it, vi } from "vitest";
import { SavedPoolsService } from "../src/services/savedPools.js";
import { provenanceManager } from "../../lib/record-provenance.js";

describe("Persisted saved-pool provenance", () => {
  it("stores imports and preserves their origin through later ordinary updates", async () => {
    let stored: any = null;
    const prisma: any = { savedPool: {
      findUnique: vi.fn(async () => stored),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (stored = { id: "saved", ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (stored = { ...stored, ...data })),
    } };
    const svc = new SavedPoolsService(prisma);
    const provenance = provenanceManager.attachImportProvenance({ id: "pool" }, "batch", "v1", "wallet").provenance;
    const input = { walletAddress: "wallet", pool: {
      poolId: "pool", poolName: "Pool", status: "open", tvl: "100", asset: "XLM",
      participantCount: 1, expectedYield: "1%", prize: null, opensAt: null, locksAt: null, drawsAt: null,
    } };
    await svc.savePool({ ...input, provenance });
    const updated = await svc.savePool({ ...input, pool: { ...input.pool, tvl: "200" } });
    expect(updated.record.provenance).toMatchObject({ importBatchId: "batch", actor: "wallet" });
    expect(updated.record.provenance?.history).toHaveLength(2);
    expect(provenance.history).toHaveLength(1);
  });
});
