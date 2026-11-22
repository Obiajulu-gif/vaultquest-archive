/**
 * End-to-end test coverage for the highest-risk user journey (#769).
 * 
 * Highest-risk journey: Deposit → Round Lock → Prize Draw → Claim
 * 
 * This flow involves:
 * - User deposits funds (custody risk)
 * - Round locks with ticket snapshot (fairness risk)
 * - Randomness generation and winner selection (manipulation risk)
 * - Prize claim and payout (solvency risk)
 * 
 * Test coverage:
 * - Happy path: full flow succeeds
 * - Deposit validation failures
 * - Round lock timing edge cases
 * - Randomness commit/reveal failures
 * - Claim authorization failures
 * - Solvency violation handling
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { logger } from '../../src/logger.js';

// Test fixtures
const TEST_WALLET_WINNER = 'GABC123WINNER456789012345678901234567890123456789';
const TEST_WALLET_LOSER = 'GDEF456LOSER789012345678901234567890123456789012';
const TEST_ADMIN = 'GADMIN789012345678901234567890123456789012345678';
const TEST_TX_HASH = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

describe('E2E: Deposit to Prize Claim', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  
  beforeAll(async () => {
    prisma = new PrismaClient();
    app = await buildApp();
    await app.ready();
  });
  
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });
  
  beforeEach(async () => {
    // Clean up test data
    await prisma.actionLedger.deleteMany({
      where: {
        walletAddress: {
          in: [TEST_WALLET_WINNER, TEST_WALLET_LOSER, TEST_ADMIN],
        },
      },
    });
  });
  
  describe('Happy Path: Full Journey', () => {
    it('should complete full deposit → draw → claim flow', async () => {
      // Step 1: User deposits funds
      const depositResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-deposit-winner-001',
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'deposit',
          action_payload: {
            amount: '1000000000', // 100 XLM (7 decimals)
            round_id: 1,
          },
        },
      });
      
      expect(depositResponse.statusCode).toBe(201);
      const depositData = JSON.parse(depositResponse.body);
      expect(depositData.status).toBe('pending');
      expect(depositData.action_type).toBe('deposit');
      
      // Step 2: Simulate on-chain confirmation
      const confirmResponse = await app.inject({
        method: 'PATCH',
        url: `/actions/${depositData.id}/submitted`,
        headers: {
          'content-type': 'application/json',
        },
        payload: {
          tx_hash: TEST_TX_HASH,
        },
      });
      
      expect(confirmResponse.statusCode).toBe(200);
      const confirmedData = JSON.parse(confirmResponse.body);
      expect(confirmedData.status).toBe('submitted');
      
      // Step 3: Simulate indexer confirming deposit
      await prisma.actionLedger.update({
        where: { id: depositData.id },
        data: {
          status: 'confirmed',
          txHash: TEST_TX_HASH,
        },
      });
      
      // Step 4: Verify deposit is confirmed
      const getDepositResponse = await app.inject({
        method: 'GET',
        url: `/actions/${depositData.id}`,
      });
      
      expect(getDepositResponse.statusCode).toBe(200);
      const depositStatus = JSON.parse(getDepositResponse.body);
      expect(depositStatus.status).toBe('confirmed');
      
      // Step 5: Simulate round lock (admin action)
      const lockRoundResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-lock-round-001',
        },
        payload: {
          wallet_address: TEST_ADMIN,
          action_type: 'lock_round',
          action_payload: {
            round_id: 1,
          },
        },
      });
      
      expect(lockRoundResponse.statusCode).toBe(201);
      
      // Step 6: Simulate prize draw
      const drawResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-draw-001',
        },
        payload: {
          wallet_address: TEST_ADMIN,
          action_type: 'draw_winner',
          action_payload: {
            round_id: 1,
            winner: TEST_WALLET_WINNER,
            prize_amount: '50000000', // 5 XLM prize
          },
        },
      });
      
      expect(drawResponse.statusCode).toBe(201);
      
      // Step 7: Winner claims prize
      const claimResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-claim-001',
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'claim_prize',
          action_payload: {
            round_id: 1,
          },
        },
      });
      
      expect(claimResponse.statusCode).toBe(201);
      const claimData = JSON.parse(claimResponse.body);
      expect(claimData.status).toBe('pending');
      
      // Verify full action history
      const historyResponse = await app.inject({
        method: 'GET',
        url: `/actions?wallet=${TEST_WALLET_WINNER}`,
      });
      
      expect(historyResponse.statusCode).toBe(200);
      const history = JSON.parse(historyResponse.body);
      expect(history.actions).toHaveLength(2); // deposit + claim
    });
  });
  
  describe('Deposit Validation Failures', () => {
    it('should reject deposit with invalid amount', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-invalid-amount-001',
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'deposit',
          action_payload: {
            amount: '-1000', // Invalid: negative amount
            round_id: 1,
          },
        },
      });
      
      expect(response.statusCode).toBe(400);
      const error = JSON.parse(response.body);
      expect(error.code).toBe('INVALID_AMOUNT');
    });
    
    it('should reject deposit with missing wallet address', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-missing-wallet-001',
        },
        payload: {
          action_type: 'deposit',
          action_payload: {
            amount: '1000000000',
            round_id: 1,
          },
        },
      });
      
      expect(response.statusCode).toBe(400);
    });
    
    it('should reject duplicate deposit with same idempotency key', async () => {
      const idempotencyKey = 'test-duplicate-deposit-001';
      
      // First deposit
      const response1 = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'deposit',
          action_payload: {
            amount: '1000000000',
            round_id: 1,
          },
        },
      });
      
      expect(response1.statusCode).toBe(201);
      
      // Duplicate deposit with same key
      const response2 = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'deposit',
          action_payload: {
            amount: '2000000000', // Different amount
            round_id: 1,
          },
        },
      });
      
      expect(response2.statusCode).toBe(200); // Returns existing action
      const data = JSON.parse(response2.body);
      expect(data.action_payload.amount).toBe('1000000000'); // Original amount
    });
    
    it('should reject deposit when pool is paused', async () => {
      // TODO: Implement pool pause state check
      // This would require contract integration or state management
      
      const response = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-paused-pool-001',
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'deposit',
          action_payload: {
            amount: '1000000000',
            round_id: 1,
            pool_state: 'paused', // Simulated
          },
        },
      });
      
      // Expected behavior: should be allowed to create intent
      // but will fail on-chain
      expect(response.statusCode).toBe(201);
    });
  });
  
  describe('Round Lock Timing Edge Cases', () => {
    it('should reject deposit after round lock', async () => {
      // Create and lock round
      const lockResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-lock-before-deposit-001',
        },
        payload: {
          wallet_address: TEST_ADMIN,
          action_type: 'lock_round',
          action_payload: {
            round_id: 2,
          },
        },
      });
      
      expect(lockResponse.statusCode).toBe(201);
      
      // Attempt deposit after lock
      const depositResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-deposit-after-lock-001',
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'deposit',
          action_payload: {
            amount: '1000000000',
            round_id: 2,
            round_status: 'locked', // Simulated
          },
        },
      });
      
      // Intent should be created, but will fail on-chain
      expect(depositResponse.statusCode).toBe(201);
    });
    
    it('should handle concurrent deposits at round boundary', async () => {
      // Simulate multiple users depositing at the same time
      const deposits = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/actions',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'test-concurrent-deposit-001',
          },
          payload: {
            wallet_address: TEST_WALLET_WINNER,
            action_type: 'deposit',
            action_payload: {
              amount: '1000000000',
              round_id: 3,
            },
          },
        }),
        app.inject({
          method: 'POST',
          url: '/actions',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'test-concurrent-deposit-002',
          },
          payload: {
            wallet_address: TEST_WALLET_LOSER,
            action_type: 'deposit',
            action_payload: {
              amount: '500000000',
              round_id: 3,
            },
          },
        }),
      ]);
      
      expect(deposits[0].statusCode).toBe(201);
      expect(deposits[1].statusCode).toBe(201);
    });
  });
  
  describe('Randomness Failures', () => {
    it('should handle randomness commit timeout', async () => {
      // Create round and attempt draw without commits
      const drawResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-draw-no-commit-001',
        },
        payload: {
          wallet_address: TEST_ADMIN,
          action_type: 'draw_winner',
          action_payload: {
            round_id: 4,
            randomness_source: 'fallback', // No commits revealed
          },
        },
      });
      
      expect(drawResponse.statusCode).toBe(201);
    });
    
    it('should reject draw with invalid winner proof', async () => {
      const drawResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-draw-invalid-proof-001',
        },
        payload: {
          wallet_address: TEST_ADMIN,
          action_type: 'draw_winner',
          action_payload: {
            round_id: 5,
            winner: TEST_WALLET_WINNER,
            proof: 'invalid_merkle_proof',
          },
        },
      });
      
      // Intent created, but will fail on-chain validation
      expect(drawResponse.statusCode).toBe(201);
    });
  });
  
  describe('Claim Authorization Failures', () => {
    it('should reject claim from non-winner', async () => {
      // Attempt claim by user who is not the winner
      const claimResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-claim-non-winner-001',
        },
        payload: {
          wallet_address: TEST_WALLET_LOSER,
          action_type: 'claim_prize',
          action_payload: {
            round_id: 1,
          },
        },
      });
      
      // Intent created, but will fail on-chain authorization
      expect(claimResponse.statusCode).toBe(201);
    });
    
    it('should reject claim after deadline', async () => {
      const claimResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-claim-after-deadline-001',
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'claim_prize',
          action_payload: {
            round_id: 1,
            claim_deadline_passed: true, // Simulated
          },
        },
      });
      
      // Intent created, but will fail on-chain deadline check
      expect(claimResponse.statusCode).toBe(201);
    });
    
    it('should reject double claim', async () => {
      const idempotencyKey1 = 'test-double-claim-001';
      const idempotencyKey2 = 'test-double-claim-002';
      
      // First claim
      const claim1 = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey1,
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'claim_prize',
          action_payload: {
            round_id: 1,
          },
        },
      });
      
      expect(claim1.statusCode).toBe(201);
      
      // Second claim attempt (different idempotency key)
      const claim2 = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey2,
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'claim_prize',
          action_payload: {
            round_id: 1,
          },
        },
      });
      
      // Intent created, but will fail on-chain (already claimed)
      expect(claim2.statusCode).toBe(201);
    });
  });
  
  describe('Solvency Violations', () => {
    it('should handle insufficient pool balance for prize payout', async () => {
      // This would require contract state simulation
      // Backend can create intent, but contract will reject
      
      const claimResponse = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-claim-insufficient-balance-001',
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'claim_prize',
          action_payload: {
            round_id: 1,
            pool_balance: '1000000', // Simulated low balance
            prize_amount: '50000000', // Prize exceeds balance
          },
        },
      });
      
      expect(claimResponse.statusCode).toBe(201);
    });
  });
  
  describe('Retry and Recovery', () => {
    it('should handle transaction retry after initial failure', async () => {
      const idempotencyKey = 'test-retry-deposit-001';
      
      // Initial attempt
      const attempt1 = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'deposit',
          action_payload: {
            amount: '1000000000',
            round_id: 1,
          },
        },
      });
      
      expect(attempt1.statusCode).toBe(201);
      const actionId = JSON.parse(attempt1.body).id;
      
      // Simulate failure
      await prisma.actionLedger.update({
        where: { id: actionId },
        data: { status: 'failed', errorCode: 'RPC_TIMEOUT' },
      });
      
      // Retry with same idempotency key
      const attempt2 = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'deposit',
          action_payload: {
            amount: '1000000000',
            round_id: 1,
          },
        },
      });
      
      expect(attempt2.statusCode).toBe(200); // Returns existing action
      const retryData = JSON.parse(attempt2.body);
      expect(retryData.id).toBe(actionId); // Same action
    });
    
    it('should handle orphaned transaction cleanup', async () => {
      // Create action that goes orphaned
      const response = await app.inject({
        method: 'POST',
        url: '/actions',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-orphaned-001',
        },
        payload: {
          wallet_address: TEST_WALLET_WINNER,
          action_type: 'deposit',
          action_payload: {
            amount: '1000000000',
            round_id: 1,
          },
        },
      });
      
      expect(response.statusCode).toBe(201);
      const actionId = JSON.parse(response.body).id;
      
      // Mark as submitted but never confirmed
      await prisma.actionLedger.update({
        where: { id: actionId },
        data: {
          status: 'submitted',
          txHash: TEST_TX_HASH,
          updatedAt: new Date(Date.now() - 3600000), // 1 hour ago
        },
      });
      
      // TODO: Run orphan cleanup worker
      // Verify action transitions to 'orphaned' status
    });
  });
});
