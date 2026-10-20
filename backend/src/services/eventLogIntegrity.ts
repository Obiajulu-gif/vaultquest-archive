import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { RawHorizonEvent } from "./stellarIndexer.js";

type Db = PrismaClient | Prisma.TransactionClient;

export class EventLogIntegrityError extends Error {
  constructor(readonly code: "MISSING_EVENT" | "ALTERED_EVENT" | "MALFORMED_EVENT", readonly eventId: string) {
    super(`${code} at event ${eventId}; restore the original event batch from a trusted archive before replaying`);
  }
}

function normalized(event: RawHorizonEvent) {
  if (!event.id || !Number.isSafeInteger(event.ledger) || event.ledger < 0 || !event.txHash ||
    !event.contractId || !Array.isArray(event.topicXdr) || event.topicXdr.some((t) => typeof t !== "string") ||
    typeof event.valueXdr !== "string" || typeof event.successful !== "boolean" ||
    (event.ledgerClosedAt !== undefined && !Number.isFinite(Date.parse(event.ledgerClosedAt)))) {
    throw new EventLogIntegrityError("MALFORMED_EVENT", event.id ?? "unknown");
  }
  // Fixed tuple order hashes the original XDR bytes without semantic normalization.
  return [event.id, event.ledger, event.ledgerClosedAt ? new Date(event.ledgerClosedAt).toISOString() : null,
    event.txHash, event.contractId, event.topicXdr, event.valueXdr, event.successful];
}

export function eventBatchHash(events: RawHorizonEvent[]): string {
  const hash = createHash("sha256");
  for (const event of [...events].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    hash.update(JSON.stringify(normalized(event)) + "\n");
  }
  return hash.digest("hex");
}

function asRaw(row: { id: string; ledger: number; ledgerClosedAt: Date | null; txHash: string;
  contractId: string; topicXdr: string[]; valueXdr: string; successful: boolean }): RawHorizonEvent {
  return { id: row.id, ledger: row.ledger, ledgerClosedAt: row.ledgerClosedAt?.toISOString(), txHash: row.txHash,
    contractId: row.contractId, topicXdr: row.topicXdr, valueXdr: row.valueXdr, successful: row.successful };
}

/** Must run inside the caller's transaction, before any event affects a projection. */
export async function appendEventLog(tx: Prisma.TransactionClient, events: RawHorizonEvent[]) {
  const distinct = new Map<string, RawHorizonEvent>();
  for (const event of events) {
    normalized(event);
    const previous = distinct.get(event.id);
    if (previous && eventBatchHash([previous]) !== eventBatchHash([event])) throw new EventLogIntegrityError("ALTERED_EVENT", event.id);
    distinct.set(event.id, event);
  }
  const ordered = [...distinct.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (let i = 0; i < ordered.length; i += 500) {
    const batch = ordered.slice(i, i + 500);
    await tx.chainEvent.createMany({ data: batch.map((event) => ({
      id: event.id, ledger: event.ledger, txHash: event.txHash, contractId: event.contractId,
      topicXdr: event.topicXdr, valueXdr: event.valueXdr, successful: event.successful,
      ledgerClosedAt: event.ledgerClosedAt ? new Date(event.ledgerClosedAt) : null,
    })), skipDuplicates: true });
    const ids = batch.map((e) => e.id);
    const persisted = await tx.chainEvent.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    const contentHash = eventBatchHash(batch);
    if (eventBatchHash(persisted.map(asRaw)) !== contentHash) throw new EventLogIntegrityError("ALTERED_EVENT", ids[0]!);
    const id = createHash("sha256").update(ids.join("\n")).digest("hex");
    await tx.chainEventBatch.upsert({ where: { id }, create: { id, eventIds: ids, contentHash }, update: {} });
  }
}

/** Bounded manifest scan. Chain event ids are ordered RPC TOIDs, never a dense integer sequence. */
export async function verifyEventLog(db: Db): Promise<{ batches: number; eventsChecked: number }> {
  let after: string | undefined;
  let batches = 0;
  let eventsChecked = 0;
  for (;;) {
    const page = await db.chainEventBatch.findMany({
      where: after ? { id: { gt: after } } : {}, orderBy: { id: "asc" }, take: 100,
    });
    for (const batch of page) {
      const rows = await db.chainEvent.findMany({ where: { id: { in: batch.eventIds } }, orderBy: { id: "asc" } });
      const ids = new Set(rows.map((r) => r.id));
      for (const id of batch.eventIds) if (!ids.has(id)) throw new EventLogIntegrityError("MISSING_EVENT", id);
      if (batch.contentHash && eventBatchHash(rows.map(asRaw)) !== batch.contentHash) {
        throw new EventLogIntegrityError("ALTERED_EVENT", batch.eventIds[0]!);
      }
      batches++;
      eventsChecked += rows.length;
    }
    if (page.length < 100) return { batches, eventsChecked };
    after = page.at(-1)!.id;
  }
}
