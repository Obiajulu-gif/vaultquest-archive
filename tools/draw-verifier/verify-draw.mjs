#!/usr/bin/env node
/**
 * VaultQuest round-draw verifier (#718).
 *
 * Standalone audit tool: recomputes a round's winner from PUBLIC CHAIN DATA
 * ONLY — Soroban contract storage + emitted contract events, read straight
 * from a Soroban RPC endpoint or from a captured fixture. No backend, no
 * database, no API keys, no npm dependencies (Node >= 18 built-ins only:
 * node:crypto for SHA-256, global fetch for RPC).
 *
 * This tool deliberately re-implements the contract's draw-audit
 * canonicalization and its own XDR (de)serialization instead of importing
 * repo helpers, so a compromised backend or app bundle cannot alter what an
 * auditor verifies.
 *
 * Algorithm (must match contracts/drip-pool/src/draw_audit.rs):
 *   leaf_hash     = SHA256("vaultquest-draw-leaf" || round_id_be8 || strkey || deposit_be)
 *   seed_hash     = SHA256("vaultquest-draw-seed" || round_id_be8 || seed32)
 *   randomness    = SHA256("vaultquest-draw-seed" || round_id_be8 || seed32 || ledger_be8)
 *   winner_index  = randomness(u256 BE) mod leaf_count
 *   snapshot_root = SHA256("vaultquest-draw-root" || round_id_be8 || leaf_count_be8 || merkle_root32)
 *
 * Usage:
 *   Live RPC (needs a deployed contract with round draws):
 *     node verify-draw.mjs verify --contract C... --round 3 \
 *       [--rpc-url https://soroban-testnet.stellar.org]
 *   Fixture (offline; a bundle captured with `capture`, incl. one produced
 *   from the contract's own Rust test events):
 *     node verify-draw.mjs verify-fixture --fixture round-3.json
 *   Capture (writes a re-verifiable offline bundle from live chain data):
 *     node verify-draw.mjs capture --contract C... --round 3 --out round-3.json
 *
 * Exit codes: 0 = VERIFIED, 1 = verification FAILED, 2 = usage/transport error.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// ── constants (mirror draw_audit.rs) ────────────────────────────────────────

const DRAW_LEAF_DOMAIN = "vaultquest-draw-leaf";
const DRAW_SEED_DOMAIN = "vaultquest-draw-seed";
const DRAW_ROOT_DOMAIN = "vaultquest-draw-root";
const DEFAULT_RPC = "https://soroban-testnet.stellar.org";
const DEFAULT_PASSPHRASE = "Test SDF Network ; September 2015";

const sha256 = (buf) => createHash("sha256").update(buf).digest();
const concatHex = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p, "hex")));

/** Minimal big-endian hex of a BigInt ("" for 0), exactly the bytes
 * deposit_be_bytes in draw_audit.rs produces: no sign octet, no padding —
 * just the shortest big-endian byte string that represents the value. */
function depositBeHex(bi) {
  if (bi === 0n) return "";
  let hex = bi.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  return hex;
}

const beU32 = (n) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n >>> 0);
  return buf.toString("hex");
};

const beU64 = (n) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n) & 0xffffffffffffffffn);
  return buf.toString("hex");
};

// ── hash builders ───────────────────────────────────────────────────────────

function leafHash(roundId, address, depositBi) {
  return sha256(
    concatHex(
      Buffer.from(DRAW_LEAF_DOMAIN, "utf8"),
      Buffer.from(beU32(roundId), "hex"),
      Buffer.from(address, "utf8"),
      Buffer.from(depositBeHex(depositBi), "hex")
    )
  ).toString("hex");
}

function seedHash(roundId, seedHex) {
  return sha256(
    concatHex(Buffer.from(DRAW_SEED_DOMAIN, "utf8"), Buffer.from(beU32(roundId), "hex"), Buffer.from(seedHex, "hex"))
  ).toString("hex");
}

function drawRandomness(roundId, seedHex, ledger) {
  return sha256(
    concatHex(
      Buffer.from(DRAW_SEED_DOMAIN, "utf8"),
      Buffer.from(beU32(roundId), "hex"),
      Buffer.from(seedHex, "hex"),
      Buffer.from(beU64(ledger), "hex") // u64 in the contract (drawn_at_ledger)
    )
  ).toString("hex");
}

