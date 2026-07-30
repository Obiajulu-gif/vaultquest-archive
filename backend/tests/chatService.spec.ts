import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatService } from "../src/services/chatService";

vi.mock("socket.io", () => {
  const mockIo = {
    on: vi.fn(),
    use: vi.fn(),
    to: vi.fn().mockReturnThis(),
    emit: vi.fn(),
    close: vi.fn()
  };
  return {
    Server: vi.fn().mockImplementation(() => mockIo)
  };
});

vi.mock("node:http", () => ({
  Server: vi.fn()
}));

describe("ChatService", () => {
  let svc: ChatService;
  let mockPrisma: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = {
      walletSession: {
        findUnique: vi.fn()
      }
    };
    svc = new ChatService({} as any, { prisma: mockPrisma });
  });

  it("creates ChatService instance", () => {
    expect(svc).toBeDefined();
  });

  it("returns the io server instance", () => {
    const io = svc.getIo();
    expect(io).toBeDefined();
  });

  it("closes the server", async () => {
    await svc.close();
    const io = svc.getIo();
    expect(io.close).toHaveBeenCalled();
  });
});
