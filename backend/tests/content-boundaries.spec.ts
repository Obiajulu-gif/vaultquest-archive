import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { randomUUID } from "node:crypto";
import {
  buildWebhookEnvelope,
  escapeCsvCell,
  looksLikeSpreadsheetFormula,
  projectPublicFields,
  sanitizeDownloadFilename,
  sanitizeRenderedText,
  signWebhookPayload,
  validateWebhookTarget,
  verifyWebhookSignature
} from "../src/services/contentBoundary.js";
import { WebhookDeliveryService } from "../src/services/webhookDelivery.js";

describe("content boundaries: CSV export escaping", () => {
  it("neutralises spreadsheet formula triggers", () => {
    for (const payload of ["=1+1", "+CMD|' /C calc'!A0", "-2+3", "@SUM(A1)", "\t=HYPERLINK(1)", "\r=1"]) {
      const cell = escapeCsvCell(payload);
      expect(cell.startsWith('"\'')).toBe(true);
    }
  });

  it("neutralises formulas hidden behind leading whitespace", () => {
    const cell = escapeCsvCell("   =1+1");
    expect(cell).toBe(`"'   =1+1"`);
  });

  it("doubles embedded quotes and always quotes cells", () => {
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("plain")).toBe('"plain"');
  });

  it("flattens CRLF / newline / control characters so rows cannot be split", () => {
    const cell = escapeCsvCell("line1\nline2\r\nline3\u0000\u0007");
    expect(cell).not.toContain("\n");
    expect(cell).not.toContain("\r");
    expect(cell).not.toContain("\u0000");
    expect(cell).toBe('"line1 line2  line3"');
  });

  it("handles null/undefined as empty cells and truncates oversized values", () => {
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
    const cell = escapeCsvCell("a".repeat(40_000));
    expect(cell.length).toBeLessThan(40_000);
    expect(cell.endsWith('[truncated]"')).toBe(true);
  });

  it("exposes the formula detector", () => {
    expect(looksLikeSpreadsheetFormula("=1+1")).toBe(true);
    expect(looksLikeSpreadsheetFormula("  =1+1")).toBe(true);
    expect(looksLikeSpreadsheetFormula("vault-1")).toBe(false);
    expect(looksLikeSpreadsheetFormula("GABC123")).toBe(false);
  });
});

describe("content boundaries: download filenames", () => {
  it("strips path traversal and separators", () => {
    expect(sanitizeDownloadFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadFilename("..\\..\\windows\\evil.csv")).toBe("evil.csv");
    expect(sanitizeDownloadFilename("normal-file_1.csv")).toBe("normal-file_1.csv");
  });

  it("strips quotes, CRLF and header-injection characters", () => {
    const name = sanitizeDownloadFilename('report".csv\r\nX-Injected: 1');
    expect(name).not.toContain('"');
    expect(name).not.toContain("\r");
    expect(name).not.toContain("\n");
    expect(name).not.toContain(":");
  });

  it("never returns an empty or over-long filename", () => {
    expect(sanitizeDownloadFilename("")).toBe("download");
    expect(sanitizeDownloadFilename("...")).toBe("download");
    const long = sanitizeDownloadFilename("x".repeat(500) + ".csv");
    expect(long.length).toBeLessThanOrEqual(100);
  });
});

describe("content boundaries: rendered text", () => {
  it("escapes HTML so untrusted content cannot execute", () => {
    const rendered = sanitizeRenderedText('<script>alert("x")</script>');
    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).toContain("&quot;");
  });

  it("strips control characters and collapses whitespace", () => {
    const rendered = sanitizeRenderedText("a\u0000b\u0007c\n\n   d");
    expect(rendered).toBe("a b c d");
  });

  it("caps length and can skip HTML escaping for plain-text contexts", () => {
    const truncated = sanitizeRenderedText("x".repeat(50), { maxLength: 10 });
    expect(truncated).toBe(`${"x".repeat(10)}...`);
    const raw = sanitizeRenderedText("<b>hi</b>", { htmlEscape: false });
    expect(raw).toBe("<b>hi</b>");
  });
});

