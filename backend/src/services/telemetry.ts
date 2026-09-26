import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "pino";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { describeError } from "../errorTaxonomy.js";
import { getPrometheusMetrics } from "./prometheusMetrics.js";

/**
 * #770 — operation telemetry.
 *
 * One structured event and one metric sample per domain operation, with a
 * fixed, allow-listed field set. Nothing free-form (wallet addresses, tx
 * hashes, payloads, error messages) is ever accepted, so sensitive values
 * cannot reach logs or metric labels through this path.
 */

/** Every operation name that emits telemetry. Metric label cardinality is bounded by this list. */
export const OPERATIONS = [
  "action.create",
  "action.attach_tx",
  "action.cancel",
  "action.reconcile_event",
  "wallet.verify_challenge",
  "settlement.settle_vault",
  "draw_proof.generate",
  "worker.job"
] as const;
export type OperationName = (typeof OPERATIONS)[number];

export const ACTOR_TYPES = ["user", "service", "system", "worker"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface OperationEvent {
  event: "operation";
  operation: string;
  actor_type: ActorType;
  result: "success" | "failure";
  latency_ms: number;
  correlation_id: string | null;
  /** Stable taxonomy code, present on failures only. */
  error_code?: string;
  /** Taxonomy category, present on failures only. */
  error_category?: string;
  /** Optional low-cardinality qualifier, e.g. the job name. */
  detail?: string;
}

const correlationStore = new AsyncLocalStorage<string>();

/** Runs `fn` with `correlationId` visible to every operation started inside it. */
export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return correlationStore.run(correlationId, fn);
}

export function bindCorrelation(correlationId: string): void {
  correlationStore.enterWith(correlationId);
}

export function currentCorrelationId(): string | null {
  return correlationStore.getStore() ?? null;
}

type Listener = (event: OperationEvent) => void;
const listeners = new Set<Listener>();
let sink: Logger | undefined;

/** Sets the logger operation events are written to (info on success, warn on failure). */
export function configureTelemetry(opts: { logger?: Logger }): void {
  sink = opts.logger;
}

/** Observe every emitted event (used by tests and in-process dashboards). */
export function subscribeTelemetry(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function classify(err: unknown): { code: string; category: string } {
  const code = err instanceof AppError ? err.code : ERROR_CODES.INTERNAL;
  return { code, category: describeError(code).category };
}

export function recordOperation(event: OperationEvent): void {
  try {
    getPrometheusMetrics().recordOperation(
      event.operation,
      event.actor_type,
      event.result,
      event.latency_ms / 1000,
      event.error_code
    );
    if (sink) {
      const level = event.result === "success" ? "info" : "warn";
      sink[level](event, `operation ${event.operation} ${event.result}`);
    }
    for (const l of listeners) l(event);
  } catch {
    // Telemetry must never break the operation it observes.
  }
}

export interface OperationSpec {
  operation: OperationName;
  actorType: ActorType;
  correlationId?: string | null;
  detail?: string;
}

/**
 * Times `fn`, records success or failure, and rethrows failures unchanged.
 */
export async function withTelemetry<T>(spec: OperationSpec, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const base = {
    event: "operation" as const,
    operation: spec.operation,
    actor_type: spec.actorType,
    correlation_id: spec.correlationId ?? currentCorrelationId(),
    ...(spec.detail ? { detail: spec.detail } : {})
  };
  try {
    const out = await fn();
    recordOperation({
      ...base,
      result: "success",
      latency_ms: Math.round((performance.now() - start) * 100) / 100
    });
    return out;
  } catch (err) {
    const { code, category } = classify(err);
    recordOperation({
      ...base,
      result: "failure",
      latency_ms: Math.round((performance.now() - start) * 100) / 100,
      error_code: code,
      error_category: category
    });
    throw err;
  }
}
