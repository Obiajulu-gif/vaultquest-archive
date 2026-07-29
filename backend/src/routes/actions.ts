import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import type { LedgerService } from "../services/ledger.js";
import {
  createActionBody,
  attachTxBody,
  cancelBody,
  listQuery,
  dashboardQuery,
  portfolioQuery,
  exportQuery,
  idempotencyKeySchema,
  actionHistoryQuery
} from "../schemas/actions.js";
import { AppError } from "../errors.js";
import { ok, page } from "../responses.js";

function serialize(row: Awaited<ReturnType<LedgerService["getAction"]>>) {
  if (!row) return null;
  return {
    id: row.id,
    idempotency_key: row.idempotencyKey,
    wallet_address: row.walletAddress,
    action_type: row.actionType,
    action_payload: row.actionPayload,
    status: row.status,
    tx_hash: row.txHash,
    soroban_event_id: row.sorobanEventId,
    correlation_id: row.correlationId,
    error_code: row.errorCode,
    error_detail: row.errorDetail,
    retry_count: row.retryCount,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    submitted_at: row.submittedAt,
    confirmed_at: row.confirmedAt,
    redacted_at: row.redactedAt
  };
}

export const actionsRoutes = (
  svc: LedgerService,
  apiKeyGuard: preHandlerHookHandler
): FastifyPluginAsync =>
  async (app) => {
    app.post("/actions", async (req, reply) => {
      const keyHeader = req.headers["idempotency-key"];
      const keyRaw = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
      const keyParsed = idempotencyKeySchema.safeParse(keyRaw);
      if (!keyParsed.success) {
        return reply.status(400).send({
          error: {
            code: "INVALID_PAYLOAD",
            message: "Idempotency-Key header must be a UUID",
            issues: keyParsed.error.issues
          }
        });
      }
      const body = createActionBody.parse(req.body);

      const existing = await svc.findByIdempotencyKey(keyParsed.data);
      const result = await svc.createAction({
        idempotencyKey: keyParsed.data,
        walletAddress: body.wallet_address,
        actionType: body.action_type,
        actionPayload: body.action_payload
      });
      reply.status(existing ? 200 : 201);
      return ok(serialize(result));
    });

    app.patch<{ Params: { id: string } }>("/actions/:id/submitted", async (req) => {
      const body = attachTxBody.parse(req.body);
      const workerId = (req.headers["x-worker-id"] as string | undefined) ?? "anonymous";
      const result = await svc.attachTxHash(req.params.id, body.tx_hash, { workerId });
      return ok(serialize(result));
    });

    app.post<{ Params: { id: string } }>("/actions/:id/cancel", async (req) => {
      const body = cancelBody.parse(req.body);
      const result = await svc.cancelAction(req.params.id, body.error_code, body.error_detail);
      return ok(serialize(result));
    });

    app.get<{ Params: { id: string } }>("/actions/:id", async (req) => {
      const row = await svc.getAction(req.params.id);
      if (!row) throw AppError.notFound(`action ${req.params.id} not found`);
      return ok(serialize(row));
    });

    app.get("/actions", async (req) => {
      const q = listQuery.parse(req.query);
      const result = await svc.listActions({
        walletAddress: q.wallet,
        status: q.status,
        cursor: q.cursor,
        limit: q.limit
      });
      return page(result.items.map(serialize), { nextCursor: result.nextCursor, limit: q.limit });
    });

    app.delete("/actions", async (req) => {
      const wallet = (req.query as Record<string, string | undefined>).wallet;
      if (!wallet || wallet.length === 0) {
        return ok({ scrubbed: 0 });
      }
      return ok(await svc.scrubWallet(wallet));
    });

    /**
     * GET /dashboard/summary?wallet=...&stale_after_ms=...
     *
     * Frontend dashboard rollup (#14): per-status counts, in-flight tx hashes
     * the wallet should keep polling, freshness flag, and the latest
     * activity / confirmation timestamps. Lets the dashboard render without
     * issuing several /actions queries and ad-hoc client-side joins.
     */
    app.get("/dashboard/summary", async (req) => {
      const q = dashboardQuery.parse(req.query);
      const summary = await svc.getDashboardSummary(q.wallet, {
        staleAfterMs: q.stale_after_ms
      });
      return ok({
        wallet_address: summary.walletAddress,
        total_actions: summary.totalActions,
        by_status: summary.byStatus,
        pending_tx_hashes: summary.pendingTxHashes,
        is_stale: summary.isStale,
        latest_activity_at: summary.latestActivityAt,
        latest_confirmed_at: summary.latestConfirmedAt
      });
    });

    /**
     * GET /portfolio/summary?wallet=...
     *
     * Wallet portfolio summary endpoint returns deposits, positions, and recent activity.
     */
    app.get("/portfolio/summary", async (req) => {
      const q = portfolioQuery.parse(req.query);
      const summary = await svc.getPortfolioSummary(q.wallet);
      return ok(summary);
    });

    /**
     * GET /actions/export?wallet=...&format=json|csv&from=...&to=...&limit=...
     *
     * Activity export endpoint (#91): returns the authenticated wallet's full
     * action history as JSON or CSV. Excludes scrubbed rows (redactedAt != null).
     * Wallet-scoping relies on the `wallet` query param — there is no session
     * auth on this API; the caller is responsible for passing their own address.
     *
     * CSV sets Content-Disposition so browsers trigger a file download.
     */
    app.get("/actions/export", async (req, reply) => {
      const q = exportQuery.parse(req.query);
      const rows = await svc.exportActivity({
        walletAddress: q.wallet,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        limit: q.limit
      });

      if (q.format === "csv") {
        const CSV_HEADERS = [
          "id", "date", "action_type", "pool_id", "amount", "token",
          "status", "tx_hash", "error_code", "submitted_at", "confirmed_at"
        ];

        const csvRows = rows.map((r) => {
          const payload = (r.actionPayload as Record<string, unknown> | null) ?? {};
          return [
            r.id,
            r.createdAt.toISOString(),
            r.actionType,
            String(payload["vault_id"] ?? ""),
            String(payload["amount"] ?? ""),
            String(payload["token"] ?? ""),
            r.status,
            r.txHash ?? "",
            r.errorCode ?? "",
            r.submittedAt?.toISOString() ?? "",
            r.confirmedAt?.toISOString() ?? ""
          ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
        });

        const csv = [CSV_HEADERS.join(","), ...csvRows].join("\n");
        const filename = `vaultquest-activity-${q.wallet.slice(0, 8)}.csv`;

        reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="${filename}"`);
        return reply.send(csv);
      }

      return ok(rows.map(serialize));
    });

    app.get<{ Params: { walletAddress: string } }>("/api/actions/:walletAddress", { preHandler: apiKeyGuard }, async (req) => {
      const q = actionHistoryQuery.parse(req.query);
      const result = await svc.listActions({
        walletAddress: req.params.walletAddress,
        status: q.status,
        type: q.type,
        cursor: q.cursor ?? null,
        limit: q.limit
      });
      return page(result.items.map(serialize), { nextCursor: result.nextCursor, limit: q.limit });
    });
  };