describe("content boundaries: private field projection", () => {
  it("removes private keys at any depth and in any casing", () => {
    const projected = projectPublicFields({
      vault_id: "v1",
      amount: "100",
      private_key: "S...",
      PrivateKey: "S...",
      nested: {
        seed_phrase: "one two three",
        mnemonic: "x",
        authorization: "Bearer abc",
        keep: 1
      },
      list: [{ secret: "s", token: "USDC" }]
    }) as Record<string, unknown>;

    expect(projected).toEqual({
      vault_id: "v1",
      amount: "100",
      nested: { keep: 1 },
      list: [{ token: "USDC" }]
    });
    expect(JSON.stringify(projected)).not.toContain("S...");
    expect(JSON.stringify(projected)).not.toContain("one two three");
  });

  it("drops prototype-pollution keys parsed from JSON", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "safe": 2}');
    const projected = projectPublicFields(hostile) as Record<string, unknown>;
    expect(projected).toEqual({ safe: 2 });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("survives cycles, deep nesting and primitives", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic["self"] = cyclic;
    const projected = projectPublicFields(cyclic) as Record<string, unknown>;
    expect(projected["name"]).toBe("x");
    expect(projected["self"]).toBe("[circular]");

    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    const projectedDeep = projectPublicFields(deep) as Record<string, unknown>;
    expect(JSON.stringify(projectedDeep)).toContain("[truncated]");

    expect(projectPublicFields("string")).toBe("string");
    expect(projectPublicFields(42)).toBe(42);
    expect(projectPublicFields(null)).toBeNull();
  });
});

describe("content boundaries: webhook target allow-list", () => {
  const policy = {
    allowedHosts: ["hooks.vaultquest.io", "*.vaultquest.io"],
    allowedSchemes: ["https:"] as const,
    allowedPorts: [443] as const
  };

  it("allows exact and wildcard-subdomain hosts on HTTPS/443", () => {
    expect(validateWebhookTarget("https://hooks.vaultquest.io/events", policy)).toMatchObject({
      allowed: true
    });
    expect(validateWebhookTarget("https://a.b.vaultquest.io/events", policy)).toMatchObject({
      allowed: true
    });
  });

  it("denies hosts that are not allow-listed, including lookalikes", () => {
    for (const target of [
      "https://evil.com/hook",
      "https://hooks.vaultquest.io.evil.com/hook",
      "https://hooks.vaultquest.io./hook",
      "https://vaultquest.io.evil.com/hook"
    ]) {
      const decision = validateWebhookTarget(target, policy);
      expect(decision.allowed).toBe(false);
    }
  });

  it("denies an empty allow-list (fail closed)", () => {
    const decision = validateWebhookTarget("https://hooks.vaultquest.io/hook", {
      allowedHosts: []
    });
    expect(decision).toMatchObject({ allowed: false, reason: "allowlist_empty" });
  });

  it("denies plain HTTP, credentials, and non-allow-listed ports", () => {
    expect(
      validateWebhookTarget("http://hooks.vaultquest.io/hook", policy)
    ).toMatchObject({ allowed: false, reason: "scheme_not_allowed" });
    expect(
      validateWebhookTarget("https://user:pass@hooks.vaultquest.io/hook", policy)
    ).toMatchObject({ allowed: false, reason: "credentials_not_allowed" });
    expect(
      validateWebhookTarget("https://hooks.vaultquest.io:8443/hook", policy)
    ).toMatchObject({ allowed: false, reason: "port_not_allowed" });
  });

  it("denies IP literals even when they appear in the allow-list", () => {
    const ssrfPolicy = { allowedHosts: ["169.254.169.254", "127.0.0.1", "[::1]", "10.0.0.1"] };
    expect(validateWebhookTarget("https://169.254.169.254/latest/meta-data", ssrfPolicy)).toMatchObject(
      { allowed: false, reason: "ip_literal_not_allowed" }
    );
    expect(validateWebhookTarget("https://127.0.0.1:443/hook", ssrfPolicy)).toMatchObject({
      allowed: false,
      reason: "ip_literal_not_allowed"
    });
    expect(validateWebhookTarget("https://[::1]:443/hook", ssrfPolicy)).toMatchObject({
      allowed: false,
      reason: "ip_literal_not_allowed"
    });
  });

  it("rejects malformed URLs", () => {
    expect(validateWebhookTarget("not a url", policy)).toMatchObject({
      allowed: false,
      reason: "invalid_url"
    });
  });
});

