import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import React from "react";
import {
  createNotification,
  upsertNotification,
  pruneExpiredNotifications,
  dismissNotification,
  markNotificationRead,
  dismissAllNotifications,
  countUnread,
  computeIdentityKey,
  createApprovalNotification,
  createCompletedActionNotification,
  createFailureNotification,
  createRecoveryNotification,
  filterNotificationsForRecipient,
  isNotificationTargeted,
  markNotificationUnread,
  type NotificationInput,
} from "../lib/notification-dedup";
import {
  NotificationProvider,
  useNotificationCenter,
} from "../src/providers/NotificationProvider";

function makeAlert(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    type: "protocol_alert",
    scope: "global",
    title: "Protocol alert",
    message: "Something happened",
    date: "2026-06-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("notification identity and scope model", () => {
  it("builds distinct identity keys per scope for the same type", () => {
    const global = computeIdentityKey({ type: "vault_pause", scope: "global" });
    const vault = computeIdentityKey({ type: "vault_pause", scope: "vault", subject: "XLM Drip Vault" });
    const wallet = computeIdentityKey({ type: "vault_pause", scope: "wallet", subject: "GBBD...FLA5" });
    expect(new Set([global, vault, wallet]).size).toBe(3);
  });

  it("wallet-specific and global alerts for the same subject never conflict", () => {
    const walletAlert = createNotification(makeAlert({ type: "vault_pause", scope: "wallet", subject: "GBBD...FLA5" }));
    const globalAlert = createNotification(makeAlert({ type: "vault_pause", scope: "global" }));
    const { notifications, outcome } = upsertNotification([walletAlert], globalAlert);
    expect(outcome).toBe("created");
    expect(notifications).toHaveLength(2);
  });
});

describe("notification deduplication", () => {
  it("collapses repeated alerts into one current notification", () => {
    const first = createNotification(makeAlert());
    const duplicate = createNotification(makeAlert());
    const { notifications, outcome } = upsertNotification([first], duplicate);
    expect(outcome).toBe("duplicate");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].version).toBe(1);
  });

  it("replaces an updated alert in place and bumps the version", () => {
    const first = createNotification(makeAlert({ title: "APY update" }));
    const updated = createNotification(
      makeAlert({ title: "APY update", message: "APY changed to 4.6%", date: "2026-06-22T09:00:00.000Z" }),
    );
    const { notifications, outcome } = upsertNotification([first], updated);
    expect(outcome).toBe("updated");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toBe("APY changed to 4.6%");
    expect(notifications[0].id).toBe(first.id);
    expect(notifications[0].version).toBe(2);
    expect(notifications[0].status).toBe("unread");
  });

  it("keeps an alert dismissed across refreshed updates of the same family", () => {
    const first = createNotification(makeAlert({ title: "Vault pause" }));
    const dismissed = dismissNotification([first], first.id);
    const refreshed = createNotification(
      makeAlert({ title: "Vault pause", message: "pause lifted", date: "2026-06-22T09:00:00.000Z" }),
    );
    const { notifications } = upsertNotification(dismissed, refreshed);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].dismissed).toBe(true);
  });

  it("prunes expired notifications and keeps active ones", () => {
    const expired = createNotification(makeAlert({ date: "2026-06-01T00:00:00.000Z", expiresAt: "2026-06-10T00:00:00.000Z" }));
    const active = createNotification(makeAlert({ date: "2026-06-20T00:00:00.000Z", expiresAt: "2026-07-01T00:00:00.000Z" }));
    const noExpiry = createNotification(makeAlert({ date: "2026-06-20T00:00:00.000Z" }));
    const pruned = pruneExpiredNotifications([active, expired, noExpiry], "2026-06-25T00:00:00.000Z");
    expect(pruned.map((n) => n.id).sort()).toEqual([active.id, noExpiry.id].sort());
  });

  it("counts only unread, non-dismissed alerts", () => {
    const a = createNotification(makeAlert());
    const b = createNotification(makeAlert({ type: "deposit", scope: "wallet", subject: "G1", title: "Deposit" }));
    const c = createNotification(makeAlert({ type: "reward_event", scope: "vault", subject: "V1", title: "Draw" }));
    const withRead = markNotificationRead([a, b, c], b.id);
    const withDismissed = dismissNotification(withRead, c.id);
    expect(countUnread(withDismissed)).toBe(1);
  });

  it("dismisses all within a single scope only", () => {
    const vault = createNotification(makeAlert({ scope: "vault", subject: "V1" }));
    const global = createNotification(makeAlert({ scope: "global" }));
    const dismissed = dismissAllNotifications([vault, global], "vault");
    expect(dismissed[0].dismissed).toBe(true);
    expect(dismissed[1].dismissed).toBe(false);
  });
});

