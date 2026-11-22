import type { FastifyPluginAsync } from "fastify";
import type {
  SupportAccessAuditRecord,
  SupportAccessGrantRecord,
  SupportAccessService
} from "../services/supportAccessService.js";
import { buildSupportNotice, supportAgentBadge } from "../services/supportAccessService.js";
import { requireServiceAuth } from "../middleware/service-auth.js";
import { ok } from "../responses.js";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { sanitizeRenderedText } from "../services/contentBoundary.js";
import {
  authorizeBody,
  createGrantBody,
  grantParams,
  revokeGrantBody,
  supportNoticesQuery
} from "../schemas/supportAccess.js";

const NOTICE_LOOKBACK_DAYS = 30;

function serializeGrant(grant: SupportAccessGrantRecord) {
  return {
    id: grant.id,
    agent_badge: supportAgentBadge(grant.requesterId),
    scope_type: grant.scopeType,
    scope: grant.scope,
    ticket_ref: grant.ticketRef,
    expires_at: grant.expiresAt,
    revoked_at: grant.revokedAt,
    revoked_by: grant.revokedBy,
    created_at: grant.createdAt
  };
}

function serializeAuditEntry(entry: SupportAccessAuditRecord) {
  return {
    id: entry.id,
    grant_id: entry.grantId,
    actor: entry.actor,
    action: entry.action,
    scope: entry.scope,
    detail: entry.detail,
    prev_hash: entry.prevHash,
    entry_hash: entry.entryHash,
    created_at: entry.createdAt
  };
}

/**
 * Support access endpoints (#support-access).
 *
 * Internal (service-secret) routes manage the grant lifecycle and exercise
 * scoped access; every one of them is audited. The public notices route only
 * exposes user-safe text generated server-side — never reasons, requester
 * identities, or raw audit detail.
 */
export const supportAccessRoutes = (
  svc: SupportAccessService,
  internalSecret: string
): FastifyPluginAsync =>
  async (app) => {
    const guard = requireServiceAuth(internalSecret);

    app.post("/internal/support-access/grants", { preHandler: guard }, async (req, reply) => {
      const body = createGrantBody.parse(req.body);
      const { grant, notice } = await svc.createGrant({
        requesterId: body.requester_id,
        reason: body.reason,
        ticketRef: body.ticket_ref,
        scopeType: body.scope_type,
        scope: body.scope,
        ttlMinutes: body.ttl_minutes
      });
      reply.status(201);
      return ok({ grant: serializeGrant(grant), notice });
    });

    app.post(
      "/internal/support-access/grants/:id/revoke",
      { preHandler: guard },
      async (req) => {
        const params = grantParams.parse(req.params);
        const body = revokeGrantBody.parse(req.body);
        const result = await svc.revokeGrant(params.id, { revokedBy: body.revoked_by });
        return ok({
          grant: serializeGrant(result.grant),
          already_revoked: result.alreadyRevoked
        });
      }
    );

    app.post("/internal/support-access/access", { preHandler: guard }, async (req) => {
      const body = authorizeBody.parse(req.body);
      const decision = await svc.authorize({
        grantId: body.grant_id,
        scopeType: body.scope_type,
        scope: body.scope,
        actor: body.actor
      });

      if (!decision.allowed) {
        // The denied attempt has already been written to the audit trail.
        throw new AppError(
          ERROR_CODES.SUPPORT_ACCESS_DENIED,
          403,
          `support access denied: ${decision.denial_reason}`,
          `grant ${decision.grant.id} is not usable for ${body.scope_type}:${body.scope}`
        );
      }

      return ok({
        allowed: true,
        grant_id: decision.grant.id,
        scope_type: decision.grant.scopeType,
        scope: decision.grant.scope,
        expires_at: decision.expiresAt,
        remaining_ms: decision.remaining_ms,
        notice: decision.notice
      });
    });

    app.get(
      "/internal/support-access/grants/:id/audit",
      { preHandler: guard },
      async (req) => {
        const params = grantParams.parse(req.params);
        const trail = await svc.getAuditTrail({ grantId: params.id });
        return ok({
          entries: trail.entries.map(serializeAuditEntry),
          chain_valid: trail.chain_valid
        });
      }
    );

    app.get("/internal/support-access/audit/verify", { preHandler: guard }, async () => {
      const verification = await svc.verifyAuditChain();
      return ok(verification);
    });

    /**
     * Public user-safe notices: every active/previous support grant that
     * touched this wallet, rendered through the content sanitiser.
     */
    app.get("/support-access/notices", async (req) => {
      const q = supportNoticesQuery.parse(req.query);
      const since = new Date(Date.now() - NOTICE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const grants = await svc.listGrantsForScope("wallet", q.wallet, { since });

      return ok({
        notices: grants.map((grant) => ({
          id: grant.id,
          agent_badge: supportAgentBadge(grant.requesterId),
          // Preserves the operator's ticket reference while neutralising any
          // markup/control characters a hostile ticket string could carry.
          ticket_ref: sanitizeRenderedText(grant.ticketRef, { maxLength: 120 }),
          scope_type: grant.scopeType,
          expires_at: grant.expiresAt,
          revoked_at: grant.revokedAt,
          created_at: grant.createdAt,
          notice: buildSupportNotice(grant)
        }))
      });
    });
  };
