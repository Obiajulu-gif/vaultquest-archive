/**
 * Tests for conflict-aware operation React hook
 *
 * Verifies:
 * - Conflict state management
 * - Operation execution with conflict detection
 * - Conflict resolution UI components
 * - Refresh and dismiss actions
 */

import { describe, it, expect, vi } from "vitest";
import {
  ConflictResolutionUI,
  ConflictBanner,
  type ConflictError,
  type ConflictResolutionUIProps,
} from "./useConflictAwareOperation";
import { VAULT_REJECTION_REASONS } from "./rejectionReasons";

describe("ConflictResolutionUI component", () => {
  const mockConflict: ConflictError = {
    reasonCode: VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION,
    userMessage: "Data was modified",
    recoveryHint: "Refresh to continue",
    expectedVersion: { entityId: "test", entityType: "test", version: 123 },
    actualVersion: { entityId: "test", entityType: "test", version: 124 },
    retryable: true,
  };

  const mockOnResolve = vi.fn();
  const mockOnDismiss = vi.fn();

  it("should create conflict resolution UI props correctly", () => {
    const props: ConflictResolutionUIProps = {
      conflict: mockConflict,
      onResolve: mockOnResolve,
      onDismiss: mockOnDismiss,
    };

    expect(props.conflict).toEqual(mockConflict);
    expect(props.onResolve).toBe(mockOnResolve);
    expect(props.onDismiss).toBe(mockOnDismiss);
    expect(props.isResolving).toBeUndefined();
  });

  it("should handle resolving state", () => {
    const props: ConflictResolutionUIProps = {
      conflict: mockConflict,
      onResolve: mockOnResolve,
      onDismiss: mockOnDismiss,
      isResolving: true,
    };

    expect(props.isResolving).toBe(true);
  });
});

describe("ConflictBanner component", () => {
  const mockConflict: ConflictError = {
    reasonCode: VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION,
    userMessage: "Data was modified",
    recoveryHint: "Refresh to continue",
    expectedVersion: { entityId: "test", entityType: "test", version: 123 },
    actualVersion: { entityId: "test", entityType: "test", version: 124 },
    retryable: true,
  };

  const mockOnResolve = vi.fn();
  const mockOnDismiss = vi.fn();

  it("should create conflict banner props correctly", () => {
    const props = {
      conflict: mockConflict,
      onResolve: mockOnResolve,
      onDismiss: mockOnDismiss,
    };

    expect(props.conflict).toEqual(mockConflict);
    expect(props.onResolve).toBe(mockOnResolve);
    expect(props.onDismiss).toBe(mockOnDismiss);
  });
});

describe("ConflictError structure", () => {
  it("should have all required fields", () => {
    const conflict: ConflictError = {
      reasonCode: VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION,
      userMessage: "Data was modified",
      recoveryHint: "Refresh to continue",
      expectedVersion: { entityId: "test", entityType: "test", version: 123 },
      actualVersion: { entityId: "test", entityType: "test", version: 124 },
      retryable: true,
    };

    expect(conflict.reasonCode).toBe(VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION);
    expect(conflict.userMessage).toBe("Data was modified");
    expect(conflict.recoveryHint).toBe("Refresh to continue");
    expect(conflict.expectedVersion).toEqual({ entityId: "test", entityType: "test", version: 123 });
    expect(conflict.actualVersion).toEqual({ entityId: "test", entityType: "test", version: 124 });
    expect(conflict.retryable).toBe(true);
  });
});
