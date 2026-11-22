/**
 * Duplicate notification suppression across channels (#856).
 *
 * Tracks which notifications have been delivered across all channels (in-app,
 * email, push, SMS) and suppresses duplicate deliveries within a configurable
 * time window. Ensures a user receives at most one notification per identity
 * per channel per window, regardless of how many times the underlying event
 * fires.
 *
 * Pure TypeScript/JS — fully unit-testable without the DOM.
 */

import type { VaultNotification, NotificationType } from "./notification-dedup";

export type NotificationChannel = "in-app" | "email" | "push" | "sms";

export interface ChannelDeliveryRecord {
  notificationId: string;
  identityKey: string;
  channel: NotificationChannel;
  deliveredAt: string; // ISO timestamp
  userId: string;
}

export interface SuppressionConfig {
  /** Default window (seconds) during which duplicates are suppressed per channel. */
  defaultWindowSeconds: number;
  /** Per-type override windows. */
  typeWindows?: Partial<Record<NotificationType, number>>;
  /** Per-channel override windows. */
  channelWindows?: Partial<Record<NotificationChannel, number>>;
}

export interface SuppressionResult {
  /** True if the notification should be delivered on this channel. */
  allowed: boolean;
  /** Reason for suppression (if blocked). */
  reason?: "recently_delivered" | "disabled_channel" | "rate_limited";
  /** When the next delivery would be allowed (ISO timestamp). */
  nextAllowedAt?: string;
}

const DEFAULT_CONFIG: SuppressionConfig = {
  defaultWindowSeconds: 300, // 5 minutes
  typeWindows: {
    protocol_alert: 600, // 10 minutes for protocol alerts
    action_failed: 300, // 5 minutes for failures
    recovery_failed: 300,
    recovery_path_available: 900, // 15 minutes for recovery paths
  },
  channelWindows: {
    email: 900, // 15 minutes for email
    sms: 1800, // 30 minutes for SMS
  },
};

/**
 * Computes the suppression window for a given notification and channel.
 */
export function getSuppressionWindow(
  type: NotificationType,
  channel: NotificationChannel,
  config: SuppressionConfig = DEFAULT_CONFIG,
): number {
  return (
    config.typeWindows?.[type] ??
    config.channelWindows?.[channel] ??
    config.defaultWindowSeconds
  );
}

/**
 * Checks if a notification should be suppressed on a given channel based
 * on recent delivery history.
 */
export function shouldSuppress(
  notification: VaultNotification,
  channel: NotificationChannel,
  userId: string,
  deliveryHistory: ChannelDeliveryRecord[],
  config: SuppressionConfig = DEFAULT_CONFIG,
  now: Date = new Date(),
): SuppressionResult {
  const windowSeconds = getSuppressionWindow(notification.type, channel, config);
  const windowStart = new Date(now.getTime() - windowSeconds * 1000).toISOString();

  // Find recent deliveries for this identity on this channel by this user
  const recentDelivery = deliveryHistory.find(
    (r) =>
      r.identityKey === notification.identityKey &&
      r.channel === channel &&
      r.userId === userId &&
      r.deliveredAt >= windowStart,
  );

  if (recentDelivery) {
    const nextAllowedAt = new Date(
      new Date(recentDelivery.deliveredAt).getTime() + windowSeconds * 1000,
    ).toISOString();
    return {
      allowed: false,
      reason: "recently_delivered",
      nextAllowedAt,
    };
  }

  return { allowed: true };
}

/**
 * Records a successful delivery in the history.
 */
export function recordDelivery(
  notification: VaultNotification,
  channel: NotificationChannel,
  userId: string,
  deliveryHistory: ChannelDeliveryRecord[],
  now: Date = new Date(),
): ChannelDeliveryRecord[] {
  const record: ChannelDeliveryRecord = {
    notificationId: notification.id,
    identityKey: notification.identityKey,
    channel,
    deliveredAt: now.toISOString(),
    userId,
  };
  return [record, ...deliveryHistory];
}

/**
 * Prunes old delivery records outside the maximum retention window.
 */
export function pruneDeliveryHistory(
  deliveryHistory: ChannelDeliveryRecord[],
  retentionSeconds: number = 3600,
  now: Date = new Date(),
): ChannelDeliveryRecord[] {
  const cutoff = new Date(now.getTime() - retentionSeconds * 1000).toISOString();
  return deliveryHistory.filter((r) => r.deliveredAt >= cutoff);
}

/**
 * Gets all channels that should receive a notification, respecting suppression.
 */
export function getActiveChannels(
  notification: VaultNotification,
  userId: string,
  deliveryHistory: ChannelDeliveryRecord[],
  availableChannels: NotificationChannel[],
  config: SuppressionConfig = DEFAULT_CONFIG,
  now: Date = new Date(),
): NotificationChannel[] {
  return availableChannels.filter(
    (channel) =>
      shouldSuppress(notification, channel, userId, deliveryHistory, config, now).allowed,
  );
}