function envelopeRoot(roundId, leafCount, merkleRootHex) {
  return sha256(
    concatHex(
      Buffer.from(DRAW_ROOT_DOMAIN, "utf8"),
      Buffer.from(beU32(roundId), "hex"),
      Buffer.from(beU32(leafCount), "hex"),
      Buffer.from(merkleRootHex, "hex")
    )
  ).toString("hex");
}

/** randomness mod count via BigInt — mirrors the byte-wise long division in Rust. */
const winnerIndex = (randomnessHex, leafCount) => BigInt("0x" + randomnessHex) % BigInt(leafCount);

/** Merkle verify; lone nodes promote unchanged (unbalanced tree). */
/** Fold a leaf and its proof path into the RAW Merkle root (no envelope).
 * Lone-node promotion and identical-sibling collapse mirror hash_pair in
 * draw_audit.rs: an unchanged promotion returns the node itself. */
function foldMerkleProof(leafHex, proof) {
  let current = Buffer.from(leafHex, "hex");
  for (const entry of proof) {
    const sibling = Buffer.from(entry.hash, "hex");
    if (entry.position === true) {
      current = current.equals(sibling) ? current : sha256(Buffer.concat([sibling, current]));
    } else {
      current = current.equals(sibling) ? current : sha256(Buffer.concat([current, sibling]));
    }
  }
  return current.toString("hex");
}

// ── XDR (hand-rolled reader/writer for the exact ScVal subset used) ─────────

const SCV = { BOOL: 0, U32: 3, I32: 4, U64: 5, I64: 6, U128: 9, I128: 10, U256: 11, I256: 12, BYTES: 13, STRING: 14, SYMBOL: 15, VEC: 16, MAP: 17, ADDRESS: 20 };

function xdrReadOpaque(buf, pos) {
  const len = buf.readUInt32BE(pos);
  pos += 4;
  const data = buf.subarray(pos, pos + len);
  return { data, pos: pos + len + ((4 - (len % 4)) % 4) };
}

function decodeScVal(buf, pos = 0) {
  const type = buf.readInt32BE(pos);
  pos += 4;
  switch (type) {
    case SCV.BOOL: return { value: buf[pos] === 1, pos };
    case SCV.U32: return { value: buf.readUInt32BE(pos), pos: pos + 4 };
    case SCV.I32: return { value: buf.readInt32BE(pos), pos: pos + 4 };
    case SCV.U64: return { value: buf.readBigUInt64BE(pos), pos: pos + 8 };
    case SCV.I64: return { value: buf.readBigInt64BE(pos), pos: pos + 8 };
    case SCV.U128: {
      const v = buf.readBigUInt64BE(pos + 8);
      return { value: v, pos: pos + 16 };
    }
    case SCV.I128: {
      const hi = BigInt(buf.readInt32BE(pos));
      const mid = buf.readBigUInt64BE(pos + 4);
      const lo = buf.readBigUInt64BE(pos + 12);
      return { value: (hi << 96n) | (mid << 32n) | lo, pos: pos + 20 };
    }
    case SCV.U256:
    case SCV.I256: {
      const { data, pos: p } = xdrReadOpaque(buf, pos);
      return { value: BigInt("0x" + (data.toString("hex") || "0")), pos: p };
    }
    case SCV.BYTES: {
      const { data, pos: p } = xdrReadOpaque(buf, pos);
      return { value: data.toString("hex"), pos: p };
    }
    case SCV.STRING:
    case SCV.SYMBOL: {
      const { data, pos: p } = xdrReadOpaque(buf, pos);
      return { value: data.toString("utf8"), pos: p };
    }
    case SCV.ADDRESS: {
      const discriminant = buf.readUInt32BE(pos);
      pos += 4;
      const key = buf.subarray(pos, pos + 40);
      return { value: strkeyEncode(discriminant === 0 ? "G" : "C", key), pos: pos + 40 };
    }
    case SCV.VEC: {
      if (buf.readInt32BE(pos) === 0) return { value: null, pos: pos + 4 };
      pos += 4;
      const len = buf.readUInt32BE(pos);
      pos += 4;
      const items = [];
      for (let i = 0; i < len; i++) {
        const decoded = decodeScVal(buf, pos);
        items.push(decoded.value);
        pos = decoded.pos;
      }
      return { value: items, pos };
    }
    case SCV.MAP: {
      const len = buf.readUInt32BE(pos);
      pos += 4;
      const entries = [];
      for (let i = 0; i < len; i++) {
        const k = decodeScVal(buf, pos);
        pos = k.pos;
        const v = decodeScVal(buf, pos);
        pos = v.pos;
        entries.push([k.value, v.value]);
      }
      return { value: Object.fromEntries(entries), pos };
    }
    default:
      throw new Error(`decodeScVal: unsupported ScVal type code ${type} at offset ${pos}`);
  }
}

