import { describe, it, expect } from "vitest";
import {
  archiveToCSV,
  archiveToJSON,
  computeArchiveProofHash,
  createArchiveExport,
  filterArchiveRecords,
  normalizeArchiveRecord,
  summarizeArchive,
  type ArchiveDocument,
  type ArchiveRecord,
  type ArchiveRoundInput,
} from "../lib/archive-export";

const ROUNDS: ArchiveRoundInput[] = [
  {
    id: "round-2026-04-xlm-drip",
    vaultId: 2,
    vaultName: "XLM Drip Vault",
    asset: "XLM",
    network: "Stellar",
    startDate: "2026-04-22",
    endDate: "2026-04-29",
    participants: 172,
    totalDeposits: 410000,
    eligibleDeposits: 398000,
    yieldGenerated: 310,
    prizePayout: 250,
    winnerCount: 4,
    claimStatus: "claimed",
    proofHash: "0x7a15e8c3",
    winners: [
      { rank: 1, walletAddress: "GBBD3A7FQ6HZN2XR5DBLD3YIYS3L2ORWVUYVY4QBEAC3IKWMUOCFLA5", amount: 100 },
      { rank: 2, walletAddress: "GDQW5FT3K2VJPRB4M6XZHZ7LN8RQCSDY4WMC5K2LF3Q67RAHDGA2BQK", amount: 70 },
    ],
  },
  {
    id: "round-2026-06-sol-yield-max",
    vaultId: 4,
    vaultName: "SOL Yield Max",
    asset: "SOL",
    network: "Solana",
    startDate: "2026-06-01",
    endDate: "2026-06-14",
    participants: 265,
    totalDeposits: 2100000,
    yieldGenerated: 14280,
    prizePayout: 9300,
    winnerCount: 8,
    claimStatus: "partially_claimed",
    proofHash: "0x9f2ac1d4",
  },
  {
    id: "round-2026-05-usdc-stable",
    vaultId: 1,
    vaultName: "USDC Stable Pool",
    asset: "USDC",
    network: "Avalanche",
    startDate: "2026-05-17",
    endDate: "2026-05-24",
    participants: 389,
    totalDeposits: 1180000,
    yieldGenerated: 1210,
    prizePayout: 920,
    winnerCount: 5,
  },
];

const OPTIONS = { generatedAt: "2026-06-30T00:00:00.000Z", source: "test" };

describe("archive record normalization", () => {
  it("derives winRate and defaults eligibleDeposits/claimStatus", () => {
    const record = normalizeArchiveRecord(ROUNDS[2]);
    expect(record.winRate).toBe(Number((5 / 389).toFixed(4)));
    expect(record.eligibleDeposits).toBe(1180000);
    expect(record.claimStatus).toBe("claimed");
    expect(record.proofHash).toBe(computeArchiveProofHash("round-2026-05-usdc-stable"));
  });

  it("keeps matching zero winRate for empty rounds", () => {
    const record = normalizeArchiveRecord({ ...ROUNDS[2], participants: 0, winnerCount: 0 });
    expect(record.winRate).toBe(0);
  });
});

