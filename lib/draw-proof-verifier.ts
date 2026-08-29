import {
  type DrawProof,
  type VerificationResult,
  type VerificationField,
  verifyProofIntegrity,
} from "./draw-proof";

// ─── RPC Client Interface ─────────────────────────────────────────────────────

export interface StellarRpcClient {
  getLedger(ledgerSeq: number): Promise<{
    id: string;
    sequence: number;
    closedAt: string;
    hash: string;
  }>;
  getTransaction(txHash: string): Promise<{
    hash: string;
    ledger: number;
    successful: boolean;
    status: string;
    resultXdr?: string;
  }>;
  getContractData(contractId: string, key: string): Promise<{
    value: string;
    lastModifiedLedger: number;
  }>;
}

// ─── Field Verifiers ──────────────────────────────────────────────────────────

function fieldPass(name: string): VerificationField {
  return { name, status: "pass" };
}

function fieldFail(name: string, detail: string): VerificationField {
  return { name, status: "fail", detail };
}

function fieldUnverified(name: string, detail: string): VerificationField {
  return { name, status: "unverified", detail };
}

/**
 * Confirms the randomness reveal actually happened on-chain (not merely
 * self-consistent inside the document) and that it landed at or after the
 * committed ledger — closing the gap the document-only checks in
 * verifyProofIntegrity can't cover on their own (#494).
 */
