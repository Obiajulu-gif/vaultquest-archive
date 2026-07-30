import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmailService } from "../src/services/emailService";

vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: vi.fn(),
    send: vi.fn().mockResolvedValue([])
  }
}));

describe("EmailService", () => {
  let svc: EmailService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new EmailService({
      apiKey: "SG.test-api-key-12345678901234567890",
      fromEmail: "test@vaultquest.io"
    });
  });

  it("sends welcome email successfully", async () => {
    const result = await svc.sendWelcomeEmail("user@example.com", "GABC123");
    expect(result).toBe(true);
  });

  it("sends password reset email successfully", async () => {
    const result = await svc.sendPasswordResetEmail("user@example.com", "reset-token-123");
    expect(result).toBe(true);
  });

  it("returns false when not configured", async () => {
    const unconfigured = new EmailService({});
    const result = await unconfigured.sendWelcomeEmail("user@example.com", "GABC123");
    expect(result).toBe(false);
  });

  it("returns false for unknown template", async () => {
    const result = await svc.sendEmail({
      to: "user@example.com",
      template: "unknown" as any,
      data: {}
    });
    expect(result).toBe(false);
  });
});