describe("critical lifecycle notifications (#776)", () => {
  const walletA = "GBBD...FLA5";
  const walletB = "GDONT...LEAK";

  it("collapses a retried failed action into one notification by its action id", () => {
    const first = createNotification(createFailureNotification({
      actionType: "withdrawal",
      errorMessage: "Network timeout",
      walletAddress: walletA,
      actionId: "action-123",
      date: "2026-06-20T12:00:00.000Z",
    }));
    const retry = createNotification(createFailureNotification({
      actionType: "withdrawal",
      errorMessage: "Still waiting for confirmation",
      walletAddress: walletA,
      actionId: "action-123",
      date: "2026-06-20T12:01:00.000Z",
    }));

    const result = upsertNotification([first], retry);
    expect(result.outcome).toBe("updated");
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toMatchObject({
      id: first.id,
      eventId: "action-123",
      severity: "critical",
      deepLink: "/app/activity",
      isPrivate: true,
      version: 2,
    });
  });

  it("targets private wallet and admin events without exposing them to other viewers", () => {
    const walletAlert = createNotification(createCompletedActionNotification({
      actionType: "deposit",
      walletAddress: walletA,
      actionId: "action-456",
    }));
    const adminAlert = createNotification(createApprovalNotification({
      title: "Repair approval needed",
      message: "A repair proposal requires review.",
      proposalId: "proposal-1",
      role: "admin",
    }));

    expect(isNotificationTargeted(walletAlert, { walletAddress: walletA })).toBe(true);
    expect(isNotificationTargeted(walletAlert, { walletAddress: walletB })).toBe(false);
    expect(isNotificationTargeted(walletAlert)).toBe(false);
    expect(isNotificationTargeted(adminAlert, { walletAddress: walletA, role: "user" })).toBe(false);
    expect(isNotificationTargeted(adminAlert, { role: "admin" })).toBe(true);
    expect(filterNotificationsForRecipient([walletAlert, adminAlert], { walletAddress: walletB })).toEqual([]);
  });

  it("provides a private, actionable recovery path and supports read-state toggles", () => {
    const recovery = createNotification(createRecoveryNotification({
      actionId: "action-789",
      walletAddress: walletA,
      actionType: "claim",
      state: "retryable",
      attempts: 1,
      maxAttempts: 3,
    }));
    const read = markNotificationRead([recovery], recovery.id);
    const unread = markNotificationUnread(read, recovery.id);

    expect(recovery).toMatchObject({
      type: "recovery_path_available",
      deepLink: "/app/activity?action=action-789&tab=recovery",
      actionLabel: "Open Recovery",
      isPrivate: true,
      retryCount: 1,
    });
    expect(read[0].status).toBe("read");
    expect(unread[0].status).toBe("unread");
  });
});

// ── Provider ────────────────────────────────────────────────────────────────

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => (map.has(key) ? (map.get(key) as string) : null)),
    setItem: vi.fn((key: string, value: string) => void map.set(key, value)),
    removeItem: vi.fn((key: string) => void map.delete(key)),
  };
}

function Harness({ probe }: { probe: (api: ReturnType<typeof useNotificationCenter>) => void }) {
  const api = useNotificationCenter();
  probe(api);
  return (
    <div>
      <span data-testid="count">{api.notifications.length}</span>
      <span data-testid="unread">{api.unreadCount}</span>
      <span data-testid="scope">{api.scopeKey}</span>
    </div>
  );
}

