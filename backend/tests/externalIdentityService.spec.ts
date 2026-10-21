import { describe, expect, it, vi } from "vitest";
import { ExternalIdentityService } from "../src/services/externalIdentityService.js";

describe("external identity linking", () => {
  it("requires verification and prevents duplicate active links", async () => {
    const prisma = { externalIdentity: { findUnique: vi.fn().mockResolvedValue({ status: "linked" }), upsert: vi.fn() }, protocolAudit: { create: vi.fn() } } as any;
    const service = new ExternalIdentityService(prisma);
    await expect(service.link("user-1", { provider: "github", subject: "42" })).rejects.toThrow();
    await expect(service.link("user-1", { provider: "github", subject: "42", verifiedAt: new Date() })).rejects.toThrow("EXTERNAL_IDENTITY_ALREADY_LINKED");
  });

  it("unlinks only for the owning user", async () => {
    const prisma = { externalIdentity: { findUnique: vi.fn().mockResolvedValue({ id: "id-1", userId: "user-1", status: "linked" }), update: vi.fn().mockResolvedValue({ status: "unlinked" }) }, protocolAudit: { create: vi.fn() } } as any;
    const service = new ExternalIdentityService(prisma);
    await expect(service.unlink("user-1", "id-1", "user-2")).rejects.toThrow();
    await expect(service.unlink("user-1", "id-1", "user-1")).resolves.toEqual({ status: "unlinked" });
  });
});
