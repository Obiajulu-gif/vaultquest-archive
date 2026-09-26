/**
 * Vault round archive — export, normalization, filtering, and proof hashing (#653).
 *
 * Turns closed round data (see `lib/vault-mock-data.js` `VAULT_ROUND_ARCHIVE`)
 * into deterministic, downloadable JSON/CSV artifacts. Everything here is pure
 * and DOM-free so it can be unit-tested without the browser and reused by the
 * export UI on the archive page.
 *
 * Privacy: by default `createArchiveExport` strips per-winner wallet addresses
 * (`redacted: true`) because the archive is a public, aggregate record.
 */

export type ArchiveClaimStatus = "claimed" | "partially_claimed" | "expired";

export interface ArchiveRoundInput {
  id: string;
  vaultId: number | string;
  vaultName: string;
  asset: string;
  network: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  participants: number;
  totalDeposits: number;
  eligibleDeposits?: number;
  yieldGenerated: number;
  prizePayout: number;
  winnerCount?: number;
  winners?: ArchiveWinnerInput[];
  proofHash?: string;
  claimStatus?: ArchiveClaimStatus;
}

export interface ArchiveWinnerInput {
  rank?: number;
  walletAddress?: string;
  amount: number;
}

export interface ArchiveRecord {
  id: string;
  vaultId: string;
  vaultName: string;
  asset: string;
  network: string;
  startDate: string;
  endDate: string;
  participants: number;
  totalDeposits: number;
  eligibleDeposits: number;
  yieldGenerated: number;
  prizePayout: number;
  winnerCount: number;
  /** winners / participants, rounded to 4 decimal places. */
  winRate: number;
  claimStatus: ArchiveClaimStatus;
  proofHash: string;
}

export interface ArchiveWinnerRecord {
  roundId: string;
  rank: number;
  /** Absent whenever the export is redacted (privacy default). */
  walletAddress?: string;
  amount: number;
}

export interface ArchiveDocument {
  schema: "vaultquest.archive.v1";
  id: string;
  source: string;
  generatedAt: string;
  count: number;
  redacted: boolean;
  records: ArchiveRecord[];
  winners: ArchiveWinnerRecord[];
  /** FNV-1a over the canonical record rows; changes when data changes. */
  proofHash: string;
}

export interface ArchiveExportOptions {
  /** Explicit timestamp keeps output byte-for-byte deterministic in tests. */
  generatedAt?: string;
  /** Label identifying the data source. */
  source?: string;
  /** Import ID used as the document id. */
  id?: string;
  /** Set false to keep wallet addresses in the exported winners (internal use only). */
  redact?: boolean;
}

const CSV_COLUMNS: (keyof ArchiveRecord)[] = [
  "id",
  "vaultId",
  "vaultName",
  "asset",
  "network",
  "startDate",
  "endDate",
  "participants",
  "totalDeposits",
  "eligibleDeposits",
  "yieldGenerated",
  "prizePayout",
  "winnerCount",
  "winRate",
  "claimStatus",
  "proofHash",
];

/** FNV-1a 32-bit hash → hex. Stable across platforms and test runs. */
export function computeArchiveProofHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Normalizes one round into a flat archive record with derived metrics. */
export function normalizeArchiveRecord(round: ArchiveRoundInput): ArchiveRecord {
  const winnerCount = round.winnerCount ?? round.winners?.length ?? 0;
  const participants = Math.max(0, round.participants);
  const winRate = participants > 0 ? Number((winnerCount / participants).toFixed(4)) : 0;
  return {
    id: round.id,
    vaultId: String(round.vaultId),
    vaultName: round.vaultName,
    asset: round.asset,
    network: round.network,
    startDate: round.startDate,
    endDate: round.endDate,
    participants,
    totalDeposits: round.totalDeposits,
    eligibleDeposits: round.eligibleDeposits ?? round.totalDeposits,
    yieldGenerated: round.yieldGenerated,
    prizePayout: round.prizePayout,
    winnerCount,
    winRate,
    claimStatus: round.claimStatus ?? "claimed",
    proofHash: round.proofHash ?? computeArchiveProofHash(round.id),
  };
}

function canonicalRows(records: ArchiveRecord[]): string {
  return records.map((r) => CSV_COLUMNS.map((col) => String(r[col])).join("|")).join("\n");
}

/**
 * Creates a self-contained, sort-stable archive document. Records are ordered
 * newest first (endDate desc, id asc as a tiebreaker).
 */
export function createArchiveExport(
  rounds: ArchiveRoundInput[],
  options: ArchiveExportOptions = {},
): ArchiveDocument {
  const redacted = options.redact !== false;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const records = rounds
    .map(normalizeArchiveRecord)
    .sort((a, b) => b.endDate.localeCompare(a.endDate) || a.id.localeCompare(b.id));

  const winners: ArchiveWinnerRecord[] = [];
  for (const round of rounds) {
    for (const winner of round.winners ?? []) {
      const entry: ArchiveWinnerRecord = {
        roundId: round.id,
        rank: winner.rank ?? winners.length + 1,
        amount: winner.amount,
      };
      if (!redacted && winner.walletAddress) {
        entry.walletAddress = winner.walletAddress;
      }
      winners.push(entry);
    }
  }

  const rows = canonicalRows(records);
  const proofHash = computeArchiveProofHash(rows);

  return {
    schema: "vaultquest.archive.v1",
    id: options.id ?? `archive-${generatedAt}`,
    source: options.source ?? "vaultquest.mock",
    generatedAt,
    count: records.length,
    redacted,
    records,
    winners,
    proofHash,
  };
}

/** Escapes a single CSV cell per RFC 4180. */
function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serializes archive records to deterministic CSV (header + one row per record). */
export function archiveToCSV(records: ArchiveRecord[]): string {
  const header = CSV_COLUMNS.map(csvCell).join(",");
  const lines = records.map((row) => CSV_COLUMNS.map((col) => csvCell(String(row[col]))).join(","));
  return [header, ...lines].join("\n").concat("\n");
}

/** Serializes the full archive document as indented JSON. */
export function archiveToJSON(document: ArchiveDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export interface ArchiveFilter {
  fromDate?: string; // inclusive, YYYY-MM-DD
  toDate?: string; // inclusive, YYYY-MM-DD
  network?: string;
  vaultId?: number | string;
}

/** Filters normalized records in place of order; date filtering is by endDate. */
export function filterArchiveRecords(records: ArchiveRecord[], filter: ArchiveFilter = {}): ArchiveRecord[] {
  return records.filter((record) => {
    if (filter.fromDate && record.endDate < filter.fromDate) return false;
    if (filter.toDate && record.endDate > filter.toDate) return false;
    if (filter.network && record.network.toLowerCase() !== filter.network.toLowerCase()) return false;
    if (filter.vaultId !== undefined && record.vaultId !== String(filter.vaultId)) return false;
    return true;
  });
}

/** Aggregated totals across a set of records. */
export function summarizeArchive(
  records: ArchiveRecord[],
): { rounds: number; participants: number; eligibleDeposits: number; deposits: number; prizesPaid: number; winners: number } {
  return records.reduce(
    (acc, record) => ({
      rounds: acc.rounds + 1,
      participants: acc.participants + record.participants,
      eligibleDeposits: acc.eligibleDeposits + record.eligibleDeposits,
      deposits: acc.deposits + record.totalDeposits,
      prizesPaid: acc.prizesPaid + record.prizePayout,
      winners: acc.winners + record.winnerCount,
    }),
    { rounds: 0, participants: 0, eligibleDeposits: 0, deposits: 0, prizesPaid: 0, winners: 0 },
  );
}