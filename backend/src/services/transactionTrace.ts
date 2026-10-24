/**
 * Cross-layer transaction trace (#753).
 *
 * The on-chain transaction hash is the correlation key: it is the one
 * identifier every layer already stores (action_ledger, chain_events,
 * pending_events, poison_events) and the key every indexer/ledger log line
 * carries (`txHash`). Given a hash, this reconstructs the full timeline from
 * intent to dashboard visibility and names the first gap, which is the
 * standard entry point for "my deposit didn't show up" reports
 * (docs/ARCHITECTURE.md).
 *
 * Cost: four indexed point lookups in parallel plus one dependent lookup,
 * then an O(k log k) sort of the k (small, bounded) timeline entries.
 */

import type { PrismaClient } from "@prisma/client";

export type TraceLayer = "intent" | "signing" | "chain" | "ingestion" | "ledger" | "dashboard";

export interface TraceEntry {
  at: string;
  layer: TraceLayer;
  stage: string;
  detail: Record<string, unknown>;
}

export interface TransactionTrace {
  txHash: string;
  actionId: string | null;
  walletAddress: string | null;
  status: string | null;
  timeline: TraceEntry[];
  /** Human-readable diagnosis of where the pipeline stopped, empty when it completed. */
  gaps: string[];
}

export class TransactionTraceService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Returns null when no layer has any record of `txHash`. */
  async trace(txHash: string): Promise<TransactionTrace | null> {
    const [action, chainEvents, pending, poison] = await Promise.all([
      this.prisma.actionLedger.findUnique({ where: { txHash } }),
      this.prisma.chainEvent.findMany({ where: { txHash }, orderBy: { id: "asc" } }),
      this.prisma.pendingEvent.findUnique({ where: { txHash } }),
      this.prisma.poisonEvent.findMany({ where: { txHash }, orderBy: { detectedAt: "asc" } })
    ]);
    if (!action && chainEvents.length === 0 && !pending && poison.length === 0) return null;

    const metric = action
      ? await this.prisma.transactionMetric.findUnique({ where: { actionId: action.id } })
      : null;

    const timeline: TraceEntry[] = [];
    const add = (at: Date | null | undefined, layer: TraceLayer, stage: string, detail: Record<string, unknown> = {}) => {
      if (at) timeline.push({ at: at.toISOString(), layer, stage, detail });
    };

    if (action) {
      add(action.createdAt, "intent", "intent_recorded", {
        actionId: action.id,
        actionType: action.actionType,
        walletAddress: action.walletAddress,
        correlationId: action.correlationId
      });
      add(action.submittedAt, "signing", "tx_hash_attached", { actionId: action.id });
    }
    for (const e of chainEvents) {
      add(e.ledgerClosedAt, "chain", "event_emitted", {
        eventId: e.id,
        ledger: e.ledger,
        contractId: e.contractId,
        successful: e.successful
      });
      add(e.ingestedAt, "ingestion", "event_logged", { eventId: e.id });
    }
    for (const p of poison) {
      add(p.detectedAt, "ingestion", "event_quarantined", {
        eventId: p.sorobanEventId,
        reason: p.reason,
        resolvedAt: p.resolvedAt?.toISOString() ?? null
      });
    }
    if (pending) {
      add(pending.receivedAt, "ingestion", "event_parked_awaiting_intent", { eventId: pending.sorobanEventId });
      add(pending.consumedAt, "ingestion", "event_matched_to_intent", {
        eventId: pending.sorobanEventId,
        cacheInvalidated: true
      });
    }
    if (action && (action.status === "confirmed" || action.status === "reverted")) {
      // updatedAt is when the ledger row reached its terminal state (the
      // last write to it); confirmedAt is the event-derived ledger close time.
      add(action.updatedAt, "ledger", `action_${action.status}`, {
        sorobanEventId: action.sorobanEventId,
        confirmedAt: action.confirmedAt?.toISOString() ?? null,
        errorCode: action.errorCode
      });
      add(action.updatedAt, "dashboard", "visible_on_dashboard", {
        status: action.status,
        servedBy: ["GET /actions/:id", "GET /actions?wallet=", "GET /dashboard/summary?wallet="]
      });
    }
    if (metric) {
      add(metric.indexedAt, "ledger", "confirmation_metric_indexed", { network: metric.network });
    }

    timeline.sort((a, b) => a.at.localeCompare(b.at));

    return {
      txHash,
      actionId: action?.id ?? null,
      walletAddress: action?.walletAddress ?? null,
      status: action?.status ?? null,
      timeline,
      gaps: diagnose(action?.status ?? null, chainEvents.length > 0, poison, pending)
    };
  }
}

function diagnose(
  status: string | null,
  hasChainEvent: boolean,
  poison: Array<{ sorobanEventId: string; reason: string; resolvedAt: Date | null }>,
  pending: { consumedAt: Date | null } | null
): string[] {
  const gaps: string[] = [];
  for (const p of poison) {
    if (!p.resolvedAt) gaps.push(`event ${p.sorobanEventId} is quarantined and holds the indexer cursor: ${p.reason}`);
  }
  if (!hasChainEvent && poison.length === 0) {
    gaps.push(
      "no on-chain event in the chain event log: not yet indexed, contract outside the indexer filter, " +
        "reconciled through POST /internal/reconcile (which bypasses the log), or older than the RPC retention window"
    );
  }
  if (status === null && pending && !pending.consumedAt) {
    gaps.push("event ingested but no action intent carries this tx_hash (PATCH /actions/:id/submitted never called)");
  }
  if ((status === "submitted" || status === "orphaned") && hasChainEvent) {
    gaps.push(`event ingested but action is still ${status}: check indexer logs for this txHash`);
  }
  return gaps;
}
