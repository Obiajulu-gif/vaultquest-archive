import { describe, it, expect, vi } from "vitest";
import { requireMaintainerApproval } from "../src/middleware/maintainerApproval.js";
import { AppError } from "../src/errors.js";
import type { FastifyRequest } from "fastify";

function mockRequest(approval?: any, principal?: any): FastifyRequest {
  const req: any = {
    headers: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    principal,
  };
  if (approval) {
    req.headers["x-maintainer-approval"] = Buffer.from(JSON.stringify(approval)).toString("base64");
  }
  return req;
}

describe("requireMaintainerApproval", () => {
  const guard = requireMaintainerApproval("admin.recovery.write");

  it("rejects when approval header is missing", async () => {
    const req = mockRequest();
    await expect(guard(req as FastifyRequest, {} as any, () => {})).rejects.toThrow("Missing maintainer approval metadata");
  });

  it("rejects when header is invalid json", async () => {
    const req: any = { headers: { "x-maintainer-approval": "not-base64-json" } };
    await expect(guard(req, {} as any, () => {})).rejects.toThrow("Invalid maintainer approval format");
  });

  it("rejects wrong-scope approval", async () => {
    const req = mockRequest({
      scope: "admin.limits.write",
      reason: "Updating limits",
      actor: "0x123",
      expiresAt: Date.now() + 10000,
    });
    await expect(guard(req, {} as any, () => {})).rejects.toThrow("Mismatched maintainer approval scope");
  });

  it("rejects expired approval", async () => {
    const req = mockRequest({
      scope: "admin.recovery.write",
      reason: "Fixing stuck tx",
      actor: "0x123",
      expiresAt: Date.now() - 10000,
    });
    await expect(guard(req, {} as any, () => {})).rejects.toThrow("Maintainer approval expired");
  });

  it("rejects missing reason", async () => {
    const req = mockRequest({
      scope: "admin.recovery.write",
      reason: "   ",
      actor: "0x123",
      expiresAt: Date.now() + 10000,
    });
    await expect(guard(req, {} as any, () => {})).rejects.toThrow("Missing or insufficient approval reason");
  });

  it("rejects actor mismatch when principal is authenticated", async () => {
    const req = mockRequest({
      scope: "admin.recovery.write",
      reason: "Fixing stuck tx",
      actor: "0x123",
      expiresAt: Date.now() + 10000,
    }, { subject: "0x999" });
    await expect(guard(req, {} as any, () => {})).rejects.toThrow("Mismatched maintainer approval actor");
  });

  it("allows valid approval", async () => {
    const req = mockRequest({
      scope: "admin.recovery.write",
      reason: "Fixing stuck tx",
      actor: "0x123",
      expiresAt: Date.now() + 10000,
    }, { subject: "0x123" });
    
    await expect(guard(req, {} as any, () => {})).resolves.toBeUndefined();
    expect(req.log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "maintainer_action_approved" }));
  });
});