async function verifyRandomnessReveal(
  proof: DrawProof,
  rpc: StellarRpcClient
): Promise<VerificationField> {
  try {
    const tx = await rpc.getTransaction(proof.randomness.revealTxHash);
    if (!tx) {
      return fieldFail("randomness_reveal", `reveal transaction ${proof.randomness.revealTxHash} not found on chain`);
    }
    if (!tx.successful) {
      return fieldFail("randomness_reveal", `reveal transaction ${proof.randomness.revealTxHash} was not successful (status: ${tx.status})`);
    }
    if (tx.ledger < proof.randomness.commitmentLedgerSeq) {
      return fieldFail(
        "randomness_reveal",
        `reveal at ledger ${tx.ledger} precedes commitment ledger ${proof.randomness.commitmentLedgerSeq}`
      );
    }
    return fieldPass("randomness_reveal");
  } catch (err) {
    return fieldUnverified(
      "randomness_reveal",
      `RPC error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function verifyPayoutTransaction(
  proof: DrawProof,
  rpc: StellarRpcClient
): Promise<VerificationField> {
  try {
    const tx = await rpc.getTransaction(proof.payout.txHash);
    if (!tx) {
      return fieldFail("payout_tx", `transaction ${proof.payout.txHash} not found on chain`);
    }
    if (!tx.successful) {
      return fieldFail("payout_tx", `transaction ${proof.payout.txHash} was not successful (status: ${tx.status})`);
    }
    if (tx.ledger !== proof.payout.ledgerSeq) {
      return fieldFail(
        "payout_tx",
        `expected ledger ${proof.payout.ledgerSeq}, got ${tx.ledger}`
      );
    }
    return fieldPass("payout_tx");
  } catch (err) {
    return fieldUnverified(
      "payout_tx",
      `RPC error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function verifySnapshotLedger(
  proof: DrawProof,
  rpc: StellarRpcClient
): Promise<VerificationField> {
  try {
    const ledger = await rpc.getLedger(proof.snapshot.ledgerSeq);
    if (!ledger) {
      return fieldFail("snapshot_ledger", `ledger ${proof.snapshot.ledgerSeq} not found`);
    }
    if (ledger.sequence !== proof.snapshot.ledgerSeq) {
      return fieldFail(
        "snapshot_ledger",
        `expected sequence ${proof.snapshot.ledgerSeq}, got ${ledger.sequence}`
      );
    }
    return fieldPass("snapshot_ledger");
  } catch (err) {
    return fieldUnverified(
      "snapshot_ledger",
      `RPC error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─── Main Verifier ────────────────────────────────────────────────────────────

export interface ClientVerificationResult extends VerificationResult {
  rpcVerified: boolean;
  rpcError?: string;
}

export async function verifyDrawProofClient(
  proof: DrawProof,
  rpc?: StellarRpcClient
): Promise<ClientVerificationResult> {
  const fields: VerificationField[] = [];

  // Surface the FULL per-field output of the document-only integrity engine
  // (#572) instead of collapsing it to a single boolean: every check —
  // document_integrity, winner_proof_hash, seed_hash, randomness_commitment
  // (and randomness_evidence on schema failure) — is forwarded verbatim so
  // the UI can render each one with its pass/fail/unverified state and the
  // `detail` string explaining *why* a check failed.
  const integrity = await verifyProofIntegrity(proof);
  fields.push(...integrity.fields);

  if (rpc) {
    fields.push(await verifySnapshotLedger(proof, rpc));
    fields.push(await verifyPayoutTransaction(proof, rpc));
    fields.push(await verifyRandomnessReveal(proof, rpc));
  } else {
    fields.push(fieldUnverified("snapshot_ledger", "No RPC client provided"));
    fields.push(fieldUnverified("payout_tx", "No RPC client provided"));
    fields.push(fieldUnverified("randomness_reveal", "No RPC client provided"));
  }

  // Randomness evidence must be independently confirmed on-chain: without an
  // RPC client the reveal can't be checked, so the proof can never be marked
  // fully verified in the browser from the document alone (#494).
  const passCount = fields.filter((f) => f.status === "pass").length;
  const failCount = fields.filter((f) => f.status === "fail").length;
  const randomnessRevealVerified = fields.find((f) => f.name === "randomness_reveal")?.status === "pass";
  const allPass = failCount === 0 && passCount >= 3 && randomnessRevealVerified;

  return {
    verified: allPass,
    fields,
    verifiedAt: new Date().toISOString(),
    rpcVerified: rpc !== undefined,
    rpcError: rpc ? undefined : "No RPC client provided — limited verification",
  };
}

// ─── Reward Entry Reconciliation (#634) ──────────────────────────────────────

export type ProofStatus = "verified" | "tampered" | "missing" | "pending" | "unverified";
export type ClaimStatus = "claimed" | "pending" | "unclaimed" | "failed";

export interface RewardReconciliation {
  proofStatus: ProofStatus;
  proofDetail: string;
  claimStatus: ClaimStatus;
}

export interface ReconcileRewardEntryInput {
  /** Round ID to match against draw proof's roundId. */
  roundId: number;
  /** Draw proof fetched from storage, or null/undefined if not found. */
  proof: DrawProof | null | undefined;
  /** Whether the cycle outcome is won. */
  isWon: boolean;
  /**
   * On-chain tx hash for the claim, if any.  Absence means unclaimed (for a
   * won entry) or irrelevant (for a no_win/pending entry).
   */
  claimTxHash: string | null;
  /**
   * Result of fetching the claim tx from the indexer/RPC.  Undefined when no
   * claimTxHash exists.  Truthy means confirmed-successful.
   */
  claimTxSuccessful?: boolean;
}

/**
 * Pure reconciliation of one reward entry against its draw proof and claim
 * transaction data (#634).  All RPC calls are done by the caller; this
 * function only interprets the pre-fetched data so it is synchronous and
 * testable in isolation.
 */
export async function reconcileRewardEntry(
  input: ReconcileRewardEntryInput,
): Promise<RewardReconciliation> {
  // ── Proof reconciliation ─────────────────────────────────────────────────
  let proofStatus: ProofStatus;
  let proofDetail: string;

  if (!input.proof) {
    proofStatus = input.isWon ? "missing" : "pending";
    proofDetail = input.isWon
      ? "No draw proof found for this round"
      : "Draw proof not yet available";
  } else if (input.proof.roundId !== input.roundId) {
    proofStatus = "tampered";
    proofDetail = `Round ID mismatch: proof.roundId=${input.proof.roundId}, expected=${input.roundId}`;
  } else {
    const result = await verifyProofIntegrity(input.proof);
    const failingField = result.fields.find((f) => f.status === "fail");
    const unverifiedField = result.fields.find((f) => f.status === "unverified");

    if (failingField) {
      proofStatus = "tampered";
      proofDetail = `${failingField.name}: ${failingField.detail ?? "check failed"}`;
    } else if (unverifiedField) {
      proofStatus = "unverified";
      proofDetail = `${unverifiedField.name}: ${unverifiedField.detail ?? "could not verify"}`;
    } else {
      proofStatus = "verified";
      proofDetail = "All proof integrity checks passed";
    }
  }

  // ── Claim reconciliation ─────────────────────────────────────────────────
  let claimStatus: ClaimStatus;

  if (!input.isWon) {
    // Non-winning entries never have a claim.
    claimStatus = "unclaimed";
  } else if (!input.claimTxHash) {
    claimStatus = "unclaimed";
  } else if (input.claimTxSuccessful === undefined) {
    // txHash exists but we couldn't fetch the result (RPC unavailable or still indexing).
    claimStatus = "pending";
  } else if (input.claimTxSuccessful) {
    claimStatus = "claimed";
  } else {
    claimStatus = "failed";
  }

  return { proofStatus, proofDetail, claimStatus };
}

// ─── Fetch-based RPC Client ───────────────────────────────────────────────────

export function createFetchRpcClient(rpcUrl: string): StellarRpcClient {
  return {
    async getLedger(ledgerSeq) {
      const resp = await fetch(`${rpcUrl}/ledgers/${ledgerSeq}`);
      if (!resp.ok) throw new Error(`Ledger ${ledgerSeq} not found`);
      const data = await resp.json();
      return {
        id: data.id,
        sequence: data.sequence,
        closedAt: data.closed_at,
        hash: data.hash,
      };
    },

    async getTransaction(txHash) {
      const resp = await fetch(`${rpcUrl}/transactions/${txHash}`);
      if (!resp.ok) throw new Error(`Transaction ${txHash} not found`);
      const data = await resp.json();
      return {
        hash: data.hash,
        ledger: data.ledger,
        successful: data.successful,
        status: data.status,
        resultXdr: data.result_xdr,
      };
    },

    async getContractData(contractId, key) {
      const resp = await fetch(
        `${rpcUrl}/contracts/${contractId}/storage?key=${key}`
      );
      if (!resp.ok) throw new Error(`Contract data not found`);
      const data = await resp.json();
      return {
        value: data.value,
        lastModifiedLedger: data.last_modified_ledger,
      };
    },
  };
}
