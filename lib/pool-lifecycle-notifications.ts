/**
 * Projects the pool lifecycle audit event (#763) onto the existing notification
 * convention in `lib/notification-dedup.ts`.
 *
 * This is the integration seam required by docs/NOTIFICATIONS.md: a caller that
 * accepts a transition can build a deduplicated notification input from the
 * audit event and hand it to `dispatchAlert`/`createNotification`. It is pure —
 * no store is touched here. Persisting the raw audit event is a separate
 * concern owned by whichever layer writes the pool record (see
 * docs/POOL_LIFECYCLE.md, "Audit trail").
 */

import type { NotificationInput, NotificationType } from "./notification-dedup";
import { POOL_STATES, type PoolAuditEvent, type PoolState } from "./pool-lifecycle";

const NOTIFICATION_TYPE_BY_STATE: Record<PoolState, NotificationType> = {
  [POOL_STATES.DRAFT]: "round_update",
  [POOL_STATES.UPCOMING]: "round_update",
  [POOL_STATES.ACTIVE]: "round_update",
  [POOL_STATES.PAUSED]: "vault_pause",
  [POOL_STATES.MATURED]: "maturity",
  [POOL_STATES.SETTLING]: "round_update",
  [POOL_STATES.COMPLETED]: "action_completed",
  [POOL_STATES.CANCELLED]: "protocol_alert",
};

export interface PoolTransitionNotificationOptions {
  poolId?: string | null;
  poolName?: string | null;
  deepLink?: string | null;
}

/**
 * Builds a dedupe-friendly {@link NotificationInput} for one transition event.
 *
 * The `eventId` is scoped to `pool + target state`, matching the model's
 * "retries collapse into one current alert" semantics: re-emitting the same
 * status change updates the existing notification instead of duplicating it.
 */
export function poolTransitionNotification(
  event: PoolAuditEvent,
  options: PoolTransitionNotificationOptions = {},
): NotificationInput {
  const subject = options.poolId ?? options.poolName ?? "Protocol";
  const label = options.poolName ?? options.poolId ?? "A pool";

  return {
    type: NOTIFICATION_TYPE_BY_STATE[event.to] ?? "round_update",
    scope: options.poolId ? "vault" : "global",
    subject,
    eventId: `${subject}:${event.to}`,
    title: `Pool status: ${event.to}`,
    message: `${label} moved from ${event.from} to ${event.to}.`,
    deepLink: options.deepLink ?? (options.poolId ? `/app/vaults/${options.poolId}` : null),
    actionLabel: options.poolId ? "View pool" : null,
    date: new Date(event.at).toISOString(),
  };
}
