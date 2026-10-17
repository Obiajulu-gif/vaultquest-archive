import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyPluginAsync } from "fastify";
import { register } from "prom-client";
import prometheusPlugin from "../src/middleware/prometheusPlugin.js";
import { getPrometheusMetrics } from "../src/services/prometheusMetrics.js";
import { configureTelemetry, recordOperation } from "../src/services/telemetry.js";
import {
  INVALID_LABEL,
  LabelCardinalityGuard,
  LogSampler,
  OVERFLOW_LABEL,
  REDACTED_LABEL,
  sanitizeLabel,
} from "../src/services/telemetryGuard.js";

/**
 * High-cardinality telemetry protection (#925): unsafe label values are
 * rejected or redacted, distinct values are capped, and noisy failure logs are
 * sampled, while metrics and subscribers keep seeing every event.
 */
const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const TX = "a".repeat(64);

async function labelValues(metricName: string, label: string): Promise<string[]> {
  const metric = (await register.getMetricsAsJSON()).find((m) => m.name === metricName) as any;
  return [...new Set<string>((metric?.values ?? []).map((v: any) => v.labels?.[label]).filter(Boolean))];
}

describe("sanitizeLabel", () => {
  it("passes route patterns, operation names and error codes through", () => {
    for (const ok of ["/api/actions/:id", "action.create", "FORBIDDEN", "worker_job-1", "/files/*"]) {
      expect(sanitizeLabel(ok)).toBe(ok);
    }
  });

  it("redacts wallet addresses and transaction hashes instead of echoing them", () => {
    expect(sanitizeLabel(`/wallets/${WALLET}`)).toBe(REDACTED_LABEL);
    expect(sanitizeLabel(`/tx/${TX}`)).toBe(REDACTED_LABEL);
  });

  it("rejects empty values and characters outside the safe set", () => {
    for (const bad of ["", undefined, null, "a b", "x\ny", 'q="1"', "é", "<script>"]) {
      expect(sanitizeLabel(bad)).toBe(INVALID_LABEL);
    }
  });

  it("caps length", () => {
    expect(sanitizeLabel("a".repeat(500))).toHaveLength(64);
    expect(sanitizeLabel("abcdef", 3)).toBe("abc");
  });
});

describe("LabelCardinalityGuard", () => {
  it("admits distinct values up to the budget then collapses the rest", () => {
    const guard = new LabelCardinalityGuard(3);
    expect(["a", "b", "c", "d", "e"].map((v) => guard.resolve("m", "l", v))).toEqual([
      "a", "b", "c", OVERFLOW_LABEL, OVERFLOW_LABEL,
    ]);
    // An admitted value keeps working after the budget is spent.
    expect(guard.resolve("m", "l", "a")).toBe("a");
    expect(guard.report()).toEqual([{ metric: "m", label: "l", distinct: 3, overflowed: 2, rejected: 0 }]);
  });

  it("tracks budgets per metric and label independently", () => {
    const guard = new LabelCardinalityGuard(1);
    expect(guard.resolve("m", "x", "a")).toBe("a");
    expect(guard.resolve("m", "y", "b")).toBe("b");
    expect(guard.resolve("n", "x", "c")).toBe("c");
  });

  it("counts rejected values without spending the budget", () => {
    const guard = new LabelCardinalityGuard(1);
    expect(guard.resolve("m", "l", `/w/${WALLET}`)).toBe(REDACTED_LABEL);
    expect(guard.resolve("m", "l", "bad value")).toBe(INVALID_LABEL);
    expect(guard.resolve("m", "l", "ok")).toBe("ok");
    expect(guard.report()[0]).toMatchObject({ distinct: 1, rejected: 2, overflowed: 0 });
  });
});

describe("LogSampler", () => {
  it("lets the first events per window through and counts the rest", () => {
    let now = 0;
    const sampler = new LogSampler({ maxPerWindow: 2, windowMs: 1000, now: () => now });
    expect([1, 2, 3, 4, 5].map(() => sampler.shouldLog("k"))).toEqual([true, true, false, false, false]);
    expect(sampler.takeSuppressed("k")).toBe(3);
    expect(sampler.takeSuppressed("k")).toBe(0);
  });

  it("starts a fresh budget each window and carries unreported drops forward", () => {
    let now = 0;
    const sampler = new LogSampler({ maxPerWindow: 1, windowMs: 1000, now: () => now });
    sampler.shouldLog("k");
    sampler.shouldLog("k");
    sampler.shouldLog("k");
    now = 1000;
    expect(sampler.shouldLog("k")).toBe(true);
    expect(sampler.takeSuppressed("k")).toBe(2);
  });

  it("samples keys independently", () => {
    const sampler = new LogSampler({ maxPerWindow: 1, now: () => 0 });
    expect(sampler.shouldLog("a")).toBe(true);
    expect(sampler.shouldLog("a")).toBe(false);
    expect(sampler.shouldLog("b")).toBe(true);
  });

  it("bounds its own memory: keys past the limit share one bucket", () => {
    const sampler = new LogSampler({ maxPerWindow: 1, maxKeys: 2, now: () => 0 });
    expect(sampler.shouldLog("a")).toBe(true);
    expect(sampler.shouldLog("b")).toBe(true);
    expect(sampler.shouldLog("c")).toBe(true);
    expect(sampler.shouldLog("d")).toBe(false);
    expect(sampler.takeSuppressed("e")).toBe(1);
  });
});

