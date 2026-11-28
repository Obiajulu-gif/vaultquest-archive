"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DrawProofSchema = void 0;
exports.computeHash = sha256Hex;
exports.canonicalize = canonicalize;
exports.computeProofHash = computeProofHash;
exports.signProof = signProof;
exports.computeDrawId = computeDrawId;
exports.computeParticipantsHash = computeParticipantsHash;
exports.computeTicketWeightsHash = computeTicketWeightsHash;
exports.computePoolHash = computePoolHash;
exports.buildDrawAuditSnapshot = buildDrawAuditSnapshot;
exports.computeDrawAuditSnapshotHash = computeDrawAuditSnapshotHash;
exports.computeWinnerProofHash = computeWinnerProofHash;
exports.verifyProofIntegrity = verifyProofIntegrity;
exports.assembleDrawProof = assembleDrawProof;
const zod_1 = require("zod");
// ??? Schemas ??????????????????????????????????????????????????????????????????
const SnapshotSchema = zod_1.z.object({
    ledgerSeq: zod_1.z.number().int().positive(),
    ledgerCloseTime: zod_1.z.string().datetime(),
    participantsHash: zod_1.z.string().min(1),
    participantCount: zod_1.z.number().int().nonnegative(),
    totalDeposits: zod_1.z.string().min(1),
    poolHash: zod_1.z.string().min(1),
    /**
     * The drip-pool contract's own `Round.principal_snapshot` (#642) ? the
     * deterministic cutoff balance the contract freezes at `lock_round`, before
     * `totalDeposits` above is ever computed off-chain from participant data.
     * Optional so older proofs (pre-#642) still validate; when present it lets
     * a verifier cross-check `totalDeposits` against the contract's own frozen
     * eligibility snapshot for this round via `getContractData` (see
     * `verifyRoundSnapshot` in draw-proof-verifier.ts) instead of trusting the
     * off-chain sum alone.
     */
    roundPrincipalSnapshot: zod_1.z.string().min(1).optional(),
});
const RandomnessSchema = zod_1.z.object({
    // "deterministic_placeholder" is intentionally not a valid value: randomness
    // derived from public identifiers (contract/round/ledger) is predictable and
    // must never be accepted as evidence (#494).
    source: zod_1.z.enum(["soroban_prng", "external_beacon"]),
    seed: zod_1.z.string().min(1),
    seedHash: zod_1.z.string().min(1),
    /** Hash published on-chain *before* the draw, proving the seed wasn't chosen after seeing the outcome. */
    commitment: zod_1.z.string().min(1),
    /** Ledger at which the commitment was recorded; must precede (or equal) drawnAtLedger. */
    commitmentLedgerSeq: zod_1.z.number().int().positive(),
    /** On-chain transaction that revealed the seed/beacon value consumed by the draw. */
    revealTxHash: zod_1.z.string().min(1),
    drawnAtLedger: zod_1.z.number().int().positive(),
});
const WinnerSelectionSchema = zod_1.z.object({
    method: zod_1.z.literal("weighted_random"),
    ticketWeightsHash: zod_1.z.string().min(1),
    winnerAddress: zod_1.z.string().min(1),
    winnerWeight: zod_1.z.string().min(1),
    totalWeight: zod_1.z.string().min(1),
    proofHash: zod_1.z.string().min(1),
});
const PayoutSchema = zod_1.z.object({
    amount: zod_1.z.string().min(1),
    asset: zod_1.z.string().min(1),
    txHash: zod_1.z.string().min(1),
    ledgerSeq: zod_1.z.number().int().positive(),
    recipientConfirmed: zod_1.z.boolean(),
});
const MetadataSchema = zod_1.z.object({
    createdAt: zod_1.z.string().datetime(),
    engineVersion: zod_1.z.string().min(1),
    contractSpecHash: zod_1.z.string().min(1),
    auditSnapshotHash: zod_1.z.string().min(1).optional(),
});
const DrawProofVersionSchema = zod_1.z.union([zod_1.z.literal("1.0.0"), zod_1.z.literal("1.1.0")]);
exports.DrawProofSchema = zod_1.z.object({
    version: DrawProofVersionSchema,
    drawId: zod_1.z.string().min(1),
    roundId: zod_1.z.number().int().nonnegative(),
    contractId: zod_1.z.string().min(1),
    snapshot: SnapshotSchema,
    randomness: RandomnessSchema,
    winnerSelection: WinnerSelectionSchema,
    payout: PayoutSchema,
    metadata: MetadataSchema,
    signature: zod_1.z.string().optional(),
});
// ??? Hashing ??????????????????????????????????????????????????????????????????
const HEX_CHARS = "0123456789abcdef";
async function sha256Hex(data) {
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
        const encoder = new TextEncoder();
        const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(data));
        const hashArray = new Uint8Array(hashBuffer);
        return Array.from(hashArray)
            .map((b) => HEX_CHARS[b >> 4] + HEX_CHARS[b & 0x0f])
            .join("");
    }
    const { createHash } = await import("crypto");
    return createHash("sha256").update(data, "utf-8").digest("hex");
}
async function hmacSha256Hex(secret, data) {
    const encoder = new TextEncoder();
    if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
        const key = await globalThis.crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const signature = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(data));
        return Array.from(new Uint8Array(signature))
            .map((b) => HEX_CHARS[b >> 4] + HEX_CHARS[b & 0x0f])
            .join("");
    }
    const { createHmac } = await import("crypto");
    return createHmac("sha256", secret).update(data, "utf-8").digest("hex");
}
// ??? Canonicalization ?????????????????????????????????????????????????????????
function sortKeys(obj) {
    if (obj === null || typeof obj !== "object")
        return obj;
    if (Array.isArray(obj))
        return obj.map(sortKeys);
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
}
function canonicalize(proof) {
    const withoutSig = { ...proof, signature: undefined };
    const sorted = sortKeys(withoutSig);
    return JSON.stringify(sorted);
}
// ??? Proof Hashing ????????????????????????????????????????????????????????????
async function computeProofHash(proof) {
    const canonical = canonicalize(proof);
    return sha256Hex(canonical);
}
async function signProof(proof, secret) {
    const canonical = canonicalize(proof);
    return hmacSha256Hex(secret, canonical);
}
// ??? Deterministic Draw ID ????????????????????????????????????????????????????
async function computeDrawId(contractId, roundId, drawLedger) {
    const input = `${contractId}:${roundId}:${drawLedger}`;
    const hash = await sha256Hex(input);
    return `draw-${hash.slice(0, 16)}`;
}
async function computeParticipantsHash(participants) {
    const sorted = [...participants].sort((a, b) => a.address.localeCompare(b.address));
    const serialized = JSON.stringify(sorted.map((p) => [p.address, p.deposit, p.lockupMultiplier]));
    return sha256Hex(serialized);
}
async function computeTicketWeightsHash(weights) {
    const sorted = [...weights].sort((a, b) => a.address.localeCompare(b.address));
    const serialized = JSON.stringify(sorted.map((w) => [w.address, w.weight]));
    return sha256Hex(serialized);
}
async function computePoolHash(poolState) {
    const sorted = sortKeys(poolState);
    return sha256Hex(JSON.stringify(sorted));
}
function buildDrawAuditSnapshot(proof) {
    return {
        roundId: proof.roundId,
        contractId: proof.contractId,
        ledgerSeq: proof.snapshot.ledgerSeq,
        participantsHash: proof.snapshot.participantsHash,
        participantCount: proof.snapshot.participantCount,
        totalDeposits: proof.snapshot.totalDeposits,
        poolHash: proof.snapshot.poolHash,
        ticketWeightsHash: proof.winnerSelection.ticketWeightsHash,
        randomness: {
            source: proof.randomness.source,
            seedHash: proof.randomness.seedHash,
            commitment: proof.randomness.commitment,
            commitmentLedgerSeq: proof.randomness.commitmentLedgerSeq,
            revealTxHash: proof.randomness.revealTxHash,
            drawnAtLedger: proof.randomness.drawnAtLedger,
        },
        winner: {
            address: proof.winnerSelection.winnerAddress,
            weight: proof.winnerSelection.winnerWeight,
            totalWeight: proof.winnerSelection.totalWeight,
        },
        payout: proof.payout,
    };
}
async function computeDrawAuditSnapshotHash(proof) {
    return sha256Hex(JSON.stringify(sortKeys(buildDrawAuditSnapshot(proof))));
}
// ??? Winner Proof Hash ????????????????????????????????????????????????????????
/**
 * Binds contractId + roundId into the hash chain so randomness evidence
 * lifted from another round or another contract can never reproduce a valid
 * proofHash here (#494) ? the recomputation on verify uses the *proof's own*
 * contractId/roundId, so a substituted seed/participants pair from elsewhere
 * mismatches even if internally self-consistent.
 */
