import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

interface Participant {
  id: string;
  deposit: bigint;
}

/**
 * Pure simulation of the Soroban contract's resolve_round_randomness and select_round_winner.
 * Maps 128-bit digest to winning ticket in [0, total_deposit) and performs canonical interval walk.
 */
function selectWinnerSim(
  participants: Participant[],
  randomDigest: Buffer,
): { winnerId: string; ticket: bigint; totalWeight: bigint } {
  const totalWeight = participants.reduce((acc, p) => acc + p.deposit, 0n);
  if (totalWeight <= 0n) {
    throw new Error("Total deposit must be positive");
  }

  // Read high 16 bytes (128 bits) big-endian
  const hi128 = randomDigest.subarray(0, 16);
  const bigIntVal = BigInt("0x" + hi128.toString("hex"));
  const ticket = bigIntVal % totalWeight;

  let cursor = 0n;
  for (const p of participants) {
    if (p.deposit > 0n) {
      const segmentEnd = cursor + p.deposit;
      if (ticket >= cursor && ticket < segmentEnd) {
        return { winnerId: p.id, ticket, totalWeight };
      }
      cursor = segmentEnd;
    }
  }

  throw new Error(`Winner selection failed for ticket ${ticket} (total ${totalWeight})`);
}

/**
 * Computes Chi-Squared statistic: sum((Observed - Expected)^2 / Expected)
 */
function chiSquaredStatistic(observed: number[], expected: number[]): number {
  return observed.reduce((acc, obs, idx) => {
    const exp = expected[idx];
    return acc + Math.pow(obs - exp, 2) / exp;
  }, 0);
}