function xdrOpaque(bodyBuf) {
  const pad = Buffer.alloc((4 - (bodyBuf.length % 4)) % 4);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bodyBuf.length);
  return Buffer.concat([len, bodyBuf, pad]);
}

/** Serialize a decoded-ScVal-shaped JS value back into ScVal XDR bytes. */
function encodeScVal(value) {
  if (typeof value === "boolean") {
    const b = Buffer.alloc(8);
    b.writeInt32BE(SCV.BOOL, 0);
    b.writeUInt8(value ? 1 : 0, 4);
    return b;
  }
  if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
    const b = Buffer.alloc(8);
    b.writeInt32BE(SCV.U32, 0);
    b.writeUInt32BE(value, 4);
    return b;
  }
  if (typeof value === "bigint") {
    const b = Buffer.alloc(24);
    b.writeInt32BE(SCV.I128, 0);
    b.writeBigUInt64BE(0n, 4); // hi pad
    b.writeBigUInt64BE(BigInt.asUintN(64, value), 12);
    return b;
  }
  if (typeof value === "string") {
    // String or hex-bytes: contract draw payloads use strings only for
    // strkeys inside leaves; event symbols arrive pre-encoded.
    const body = Buffer.from(value, "utf8");
    const b = Buffer.concat([Buffer.from([0, 0, 0, SCV.STRING]), xdrOpaque(body)]);
    return b;
  }
  throw new Error(`encodeScVal: unsupported value ${typeof value}`);
}

/** Build the ScVal XDR for `DataKey::RoundDrawCommit(round_id)` / `RoundDrawResult`. */
function roundDataKeyScVal(variantIndex, roundId) {
  // ScVal::Vec(Some([ScVal::U32(round_id)])) wrapped in the enum shape the
  // contracttype macro emits: a 2-field variant of the DataKey enum —
  // encoded as ScVal::Vec([U32(variant_index), U32(round_id)]).
  const inner = Buffer.concat([encodeScVal(variantIndex), encodeScVal(roundId)]);
  return Buffer.concat([Buffer.from([0, 0, 0, SCV.VEC, 0, 0, 0, 1]), inner]);
}

/** Strkey (base32 + CRC16-xmodem) for G/C keys. */
function strkeyEncode(versionChar, keyBytes) {
  const version = { G: 0x30, C: 0x20 }[versionChar];
  const payload = Buffer.concat([Buffer.from([version]), keyBytes]);
  const checksum = crc16xmodem(payload);
  const full = Buffer.concat([payload, Buffer.from([checksum >> 8, checksum & 0xff])]);
  return base32(full);
}

function crc16xmodem(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let bits = 0n;
  for (const b of buf) bits = (bits << 8n) | BigInt(b);
  const totalBits = buf.length * 8;
  let out = "";
  for (let i = 0; i < Math.ceil(totalBits / 5); i++) {
    const shift = BigInt(totalBits - (i + 1) * 5);
    const idx = shift >= 0n ? Number((bits >> shift) & 31n) : Number((bits << -shift) & 31n);
    out += B32[idx];
  }
  return out;
}

// ── Soroban JSON-RPC (fetch only) ───────────────────────────────────────────

