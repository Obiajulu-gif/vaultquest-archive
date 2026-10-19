/**
 * Synthetic journey monitor (#monitor)
 *
 * Exercises the single most valuable end-to-end workflow — wallet deposit
 * intent through indexer reconciliation to dashboard confirmation — on a
 * schedule or on demand, and reports per-step latency, failures, and which
 * dependency is to blame.
 *
 * The journey is executed through the real HTTP surface via `app.inject`,
 * so middleware (CSRF, rate limiting, validation, error envelope) is part of
 * what is verified — not just the service layer:
 *
 *   1. create_intent          POST /actions             (ledger write path)
 *   2. attach_tx              PATCH /actions/:id/submitted
 *   3. indexer_reconcile      POST /internal/reconcile  (indexer path)
 *   4. dashboard_confirmation GET /dashboard/summary    (read/rollup path)
 *
 * Cleanup (privacy scrub) runs in `finally` so the synthetic wallet never
 * keeps payload data around, even when the journey fails.
 *
 * The journey uses its own client IP bucket so monitor traffic can never
 * starve — or be starved by — user traffic hitting the rate limiter.
 * Operational notes: `docs/SYNTHETIC_MONITOR.md`.
 */

import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export type JourneyStepName =
  | "create_intent"
  | "attach_tx"
  | "indexer_reconcile"
  | "dashboard_confirmation"
  | "cleanup";

export type JourneyStepResult = {
  name: JourneyStepName;
  ok: boolean;
  skipped?: boolean;
  duration_ms: number;
  status_code?: number;
  blame?: string;
  detail?: string;
};

export type SyntheticRunStatus = "pass" | "degraded" | "fail";

export type SyntheticRunResult = {
  run_id: string;
  status: SyntheticRunStatus;
  wallet: string;
  tx_hash: string;
  started_at: string;
  finished_at: string;
  total_duration_ms: number;
  budget_ms: number;
  budget_exceeded: boolean;
  slowest_step: { name: JourneyStepName; duration_ms: number } | null;
  steps: JourneyStepResult[];
  /** Dependency blamed for the first failure (null when the run passed). */
  blame: string | null;
  summary: string;
};

export type JourneyStepResponse = {
  ok: boolean;
  status_code: number;
  error?: string;
  body?: unknown;
};

export interface JourneyClient {
  createIntent(input: {
    wallet: string;
    idempotencyKey: string;
    actionPayload: Record<string, unknown>;
  }): Promise<JourneyStepResponse & { actionId?: string }>;
  attachTx(actionId: string, txHash: string): Promise<JourneyStepResponse>;
  reconcile(txHash: string): Promise<JourneyStepResponse>;
  readDashboard(wallet: string, txHash: string): Promise<JourneyStepResponse>;
  scrub(wallet: string): Promise<JourneyStepResponse>;
}

export type SyntheticMonitorLogger = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
};

/**
 * Dependency attributed to each journey step when it fails without a more
 * specific classification (auth / rate-limit / transport).
 */
const STEP_DEPENDENCY: Record<JourneyStepName, string> = {
  create_intent: "ledger_api",
  attach_tx: "ledger_api",
  indexer_reconcile: "indexer",
  dashboard_confirmation: "ledger_read",
  cleanup: "ledger_api"
};

export function classifyBlame(
  step: JourneyStepName,
  response: JourneyStepResponse
): string {
  if (response.status_code === 429) return "rate_limit";
  if (response.status_code === 401) return "auth_config";
  if (response.status_code === 403 && /csrf/i.test(response.error ?? "")) {
    return "middleware_csrf";
  }
  if (response.status_code === 403) return "auth_config";
  if (response.error === "timeout" || response.error === "network_error") return "network";
  return STEP_DEPENDENCY[step];
}

/** Deterministic Stellar-shaped synthetic wallet, unique per run id. */
export function syntheticWalletFor(runId: string): string {
  const digest = createHash("sha256").update(`vaultquest-synthetic:${runId}`).digest("hex");
  const base32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let wallet = "G";
  for (const byte of Buffer.from(digest, "hex")) {
    wallet += base32[byte % base32.length];
    if (wallet.length === 56) break;
  }
  return wallet.padEnd(56, "A").slice(0, 56);
}

export type SyntheticMonitorOptions = {
  client: JourneyClient;
  latencyBudgetMs?: number;
  wallet?: string;
  runId?: string;
  logger?: SyntheticMonitorLogger;
  /** Monotonic clock in milliseconds (injectable for tests). */
  monotonicNow?: () => number;
  wallNow?: () => Date;
};

export class SyntheticMonitor {
  private readonly client: JourneyClient;
  private readonly latencyBudgetMs: number;
  private readonly runId: string;
  private readonly wallet: string;
  private readonly logger: SyntheticMonitorLogger;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => Date;

