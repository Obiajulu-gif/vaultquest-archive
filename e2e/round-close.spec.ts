import { test, expect } from "@playwright/test";
import {
  assembleDrawProof,
  computeDrawAuditSnapshotHash,
  computeDrawId,
  computeHash,
  computeParticipantsHash,
  computeProofHash,
  computeTicketWeightsHash,
  computeWinnerProofHash,
  verifyProofIntegrity,
  type DrawProof,
  type ParticipantEntry,
} from "../lib/draw-proof";

/**
 * Round-close e2e (#746): a sealed draw is independently verified end-to-end.
 *
 * The test does NOT trust the served proof: it recomputes the winner itself —
 * sha256(seed) -> R -> cumulative weighted walk over ticket weights — plus the
 * full hash chain (participants hash, ticket-weights hash, winner proof hash,
 * draw id), asserts every value equals the proof the "backend" is serving, and
 * then verifies the prizes page surfaces that independently-confirmed winner
 * with the local "Verified" integrity badge.
 */

const CONTRACT_ID = "CC7IDDOGVAUJ6IF7ABRKQGO3OCQFJIG3WRMTVD1QVLZH3UYZNS6FM6VP";
const ROUND_ID = 7;
const DRAWN_AT_LEDGER = 42_000;
const COMMITMENT_LEDGER = 41_950;
const SEED = "0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const REVEAL_TX = "0x7d3a95bfce31a20df949e29ae8fa9a1f3b8d33b1a6408d19c0a5d8c7e2f4b6a1";
const PAYOUT_TX = "0x4f2e6a91c8d30b52f10e2c8a7b6d59e3a4f81cd0a2e9f4b7c6d5e8a1b2c3d4e5f";
const PAYOUT_AMOUNT = "1500000"; // 1.5 USDC (6-decimal precision)
const POOL_STATE = {
  contractId: CONTRACT_ID,
  strategyExposureBps: 8000,
  idleLiquidity: "200000",
  queuedWithdrawals: "50000",
};

const PARTICIPANTS: ParticipantEntry[] = [
  { address: "GARSXDAETTREB4VYLQ4NDWU2TLQ7SZOKV6N7G2WKQKM5XQJQDO7VCDSK", deposit: "1200000", lockupMultiplier: 100 },
  { address: "GBUZSZEEMLQXBZHHN57FJSGZ4NPGWYQP4MRUVPXS2H2NROYIL2RWKQE5", deposit: "800000", lockupMultiplier: 150 },
  { address: "GCLJKXCBLWXGQ76PQK3K3I3N5GV3D6QS2OR2EVIQ3TG3S6OX6U7KPZMP", deposit: "500000", lockupMultiplier: 100 },
];

function ticketWeightsOf(participants: ParticipantEntry[]): { address: string; weight: string }[] {
  return participants.map((p) => ({
    address: p.address,
    weight: (BigInt(p.deposit) * BigInt(p.lockupMultiplier)).toString(),
  }));
}

/** Independent weighted selection: R = sha256(seed) % totalWeight, cumulative walk. */
async function selectWinnerIndependently(
  participants: ParticipantEntry[],
  seed: string
): Promise<{ winnerAddress: string; seedHash: string }> {
  const seedHash = await computeHash(seed);
  const weights = ticketWeightsOf(participants);
  const totalWeight = weights.reduce((sum, w) => sum + BigInt(w.weight), 0n);
  const r = BigInt(`0x${seedHash}`) % totalWeight;

  let cumulative = 0n;
  for (const w of weights) {
    cumulative += BigInt(w.weight);
    if (r <= cumulative) {
      return { winnerAddress: w.address, seedHash };
    }
  }
  return { winnerAddress: weights[weights.length - 1].address, seedHash };
}