// Runs before the abuse tests below: the guard is a process-wide singleton and
// its route budget would otherwise already be spent.
describe("HTTP metrics route label", () => {
  it("uses the matched route pattern, not the raw URL", async () => {
    // Register the plugin on the root instance so its hooks cover the routes below.
    const unencapsulated: FastifyPluginAsync = async (app) => {
      await prometheusPlugin(app, {});
    };
    (unencapsulated as any)[Symbol.for("skip-override")] = true;

    const app = Fastify();
    app.register(unencapsulated);
    app.register(async (instance) => {
      instance.get("/items/:id", async () => ({ ok: true }));
    });
    await app.ready();
    try {
      for (const id of ["1", "2", "3", WALLET]) {
        await app.inject({ method: "GET", url: `/items/${id}?token=secret` });
      }
      await app.inject({ method: "GET", url: "/no/such/path/12345" });
    } finally {
      await app.close();
    }

    const routes = await labelValues("http_requests_total", "route");
    expect(routes).toContain("/items/:id");
    expect(routes.some((r) => /\/items\/\d|secret|12345|\/no\/such/.test(r) || r.includes(WALLET))).toBe(false);
  });
});

describe("Prometheus label protection", () => {
  it("caps distinct HTTP route labels and keeps sensitive values out of them", async () => {
    const metrics = getPrometheusMetrics();
    for (let i = 0; i < 250; i += 1) metrics.recordHttpRequest("GET", `/abuse/${i}`, 200, 0.01);
    metrics.recordHttpRequest("GET", `/wallets/${WALLET}`, 200, 0.01);
    metrics.recordHttpRequest("GET", `/tx/${TX}`, 200, 0.01);

    const routes = await labelValues("http_requests_total", "route");
    expect(routes.filter((r) => r.startsWith("/abuse/")).length).toBeLessThanOrEqual(100);
    expect(routes).toContain(OVERFLOW_LABEL);
    expect(routes.some((r) => r.includes(WALLET) || r.includes(TX))).toBe(false);
    const entry = metrics.getLabelCardinalityReport().find((e) => e.metric === "http" && e.label === "route");
    expect(entry?.distinct).toBeLessThanOrEqual(100);
    expect(entry?.overflowed).toBeGreaterThan(0);
  });

  it("collapses unknown HTTP methods", async () => {
    getPrometheusMetrics().recordHttpRequest("BREW", "/pot", 418, 0.01);
    expect(await labelValues("http_requests_total", "method")).not.toContain("BREW");
    expect(await labelValues("http_requests_total", "method")).toContain("OTHER");
  });

  it("bounds operation error codes", async () => {
    const metrics = getPrometheusMetrics();
    for (let i = 0; i < 250; i += 1) metrics.recordOperation("worker.job", "worker", "failure", 0.01, `CODE_${i}`);
    const codes = await labelValues("vaultquest_operation_failures_total", "error_code");
    expect(codes.length).toBeLessThanOrEqual(101);
    expect(codes).toContain(OVERFLOW_LABEL);
  });
});

describe("failure log sampling", () => {
  afterEach(() => configureTelemetry({}));

  it("samples repeated failure logs but still records every metric and event", () => {
    const logger = { info: vi.fn(), warn: vi.fn() } as any;
    configureTelemetry({ logger });
    for (let i = 0; i < 25; i += 1) {
      recordOperation({
        event: "operation", operation: "action.reconcile_event", actor_type: "system", result: "failure",
        latency_ms: 1, correlation_id: null, error_code: "SAMPLED_FLOOD",
      });
    }
    expect(logger.warn).toHaveBeenCalledTimes(10);
  });

  it("never samples success logs", () => {
    const logger = { info: vi.fn(), warn: vi.fn() } as any;
    configureTelemetry({ logger });
    for (let i = 0; i < 25; i += 1) {
      recordOperation({ event: "operation", operation: "action.create", actor_type: "user", result: "success", latency_ms: 1, correlation_id: null });
    }
    expect(logger.info).toHaveBeenCalledTimes(25);
  });
});
