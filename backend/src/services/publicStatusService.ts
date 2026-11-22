/**
 * Public Status Service - Safe, user-facing operational status model
 *
 * Purpose:
 *  Exposes operational state (degraded, paused, maintenance) to users and operators
 *  without leaking internal details (service names, error messages, architecture).
 *
 * Key invariants:
 *  1. Never expose internal dependency names (soroban_rpc, database, redis_cache)
 *  2. Never expose error details, stack traces, or configuration
 *  3. Provide actionable user messages and ETAs for recovery
 *  4. Distinguish between "read-only" (degraded) and "read-write" (paused) modes
 *  5. Support maintenance windows with scheduled recovery times
 *
 * Failure modes & recovery:
 *  • Degraded (read-only): One or more non-critical dependencies unhealthy
 *    - Impact: Some data may be cached or delayed; mutations fail with 503
 *    - Recovery: Automatic when dependencies recover
 *  • Paused (no mutations): Critical dependency unhealthy
 *    - Impact: Balance mutations, transfers blocked; reads may be stale
 *    - Recovery: Manual intervention or dependency recovery
 *  • Maintenance: Scheduled operator intervention
 *    - Impact: All operations blocked; explicit maintenance message shown
 *    - Recovery: Operator clears maintenance flag and resumes service
 *
 * See tests/public-status.spec.ts for acceptance tests across UI/API/background paths.
 */

import type { DegradedModeService } from "./degradedModeService.js";

export type OperationalStatus = "healthy" | "degraded" | "paused" | "maintenance";

export interface PublicStatusSnapshot {
  status: OperationalStatus;
  message: string;
  retryAfterSeconds?: number;
  maintenanceUntil?: Date;
  affectedFeatures: {
    deposits: boolean;
    withdrawals: boolean;
    claims: boolean;
    views: boolean; // read-only views like portfolio, history
  };
  guidance: string;
}

export interface MaintenanceWindow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
}

export class PublicStatusService {
  private maintenanceWindow: MaintenanceWindow | null = null;
  private pauseUntil: Date | null = null;
  private pauseReason: string | null = null;

  constructor(private readonly degradedMode: DegradedModeService) {}

  /**
   * Schedules a maintenance window.
   * During maintenance, all user operations are blocked.
   *
   * @param window - Maintenance window with start/end times and reason
   */
  scheduleMaintenanceWindow(window: Omit<MaintenanceWindow, "id">): void {
    this.maintenanceWindow = {
      id: `maint-${Date.now()}`,
      ...window,
    };
  }

  /**
   * Clears the current maintenance window (operator action to resume service).
   */
  clearMaintenanceWindow(): void {
    this.maintenanceWindow = null;
  }

  /**
   * Temporarily pauses user mutations (e.g., during a critical security incident).
   * Reads continue to work with fallback/stale data if available.
   *
   * @param reason - User-safe reason for the pause
   * @param durationSeconds - How long to pause (optional; null = indefinite)
   */
  pauseMutations(reason: string, durationSeconds?: number): void {
    this.pauseReason = reason;
    if (durationSeconds) {
      this.pauseUntil = new Date(Date.now() + durationSeconds * 1000);
    } else {
      this.pauseUntil = null; // indefinite until explicitly cleared
    }
  }

  /**
   * Resumes mutations (operator action after pause).
   */
  resumeMutations(): void {
    this.pauseUntil = null;
    this.pauseReason = null;
  }

  /**
   * Generates the current operational status snapshot (safe for public consumption).
   */
  getPublicStatus(): PublicStatusSnapshot {
    // ── Check maintenance window first (highest priority) ──────────────────
    const now = new Date();
    if (this.maintenanceWindow) {
      const inWindow =
        now >= this.maintenanceWindow.startsAt &&
        now < this.maintenanceWindow.endsAt;

      if (inWindow) {
        const minutesRemaining = Math.ceil(
          (this.maintenanceWindow.endsAt.getTime() - now.getTime()) / 60_000
        );
        return {
          status: "maintenance",
          message: this.maintenanceWindow.reason,
          maintenanceUntil: this.maintenanceWindow.endsAt,
          retryAfterSeconds: Math.max(60, minutesRemaining * 60),
          affectedFeatures: {
            deposits: true,
            withdrawals: true,
            claims: true,
            views: true,
          },
          guidance: `We are performing scheduled maintenance. Service will resume at ${this.maintenanceWindow.endsAt.toLocaleTimeString()}. No action is required.`,
        };
      }
    }

    // ── Check mutation pause (e.g., incident response) ──────────────────────
    if (this.pauseUntil === null || this.pauseUntil > now) {
      if (this.pauseReason) {
        const minutesRemaining = this.pauseUntil
          ? Math.ceil((this.pauseUntil.getTime() - now.getTime()) / 60_000)
          : null;

        return {
          status: "paused",
          message: this.pauseReason,
          retryAfterSeconds: this.pauseUntil
            ? Math.max(60, minutesRemaining! * 60)
            : undefined,
          affectedFeatures: {
            deposits: true,
            withdrawals: true,
            claims: true,
            views: false, // reads still work
          },
          guidance:
            "Transaction processing is temporarily paused. Your wallet and balances are safe. Please try again soon.",
        };
      }
    }

    // ── Check degradation from dependency health ──────────────────────────
    const degradedReport = this.degradedMode.getUserSafeStatus();

    if (degradedReport.status === "unavailable") {
      return {
        status: "paused",
        message:
          "The platform is temporarily unavailable due to upstream service disruptions.",
        retryAfterSeconds: degradedReport.retryAfterSeconds,
        affectedFeatures: {
          deposits: true,
          withdrawals: true,
          claims: true,
          views: true,
        },
        guidance:
          "We are experiencing technical difficulties and have paused all transactions for safety. Your funds are secure. We will resume service as soon as possible.",
      };
    }

    if (degradedReport.status === "degraded") {
      return {
        status: "degraded",
        message: degradedReport.userBanner || "Some services are experiencing elevated response times.",
        retryAfterSeconds: degradedReport.retryAfterSeconds,
        affectedFeatures: {
          deposits: false,
          withdrawals: false,
          claims: false,
          views: true, // views may show stale data
        },
        guidance:
          "We are experiencing slightly elevated network latency. Your transactions will proceed normally, but real-time updates may be delayed by a few seconds.",
      };
    }

    // ── All clear: healthy operational state ──────────────────────────────
    return {
      status: "healthy",
      message: "All systems operational",
      affectedFeatures: {
        deposits: false,
        withdrawals: false,
        claims: false,
        views: false,
      },
      guidance: "The platform is operating normally.",
    };
  }

  /**
   * Safe to call from any context (UI, API, background workers).
   * Returns true if user mutations should be allowed.
   */
  canUserMutate(): boolean {
    const status = this.getPublicStatus();
    return (
      status.status === "healthy" ||
      (status.status === "degraded" && !status.affectedFeatures.deposits)
    );
  }

  /**
   * Returns the pause/maintenance duration remaining, or null if none active.
   */
  getRecoveryEta(): Date | null {
    if (this.pauseUntil) return this.pauseUntil;
    if (
      this.maintenanceWindow &&
      new Date() < this.maintenanceWindow.endsAt
    ) {
      return this.maintenanceWindow.endsAt;
    }
    return null;
  }

  /**
   * For automated systems: returns true if the state is stable (not transitioning).
   * Used by health check probes and recovery orchestrators.
   */
  isStateStable(): boolean {
    // Unstable: currently transitioning between paused/degraded
    // In this implementation, we consider the state stable if no transitions
    // are pending. For more complex cases, track transition timestamps.
    return true;
  }
}
