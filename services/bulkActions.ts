/**
 * Permission-Aware Bulk Action Framework (#848)
 *
 * Applies bulk operations to eligible selected records with dry-run support,
 * per-record permission checks, and explicit confirmation for execution.
 */

export interface BulkActionInput {
  action: string;
  recordIds: string[];
  actorId: string;
  filters?: Record<string, unknown>;
}

export interface RecordEligibility {
  recordId: string;
  eligible: boolean;
  reason?: string;
  hasPermission: boolean;
}

export interface DryRunResult {
  totalSelected: number;
  eligible: number;
  ineligible: number;
  details: RecordEligibility[];
  wouldModify: string[];
}

export interface ExecutionResult {
  succeeded: string[];
  failed: Array<{ recordId: string; error: string }>;
  confirmationToken: string;
}

export interface PermissionChecker {
  canPerform(actorId: string, action: string, recordId: string): boolean;
}

/**
 * BulkActionProcessor validates eligibility, runs dry-runs, and executes
 * bulk actions with per-record permission enforcement.
 */
export class BulkActionProcessor {
  private permissionChecker: PermissionChecker;
  private confirmationTokens = new Map<string, { input: BulkActionInput; expires: number }>();

  constructor(permissionChecker: PermissionChecker) {
    this.permissionChecker = permissionChecker;
  }

  /**
   * Check eligibility of all selected records without performing any writes.
   */
  dryRun(input: BulkActionInput): DryRunResult {
    const details: RecordEligibility[] = [];
    let eligible = 0;
    let ineligible = 0;

    for (const recordId of input.recordIds) {
      const hasPermission = this.permissionChecker.canPerform(
        input.actorId,
        input.action,
        recordId
      );
      const isEligible = hasPermission;
      if (isEligible) eligible++;
      else ineligible++;

      details.push({
        recordId,
        eligible: isEligible,
        hasPermission,
        reason: hasPermission ? undefined : 'Insufficient permissions',
      });
    }

    return {
      totalSelected: input.recordIds.length,
      eligible,
      ineligible,
      details,
      wouldModify: details.filter(d => d.eligible).map(d => d.recordId),
    };
  }

  /**
   * Generate a confirmation token for executing a bulk action.
   * The token expires after 5 minutes and must be provided to execute.
   */
  generateConfirmationToken(input: BulkActionInput): string {
    const token = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.confirmationTokens.set(token, {
      input: { ...input, recordIds: [...input.recordIds] },
      expires: Date.now() + 5 * 60 * 1000,
    });
    return token;
  }

  /**
   * Execute a bulk action. Requires a valid confirmation token.
   * Applies the action only to eligible records; ineligible records are
   * reported in the failure list.
   */
  execute(
    confirmationToken: string,
    executor: (recordId: string, action: string) => Promise<void> | void
  ): Promise<ExecutionResult> | ExecutionResult {
    const entry = this.confirmationTokens.get(confirmationToken);
    if (!entry || Date.now() > entry.expires) {
      this.confirmationTokens.delete(confirmationToken);
      throw new Error('Invalid or expired confirmation token');
    }
    this.confirmationTokens.delete(confirmationToken);

    const dryRun = this.dryRun(entry.input);
    const succeeded: string[] = [];
    const failed: Array<{ recordId: string; error: string }> = [];

    for (const detail of dryRun.details) {
      if (!detail.eligible) {
        failed.push({ recordId: detail.recordId, error: detail.reason || 'Ineligible' });
        continue;
      }
      try {
        const result = executor(detail.recordId, entry.input.action);
        if (result instanceof Promise) {
          return result
            .then(() => {
              succeeded.push(detail.recordId);
              return this.buildResult(succeeded, failed, confirmationToken);
            })
            .catch(err => {
              failed.push({ recordId: detail.recordId, error: String(err) });
              return this.buildResult(succeeded, failed, confirmationToken);
            });
        }
        succeeded.push(detail.recordId);
      } catch (err) {
        failed.push({ recordId: detail.recordId, error: String(err) });
      }
    }

    return this.buildResult(succeeded, failed, confirmationToken);
  }

  private buildResult(
    succeeded: string[],
    failed: Array<{ recordId: string; error: string }>,
    token: string
  ): ExecutionResult {
    return { succeeded, failed, confirmationToken: token };
  }
}
