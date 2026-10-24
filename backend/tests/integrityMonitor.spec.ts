import { describe, it, expect, vi } from "vitest";
import { checkIntegrity } from "../src/scripts/integrity-monitor.js";

describe("Integrity Monitor", () => {
  it("detects no issues when data is clean", async () => {
    const mockPrisma = {
      pendingEvent: { findMany: vi.fn().mockResolvedValue([]) },
      actionLedger: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;
    
    const issues = await checkIntegrity(mockPrisma);
    expect(issues).toHaveLength(0);
  });

  it("detects orphaned pending events", async () => {
    const mockPrisma = {
      pendingEvent: { 
        findMany: vi.fn().mockResolvedValue([{
          txHash: "0x123",
          receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
          consumedAt: null
        }]) 
      },
      actionLedger: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;
    
    const issues = await checkIntegrity(mockPrisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("orphaned");
    expect(issues[0].recordId).toBe("0x123");
  });

  it("detects inconsistent actions", async () => {
    const mockPrisma = {
      pendingEvent: { findMany: vi.fn().mockResolvedValue([]) },
      actionLedger: { 
        findMany: vi.fn((args: any) => {
          if (args?.where?.status === "confirmed") {
            return Promise.resolve([{ id: "act-1", status: "confirmed", txHash: null }]);
          }
          return Promise.resolve([]);
        })
      },
    } as any;
    
    const issues = await checkIntegrity(mockPrisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("inconsistent");
    expect(issues[0].recordId).toBe("act-1");
  });

  it("detects stale actions", async () => {
    const mockPrisma = {
      pendingEvent: { findMany: vi.fn().mockResolvedValue([]) },
      actionLedger: { 
        findMany: vi.fn((args: any) => {
          if (args?.where?.status?.in?.includes("pending")) {
            return Promise.resolve([{ id: "act-2", status: "pending", createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) }]);
          }
          return Promise.resolve([]);
        })
      },
    } as any;
    
    const issues = await checkIntegrity(mockPrisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("stale");
    expect(issues[0].recordId).toBe("act-2");
  });

  it("detects duplicate actions", async () => {
    const now = new Date();
    const mockPrisma = {
      pendingEvent: { findMany: vi.fn().mockResolvedValue([]) },
      actionLedger: { 
        findMany: vi.fn((args: any) => {
          if (args?.orderBy) {
            return Promise.resolve([
              { id: "act-dup-1", walletAddress: "G123", actionType: "deposit", createdAt: now },
              { id: "act-dup-2", walletAddress: "G123", actionType: "deposit", createdAt: new Date(now.getTime() - 10000) } // 10 seconds diff
            ]);
          }
          return Promise.resolve([]);
        })
      },
    } as any;
    
    const issues = await checkIntegrity(mockPrisma);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("duplicate");
    expect(issues[0].recordId).toBe("act-dup-2"); // the earlier one
  });
});