  constructor(options: SyntheticMonitorOptions) {
    this.client = options.client;
    this.latencyBudgetMs = options.latencyBudgetMs ?? 5_000;
    this.runId = options.runId ?? randomUUID();
    this.wallet = options.wallet ?? syntheticWalletFor(this.runId);
    this.logger = options.logger ?? {};
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => new Date());
  }

  async run(): Promise<SyntheticRunResult> {
    const startedAt = this.wallNow();
    const startedTick = this.monotonicNow();
    const txHash = `synthetic-tx-${this.runId}`;
    const idempotencyKey = randomUUID();

    const steps: JourneyStepResult[] = [];
    let blame: string | null = null;
    let failed = false;
    let actionId: string | undefined;

    const runStep = async <T extends JourneyStepResponse>(
      name: JourneyStepName,
      fn: () => Promise<T>
    ): Promise<T | null> => {
      if (failed) {
        steps.push({ name, ok: false, skipped: true, duration_ms: 0, detail: "skipped after earlier failure" });
        return null;
      }
      const tick = this.monotonicNow();
      try {
        const response = await fn();
        const result: JourneyStepResult = {
          name,
          ok: response.ok,
          duration_ms: Math.round(this.monotonicNow() - tick),
          status_code: response.status_code,
          ...(response.ok ? {} : { blame: classifyBlame(name, response), detail: response.error })
        };
        if (!response.ok) {
          failed = true;
          blame = result.blame ?? null;
        }
        steps.push(result);
        return response;
      } catch (err) {
        failed = true;
        blame = classifyBlame(name, { ok: false, status_code: 0, error: "network_error" });
        steps.push({
          name,
          ok: false,
          duration_ms: Math.round(this.monotonicNow() - tick),
          blame,
          detail: err instanceof Error ? err.message : String(err)
        });
        return null;
      }
    };

    try {
      const created = await runStep("create_intent", () =>
        this.client.createIntent({
          wallet: this.wallet,
          idempotencyKey,
          actionPayload: {
            vault_id: "synthetic-vault-1",
            amount: "1",
            token: "XLM",
            synthetic: true,
            run_id: this.runId
          }
        })
      );
      actionId = created?.actionId;

      await runStep("attach_tx", () =>
        actionId
          ? this.client.attachTx(actionId, txHash)
          : Promise.resolve({ ok: false, status_code: 0, error: "missing_action_id" })
      );
      await runStep("indexer_reconcile", () => this.client.reconcile(txHash));
      await runStep("dashboard_confirmation", () =>
        this.client.readDashboard(this.wallet, txHash)
      );
    } finally {
      // Cleanup must run even when the journey failed; a cleanup failure is
      // recorded but does not overwrite the original blame.
      const tick = this.monotonicNow();
      try {
        const response = await this.client.scrub(this.wallet);
        steps.push({
          name: "cleanup",
          ok: response.ok,
          duration_ms: Math.round(this.monotonicNow() - tick),
          status_code: response.status_code,
          ...(response.ok ? {} : { detail: response.error })
        });
      } catch (err) {
        steps.push({
          name: "cleanup",
          ok: false,
          duration_ms: Math.round(this.monotonicNow() - tick),
          detail: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const finishedAt = this.wallNow();
    const totalDurationMs = Math.round(this.monotonicNow() - startedTick);
    const budgetExceeded = totalDurationMs > this.latencyBudgetMs;

    const executed = steps.filter((step) => !step.skipped);
    const slowest = executed.reduce<JourneyStepResult | null>(
      (worst, step) => (worst === null || step.duration_ms > worst.duration_ms ? step : worst),
      null
    );

    let status: SyntheticRunStatus = "pass";
    if (failed) status = "fail";
    else if (budgetExceeded) status = "degraded";

    const failedStep = steps.find((step) => !step.ok && !step.skipped);
    const summary =
      status === "pass"
        ? `pass: journey completed in ${totalDurationMs}ms (budget ${this.latencyBudgetMs}ms)`
        : status === "degraded"
          ? `degraded: journey completed in ${totalDurationMs}ms, over budget ${this.latencyBudgetMs}ms`
          : `fail: ${failedStep?.name ?? "unknown"} failed (dependency=${blame ?? "unknown"}, ` +
            `status=${failedStep?.status_code ?? "n/a"}); total ${totalDurationMs}ms`;

    const result: SyntheticRunResult = {
      run_id: this.runId,
      status,
      wallet: this.wallet,
      tx_hash: txHash,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      total_duration_ms: totalDurationMs,
      budget_ms: this.latencyBudgetMs,
      budget_exceeded: budgetExceeded,
      slowest_step: slowest ? { name: slowest.name, duration_ms: slowest.duration_ms } : null,
      steps,
      blame,
      summary
    };

    if (status === "fail") {
      this.logger.error?.({ result }, "synthetic journey failed");
    } else {
      this.logger.info?.({ status, total_duration_ms: totalDurationMs }, "synthetic journey complete");
    }

    return result;
  }
}

/* ------------------------------------------------------------------------- */
/* HTTP journey client (app.inject based)                                    */
/* ------------------------------------------------------------------------- */

export type AppJourneyClientOptions = {
  internalSecret: string;
  /** Dedicated rate-limit bucket for monitor traffic. */
  clientIp?: string;
};

type InjectResponse = {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
};

export function createAppJourneyClient(
  app: FastifyInstance,
  options: AppJourneyClientOptions
): JourneyClient {
  const clientIp = options.clientIp ?? "10.255.255.10";

  const inject = async (input: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }): Promise<InjectResponse> => {
    const response = (await app.inject({
      method: input.method as never,
      url: input.url,
      headers: input.headers,
      payload: input.payload as never,
      remoteAddress: clientIp
    })) as unknown as InjectResponse;
    return response;
  };

  const csrfHandshake = async (): Promise<{ token: string; cookie: string }> => {
    const res = await inject({ method: "GET", url: "/health" });
    const token = String(res.headers["x-csrf-token"] ?? "");
    const setCookie = String(res.headers["set-cookie"] ?? "");
    return { token, cookie: setCookie.split(";")[0] ?? "" };
  };

  const describe = (res: InjectResponse): JourneyStepResponse => {
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = undefined;
    }
    const apiError =
      body && typeof body === "object" && "error" in body
        ? (body as { error?: { code?: string; message?: string } }).error
        : undefined;
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status_code: res.statusCode,
      ...(apiError ? { error: apiError.message ?? apiError.code } : {}),
      body
    };
  };

  return {
    async createIntent(input) {
      const { token, cookie } = await csrfHandshake();
      const res = await inject({
        method: "POST",
        url: "/actions",
        headers: {
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
          "x-csrf-token": token,
          cookie
        },
        payload: {
          wallet_address: input.wallet,
          action_type: "deposit",
          action_payload: input.actionPayload
        }
      });
      const described = describe(res);
      if (!described.ok) return described;
      const actionId = (described.body as { data?: { id?: string } })?.data?.id;
      return { ...described, actionId };
    },

    async attachTx(actionId, txHash) {
      const { token, cookie } = await csrfHandshake();
      const res = await inject({
        method: "PATCH",
        url: `/actions/${actionId}/submitted`,
        headers: { "content-type": "application/json", "x-csrf-token": token, cookie },
        payload: { tx_hash: txHash }
      });
      return describe(res);
    },

    async reconcile(txHash) {
      const res = await inject({
        method: "POST",
        url: "/internal/reconcile",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": options.internalSecret
        },
        payload: {
          tx_hash: txHash,
          soroban_event_id: `synthetic-evt-${txHash}`,
          event_payload: { type: "deposit", synthetic: true },
          status_hint: "confirmed"
        }
      });
      return describe(res);
    },

    async readDashboard(wallet, txHash) {
      const res = await inject({
        method: "GET",
        url: `/dashboard/summary?wallet=${encodeURIComponent(wallet)}`
      });
      const described = describe(res);
      if (!described.ok) return described;
      const body = described.body as {
        data?: { by_status?: { confirmed?: number }; pending_tx_hashes?: string[] };
      };
      const confirmed = body?.data?.by_status?.confirmed ?? 0;
      if (confirmed < 1) {
        return {
          ok: false,
          status_code: described.status_code,
          error: `dashboard does not reflect confirmation (tx ${txHash})`,
          body: described.body
        };
      }
      return described;
    },

    async scrub(wallet) {
      const { token, cookie } = await csrfHandshake();
      const res = await inject({
        method: "DELETE",
        url: `/actions?wallet=${encodeURIComponent(wallet)}`,
        headers: { "x-csrf-token": token, cookie }
      });
      return describe(res);
    }
  };
}

/* ------------------------------------------------------------------------- */
/* Runner used by routes, cron and the CLI                                   */
/* ------------------------------------------------------------------------- */

const runners = new WeakMap<FastifyInstance, SyntheticMonitorRunner>();

export class SyntheticMonitorRunner {
  private readonly monitor: SyntheticMonitor;
  private last: SyntheticRunResult | null = null;

  constructor(options: SyntheticMonitorOptions) {
    this.monitor = new SyntheticMonitor(options);
  }

  async run(): Promise<SyntheticRunResult> {
    this.last = await this.monitor.run();
    return this.last;
  }

  getLast(): SyntheticRunResult | null {
    return this.last;
  }
}

export function attachSyntheticMonitor(
  app: FastifyInstance,
  options: AppJourneyClientOptions & { latencyBudgetMs?: number; logger?: SyntheticMonitorLogger }
): SyntheticMonitorRunner {
  const runner = new SyntheticMonitorRunner({
    client: createAppJourneyClient(app, options),
    latencyBudgetMs: options.latencyBudgetMs,
    logger: options.logger
  });
  runners.set(app, runner);
  return runner;
}

export function getSyntheticMonitor(app: FastifyInstance): SyntheticMonitorRunner | null {
  return runners.get(app) ?? null;
}
