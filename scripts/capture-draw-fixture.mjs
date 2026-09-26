/**
 * Captures the emitted `round committed` / `round drawn` events from the
 * drip-pool contract's Rust test run into a raw-ScVal fixture bundle for
 * the standalone TS verifier (#718).
 *
 * Pipeline (run from contracts/drip-pool):
 *   cargo test --package drip-pool --lib draw_audit -- --nocapture
 *     → the #718 end-to-end test prints a DRAW_EVENT_FIXTURE JSON line via
 *       emit_draw_fixture (cfg(feature = "testutils") test emitter)
 *   node ../../scripts/capture-draw-fixture.mjs
 *     → reads target/draw-event-fixture.json (written by the test emitter
 *       when CAPTURE_DRAW_FIXTURE is set) and normalizes it into
 *       tools/draw-verifier/testdata/round-fixture.json
 *
 * The fixture contains ONLY what live chain data would contain (event
 * topics/values as decoded ScVal structures), so verifying it is the same
 * code path as verifying a real testnet round.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "contracts/drip-pool/target/draw-event-fixture.json");
const OUT = path.join(ROOT, "tools/draw-verifier/testdata/round-fixture.json");

const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));

// Raw shape (straight from the contract test emitter, already decoded from
// ScVal XDR): { roundId, committed: {...}, drawn: {...} } where each event
// carries exactly the payload fields the contract publishes.
const bundle = {
  commit: {
    roundId: raw.roundId,
    seedHash: raw.committed.seedHash,
    snapshotRoot: raw.committed.snapshotRoot,
    leafCount: raw.committed.leafCount,
  },
  draw: {
    seed: raw.drawn.seed,
    seedHash: raw.drawn.seedHash,
    merkleRoot: raw.drawn.merkleRoot,
    leafCount: raw.drawn.leafCount,
    randomness: raw.drawn.randomness,
    winnerIndex: raw.drawn.winnerIndex,
    winner: raw.drawn.winner,
    drawnAtLedger: raw.drawn.drawnAtLedger,
    winnerDeposit: raw.drawn.winnerDeposit,
    winnerLeaf: raw.drawn.winnerLeaf,
    winnerProof: raw.drawn.winnerProof,
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(bundle, null, 2) + "\n");
console.log(`Wrote ${OUT}`);
console.log(`  round ${bundle.commit.roundId}, leaf count ${bundle.commit.leafCount}, winner index ${bundle.draw.winnerIndex}`);