describe("content boundaries: webhook envelopes and signatures", () => {
  it("rejects event types outside the allow-list", () => {
    expect(() =>
      buildWebhookEnvelope({
        eventType: "action.pwned",
        data: {},
        deliveryId: randomUUID()
      })
    ).toThrow(/not allowed/);
  });

  it("projects private fields out of webhook payloads", () => {
    const envelope = buildWebhookEnvelope({
      eventType: "action.confirmed",
      deliveryId: randomUUID(),
      data: { action_id: "a1", private_key: "S", nested: { secret: "x", keep: true } }
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("private_key");
    expect(serialized).not.toContain("\"S\"");
    expect(envelope.data).toEqual({ action_id: "a1", nested: { keep: true } });
  });

  it("signs and verifies payloads, and rejects tampering", () => {
    const secret = "whsec_test";
    const body = JSON.stringify({ hello: "world" });
    const signature = signWebhookPayload(secret, body);

    expect(signature.startsWith("sha256=")).toBe(true);
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, `${body}x`, signature)).toBe(false);
    expect(verifyWebhookSignature("other", body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "sha256=short")).toBe(false);
  });
});

describe("content boundaries: export endpoints (integration)", () => {
  const internalSecret = "test-internal-secret-123456";

  function mockPrisma(row: Record<string, unknown>) {
    return {
      actionLedger: {
        findMany: vi.fn().mockResolvedValue([row]),
        findUnique: vi.fn().mockResolvedValue(row)
      },
      savedPool: { findMany: vi.fn().mockResolvedValue([]) },
      indexerCheckpoint: { findUnique: vi.fn().mockResolvedValue(null) }
    } as unknown as PrismaClient;
  }

  const hostileRow = {
    id: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: "00000000-0000-4000-8000-000000000002",
    walletAddress: "GWALLET",
    actionType: "deposit",
    actionPayload: {
      vault_id: '=HYPERLINK("http://evil.example","click")',
      amount: "+100",
      token: "USDC",
      private_key: "S-SECRET",
      nested: { mnemonic: "one two", public_note: "ok" }
    },
    status: "confirmed",
    txHash: "tx1",
    sorobanEventId: null,
    correlationId: "00000000-0000-4000-8000-000000000003",
    errorCode: null,
    errorDetail: null,
    retryCount: 0,
    redactedAt: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    submittedAt: new Date("2026-10-01T00:01:00Z"),
    confirmedAt: new Date("2026-10-01T00:02:00Z")
  };

  it("CSV downloads neutralise formula payloads in every column", async () => {
    const app = buildApp({ prisma: mockPrisma(hostileRow), internalSecret });
    const res = await app.inject({
      method: "GET",
      url: "/actions/export?wallet=GWALLET&format=csv"
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;
    // The hostile vault_id is present but neutralised, never a live formula.
    expect(body).toContain(`"'=HYPERLINK`);
    expect(body).not.toContain('"=HYPERLINK');
    expect(body).toContain(`"'+100"`);
    await app.close();
  });

  it("download filenames cannot inject headers or traverse paths", async () => {
    const app = buildApp({ prisma: mockPrisma(hostileRow), internalSecret });
    const res = await app.inject({
      method: "GET",
      url: `/actions/export?wallet=${encodeURIComponent("..%2F..%2F etc\"")}&format=csv`
    });

    const disposition = String(res.headers["content-disposition"]);
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    expect(disposition).not.toContain("..");
    expect(disposition).not.toContain('\\"');
    await app.close();
  });

  it("JSON exports never leak private payload fields", async () => {
    const app = buildApp({ prisma: mockPrisma(hostileRow), internalSecret });
    const res = await app.inject({
      method: "GET",
      url: "/actions/export?wallet=GWALLET&format=json"
    });

    expect(res.statusCode).toBe(200);
    const payload = res.json().data[0].action_payload;
    expect(payload).toEqual({
      vault_id: '=HYPERLINK("http://evil.example","click")',
      amount: "+100",
      token: "USDC",
      nested: { public_note: "ok" }
    });
    expect(res.body).not.toContain("S-SECRET");
    expect(res.body).not.toContain("mnemonic");
    await app.close();
  });

  it("single-action reads never leak private payload fields", async () => {
    const app = buildApp({ prisma: mockPrisma(hostileRow), internalSecret });
    const res = await app.inject({
      method: "GET",
      url: `/actions/${hostileRow.id}`
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("S-SECRET");
    expect(res.json().data.action_payload.nested).toEqual({ public_note: "ok" });
    await app.close();
  });
});

describe("content boundaries: webhook delivery", () => {
  async function startServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<{ url: string; port: number; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://localhost:${port}/hook`,
      port,
      close: () => new Promise((resolve) => server.close(() => resolve()))
    };
  }

  function localPolicy(port: number) {
    return {
      allowedHosts: ["localhost"] as const,
      allowedSchemes: ["http:"] as const,
      allowedPorts: [port] as const
    };
  }

  it("delivers a signed, projected envelope to an allow-listed receiver", async () => {
    let received: { headers: http.IncomingHttpHeaders; body: string } | null = null;
    const server = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received = { headers: req.headers, body };
        res.statusCode = 204;
        res.end();
      });
    });

    try {
      const secret = "whsec_test";
      const delivery = new WebhookDeliveryService({
        secret,
        policy: localPolicy(server.port),
        maxAttempts: 1
      });

      const outcome = await delivery.deliver(server.url, {
        eventType: "action.confirmed",
        data: { action_id: "a1", private_key: "S", nested: { seed_phrase: "x", ok: 1 } }
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.status_code).toBe(204);
      expect(outcome.attempts).toBe(1);

      expect(received).not.toBeNull();
      const request = received as unknown as { headers: http.IncomingHttpHeaders; body: string };
      expect(verifyWebhookSignature(secret, request.body, String(request.headers["x-vaultquest-signature"]))).toBe(true);
      expect(String(request.headers["x-vaultquest-event"])).toBe("action.confirmed");

      const envelope = JSON.parse(request.body);
      expect(envelope.data).toEqual({ action_id: "a1", nested: { ok: 1 } });
      expect(request.body).not.toContain("private_key");
      expect(request.body).not.toContain("seed_phrase");
    } finally {
      await server.close();
    }
  });

  it("blocks non-allow-listed targets before any network call", async () => {
    const fetchImpl = vi.fn();
    const delivery = new WebhookDeliveryService({
      secret: "s",
      policy: { allowedHosts: ["hooks.example.com"] },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const outcome = await delivery.deliver("http://127.0.0.1:8080/hook", {
      eventType: "action.confirmed",
      data: {}
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("target_rejected");
    expect(outcome.attempts).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never follows redirects from an allow-listed host", async () => {
    const server = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://169.254.169.254/latest/meta-data");
      res.end();
    });

    try {
      const delivery = new WebhookDeliveryService({
        secret: "s",
        policy: localPolicy(server.port),
        maxAttempts: 2,
        backoffMs: 1
      });
      const outcome = await delivery.deliver(server.url, {
        eventType: "action.confirmed",
        data: {}
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBe("redirect_rejected");
      expect(outcome.attempts).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("retries transient 5xx failures and succeeds", async () => {
    let calls = 0;
    const server = await startServer((_req, res) => {
      calls += 1;
      res.statusCode = calls === 1 ? 500 : 200;
      res.end();
    });

    try {
      const delivery = new WebhookDeliveryService({
        secret: "s",
        policy: localPolicy(server.port),
        maxAttempts: 3,
        backoffMs: 1
      });
      const outcome = await delivery.deliver(server.url, {
        eventType: "action.confirmed",
        data: {}
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.attempts).toBe(2);
      expect(calls).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("times out on slow subscribers and reports a network blame", async () => {
    const server = await startServer((_req, res) => {
      const timer = setTimeout(() => {
        res.statusCode = 200;
        res.end();
      }, 500);
      res.on("close", () => clearTimeout(timer));
    });

    try {
      const delivery = new WebhookDeliveryService({
        secret: "s",
        policy: localPolicy(server.port),
        timeoutMs: 50,
        maxAttempts: 1
      });
      const outcome = await delivery.deliver(server.url, {
        eventType: "action.confirmed",
        data: {}
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBe("timeout");
    } finally {
      await server.close();
    }
  });
});
