import { describe, expect, it } from "vitest";
import {
  MANDATORY_NOTIFICATION_TYPES,
  NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
  NOTIFICATION_ROUTING_POLICY,
  appendRoutingAudit,
  classifyNotification,
  createDefaultNotificationPreferences,
  describeRoutingReason,
  isMandatoryNotificationType,
  loadNotificationPreferences,
  loadRoutingAudit,
  notificationPreferencesStorageKey,
  routeNotification,
  sanitizeNotificationPreferences,
  saveNotificationPreferences,
  saveRoutingAudit,
  setOptionalMuteUntil,
  setOptionalNotificationEnabled,
  type NotificationPreferences,
} from "../lib/notification-routing";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const NOW = new Date("2026-10-16T12:00:00.000Z");

describe("mandatory-alert classification", () => {
  it("classifies failure, recovery, approval, protocol, and pause alerts as mandatory", () => {
    const mandatory = [
      "action_failed",
      "recovery_failed",
      "recovery_path_available",
      "recovery_resolved",
      "approval_required",
      "protocol_alert",
      "vault_pause",
    ] as const;
    for (const type of mandatory) {
      expect(isMandatoryNotificationType(type)).toBe(true);
      expect(classifyNotification(type).classification).toBe("mandatory");
    }
    expect(MANDATORY_NOTIFICATION_TYPES.sort()).toEqual([...mandatory].sort());
  });

  it("classifies reminders, confirmations, and informational alerts as optional", () => {
    for (const type of ["maturity", "claim_window", "apy_change", "deposit", "action_completed", "account"] as const) {
      expect(isMandatoryNotificationType(type)).toBe(false);
      expect(classifyNotification(type).classification).toBe("optional");
    }
  });

  it("promotes any optional type to mandatory when severity is critical", () => {
    expect(classifyNotification("account", "critical")).toEqual({
      classification: "mandatory",
      reason: "severity_promotion",
    });
    expect(classifyNotification("account", "info").classification).toBe("optional");
  });

  it("exposes a policy entry for every routable type", () => {
    for (const [type, entry] of Object.entries(NOTIFICATION_ROUTING_POLICY)) {
      expect(entry.description.length).toBeGreaterThan(0);
      if (entry.classification === "mandatory") expect(entry.reason).toBeDefined();
      expect(typeof type).toBe("string");
    }
  });
});