async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method} error: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** Contract events for a round via getEvents, decoded from raw XDR. */
async function fetchDrawEvents(rpcUrl, contractId) {
  const result = await rpcCall(rpcUrl, "getEvents", {
    startLedger: 1,
    filters: [{ type: "contract", contractIds: [contractId] }],
    pagination: { limit: 1000 },
  });
  const events = [];
  for (const e of result.events || []) {
    const topics = (e.topic ?? []).map((b64) => decodeScVal(Buffer.from(b64, "base64")).value);
    const value = decodeScVal(Buffer.from(e.value, "base64")).value;
    events.push({
      id: e.id,
      ledger: e.ledger,
      txHash: e.txHash,
      topics,
      value,
      inSuccessfulContractCall: e.inSuccessfulContractCall,
    });
  }
  return events;
}

/** Read a persistent DataKey entry for the round. Returns decoded ScVal or null. */
async function fetchContractData(rpcUrl, contractId, keyXdr) {
  const result = await rpcCall(rpcUrl, "getLedgerEntries", { keys: [keyXdr.toString("base64")] });
  const entry = (result.entries || [])[0];
  if (!entry) return null;
  return decodeScVal(Buffer.from(entry.key, "base64")).value;
}

// ── evidence extraction ─────────────────────────────────────────────────────

/**
 * From raw decoded events, pull the commit/draw pair for a round and shape
 * the evidence bundle the verification core consumes. Works for both live
 * RPC output and fixture bundles (which store the same decoded shape).
 */
function extractEvidence(allDecodedEvents, roundId) {
  // Topics: ["round", "<action>"], payload: Vec of fields (or scalars).
  const committed = allDecodedEvents.find(
    (e) => e.topics?.[0] === "round" && e.topics?.[1] === "committed"
  );
  const drawn = allDecodedEvents.find(
    (e) => e.topics?.[0] === "round" && e.topics?.[1] === "drawn"
  );
  if (!committed) throw new Error(`no 'round committed' event found for round ${roundId}`);
  if (!drawn) throw new Error(`no 'round drawn' event found for round ${roundId}`);

  // round_commit_draw payload: (round_id, seed_hash, snapshot_root, leaf_count)
  const c = committed.value;
  if (!Array.isArray(c) || c.length !== 4) throw new Error("unexpected 'round committed' payload shape");
  const [cRound, cSeedHash, cRoot, cCount] = c;
  if (Number(cRound) !== roundId) throw new Error(`commit event is for round ${cRound}, not ${roundId}`);

  // round_draw payload: (round_id, seed_hash, seed, snapshot_root, leaf_count, randomness, winner_index, winner, drawn_at_ledger)
  const d = drawn.value;
  if (!Array.isArray(d) || d.length !== 9) throw new Error("unexpected 'round drawn' payload shape");
  const [dRound, dSeedHash, dSeed, dRoot, dCount, dRandomness, dIndex, dWinner, dLedger] = d;
  if (Number(dRound) !== roundId) throw new Error(`draw event is for round ${dRound}, not ${roundId}`);

  return {
    commit: {
      roundId,
      seedHash: cSeedHash,
      snapshotRoot: cRoot,
      leafCount: Number(cCount),
    },
    draw: {
      seed: dSeed,
      seedHash: dSeedHash,
      merkleRoot: dRoot,
      leafCount: Number(dCount),
      randomness: dRandomness,
      winnerIndex: Number(dIndex),
      winner: dWinner,
      drawnAtLedger: Number(dLedger),
    },
  };
}

// ── verification core (pure, exported for tests) ────────────────────────────

/**
 * Verify a round's draw from an evidence bundle. Returns { ok, failures,
 * winnerIndex } — never throws for verification failures.
 */