describe("NotificationProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates seed alerts and collapses on dispatch", async () => {
    let api: ReturnType<typeof useNotificationCenter> | null = null;
    render(
      <NotificationProvider scopeKey="wallet-a@testnet" initialAlerts={[makeAlert(), makeAlert()]}>
        <Harness probe={(a) => { api = a; }} />
      </NotificationProvider>,
    );
    expect(screen.getByTestId("count")).toHaveTextContent("1");

    await act(async () => {
      api!.dispatchAlert(makeAlert({ message: "latest alert" }));
    });
    expect(api!.notifications).toHaveLength(1);
    expect(api!.notifications[0].message).toBe("latest alert");
    expect(api!.notifications[0].version).toBe(2);
  });

  it("persists dismissed alerts by storage scope", async () => {
    const storage = createMemoryStorage();
    let api: ReturnType<typeof useNotificationCenter> | null = null;
    const seed = [makeAlert()];
    const { unmount } = render(
      <NotificationProvider scopeKey="wallet-a@testnet" initialAlerts={seed} storage={storage}>
        <Harness probe={(a) => { api = a; }} />
      </NotificationProvider>,
    );

    await act(async () => {
      api!.dismiss(api!.notifications[0].id);
    });
    expect(api!.notifications[0].dismissed).toBe(true);

    await waitFor(() => {
      const matchingCalls = storage.setItem.mock.calls.filter(([key]) => key.includes("wallet-a@testnet"));
      const persisted = matchingCalls.length
        ? JSON.parse(matchingCalls[matchingCalls.length - 1][1] as string)
        : null;
      expect(persisted?.dismissedIds).toContain(api!.notifications[0].id);
    });

    // Remount with a fresh memory storage holding the persisted flag.
    unmount();
    render(
      <NotificationProvider scopeKey="wallet-a@testnet" initialAlerts={seed} storage={storage}>
        <Harness probe={(a) => { api = a; }} />
      </NotificationProvider>,
    );
    expect(api!.notifications[0].dismissed).toBe(true);
  });

  it("does not leak dismissed state across different scope keys", async () => {
    const storage = createMemoryStorage();
    let api: ReturnType<typeof useNotificationCenter> | null = null;
    const seed = [makeAlert()];
    render(
      <NotificationProvider scopeKey="wallet-b@testnet" initialAlerts={seed} storage={storage}>
        <Harness probe={(a) => { api = a; }} />
      </NotificationProvider>,
    );
    await act(async () => {
      api!.dismiss(api!.notifications[0].id);
    });
    expect(api!.notifications[0].dismissed).toBe(true);

    let secondApi: ReturnType<typeof useNotificationCenter> | null = null;
    const { getByTestId } = render(
      <div data-testid="second-tree">
        <NotificationProvider scopeKey="wallet-c@mainnet" initialAlerts={seed} storage={storage}>
          <Harness probe={(a) => { secondApi = a; }} />
        </NotificationProvider>
      </div>,
    );
    expect(within(getByTestId("second-tree")).getByTestId("scope")).toHaveTextContent("wallet-c@mainnet");
    expect(secondApi!.notifications[0].dismissed).toBe(false);
  });

  it("filters another wallet's private seed and dispatched alerts before storage", async () => {
    const storage = createMemoryStorage();
    let api: ReturnType<typeof useNotificationCenter> | null = null;
    const privateAlert = createCompletedActionNotification({
      actionType: "deposit",
      walletAddress: "GOWNER",
      actionId: "deposit-1",
    });
    render(
      <NotificationProvider
        scopeKey="other-wallet@testnet"
        viewer={{ walletAddress: "GOTHER", role: "user" }}
        initialAlerts={[privateAlert]}
        storage={storage}
      >
        <Harness probe={(a) => { api = a; }} />
      </NotificationProvider>,
    );

    expect(api!.notifications).toEqual([]);
    await act(async () => {
      api!.dispatchAlert(privateAlert);
    });
    expect(api!.notifications).toEqual([]);
    expect(api!.unreadCount).toBe(0);
  });
});