describe("durable preference document", () => {
  it("migrates a bare array of disabled types and strips mandatory entries", () => {
    const { preferences, repairs, migrated } = sanitizeNotificationPreferences(
      ["apy_change", "vault_pause", "not_a_type", "apy_change"],
      NOW,
    );
    expect(migrated).toBe(true);
    expect(preferences.schemaVersion).toBe(NOTIFICATION_PREFERENCE_SCHEMA_VERSION);
    expect(preferences.disabledTypes).toEqual(["apy_change"]);
    expect(repairs.some((r) => r.includes("vault_pause"))).toBe(true);
    expect(repairs.some((r) => r.includes("not_a_type"))).toBe(true);
  });

  it("migrates the legacy backend shape and preserves a valid revision", () => {
    const { preferences, migrated } = sanitizeNotificationPreferences(
      { disabledTypes: ["maturity"], revision: 7, updatedAt: NOW.toISOString() },
      NOW,
    );
    expect(migrated).toBe(true);
    expect(preferences.disabledTypes).toEqual(["maturity"]);
    expect(preferences.revision).toBe(7);
  });

  it("drops invalid mute timestamps and repairs invalid revisions", () => {
    const { preferences, repairs } = sanitizeNotificationPreferences(
      { schemaVersion: 2, disabledTypes: [], optionalMutedUntil: "not-a-date", revision: -3 },
      NOW,
    );
    expect(preferences.optionalMutedUntil).toBeNull();
    expect(preferences.revision).toBe(1);
    expect(repairs.some((r) => r.includes("mute"))).toBe(true);
  });

  it("degrades to defaults when stored JSON is corrupt, without throwing", () => {
    const storage = fakeStorage({ [notificationPreferencesStorageKey("walletA@testnet")]: "{not json" });
    const { preferences, repairs } = loadNotificationPreferences(storage, "walletA@testnet", NOW);
    expect(preferences).toEqual(createDefaultNotificationPreferences(NOW));
    expect(repairs).toHaveLength(1);
  });

  it("round-trips through durable storage per scope", () => {
    const storage = fakeStorage();
    const base = createDefaultNotificationPreferences(NOW);
    const { preferences } = setOptionalNotificationEnabled(base, "claim_window", false, NOW);
    saveNotificationPreferences(storage, "walletA@testnet", preferences);

    const reloaded = loadNotificationPreferences(storage, "walletA@testnet", NOW);
    expect(reloaded.preferences.disabledTypes).toEqual(["claim_window"]);
    expect(reloaded.preferences.revision).toBe(2);
    // A different wallet scope never sees the first wallet's preferences.
    expect(loadNotificationPreferences(storage, "walletB@testnet", NOW).preferences.disabledTypes).toEqual([]);
  });

  it("refuses to disable mandatory types and unknown types", () => {
    const base = createDefaultNotificationPreferences(NOW);
    const mandatory = setOptionalNotificationEnabled(base, "protocol_alert", false, NOW);
    expect(mandatory.changed).toBe(false);
    expect(mandatory.rejectedReason).toContain("mandatory");
    expect(mandatory.preferences.disabledTypes).toEqual([]);

    const unknown = setOptionalNotificationEnabled(base, "does_not_exist", false, NOW);
    expect(unknown.changed).toBe(false);
    expect(unknown.rejectedReason).toContain("Unknown");
  });

  it("toggles an optional type idempotently and bumps the revision on real changes", () => {
    const base = createDefaultNotificationPreferences(NOW);
    const disabled = setOptionalNotificationEnabled(base, "apy_change", false, NOW);
    expect(disabled.changed).toBe(true);
    expect(disabled.preferences.revision).toBe(base.revision + 1);
    const again = setOptionalNotificationEnabled(disabled.preferences, "apy_change", false, NOW);
    expect(again.changed).toBe(false);
    const enabled = setOptionalNotificationEnabled(again.preferences, "apy_change", true, NOW);
    expect(enabled.changed).toBe(true);
    expect(enabled.preferences.disabledTypes).toEqual([]);
  });

  it("mutes optional alerts until a timestamp and rejects invalid input", () => {
    const base = createDefaultNotificationPreferences(NOW);
    const muted = setOptionalMuteUntil(base, "2026-10-17T00:00:00.000Z", NOW);
    expect(muted.changed).toBe(true);
    expect(muted.preferences.optionalMutedUntil).toBe("2026-10-17T00:00:00.000Z");
    expect(setOptionalMuteUntil(base, "yesterday-ish", NOW).rejectedReason).toContain("ISO");
    expect(setOptionalMuteUntil(muted.preferences, null, NOW).preferences.optionalMutedUntil).toBeNull();
  });
});

