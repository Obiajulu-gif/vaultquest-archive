# Vault Engagement Data Requirements

The leaderboard and notification history UI added for vault engagement uses sample data until live services are available.

## Leaderboard

- Wallet identifier or anonymized display name.
- Vault ID, asset, network, and eligibility status.
- Rank, previous rank, rank delta, and score.
- Engagement inputs such as deposit streaks, tickets, prize participation, referrals, and last activity timestamp.
- Privacy preference for public display.

## Notifications

- Notification ID, wallet ID, vault ID, title, body, type, status, created timestamp, and read timestamp.
- Delivery channel metadata for in-app, email, push, or wallet-message notifications.
- Retention policy and pagination cursor for history views.

## Round Archive Export (#653)

Closed vault rounds are downloadable from `app/app/vaults/archive` as deterministic CSV or JSON artifacts.

### Archive Record Columns

Every exported record carries:
- Round `id`, `vaultId`, `vaultName`, `asset`, and `network`.
- `startDate` / `endDate` (YYYY-MM-DD, inclusive ranges).
- `participants`, `totalDeposits`, and `eligibleDeposits`.
- `yieldGenerated`, `prizePayout`, `winnerCount`, `winRate` (`winnerCount / participants`).
- `claimStatus` (`claimed` | `partially_claimed` | `expired`) and a `proofHash`.

### Format & Integrity

- CSV follows RFC 4180 quoting (headers + one row per round, newest first).
- JSON uses the `vaultquest.archive.v1` schema with `generatedAt`, `count`, `redacted`, `records`, and `winners`.
- Every document ships a **proof hash** (FNV-1a over the canonical record rows) so a changed/truncated export is detectable.
- Identical input produces byte-identical output when `generatedAt` is pinned (the exporter is deterministic and sort-stable).

### Privacy

Exports are **redacted by default**: per-winner wallet addresses are stripped from the `winners` list. Pass `redact: false` to include addresses for internal reconciliation only.

### Filters

Decay can be restricted by `fromDate` / `toDate` (by `endDate`) and `network` before export. Totals (`summarizeArchive`) always reflect the filtered set.

Tests: `tests/archive-export.test.ts`. Exporter lives in `lib/archive-export.ts` (pure, DOM-free).