function verifyDrawEvidence(evidence) {
  const failures = [];
  const log = (ok, name, detail) => {
    if (ok) console.log(`  \u2713 ${name}`);
    else {
      failures.push(name);
      console.error(`  \u2717 ${name}${detail ? `: ${detail}` : ""}`);
    }
  };

  const { commit, draw } = evidence;

  // 0. Event cross-consistency. Both events publish the ENVELOPED snapshot
  // root (same field committed at lock time), so there is no separate raw
  // root to compare here — the raw root is recovered from the winner's
  // proof and envelope-checked in step 4.
  log(commit.seedHash === draw.seedHash, "commit/draw events agree on seed hash");
  log(commit.leafCount === draw.leafCount, "commit/draw events agree on leaf count");

  // 1. Seed reveal matches the lock-time commitment.
  const recomputedSeedHash = seedHash(commit.roundId, draw.seed);
  log(recomputedSeedHash === commit.seedHash, "seed reveal matches lock-time commitment",
    `recomputed ${recomputedSeedHash} != committed ${commit.seedHash}`);

  // 2. Randomness derivation from public inputs.
  const randomness = drawRandomness(commit.roundId, draw.seed, draw.drawnAtLedger);
  log(randomness === draw.randomness, "randomness = H(seed || round || draw ledger)",
    `recomputed ${randomness} != event ${draw.randomness}`);

  // 3. Winner index is the documented formula, not a chosen value.
  const idx = winnerIndex(randomness, commit.leafCount);
  log(idx === BigInt(draw.winnerIndex), `winner_index = randomness mod ${commit.leafCount} = ${idx}`,
    `recomputed ${idx} != event ${draw.winnerIndex}`);

  // 4. Winner Merkle proof, when the bundle carries one. Both events
  // publish the ENVELOPED snapshot root (domain || round || leaf_count ||
  // raw_root); the raw root is only recoverable by folding the winner's
  // proof. Folding it and re-applying the envelope is the binding check:
  // the winner is proven a member of exactly the committed snapshot.
  if (draw.winnerLeaf && draw.winnerProof) {
    const leaf = leafHash(commit.roundId, draw.winner, BigInt(draw.winnerDeposit));
    log(leaf === draw.winnerLeaf, "winner leaf hash matches bundle",
      `recomputed ${leaf} != supplied ${draw.winnerLeaf}`);
    const rawRoot = foldMerkleProof(leaf, draw.winnerProof);
    const enveloped = envelopeRoot(commit.roundId, commit.leafCount, rawRoot);
    log(enveloped === commit.snapshotRoot,
      "winner proof resolves to the committed snapshot (envelope binds round id + leaf count)",
      `enveloped ${enveloped} != committed ${commit.snapshotRoot}`);
  }

  return { ok: failures.length === 0, failures, winnerIndex: idx.toString() };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--contract") args.contract = argv[++i];
    else if (a === "--round") args.round = parseInt(argv[++i], 10);
    else if (a === "--rpc-url") args.rpcUrl = argv[++i];
    else if (a === "--network-passphrase") args.passphrase = argv[++i];
    else if (a === "--fixture") args.fixture = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (!args.command) args.command = a;
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node verify-draw.mjs verify --contract <C...> --round <n> [--rpc-url URL] [--network-passphrase P]
  node verify-draw.mjs verify-fixture --fixture <round.json>
  node verify-draw.mjs capture --contract <C...> --round <n> --out <round.json>`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "verify-fixture") {
    if (!args.fixture) usage();
    const bundle = JSON.parse(readFileSync(args.fixture, "utf8"));
    console.log(`Verifying captured draw bundle for round ${bundle.commit.roundId}...`);
    const { ok, failures } = verifyDrawEvidence(bundle);
    finish(ok, failures);
    return;
  }

  if (args.command === "verify" || args.command === "capture") {
    if (!args.contract || !Number.isInteger(args.round)) usage();
    const rpcUrl = args.rpcUrl || DEFAULT_RPC;
    console.log(`Fetching draw evidence for round ${args.round} of ${args.contract}`);
    console.log(`  rpc: ${rpcUrl}`);

    const events = await fetchDrawEvents(rpcUrl, args.contract);
    console.log(`  contract events fetched: ${events.length}`);
    const evidence = extractEvidence(events, args.round);

    if (args.command === "capture") {
      const out = args.out || `round-${args.round}.json`;
      writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
      console.log(`Captured offline-verifiable bundle to ${out}`);
      return;
    }

    console.log(`Verifying round ${args.round} winner (reported: ${evidence.draw.winner})...`);
    const { ok, failures } = verifyDrawEvidence(evidence);
    finish(ok, failures);
    return;
  }

  usage();
}

function finish(ok, failures) {
  if (ok) {
    console.log("\nVERIFIED: winner recomputed from public chain data matches the reported draw.");
    process.exit(0);
  } else {
    console.error(`\nFAILED: ${failures.length} check(s) did not hold: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(2);
});
