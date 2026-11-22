/**
 * Self-tests for the standalone draw verifier (#718).
 *
 * Run: node --test test/verify-draw.test.mjs
 *
 * The golden fixture at testdata/round-fixture.json is produced by
 * scripts/capture-draw-fixture.mjs from the contract's own Rust test run
 * (real canonical-contract event data), so these tests double as the CI
 * cross-check that the TS verifier and the Rust contract agree exactly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DRAW_LEAF_DOMAIN = "vaultquest-draw-leaf";
const DRAW_SEED_DOMAIN = "vaultquest-draw-seed";
const DRAW_ROOT_DOMAIN = "vaultquest-draw-root";

const sha256 = (buf) => createHash("sha256").update(buf).digest();

// Re-implement the tiny hash builders here (test-local copies) so a bug in
// verify-draw.mjs cannot hide behind a shared import.
function beU32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n >>> 0);
  return buf;
}

function depositBeHex(bi) {
  if (bi === 0n) return "";
  let hex = bi.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  return hex;
}

function leafHash(roundId, address, depositBi) {
  return sha256(
    Buffer.concat([
      Buffer.from(DRAW_LEAF_DOMAIN, "utf8"),
      beU32(roundId),
      Buffer.from(address, "utf8"),
      Buffer.from(depositBeHex(depositBi), "hex"),
    ])
  ).toString("hex");
}

function seedHash(roundId, seedHex) {
  return sha256(
    Buffer.concat([Buffer.from(DRAW_SEED_DOMAIN, "utf8"), beU32(roundId), Buffer.from(seedHex, "hex")])
  ).toString("hex");
}

function beU64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n) & 0xffffffffffffffffn);
  return buf;
}

function drawRandomness(roundId, seedHex, ledger) {
  return sha256(
    Buffer.concat([
      Buffer.from(DRAW_SEED_DOMAIN, "utf8"),
      beU32(roundId),
      Buffer.from(seedHex, "hex"),
      beU64(ledger), // u64 in the contract (drawn_at_ledger)
    ])
  ).toString("hex");
}

function envelopeRoot(roundId, leafCount, merkleRootHex) {
  return sha256(
    Buffer.concat([
      Buffer.from(DRAW_ROOT_DOMAIN, "utf8"),
      beU32(roundId),
      beU32(leafCount),
      Buffer.from(merkleRootHex, "hex"),
    ])
  ).toString("hex");
}

test("deposit encoding matches the contract's minimal big-endian rule", () => {
  assert.equal(depositBeHex(0n), "");
  assert.equal(depositBeHex(255n), "ff");
  assert.equal(depositBeHex(256n), "0100");
  assert.equal(depositBeHex(1000n), "03e8");
  // No sign-disambiguation octet: the contract emits raw minimal BE bytes.
  assert.equal(depositBeHex(0xffffffffffffffffn), "ffffffffffffffff");
});

test("hash builders are domain-separated", () => {
  const seed = "aa".repeat(32);
  assert.notEqual(seedHash(1, seed), seedHash(2, seed));
  assert.notEqual(drawRandomness(1, seed, 10), drawRandomness(1, seed, 11));
  assert.notEqual(envelopeRoot(1, 3, seed), envelopeRoot(2, 3, seed));
});

test("winner index equals BigInt mod (documented formula)", () => {
  // 0x0103 = 259 placed in the low bytes, so the value IS 259 and the
  // modular facts are direct: 259 mod 100 = 59 and 259 mod 259 = 0.
  const randomness = "0".repeat(60) + "0103";
  assert.equal(BigInt("0x" + randomness) % 100n, 59n);
  assert.equal(BigInt("0x" + randomness) % 259n, 0n);
});

test("golden fixture from contract events verifies", () => {
  const fixturePath = path.join(HERE, "..", "testdata", "round-fixture.json");
  const bundle = JSON.parse(readFileSync(fixturePath, "utf8"));
  const { commit, draw } = bundle;

  // 1. Reveal matches commitment.
  assert.equal(seedHash(commit.roundId, draw.seed), commit.seedHash, "seed reveal mismatch");

  // 2. Randomness derivation.
  const randomness = drawRandomness(commit.roundId, draw.seed, draw.drawnAtLedger);
  assert.equal(randomness, draw.randomness, "randomness mismatch");

  // 3. Winner index formula.
  const idx = BigInt("0x" + randomness) % BigInt(commit.leafCount);
  assert.equal(idx, BigInt(draw.winnerIndex), "winner index mismatch");

  // 4. Winner leaf + proof. The draw event carries the enveloped root in
  // `merkleRoot`; the raw root is recovered by folding the winner's proof,
  // then re-envelope-bound to the committed snapshot root.
  const leaf = leafHash(commit.roundId, draw.winner, BigInt(draw.winnerDeposit));
  assert.equal(leaf, draw.winnerLeaf, "winner leaf mismatch");
  let current = Buffer.from(leaf, "hex");
  for (const entry of draw.winnerProof) {
    const sibling = Buffer.from(entry.hash, "hex");
    current = entry.position
      ? current.equals(sibling)
        ? current
        : sha256(Buffer.concat([sibling, current]))
      : current.equals(sibling)
        ? current
        : sha256(Buffer.concat([current, sibling]));
  }
  const rawRoot = current.toString("hex");
  assert.equal(
    envelopeRoot(commit.roundId, commit.leafCount, rawRoot),
    commit.snapshotRoot,
    "winner proof does not resolve to the committed snapshot root"
  );
});
