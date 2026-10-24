/**
 * Server-side enforcement of operation limits (#815).
 *
 * Two ways to attach a limit, both calling the same OperationLimitService:
 *
 *  - {@link enforceOperationLimit}: a preHandler for routes that already run a
 *    permission guard. Chain it *after* the guard (see {@link chainPreHandlers})
 *    so the limit is keyed by the authenticated wallet/subject, not by
 *    something the client typed.
 *  - {@link operationLimitsHook}: an app-level preHandler hook for public
 *    routes that have no guard (POST /actions, POST /wallet-auth/challenge).
 *    It matches on method + route pattern, so it can't be skipped by adding a
 *    query string or trailing slash.
 *
 * Scope keys fall back to the client IP whenever the preferred identity is
 * missing, so omitting a wallet never means "unlimited".
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { LimitDecision, OperationLimitService, OperationName } from "../services/operationLimits.js";

export type WalletHint = (req: FastifyRequest) => string | undefined;

function clientIp(req: FastifyRequest): string {
  return req.ip || "unknown";
}

/** Builds the counter scope key for a request, per the operation's policy scope. */
export function scopeKeyFor(
  svc: OperationLimitService,
  operation: OperationName,
  req: FastifyRequest,
  walletHint?: WalletHint,
): string {
  const scope = svc.policy(operation).scope;
  if (scope === "ip") return `ip:${clientIp(req)}`;
  if (scope === "subject") {
    return req.principal?.subject ? `subject:${req.principal.subject}` : `ip:${clientIp(req)}`;
  }
  const wallet = req.principal?.walletAddress ?? walletHint?.(req);
  return typeof wallet === "string" && wallet.trim()
    ? `wallet:${wallet.trim().toLowerCase()}`
    : `ip:${clientIp(req)}`;
}

function exposeUsage(reply: FastifyReply, d: LimitDecision): void {
  reply.header("X-Operation-Limit", String(d.limit));
  reply.header("X-Operation-Limit-Remaining", String(d.remaining));
  reply.header("X-Operation-Limit-Reset", d.resetAt);
}

export function enforceOperationLimit(
  svc: OperationLimitService,
  operation: OperationName,
  walletHint?: WalletHint,
): preHandlerHookHandler {
  return async function operationLimitGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const decision = await svc.enforce(operation, scopeKeyFor(svc, operation, req, walletHint));
    exposeUsage(reply, decision);
  };
}

export interface RouteLimit {
  method: string;
  /** Fastify route pattern, e.g. "/actions" or "/actions/:id". */
  url: string;
  operation: OperationName;
  walletHint?: WalletHint;
}

/** Wallet from a JSON body field, used by unauthenticated routes. */
export function bodyWallet(field = "wallet_address"): WalletHint {
  return (req) => {
    const body = req.body as Record<string, unknown> | undefined;
    const value = body?.[field];
    return typeof value === "string" ? value : undefined;
  };
}

export function operationLimitsHook(svc: OperationLimitService, routes: readonly RouteLimit[]): preHandlerHookHandler {
  const table = new Map(routes.map((r) => [`${r.method.toUpperCase()} ${r.url}`, r]));
  return async function operationLimitsRouteHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const pattern = req.routeOptions?.url;
    if (!pattern) return;
    const rule = table.get(`${req.method.toUpperCase()} ${pattern}`);
    if (!rule) return;
    const decision = await svc.enforce(rule.operation, scopeKeyFor(svc, rule.operation, req, rule.walletHint));
    exposeUsage(reply, decision);
  };
}

/**
 * Runs async preHandlers in order, stopping at the first that throws or
 * replies. For routes whose signature takes a single guard.
 */
export function chainPreHandlers(...handlers: preHandlerHookHandler[]): preHandlerHookHandler {
  return async function chainedPreHandler(this: unknown, req: FastifyRequest, reply: FastifyReply): Promise<void> {
    for (const handler of handlers) {
      await (handler as unknown as (this: unknown, r: FastifyRequest, p: FastifyReply) => Promise<void>).call(
        this,
        req,
        reply,
      );
      if (reply.sent) return;
    }
  };
}
