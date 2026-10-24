/**
 * Deterministic chaos testing framework for Issue #1.
 * 
 * Provides injectable faults (network failures, process restarts, stale reads,
 * retries) with deterministic sequencing to avoid flaky timing assumptions.
 * 
 * Design:
 * - ChaosScenario defines a deterministic sequence of failures
 * - ChaosCoordinator intercepts operations and injects faults
 * - Tests verify system recovers to correct state after fault sequence
 */

import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../src/errors.js";
import { ERROR_CODES } from "../../src/constants.js";

export type FaultType =
  | "network_timeout"
  | "network_disconnect"
  | "process_restart"
  | "stale_read"
  | "retry_exhausted"
  | "transaction_conflict";

export interface Fault {
  type: FaultType;
  /** Operation sequence number when fault triggers (deterministic) */
  atOperation: number;
  /** How many times this fault repeats */
  repeatCount?: number;
  /** Millisecond delay to simulate (not actual delay, just recorded) */
  delayMs?: number;
}

export interface ChaosScenario {
  name: string;
  faults: Fault[];
  /** Expected recovery state after all faults */
  expectedOutcome: "success" | "compensated" | "manual_intervention";
}

export class ChaosCoordinator {
  private operationCount = 0;
  private faultIndex = 0;
  private executedFaults: Fault[] = [];
  private staleDataOverride: Record<string, unknown> | null = null;

  constructor(private scenario: ChaosScenario) {}

  /** Call before each operation to check if fault should trigger */
  async beforeOperation(operationName: string): Promise<void> {
    this.operationCount++;

    const nextFault = this.scenario.faults[this.faultIndex];
    if (!nextFault || nextFault.atOperation !== this.operationCount) {
      return;
    }

    this.executedFaults.push(nextFault);
    this.faultIndex++;

    switch (nextFault.type) {
      case "network_timeout":
        throw new AppError(ERROR_CODES.NETWORK_ERROR, `Chaos: network timeout at ${operationName}`);
      
      case "network_disconnect":
        throw new AppError(ERROR_CODES.NETWORK_ERROR, `Chaos: network disconnect at ${operationName}`);
      
      case "process_restart":
        // Simulated by throwing; test harness should catch and restart flow
        throw new ProcessRestartError(`Chaos: process restart at ${operationName}`);
      
      case "transaction_conflict":
        throw new AppError(ERROR_CODES.CONFLICT, `Chaos: transaction conflict at ${operationName}`);
      
      case "retry_exhausted":
        throw new AppError(ERROR_CODES.NETWORK_ERROR, `Chaos: retries exhausted at ${operationName}`);
      
      case "stale_read":
        // Mark next read as stale; actual injection happens in interceptRead
        this.staleDataOverride = { __stale: true, operation: operationName };
        break;
    }
  }

  /** Inject stale data into read operations */
  interceptRead<T>(data: T): T {
    if (this.staleDataOverride) {
      const stale = { ...data, ...this.staleDataOverride };
      this.staleDataOverride = null;
      return stale as T;
    }
    return data;
  }

  getExecutedFaults(): Fault[] {
    return this.executedFaults;
  }

  reset(): void {
    this.operationCount = 0;
    this.faultIndex = 0;
    this.executedFaults = [];
    this.staleDataOverride = null;
  }
}

export class ProcessRestartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessRestartError";
  }
}

/**
 * Test helper: wrap a workflow with chaos injection and verify recovery.
 * 
 * The workflow function receives a ChaosCoordinator and must call
 * beforeOperation() before each critical operation.
 */
export async function runChaosTest<T>(
  scenario: ChaosScenario,
  workflow: (coordinator: ChaosCoordinator) => Promise<T>,
  verifyRecovery: (result: T | null, faults: Fault[]) => Promise<void>
): Promise<void> {
  const coordinator = new ChaosCoordinator(scenario);
  let result: T | null = null;
  let restartCount = 0;
  const MAX_RESTARTS = 5;

  while (restartCount <= MAX_RESTARTS) {
    try {
      result = await workflow(coordinator);
      break; // Success
    } catch (err) {
      if (err instanceof ProcessRestartError) {
        restartCount++;
        if (restartCount > MAX_RESTARTS) {
          throw new Error(`Chaos test exceeded max restarts (${MAX_RESTARTS})`);
        }
        // Workflow should be idempotent; restart from beginning
        continue;
      }
      // Other errors are expected faults; workflow should handle or propagate
      if (err instanceof AppError) {
        // Workflow chose to propagate fault; this is terminal
        break;
      }
      throw err;
    }
  }

  await verifyRecovery(result, coordinator.getExecutedFaults());
}

/**
 * Standard chaos scenarios for vault operations.
 */
export const VAULT_CHAOS_SCENARIOS: ChaosScenario[] = [
  {
    name: "deposit_with_network_timeout_then_success",
    faults: [
      { type: "network_timeout", atOperation: 2 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "deposit_with_process_restart_mid_submission",
    faults: [
      { type: "process_restart", atOperation: 3 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "deposit_with_stale_read_then_conflict",
    faults: [
      { type: "stale_read", atOperation: 1 },
      { type: "transaction_conflict", atOperation: 4 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "withdraw_with_multiple_retries",
    faults: [
      { type: "network_timeout", atOperation: 2, repeatCount: 2 },
      { type: "transaction_conflict", atOperation: 5 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "quest_completion_with_concurrent_conflicts",
    faults: [
      { type: "transaction_conflict", atOperation: 3 },
      { type: "stale_read", atOperation: 4 },
    ],
    expectedOutcome: "success",
  },
];
