import {
  type DrawProof,
  type VerificationResult,
  type VerificationField,
  computeHash,
  computeWinnerProofHash,
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

async function verifyDocumentIntegrity(proof: DrawProof): Promise<VerificationField> {
  const result = await verifyProofIntegrity(proof);
  const docField = result.fields.find((f) => f.name === "document_integrity");
  return docField ?? fieldFail("document_integrity", "missing from integrity check");
}

async function verifyWinnerHashChain(proof: DrawProof): Promise<VerificationField> {
  const result = await verifyProofIntegrity(proof);
  const winnerField = result.fields.find((f) => f.name === "winner_proof_hash");
  return winnerField ?? fieldFail("winner_proof_hash", "missing from integrity check");
}

async function verifySeedHash(proof: DrawProof): Promise<VerificationField> {
  const recomputed = await computeHash(proof.randomness.seed);
  if (recomputed === proof.randomness.seedHash) {
    return fieldPass("seed_hash");
  }
  return fieldFail("seed_hash", `expected ${recomputed}, got ${proof.randomness.seedHash}`);
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

  fields.push(await verifyDocumentIntegrity(proof));
  fields.push(await verifyWinnerHashChain(proof));
  fields.push(await verifySeedHash(proof));

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