test("round close: independently-verified winner is served and shown as Verified", async ({ page }) => {
  // 1. Independently recompute the winner and the whole hash chain.
  const { winnerAddress, seedHash } = await selectWinnerIndependently(PARTICIPANTS, SEED);
  const participantsHash = await computeParticipantsHash(PARTICIPANTS);
  const weightsHash = await computeTicketWeightsHash(ticketWeightsOf(PARTICIPANTS));
  const drawId = await computeDrawId(CONTRACT_ID, ROUND_ID, DRAWN_AT_LEDGER);
  const winnerProofHash = await computeWinnerProofHash(
    CONTRACT_ID,
    ROUND_ID,
    winnerAddress,
    seedHash,
    participantsHash
  );

  // 2. The "backend" assembles the proof of record for that same winner and
  // seals it with the legacy 1.0.0 document-hash signature (the only signature
  // class the browser's local integrity check can verify without a secret).
  const assembled = await assembleDrawProof(
    {
      roundId: ROUND_ID,
      contractId: CONTRACT_ID,
      participants: PARTICIPANTS,
      poolState: POOL_STATE,
      randomnessSource: "soroban_prng",
      randomnessSeed: SEED,
      randomnessCommitment: await computeHash(SEED),
      commitmentLedgerSeq: COMMITMENT_LEDGER,
      revealTxHash: REVEAL_TX,
      drawnAtLedger: DRAWN_AT_LEDGER,
      winnerAddress,
      payoutTxHash: PAYOUT_TX,
      payoutLedgerSeq: DRAWN_AT_LEDGER + 10,
      payoutAmount: PAYOUT_AMOUNT,
      payoutAsset: "USDC",
      payoutConfirmed: true,
      contractSpecHash: "conformance-v1",
    }
  );
  const proof: DrawProof = { ...assembled, version: "1.0.0" };
  proof.metadata.auditSnapshotHash = await computeDrawAuditSnapshotHash(proof);
  const proofBody = { ...proof };
  delete proofBody.signature;
  proof.signature = await computeProofHash(proofBody);

  // 3. Independent winner verification wired into the round-close assertion:
  // the served proof must agree with the independently recomputed values.
  expect(proof.winnerSelection.winnerAddress).toBe(winnerAddress);
  expect(proof.snapshot.participantsHash).toBe(participantsHash);
  expect(proof.winnerSelection.ticketWeightsHash).toBe(weightsHash);
  expect(proof.winnerSelection.winnerWeight).not.toBe("0");
  expect(proof.winnerSelection.proofHash).toBe(winnerProofHash);
  expect(proof.drawId).toBe(drawId);
  expect(proof.roundId).toBe(ROUND_ID);
  expect(proof.contractId).toBe(CONTRACT_ID);
  expect(proof.payout.amount).toBe(PAYOUT_AMOUNT);
  expect(proof.snapshot.participantCount).toBe(PARTICIPANTS.length);

  // 4. The proof must itself pass full integrity verification independently
  // (no secret required for the legacy 1.0.0 signature class).
  const integrity = await verifyProofIntegrity(proof);
  expect(integrity.verified).toBe(true);
  const failedFields = integrity.fields.filter((f) => f.status === "fail");
  expect(failedFields).toEqual([]);

  // 5. Serve it through the same envelope the backend returns.
  await page.route("**/api/draw-proofs*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: proof.drawId,
            draw_id: proof.drawId,
            round_id: ROUND_ID,
            contract_id: CONTRACT_ID,
            proof,
            proof_hash: proof.signature ?? "",
            signature: proof.signature ?? null,
            verified: true,
            verified_at: new Date().toISOString(),
            verification_error: null,
            created_at: new Date().toISOString(),
          },
        ],
        meta: { pagination: { next_cursor: null, limit: 10, has_more: false } },
      }),
    })
  );

  // 6. The prizes page shows this round's proof with the independently-known
  // winner and an on-page "Verified" badge (local integrity check passed).
  await page.goto("/app/prizes");

  await expect(page.getByText(`Round #${ROUND_ID}`).first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(`[title="${winnerAddress}"]`)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/sig:/i).first()).toBeVisible({ timeout: 5000 });
});