async function computeWinnerProofHash(contractId, roundId, winnerAddress, seedHash, participantsHash) {
    const input = `${contractId}:${roundId}:${winnerAddress}:${seedHash}:${participantsHash}`;
    return sha256Hex(input);
}
function fieldPass(name) {
    return { name, status: "pass" };
}
function fieldFail(name, detail) {
    return { name, status: "fail", detail };
}
function fieldUnverified(name, detail) {
    return { name, status: "unverified", detail };
}
async function verifyProofIntegrity(proof, options = {}) {
    const fields = [];
    const signatureSecret = typeof options === "string" ? options : options.signatureSecret;
    // Schema gate first: a proof with missing/predictable/malformed randomness
    // evidence (e.g. no commitment, or the legacy "deterministic_placeholder"
    // source) fails parsing outright and can never be verified (#494).
    const parsed = exports.DrawProofSchema.safeParse(proof);
    if (!parsed.success) {
        fields.push(fieldFail("randomness_evidence", parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")));
        return { verified: false, fields, verifiedAt: new Date().toISOString() };
    }
    const { signature, ...proofBody } = proof;
    const expectedDocHash = await computeProofHash(proofBody);
    if (!proof.signature) {
        fields.push(fieldUnverified("document_integrity", "No signature stored in document"));
    }
    else if (proof.version === "1.0.0") {
        if (expectedDocHash === proof.signature) {
            fields.push(fieldPass("document_integrity"));
        }
        else {
            fields.push(fieldFail("document_integrity", `expected legacy document hash ${expectedDocHash}, got ${proof.signature}`));
        }
    }
    else if (!signatureSecret) {
        fields.push(fieldUnverified("document_integrity", "No HMAC signing secret provided for proof version 1.1.0"));
    }
    else {
        const expectedSignature = await signProof(proofBody, signatureSecret);
        if (expectedSignature === proof.signature) {
            fields.push(fieldPass("document_integrity"));
        }
        else {
            fields.push(fieldFail("document_integrity", `expected HMAC-SHA256 signature ${expectedSignature}, got ${proof.signature}`));
        }
    }
    const expectedWinnerHash = await computeWinnerProofHash(proof.contractId, proof.roundId, proof.winnerSelection.winnerAddress, proof.randomness.seedHash, proof.snapshot.participantsHash);
    if (expectedWinnerHash === proof.winnerSelection.proofHash) {
        fields.push(fieldPass("winner_proof_hash"));
    }
    else {
        fields.push(fieldFail("winner_proof_hash", `expected ${expectedWinnerHash}, got ${proof.winnerSelection.proofHash} (randomness/participants may be substituted or from another round/contract)`));
    }
    if (proof.metadata.auditSnapshotHash) {
        const recomputedAuditHash = await computeDrawAuditSnapshotHash(proofBody);
        if (recomputedAuditHash === proof.metadata.auditSnapshotHash) {
            fields.push(fieldPass("audit_snapshot_hash"));
        }
        else {
            fields.push(fieldFail("audit_snapshot_hash", `expected ${recomputedAuditHash}, got ${proof.metadata.auditSnapshotHash}`));
        }
    }
    else {
        fields.push(fieldUnverified("audit_snapshot_hash", "Proof does not include a replayable audit snapshot hash"));
    }
    const recomputedSeedHash = await sha256Hex(proof.randomness.seed);
    if (recomputedSeedHash === proof.randomness.seedHash) {
        fields.push(fieldPass("seed_hash"));
    }
    else {
        fields.push(fieldFail("seed_hash", `expected ${recomputedSeedHash}, got ${proof.randomness.seedHash}`));
    }
    // The revealed seed must match the pre-committed hash, and the commitment
    // must have been recorded at or before the draw ledger ? otherwise the
    // "randomness" could have been chosen after the outcome was known.
    const recomputedCommitment = await sha256Hex(proof.randomness.seed);
    if (recomputedCommitment !== proof.randomness.commitment) {
        fields.push(fieldFail("randomness_commitment", `revealed seed does not match commitment (expected ${recomputedCommitment}, got ${proof.randomness.commitment}) ? evidence may be substituted`));
    }
    else if (proof.randomness.commitmentLedgerSeq > proof.randomness.drawnAtLedger) {
        fields.push(fieldFail("randomness_commitment", `commitment recorded at ledger ${proof.randomness.commitmentLedgerSeq}, after draw ledger ${proof.randomness.drawnAtLedger}`));
    }
    else {
        fields.push(fieldPass("randomness_commitment"));
    }
    const allPass = fields.every((f) => f.status === "pass");
    const anyFail = fields.some((f) => f.status === "fail");
    return {
        verified: allPass && !anyFail,
        fields,
        verifiedAt: new Date().toISOString(),
    };
}
async function assembleDrawProof(input, options = {}) {
    const participantsHash = await computeParticipantsHash(input.participants);
    const poolHash = await computePoolHash(input.poolState);
    const seedHash = await sha256Hex(input.randomnessSeed);
    const totalDeposits = input.participants
        .reduce((sum, p) => sum + BigInt(p.deposit), BigInt(0))
        .toString();
    const weights = input.participants.map((p) => ({
        address: p.address,
        weight: (BigInt(p.deposit) * BigInt(p.lockupMultiplier)).toString(),
    }));
    const ticketWeightsHash = await computeTicketWeightsHash(weights);
    const totalWeight = weights
        .reduce((sum, w) => sum + BigInt(w.weight), BigInt(0))
        .toString();
    const winnerWeight = weights.find((w) => w.address === input.winnerAddress)?.weight ?? "0";
    const proofHash = await computeWinnerProofHash(input.contractId, input.roundId, input.winnerAddress, seedHash, participantsHash);
    const drawId = await computeDrawId(input.contractId, input.roundId, input.drawnAtLedger);
    const snapshotLedgerTime = new Date().toISOString();
    const proof = {
        version: "1.1.0",
        drawId,
        roundId: input.roundId,
        contractId: input.contractId,
        snapshot: {
            ledgerSeq: input.drawnAtLedger,
            ledgerCloseTime: snapshotLedgerTime,
            participantsHash,
            participantCount: input.participants.length,
            totalDeposits,
            poolHash,
            ...(input.roundPrincipalSnapshot !== undefined && {
                roundPrincipalSnapshot: input.roundPrincipalSnapshot,
            }),
        },
        randomness: {
            source: input.randomnessSource,
            seed: input.randomnessSeed,
            seedHash,
            commitment: input.randomnessCommitment,
            commitmentLedgerSeq: input.commitmentLedgerSeq,
            revealTxHash: input.revealTxHash,
            drawnAtLedger: input.drawnAtLedger,
        },
        winnerSelection: {
            method: "weighted_random",
            ticketWeightsHash,
            winnerAddress: input.winnerAddress,
            winnerWeight,
            totalWeight,
            proofHash,
        },
        payout: {
            amount: input.payoutAmount,
            asset: input.payoutAsset,
            txHash: input.payoutTxHash,
            ledgerSeq: input.payoutLedgerSeq,
            recipientConfirmed: input.payoutConfirmed,
        },
        metadata: {
            createdAt: new Date().toISOString(),
            engineVersion: "1.0.0",
            contractSpecHash: input.contractSpecHash,
        },
    };
    proof.metadata.auditSnapshotHash = await computeDrawAuditSnapshotHash(proof);
    const signature = options.signatureSecret
        ? await signProof(proof, options.signatureSecret)
        : undefined;
    return { ...proof, signature };
}
//# sourceMappingURL=draw-proof.js.map