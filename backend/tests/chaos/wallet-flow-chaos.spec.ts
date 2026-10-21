/**
 * Chaos tests for wallet interaction flows (Issue #1).
 * 
 * Tests wallet approval, transaction submission, and timeout recovery under
 * failures. Verifies idempotent retry and recovery checkpoint progression.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createTestPrisma } from "../helpers/db.js";
import { LedgerService } from "../../src/services/ledger.js";
import { CacheService } from "../../src/services/cacheService.js";
import type { PrismaClient } from "@prisma/client";
import { runChaosTest, ChaosScenario, ProcessRestartError } from "./chaos-framework.js";
import { AppError } from "../../src/errors.js";
import { ERROR_CODES } from "../../src/constants.js";

const WALLET_CHAOS_SCENARIOS: ChaosScenario[] = [
  {
    name: "wallet_approval_with_timeout",
    faults: [
      { type: "network_timeout", atOperation: 4 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "tx_submission_with_process_restart",
    faults: [
      { type: "process_restart", atOperation: 5 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "wallet_flow_with_browser_refresh",
    faults: [
      { type: "process_restart", atOperation: 3 },
      { type: "network_timeout", atOperation: 7 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "tx_hash_attachment_with_conflict",
    faults: [
      { type: "transaction_conflict", atOperation: 6 },
    ],
    expectedOutcome: "success",
  },
];

describe("Wallet Flow Chaos Tests", () => {
  let prisma: PrismaClient;
  let ledgerService: LedgerService;
  let cacheService: CacheService;

  beforeEach(async () => {
    prisma = await createTestPrisma();
    cacheService = new CacheService(prisma, null);
    ledgerService = new LedgerService(prisma, cacheService);
  });

  it("wallet approval survives timeout and resumes", async () => {
    const scenario = WALLET_CHAOS_SCENARIOS[0];
    const walletAddress = "GCHAOSWALLET1";
    const idempotencyKey = `wallet-approval-${Date.now()}`;

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Create action intent
        await coordinator.beforeOperation("create_intent");
        let action = await ledgerService.createAction({
          idempotencyKey,
          walletAddress,
          actionType: "deposit",
          actionPayload: { amount: "7000", poolId: "wallet-pool" },
        });

        // Op 2: Mark checkpoint: intent_recorded
        await coordinator.beforeOperation("checkpoint_intent");
        await ledgerService.markCheckpoint({
          id: action.id,
          checkpoint: { stage: "intent_recorded" },
        });

        // Op 3: Request wallet approval
        await coordinator.beforeOperation("request_wallet_approval");
        await ledgerService.markCheckpoint({
          id: action.id,
          checkpoint: { stage: "wallet_approval_requested" },
        });

        // Op 4: Simulate wallet response (network_timeout fault)
        await coordinator.beforeOperation("wallet_response");
        try {
          await ledgerService.markCheckpoint({
            id: action.id,
            checkpoint: { stage: "external_action_started" },
          });
        } catch (err) {
          if (err instanceof AppError && err.code === ERROR_CODES.NETWORK_ERROR) {
     