describe("routing decisions", () => {
  const scopeKey = "walletA@testnet";
  const base = createDefaultNotificationPreferences(NOW);

  it("delivers mandatory alerts even when the wallet disabled or muted everything it can", () => {
    const prefs: NotificationPreferences = {
      ...base,
      disabledTypes: ["apy_change"],
      optionalMutedUntil: "2030-01-01T00:00:00.000Z",
    };
    for (const type of ["action_failed", "protocol_alert", "vault_pause", "approval_required"] as const) {
      const route = routeNotification({ type, identityKey: `k-${type}` }, prefs, { scopeKey, now: NOW });
      expect(route.deliver).toBe(true);
      expect(route.classification).toBe("mandatory");
      expect(route.reason).toBe("mandatory_type");
    }
  });

  it("delivers an optional type promoted by critical severity despite an active mute window", () => {
    const prefs = { ...base, optionalMutedUntil: "2030-01-01T00:00:00.000Z" };
    const route = routeNotification({ type: "account", severity: "critical", identityKey: "sec-1" }, prefs, {
      scopeKey,
      now: NOW,
    });
    expect(route.deliver).toBe(true);
    expect(route.reason).toBe("mandatory_severity_promotion");
  });

  it("suppresses a disabled optional type with an auditable reason", () => {
    const prefs = { ...base, disabledTypes: ["claim_window" as const] };
    const route = routeNotification({ type: "claim_window", identityKey: "pos-1" }, prefs, { scopeKey, now: NOW });
    expect(route.deliver).toBe(false);
    expect(route.decision).toBe("suppressed");
    expect(route.reason).toBe("disabled_by_preference");
    expect(route.audit.preferenceRevision).toBe(prefs.revision);
    expect(describeRoutingReason(route.reason)).toContain("wallet disabled");
  });

  it("suppresses optional alerts inside an active mute window but delivers after it expires", () => {
    const prefs = { ...base, optionalMutedUntil: "2026-10-16T18:00:00.000Z" };
    const during = routeNotification({ type: "reward_event", identityKey: "r-1" }, prefs, { scopeKey, now: NOW });
    expect(during.deliver).toBe(false);
    expect(during.reason).toBe("optional_muted");

    const later = routeNotification({ type: "reward_event", identityKey: "r-1" }, prefs, {
      scopeKey,
      now: new Date("2026-10-16T19:00:00.000Z"),
    });
    expect(later.deliver).toBe(true);
    expect(later.reason).toBe("preferences_allow");
  });

  it("produces deterministic audit ids for identical evaluations and distinct ids across revisions", () => {
    const first = routeNotification({ type: "maturity", identityKey: "pos-9" }, base, { scopeKey, now: NOW });
    const second = routeNotification({ type: "maturity", identityKey: "pos-9" }, base, { scopeKey, now: NOW });
    expect(first.audit.id).toBe(second.audit.id);

    const revised = { ...base, revision: base.revision + 1 };
    const afterRevision = routeNotification({ type: "maturity", identityKey: "pos-9" }, revised, {
      scopeKey,
      now: NOW,
    });
    expect(afterRevision.audit.id).not.toBe(first.audit.id);
  });
});

describe("bounded routing audit trail", () => {
  const scopeKey = "walletA@testnet";

  it("collapses identical consecutive evaluations into counted records", () => {
    const route = routeNotification({ type: "apy_change", identityKey: "v-1" }, createDefaultNotificationPreferences(NOW), {
      scopeKey,
      now: NOW,
    });
    let audit = appendRoutingAudit([], route.audit);
    audit = appendRoutingAudit(audit, route.audit);
    expect(audit).toHaveLength(1);
    expect(audit[0].count).toBe(2);
    expect(audit[0].firstAt).toBe(NOW.toISOString());
  });

  it("bounds the log and keeps the newest records", () => {
    let audit = [] as ReturnType<typeof appendRoutingAudit>;
    for (let i = 0; i < 12; i += 1) {
      const route = routeNotification(
        { type: "claim_window", identityKey: `pos-${i}` },
        createDefaultNotificationPreferences(NOW),
        { scopeKey, now: new Date(NOW.getTime() + i * 1000) },
      );
      audit = appendRoutingAudit(audit, route.audit, 5);
    }
    expect(audit).toHaveLength(5);
    expect(audit[0].identityKey).toBe("pos-11");
    expect(audit[4].identityKey).toBe("pos-7");
  });

  it("survives a reload through durable storage", () => {
    const storage = fakeStorage();
    const route = routeNotification({ type: "action_failed", identityKey: "a-1" }, createDefaultNotificationPreferences(NOW), {
      scopeKey,
      now: NOW,
    });
    saveRoutingAudit(storage, scopeKey, appendRoutingAudit([], route.audit));
    const reloaded = loadRoutingAudit(storage, scopeKey);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].decision).toBe("delivered");
    expect(reloaded[0].type).toBe("action_failed");
  });

  it("ignores corrupt stored audit payloads", () => {
    const storage = fakeStorage({ "vaultquest:notification-routing-audit:walletA@testnet": "[not json" });
    expect(loadRoutingAudit(storage, scopeKey)).toEqual([]);
  });
});
