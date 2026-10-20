/**
 * React hook for conflict-aware operations
 *
 * Provides a hook that wraps operations with optimistic concurrency control
 * and user-facing conflict resolution UI.
 */

import { useCallback, useState } from "react";
import type {
  ConflictError,
  VersionCheckedResult,
  VersionToken,
} from "./concurrencyControl";
import { getRejectionExplanation, VAULT_REJECTION_REASONS } from "./rejectionReasons";

export interface ConflictState {
  hasConflict: boolean;
  conflict: ConflictError | null;
  isResolving: boolean;
}

export interface UseConflictAwareOperationResult<T> {
  state: ConflictState;
  execute: (operation: () => Promise<T>) => Promise<VersionCheckedResult<T>>;
  resolveConflict: () => void;
  refresh: () => void;
}

/**
 * Hook for managing conflict-aware operations
 *
 * @param getVersion Function to get the current version token
 * @param onRefresh Function to refresh data
 * @returns Conflict state and operation executor
 */
export function useConflictAwareOperation<T>(
  getVersion: () => VersionToken | null,
  onRefresh: () => void,
): UseConflictAwareOperationResult<T> {
  const [conflictState, setConflictState] = useState<ConflictState>({
    hasConflict: false,
    conflict: null,
    isResolving: false,
  });

  const execute = useCallback(
    async (operation: () => Promise<T>): Promise<VersionCheckedResult<T>> => {
      setConflictState({ hasConflict: false, conflict: null, isResolving: false });

      try {
        const result = await operation();

        if (result.success === false && result.conflict) {
          setConflictState({
            hasConflict: true,
            conflict: result.conflict,
            isResolving: false,
          });
        }

        return result;
      } catch (error) {
        const errorWithConflict = error as { conflict?: ConflictError };
        if (errorWithConflict.conflict) {
          setConflictState({
            hasConflict: true,
            conflict: errorWithConflict.conflict,
            isResolving: false,
          });
          return { success: false, conflict: errorWithConflict.conflict };
        }
        throw error;
      }
    },
    [],
  );

  const resolveConflict = useCallback(() => {
    setConflictState({ hasConflict: false, conflict: null, isResolving: true });
    onRefresh();
  }, [onRefresh]);

  const refresh = useCallback(() => {
    setConflictState({ hasConflict: false, conflict: null, isResolving: false });
    onRefresh();
  }, [onRefresh]);

  return {
    state: conflictState,
    execute,
    resolveConflict,
    refresh,
  };
}

/**
 * Conflict resolution UI component props
 */
export interface ConflictResolutionUIProps {
  conflict: ConflictError;
  onResolve: () => void;
  onDismiss: () => void;
  isResolving?: boolean;
}

/**
 * Default conflict resolution UI component
 *
 * Shows a user-friendly message when a conflict is detected and provides
 * action buttons to resolve it.
 */
export function ConflictResolutionUI({
  conflict,
  onResolve,
  onDismiss,
  isResolving = false,
}: ConflictResolutionUIProps) {
  const rejectionExplanation = getRejectionExplanation(conflict.reasonCode);

  return (
    <div className="conflict-resolution-banner" role="alert" aria-live="polite">
      <div className="conflict-icon">⚠️</div>
      <div className="conflict-content">
        <h3 className="conflict-title">Data Changed</h3>
        <p className="conflict-message">{conflict.userMessage}</p>
        <p className="conflict-recovery">{conflict.recoveryHint}</p>
        <div className="conflict-actions">
          <button
            onClick={onResolve}
            disabled={isResolving}
            className="conflict-resolve-btn"
          >
            {isResolving ? "Refreshing..." : "Refresh Data"}
          </button>
          <button
            onClick={onDismiss}
            className="conflict-dismiss-btn"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Minimal conflict banner for inline display
 */
export function ConflictBanner({
  conflict,
  onResolve,
  onDismiss,
}: Omit<ConflictResolutionUIProps, "isResolving">) {
  return (
    <div className="conflict-banner" role="alert" aria-live="polite">
      <span className="conflict-banner-icon">⚠️</span>
      <span className="conflict-banner-message">{conflict.userMessage}</span>
      <button
        onClick={onResolve}
        className="conflict-banner-refresh"
        aria-label="Refresh data"
      >
        Refresh
      </button>
      <button
        onClick={onDismiss}
        className="conflict-banner-dismiss"
        aria-label="Dismiss conflict"
      >
        ✕
      </button>
    </div>
  );
}