describe("archive document export", () => {
  it("sorts records newest first with a stable tiebreak", () => {
    const document = createArchiveExport(ROUNDS, OPTIONS);
    expect(document.records.map((r) => r.id)).toEqual([
      "round-2026-06-sol-yield-max",
      "round-2026-05-usdc-stable",
      "round-2026-04-xlm-drip",
    ]);
    expect(document.count).toBe(3);
  });

  it("produces byte-identical JSON for identical input", () => {
    const first = createArchiveExport(ROUNDS, OPTIONS);
    const second = createArchiveExport(
      // Equivalent round data in a shuffled order must still serialize identically.
      [ROUNDS[1], ROUNDS[0], ROUNDS[2]],
      OPTIONS,
    );
    expect(archiveToJSON(first)).toBe(archiveToJSON(second));
  });

  it("computes a proof hash that is stable for the same data", () => {
    const first = createArchiveExport(ROUNDS, OPTIONS);
    const second = createArchiveExport(ROUNDS, OPTIONS);
    expect(first.proofHash).toBe(second.proofHash);
    expect(first.proofHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes the proof hash when data changes", () => {
    const base = createArchiveExport(ROUNDS, OPTIONS);
    const tampered = createArchiveExport(
      ROUNDS.map((round, index) => (index === 0 ? { ...round, prizePayout: round.prizePayout + 1 } : round)),
      OPTIONS,
    );
    expect(tampered.proofHash).not.toBe(base.proofHash);
  });

  it("redacts wallet addresses by default and keeps them on request", () => {
    const redacted = createArchiveExport(ROUNDS, OPTIONS);
    expect(redacted.redacted).toBe(true);
    expect(redacted.winners).toHaveLength(2);
    for (const winner of redacted.winners) {
      expect(winner).not.toHaveProperty("walletAddress");
    }
    expect(redacted.records.length).toBeGreaterThan(0);

    const full = createArchiveExport(ROUNDS, { ...OPTIONS, redact: false });
    expect(full.redacted).toBe(false);
    expect(full.winners[0].walletAddress).toBe("GBBD3A7FQ6HZN2XR5DBLD3YIYS3L2ORWVUYVY4QBEAC3IKWMUOCFLA5");
  });
});

describe("CSV serialization", () => {
  it("writes a header row followed by one row per record", () => {
    const document = createArchiveExport(ROUNDS, OPTIONS);
    const csv = archiveToCSV(document.records);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(document.records.length + 1);
    expect(lines[0]).toContain("vaultName");
    expect(lines[0]).toContain("winRate");
    expect(lines[0]).toContain("proofHash");
  });

  it("escapes cells that contain commas or quotes", () => {
    const record: ArchiveRecord = {
      ...normalizeArchiveRecord(ROUNDS[0]),
      vaultName: 'Owl, "Prime" Vault',
    };
    const csv = archiveToCSV([record]);
    expect(csv).toContain('"Owl, ""Prime"" Vault"');
  });
});

describe("archive filtering and summaries", () => {
  it("filters by date range, network, and vault", () => {
    const document = createArchiveExport(ROUNDS, OPTIONS);
    const byDate = filterArchiveRecords(document.records, { fromDate: "2026-05-01", toDate: "2026-05-31" });
    expect(byDate.map((r) => r.id)).toEqual(["round-2026-05-usdc-stable"]);

    const stellar = filterArchiveRecords(document.records, { network: "stellar" });
    expect(stellar.map((r) => r.id)).toEqual(["round-2026-04-xlm-drip"]);

    const vault4 = filterArchiveRecords(document.records, { vaultId: 4 });
    expect(vault4.map((r) => r.id)).toEqual(["round-2026-06-sol-yield-max"]);
  });

  it("summarizes totals and winners across records", () => {
    const document = createArchiveExport(ROUNDS, OPTIONS);
    const totals = summarizeArchive(document.records);
    expect(totals.rounds).toBe(3);
    expect(totals.participants).toBe(826);
    expect(totals.deposits).toBe(3690000);
    expect(totals.prizesPaid).toBe(10470);
    expect(totals.winners).toBe(17);
  });
});

describe("archive JSON document shape", () => {
  it("serializes as JSON with schema metadata", () => {
    const document: ArchiveDocument = createArchiveExport(ROUNDS, OPTIONS);
    const parsed = JSON.parse(archiveToJSON(document)) as ArchiveDocument;
    expect(parsed.schema).toBe("vaultquest.archive.v1");
    expect(parsed.source).toBe("test");
    expect(parsed.generatedAt).toBe("2026-06-30T00:00:00.000Z");
    expect(parsed.records).toHaveLength(3);
    expect(parsed.proofHash).toBe(document.proofHash);
  });
});