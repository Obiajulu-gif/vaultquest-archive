import { describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import React from "react";
import { NotificationProvider, useNotificationCenter } from "../src/providers/NotificationProvider";
import type { NotificationInput } from "../lib/notification-dedup";
import { notificationPreferencesStorageKey } from "../lib/notification-routing";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

function optionalAlert(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    type: "claim_window",
    scope: "wallet",
    subject: "GGROUND...POOL",
    title: "Claim window approaching",
    message: "Draw opens soon",
    date: "2026-10-16T12:00:00.000Z",
    ...overrides,
  };
}

function mandatoryAlert(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    type: "action_failed",
    scope: "wallet",
    subject: "GGROUND...POOL",
    title: "Deposit failed",
    message: "The deposit transaction reverted",
    date: "2026-10-16T12:00:00.000Z",
    ...overrides,
  };
}

let latestApi: ReturnType<typeof useNotificationCenter> | null = null;

function CaptureApi() {
  latestApi = useNotificationCenter();
  return null;
}

function Board() {
  const api = useNotificationCenter();
  return (
    <div>
      <ul data-testid="notifications">
        {api.notifications.map((n) => (
          <li key={n.id} data-testid={`notification-${n.type}`}>
            {n.title}
          </li>
        ))}
      </ul>
      <ul data-testid="audit">
        {api.routingAudit.map((record) => (
          <li key={record.id} data-testid={`audit-${record.type}-${record.reason}`}>
            {record.decision}:{record.reason}
          </li>
        ))}
      </ul>
      <span data-testid="preferences">{JSON.stringify(api.preferences)}</span>
    </div>
  );
}

function renderWithPreferences(
  storage: ReturnType<typeof fakeStorage>,
  viewer = { walletAddress: "GGROUND...POOL", role: "user" as const },
  initialAlerts?: NotificationInput[],
) {
  latestApi = null;
  const rendered = render(
    <NotificationProvider
      scopeKey="GGROUND...POOL@testnet"
      storage={storage}
      viewer={viewer}
      initialAlerts={initialAlerts}
    >
      <CaptureApi />
      <Board />
    </NotificationProvider>,
  );
  return {
    unmount: rendered.unmount,
    getApi: (): ReturnType<typeof useNotificationCenter> => {
      if (!latestApi) throw new Error("provider API not captured");
      return latestApi;
    },
  };
}

describe("NotificationProvider durable preference routing", () => {
  it("suppresses a disabled optional alert and records an auditable reason", () => {
    const storage = fakeStorage();
    const { getApi } = renderWithPreferences(storage);

    act(() => {
      getApi().setOptionalEnabled("claim_window", false);
    });
    act(() => {
      getApi().dispatchAlert(optionalAlert({ eventId: "draw-1" }));
    });
    expect(screen.queryByTestId("notification-claim_window")).toBeNull();
    expect(screen.getByTestId("audit-claim_window-disabled_by_preference")).toBeInTheDocument();
  });

  it("always delivers mandatory alerts even when preferences are maximally restricted", () => {
    const storage = fakeStorage({
      [notificationPreferencesStorageKey("GGROUND...POOL@testnet")]: JSON.stringify({
        schemaVersion: 2,
        disabledTypes: ["action_failed", "claim_window"],
        optionalMutedUntil: "2030-01-01T00:00:00.000Z",
        revision: 3,
        updatedAt: "2026-10-16T12:00:00.000Z",
      }),
    });
    const { getApi } = renderWithPreferences(storage);

    act(() => {
      getApi().dispatchAlert(mandatoryAlert({ eventId: "dep-1" }));
    });

    expect(screen.getByTestId("notification-action_failed")).toBeInTheDocument();
    expect(screen.getByTestId("audit-action_failed-mandatory_type")).toBeInTheDocument();
    const preferences = JSON.parse(screen.getByTestId("preferences").textContent ?? "{}");
    // The stored mandatory entry is stripped during sanitization at load time.
    expect(preferences.disabledTypes).toEqual(["claim_window"]);
  });

  it("persists preferences durably across a provider remount", () => {
    const storage = fakeStorage();
    const first = renderWithPreferences(storage);

    act(() => {
      const api = first.getApi();
      api.setOptionalEnabled("apy_change", false);
    });
    const stored = JSON.parse(storage.getItem(notificationPreferencesStorageKey("GGROUND...POOL@testnet")) ?? "{}");
    expect(stored.disabledTypes).toEqual(["apy_change"]);

    const second = renderWithPreferences(storage);
    act(() => {
      const api = second.getApi();
      api.dispatchAlert(optionalAlert({ type: "apy_change", eventId: "apy-1", title: "APY changed" }));
    });
    expect(screen.queryByTestId("notification-apy_change")).toBeNull();
    expect(screen.getByTestId("audit-apy_change-disabled_by_preference")).toBeInTheDocument();
  });

  it("rejects attempts to disable mandatory types through the provider API", () => {
    const storage = fakeStorage();
    const { getApi } = renderWithPreferences(storage);
    let outcome: { changed: boolean; rejectedReason?: string } | null = null;
    act(() => {
      outcome = getApi().setOptionalEnabled("protocol_alert", false);
    });
    expect(outcome!.changed).toBe(false);
    expect(outcome!.rejectedReason).toContain("mandatory");
  });

  it("records a routing audit trail that survives a remount", () => {
    const storage = fakeStorage();
    const first = renderWithPreferences(storage);
    act(() => {
      first.getApi().dispatchAlert(mandatoryAlert({ eventId: "dep-2" }));
    });
    expect(screen.getByTestId("audit-action_failed-mandatory_type")).toBeInTheDocument();
    first.unmount();

    renderWithPreferences(storage);
    expect(screen.getByTestId("audit-action_failed-mandatory_type")).toBeInTheDocument();
  });

  it("filters seed alerts through preferences so suppressed optional alerts never enter state", () => {
    const storage = fakeStorage({
      [notificationPreferencesStorageKey("GGROUND...POOL@testnet")]: JSON.stringify({
        schemaVersion: 2,
        disabledTypes: ["claim_window"],
        optionalMutedUntil: null,
        revision: 2,
        updatedAt: "2026-10-16T12:00:00.000Z",
      }),
    });
    renderWithPreferences(storage, { walletAddress: "GGROUND...POOL", role: "user" }, [
      optionalAlert(),
      mandatoryAlert(),
    ]);
    expect(screen.queryByTestId("notification-claim_window")).toBeNull();
    expect(screen.getByTestId("notification-action_failed")).toBeInTheDocument();
    expect(screen.getByTestId("audit-claim_window-disabled_by_preference")).toBeInTheDocument();
  });
});
