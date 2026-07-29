import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import {
  assembleDrawProof,
  verifyProofIntegrity,
  computeDrawId,
  type DrawProof,
  type DrawProofInput,
  type ParticipantEntry,
  type VerificationResult,
} from "../../../lib/draw-proof.js";

export interface RpcClient {
  getLedger(ledgerSeq: number): Promise<{ sequence: number; closedAt: string; hash: string }>;
  getTransaction(txHash: string): Promise<{ hash: string; ledger: number; successful: boolean; status: string }>;
  getContractData(contractId: string, key: string): Promise<{ value: string }>;
  getEvents(opts: { contractId: string; topic?: string[]; startLedger?: number; limit?: number }): Promise<{
    events: Array<{ id: string; ledger: number; txHash: string; topicXdr: string[]; valueXdr: string }>;
  }>;
}

export interface DrawProofRecord {
  id: string;
  drawId: string;
  roundId: number;
  contractId: string;
  proofJson: DrawProof;
  proofHash: string;
  signature: string | null;
  verified: boolean;
  verifiedAt: Date | null;
  verificationError: string | null;
  createdAt: Date;
}

export interface GenerateProofOptions {
  actionId: string;
  contractSpecHash?: string;
}

export class DrawProofService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly rpc: RpcClient | null,
    private readonly logger?: Logger
  ) {}

  async generateProof(options: GenerateProofOptions): Promise<DrawProofRecord | null> {
    const action = await this.prisma.actionLedger.findUnique({
      where: { id: options.actionId },
    });

    if (!action) {
      this.logger?.warn({ actionId: options.actionId }, "draw proof: action not found");
      return null;
    }

    if (action.actionType !== "select_winner") {
      this.logger?.warn(
        { actionId: options.actionId, type: action.actionType },
        "draw proof: action is not select_winner"
      );
      return null;
    }

    if (action.status !== "confirmed") {
      this.logger?.warn(
        { actionId: options.actionId, status: action.status },
        "draw proof: action not confirmed"
      );
      return null;
    }

    const payload = (action.actionPayload ?? {}) as Record<string, unknown>;
    const contractId = String(payload.contract_id || payload.pool_id || "unknown");
    const roundId = Number(payload.round_id || 0);
    const winnerAddress = String(payload.winner || payload.winnerAddress || "");
    const prizeAmount = String(payload.prize || payload.amount || "0");
    const drawLedger = Number(payload.draw_ledger || action.submittedAt?.getTime() || Date.now());

    if (!winnerAddress) {
      this.logger?.warn({ actionId: options.actionId }, "draw proof: no winner in payload");
      return null;
    }

    if (!this.rpc) {
      this.logger?.warn(
        { actionId: options.actionId },
        "draw proof: no RPC client configured, refusing to fabricate randomness evidence"
      );
      return null;
    }

    let participants: ParticipantEntry[] = [];
    let poolState: Record<string, unknown> = {};
    let payoutTxHash = action.txHash || "";
    let payoutLedgerSeq = drawLedger + 1;

    try {
      participants = await this.fetchParticipants(contractId, drawLedger);
      poolState = await this.fetchPoolState(contractId);
      if (action.txHash) {
        const tx = await this.rpc.getTransaction(action.txHash);
        if (tx) {
          payoutLedgerSeq = tx.ledger;
        }
      }
    } catch (err) {
      this.logger?.warn({ err, contractId }, "draw proof: RPC fetch failed, using empty data");
    }

    // Real randomness evidence must come from the contract's own commit/reveal
    // (or beacon) event — never derived from public identifiers, which would
    // be predictable and defeat the whole point of the proof (#494).
    const randomness = await this.fetchRandomnessEvidence(contractId, roundId, drawLedger);
    if (!randomness) {
      this.logger?.warn(
        { actionId: options.actionId, contractId, roundId },
        "draw proof: no on-chain randomness evidence found, refusing to generate proof"
      );
      return null;
    }

    const input: DrawProofInput = {
      roundId,
      contractId,
      participants,
      poolState,
      randomnessSource: randomness.source,
      randomnessSeed: randomness.seed,
      randomnessCommitment: randomness.commitment,
      commitmentLedgerSeq: randomness.commitmentLedgerSeq,
      revealTxHash: randomness.revealTxHash,
      drawnAtLedger: drawLedger,
      winnerAddress,
      payoutTxHash,
      payoutLedgerSeq,
      payoutAmount: prizeAmount,
      payoutAsset: String(payload.asset || "USDC"),
      payoutConfirmed: true,
      contractSpecHash: options.contractSpecHash || "unknown",
    };

    const proof = await assembleDrawProof(input);
    const docHash = await computeDrawId(contractId, roundId, drawLedger);

    const existing = await this.prisma.drawProof.findUnique({
      where: { drawId: proof.drawId },
    });

    if (existing) {
      this.logger?.info({ drawId: proof.drawId }, "draw proof: already exists");
      return this.toRecord(existing);
    }

    const created = await this.prisma.drawProof.create({
      data: {
        drawId: proof.drawId,
        roundId: proof.roundId,
        contractId: proof.contractId,
        proofJson: proof as unknown as object,
        proofHash: docHash,
        signature: proof.signature ?? null,
        verified: false,
      },
    });

    this.logger?.info(
      { drawId: proof.drawId, roundId, winner: winnerAddress },
      "draw proof: generated"
    );

    return this.toRecord(created);
  }

  async verifyProof(drawId: string): Promise<{
    record: DrawProofRecord;
    verification: VerificationResult;
  } | null> {
    const record = await this.prisma.drawProof.findUnique({
      where: { drawId },
    });

    if (!record) return null;

    const proof = record.proofJson as unknown as DrawProof;
    const verification = await verifyProofIntegrity(proof);

    await this.prisma.drawProof.update({
      where: { drawId },
      data: {
        verified: verification.verified,
        verifiedAt: new Date(),
        verificationError: verification.verified
          ? null
          : verification.fields
              .filter((f) => f.status === "fail")
              .map((f) => `${f.name}: ${f.detail}`)
              .join("; "),
      },
    });

    return {
      record: this.toRecord({ ...record, verified: verification.verified, verifiedAt: new Date() }),
      verification,
    };
  }

  async getProof(drawId: string): Promise<DrawProofRecord | null> {
    const record = await this.prisma.drawProof.findUnique({
      where: { drawId },
    });
    return record ? this.toRecord(record) : null;
  }

  async listProofs(params: {
    roundId?: number;
    contractId?: string;
    limit: number;
    cursor?: string | null;
  }): Promise<{ items: DrawProofRecord[]; nextCursor: string | null }> {
    const where = {
      ...(params.roundId !== undefined && { roundId: params.roundId }),
      ...(params.contractId !== undefined && { contractId: params.contractId }),
    };

    const rows = await this.prisma.drawProof.findMany({
      where,
      orderBy: [{ roundId: "desc" }, { createdAt: "desc" }],
      take: params.limit + 1,
      ...(params.cursor != null && { cursor: { id: params.cursor }, skip: 1 }),
    });

    const hasMore = rows.length > params.limit;
    const items = hasMore ? rows.slice(0, params.limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return { items: items.map((r) => this.toRecord(r)), nextCursor };
  }

  async retroactiveGenerateAll(contractSpecHash?: string): Promise<number> {
    const confirmedDraws = await this.prisma.actionLedger.findMany({
      where: {
        actionType: "select_winner",
        status: "confirmed",
      },
      orderBy: { confirmedAt: "desc" },
    });

    let generated = 0;
    for (const action of confirmedDraws) {
      const existing = await this.prisma.drawProof.findFirst({
        where: {
          contractId: String(
            (action.actionPayload as Record<string, unknown>)?.contract_id ||
              (action.actionPayload as Record<string, unknown>)?.pool_id ||
              "unknown"
          ),
          roundId: Number(
            (action.actionPayload as Record<string, unknown>)?.round_id || 0
          ),
        },
      });

      if (!existing) {
        const result = await this.generateProof({
          actionId: action.id,
          contractSpecHash,
        });
        if (result) generated++;
      }
    }

    this.logger?.info({ generated, total: confirmedDraws.length }, "draw proof: retroactive generation complete");
    return generated;
  }

  /**
   * Reads the actual randomness commit/reveal (or beacon) evidence the
   * contract emitted for this round. Returns null — never a fabricated seed —
   * when the contract hasn't published real evidence for this draw.
   */
  private async fetchRandomnessEvidence(
    contractId: string,
    roundId: number,
    drawLedger: number
  ): Promise<{
    source: "soroban_prng" | "external_beacon";
    seed: string;
    commitment: string;
    commitmentLedgerSeq: number;
    revealTxHash: string;
  } | null> {
    if (!this.rpc) return null;

    try {
      const { events } = await this.rpc.getEvents({
        contractId,
        topic: ["randomness_reveal"],
        limit: 50,
      });

      for (const evt of events) {
        let decoded: Record<string, unknown>;
        try {
          decoded = JSON.parse(Buffer.from(evt.valueXdr, "base64").toString("utf8"));
        } catch {
          continue;
        }

        if (Number(decoded.round_id) !== roundId) continue;
        const seed = String(decoded.seed || "");
        const commitment = String(decoded.commitment || "");
        const commitmentLedgerSeq = Number(decoded.commitment_ledger || 0);
        const source = decoded.source === "external_beacon" ? "external_beacon" : "soroban_prng";

        if (!seed || !commitment || !commitmentLedgerSeq || commitmentLedgerSeq > drawLedger) {
          continue;
        }

        return { source, seed, commitment, commitmentLedgerSeq, revealTxHash: evt.txHash };
      }

      return null;
    } catch (err) {
      this.logger?.warn({ err, contractId, roundId }, "draw proof: failed to fetch randomness evidence");
      return null;
    }
  }

  private async fetchParticipants(
    contractId: string,
    _atLedger: number
  ): Promise<ParticipantEntry[]> {
    if (!this.rpc) return [];

    try {
      const poolData = await this.rpc.getContractData(contractId, "Pool");
      const pool = JSON.parse(poolData.value) as Record<string, unknown>;

      const admins = Array.isArray(pool.admins) ? pool.admins : [];
      const participants: ParticipantEntry[] = [];

      for (const admin of admins) {
        try {
          const pData = await this.rpc.getContractData(contractId, `Participant:${admin}`);
          const p = JSON.parse(pData.value) as Record<string, unknown>;
          participants.push({
            address: String(admin),
            deposit: String(p.deposited || "0"),
            lockupMultiplier: Number(p.lockup_multiplier || 100),
          });
        } catch {
          // participant not found, skip
        }
      }

      return participants;
    } catch {
      return [];
    }
  }

  private async fetchPoolState(contractId: string): Promise<Record<string, unknown>> {
    if (!this.rpc) return {};

    try {
      const data = await this.rpc.getContractData(contractId, "Pool");
      return JSON.parse(data.value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private toRecord(row: {
    id: string;
    drawId: string;
    roundId: number;
    contractId: string;
    proofJson: unknown;
    proofHash: string;
    signature: string | null;
    verified: boolean;
    verifiedAt: Date | null;
    verificationError: string | null;
    createdAt: Date;
  }): DrawProofRecord {
    return {
      id: row.id,
      drawId: row.drawId,
      roundId: row.roundId,
      contractId: row.contractId,
      proofJson: row.proofJson as DrawProof,
      proofHash: row.proofHash,
      signature: row.signature,
      verified: row.verified,
      verifiedAt: row.verifiedAt,
      verificationError: row.verificationError,
      createdAt: row.createdAt,
    };
  }
}