describe("Statistical Validation of Ticket-Weighting Algorithm (#716)", () => {
  it("passes Chi-squared goodness-of-fit test across 100,000 simulated rounds (Uniform Pool)", () => {
    const participants: Participant[] = [
      { id: "alice", deposit: 1000n },
      { id: "bob", deposit: 1000n },
      { id: "charlie", deposit: 1000n },
      { id: "david", deposit: 1000n },
      { id: "eve", deposit: 1000n },
    ];

    const N = 100_000;
    const winCounts: Record<string, number> = {
      alice: 0,
      bob: 0,
      charlie: 0,
      david: 0,
      eve: 0,
    };

    for (let i = 0; i < N; i++) {
      const digest = createHash("sha256").update(`seed_${i}`).digest();
      const { winnerId } = selectWinnerSim(participants, digest);
      winCounts[winnerId]++;
    }

    const expectedPerParticipant = N / participants.length; // 20,000
    const observed = participants.map((p) => winCounts[p.id]);
    const expected = participants.map(() => expectedPerParticipant);

    const chi2 = chiSquaredStatistic(observed, expected);

    // For 4 degrees of freedom (5 participants), critical value at alpha = 0.01 is 13.28
    expect(chi2).toBeLessThan(13.28);

    // Each participant should win within +/- 1.5% of expected 20%
    for (const p of participants) {
      const share = winCounts[p.id] / N;
      expect(share).toBeGreaterThan(0.19);
      expect(share).toBeLessThan(0.21);
    }
  });

  it("passes Chi-squared goodness-of-fit test on Skewed / Pareto Whale distribution", () => {
    const participants: Participant[] = [
      { id: "whale", deposit: 70_000n },   // 70% expected
      { id: "medium_1", deposit: 15_000n }, // 15% expected
      { id: "medium_2", deposit: 10_000n }, // 10% expected
      { id: "retail", deposit: 5_000n },    // 5% expected
    ];

    const N = 50_000;
    const winCounts: Record<string, number> = {
      whale: 0,
      medium_1: 0,
      medium_2: 0,
      retail: 0,
    };

    for (let i = 0; i < N; i++) {
      const digest = createHash("sha256").update(`pareto_${i}`).digest();
      const { winnerId } = selectWinnerSim(participants, digest);
      winCounts[winnerId]++;
    }

    const observed = participants.map((p) => winCounts[p.id]);
    const expected = participants.map((p) => (Number(p.deposit) / 100_000) * N);

    const chi2 = chiSquaredStatistic(observed, expected);
    // For 3 degrees of freedom, critical value at alpha = 0.01 is 11.34
    expect(chi2).toBeLessThan(11.34);

    expect(winCounts.whale / N).toBeCloseTo(0.70, 1);
    expect(winCounts.retail / N).toBeCloseTo(0.05, 1);
  });

  it("empirically proves anti-split / Sybil invariance (1 account vs 10 sub-accounts)", () => {
    // Strategy A: Alice puts 10,000 in 1 account
    const poolA: Participant[] = [
      { id: "alice_single", deposit: 10_000n },
      { id: "competitor_1", deposit: 40_000n },
      { id: "competitor_2", deposit: 50_000n },
    ];

    // Strategy B: Alice splits 10,000 into 10 sub-accounts of 1,000 each
    const poolB: Participant[] = [
      { id: "alice_sub_1", deposit: 1000n },
      { id: "alice_sub_2", deposit: 1000n },
      { id: "alice_sub_3", deposit: 1000n },
      { id: "alice_sub_4", deposit: 1000n },
      { id: "alice_sub_5", deposit: 1000n },
      { id: "alice_sub_6", deposit: 1000n },
      { id: "alice_sub_7", deposit: 1000n },
      { id: "alice_sub_8", deposit: 1000n },
      { id: "alice_sub_9", deposit: 1000n },
      { id: "alice_sub_10", deposit: 1000n },
      { id: "competitor_1", deposit: 40_000n },
      { id: "competitor_2", deposit: 50_000n },
    ];

    const N = 40_000;
    let aliceWinsA = 0;
    let aliceWinsB = 0;

    for (let i = 0; i < N; i++) {
      const digest = createHash("sha256").update(`sybil_${i}`).digest();
      const resA = selectWinnerSim(poolA, digest);
      if (resA.winnerId === "alice_single") aliceWinsA++;

      const resB = selectWinnerSim(poolB, digest);
      if (resB.winnerId.startsWith("alice_sub_")) aliceWinsB++;
    }

    const winRateA = aliceWinsA / N;
    const winRateB = aliceWinsB / N;

    // Expected rate is 10,000 / 100,000 = 10%
    expect(winRateA).toBeCloseTo(0.10, 1);
    expect(winRateB).toBeCloseTo(0.10, 1);

    // Difference between single account and 10 split accounts must be statistically indistinguishable (< 0.005)
    expect(Math.abs(winRateA - winRateB)).toBeLessThan(0.005);
  });

  it("handles boundary condition: Single depositor always wins 100%", () => {
    const participants: Participant[] = [{ id: "solo", deposit: 500n }];
    for (let i = 0; i < 100; i++) {
      const digest = createHash("sha256").update(`solo_${i}`).digest();
      const { winnerId } = selectWinnerSim(participants, digest);
      expect(winnerId).toBe("solo");
    }
  });

  it("handles boundary condition: Zero-weight depositor never wins", () => {
    const participants: Participant[] = [
      { id: "zero_bob", deposit: 0n },
      { id: "alice", deposit: 1000n },
      { id: "zero_charlie", deposit: 0n },
    ];

    for (let i = 0; i < 500; i++) {
      const digest = createHash("sha256").update(`zero_${i}`).digest();
      const { winnerId } = selectWinnerSim(participants, digest);
      expect(winnerId).toBe("alice");
    }
  });

  it("handles exact edge boundary tickets without off-by-one errors", () => {
    const participants: Participant[] = [
      { id: "alice", deposit: 100n },  // Range: [0, 100)
      { id: "bob", deposit: 200n },    // Range: [100, 300)
      { id: "charlie", deposit: 300n } // Range: [300, 600)
    ];

    function makeDigestForTicket(targetTicket: bigint, totalWeight: bigint): Buffer {
      const buf = Buffer.alloc(32);
      // Write targetTicket into high 16 bytes
      const hex = targetTicket.toString(16).padStart(32, "0");
      buf.write(hex, 0, 16, "hex");
      return buf;
    }

    // Boundary 1: Ticket = 0 (first ticket in Alice's segment)
    expect(selectWinnerSim(participants, makeDigestForTicket(0n, 600n)).winnerId).toBe("alice");

    // Boundary 2: Ticket = 99 (last ticket in Alice's segment)
    expect(selectWinnerSim(participants, makeDigestForTicket(99n, 600n)).winnerId).toBe("alice");

    // Boundary 3: Ticket = 100 (first ticket in Bob's segment)
    expect(selectWinnerSim(participants, makeDigestForTicket(100n, 600n)).winnerId).toBe("bob");

    // Boundary 4: Ticket = 299 (last ticket in Bob's segment)
    expect(selectWinnerSim(participants, makeDigestForTicket(299n, 600n)).winnerId).toBe("bob");

    // Boundary 5: Ticket = 300 (first ticket in Charlie's segment)
    expect(selectWinnerSim(participants, makeDigestForTicket(300n, 600n)).winnerId).toBe("charlie");

    // Boundary 6: Ticket = 599 (last ticket in total range [0, 600))
    expect(selectWinnerSim(participants, makeDigestForTicket(599n, 600n)).winnerId).toBe("charlie");
  });

  it("handles extreme balance disparity (1 stroop vs 10^9 stroops)", () => {
    const participants: Participant[] = [
      { id: "micro", deposit: 1n },
      { id: "giga_whale", deposit: 1_000_000_000n },
    ];

    // First ticket (0) goes to micro
    const digest0 = Buffer.alloc(32);
    expect(selectWinnerSim(participants, digest0).winnerId).toBe("micro");

    // Ticket 1 goes to giga_whale
    const digest1 = Buffer.alloc(32);
    digest1.write("00000000000000000000000000000001", 0, 16, "hex");
    expect(selectWinnerSim(participants, digest1).winnerId).toBe("giga_whale");
  });
});
