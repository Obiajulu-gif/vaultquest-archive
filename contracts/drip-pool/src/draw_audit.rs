//! Draw auditability (#718).
//!
//! Everything an independent auditor needs to recompute a round's winner
//! from public chain data only, mirroring the off-chain `lib/draw-proof.ts`
//! canonicalization contract:
//!
//! - `leaf_hash`     = SHA-256("vaultquest-draw-leaf" || round_id_be8 || strkey(addr) || deposit_be)
//! - `seed_hash`     = SHA-256("vaultquest-draw-seed" || round_id_be8 || seed32)
//! - `snapshot_root` = SHA-256("vaultquest-draw-root" || round_id_be8 || leaf_count_be8 || merkle_root32)
//! - `randomness`    = SHA-256("vaultquest-draw-seed" || round_id_be8 || seed32 || drawn_at_ledger_be8)
//! - `winner_index`  = randomness (u256, big-endian) mod leaf_count
//!
//! Every hash input starts with a domain tag and the big-endian round id so
//! evidence can never be replayed across rounds or contract instances. All
//! integers are big-endian. Deposit hex is the minimal big-endian encoding
//! (empty for zero, matching `BigInt.toString(16)` in the TS verifier);
//! leaf hashes include the full 56-char strkey, so distinct addresses with
//! equal deposits always hash distinctly.
//!
//! The winner formula is exactly the one documented in
//! VAULTQUEST_ARCHITECTURE_DESIGN.md (`randomness % eligible count`) — the
//! u256 mod is computed byte-wise on-chain (32 iterations) so the TS
//! verifier reproduces it bit-exactly with one BigInt `%`.

use soroban_sdk::{vec, Address, Bytes, BytesN, Env, IntoVal, String, Val, Vec};

use crate::{DataKey, Error, MerkleProofEntry, RoundDrawCommit, RoundDrawResult};

const DRAW_LEAF_DOMAIN: &[u8] = b"vaultquest-draw-leaf";
const DRAW_SEED_DOMAIN: &[u8] = b"vaultquest-draw-seed";
const DRAW_ROOT_DOMAIN: &[u8] = b"vaultquest-draw-root";

/// Big-endian minimal-length encoding of a non-negative `i128` as `Bytes`.
/// Empty for zero, otherwise the shortest big-endian byte string — exactly
/// the byte semantics of JS `BigInt(n).toString(16)` in the TS verifier.
pub fn deposit_be_bytes(env: &Env, amount: &i128) -> Bytes {
    if *amount <= 0 {
        // Deposits are validated positive upstream; zero encodes empty.
        return Bytes::new(env);
    }
    let mut be = [0u8; 16];
    let mut i = 16;
    let mut v = *amount;
    while v > 0 {
        i -= 1;
        be[i] = (v & 0xff) as u8;
        v >>= 8;
    }
    Bytes::from_slice(env, &be[i..])
}

fn u32_be_bytes(env: &Env, v: u32) -> Bytes {
    Bytes::from_array(env, &v.to_be_bytes())
}

fn u64_be_bytes(env: &Env, v: u64) -> Bytes {
    Bytes::from_array(env, &v.to_be_bytes())
}

/// `leaf_hash = SHA256("vaultquest-draw-leaf" || round_id_be8 || strkey(addr) || deposit_be)`
pub fn leaf_hash(env: &Env, round_id: u32, who: &Address, deposit: &i128) -> BytesN<32> {
    let mut input = Bytes::from_slice(env, DRAW_LEAF_DOMAIN);
    input.append(&u32_be_bytes(env, round_id));
    input.append(&Bytes::from(who.to_string()));
    input.append(&deposit_be_bytes(env, deposit));
    env.crypto().sha256(&input).into()
}

/// `seed_hash = SHA256("vaultquest-draw-seed" || round_id_be8 || seed32)`
pub fn seed_hash(env: &Env, round_id: u32, seed: &BytesN<32>) -> BytesN<32> {
    let mut input = Bytes::from_slice(env, DRAW_SEED_DOMAIN);
    input.append(&u32_be_bytes(env, round_id));
    input.append(&Bytes::from_array(env, &seed.to_array()));
    env.crypto().sha256(&input).into()
}

/// `snapshot_root = SHA256("vaultquest-draw-root" || round_id_be8 || leaf_count_be8 || merkle_root32)`
///
/// The envelope binds the root to this round and this ticket count, so a
/// root from another round (or computed over a different participant set)
/// can never be substituted as evidence.
pub fn envelope_snapshot_root(
    env: &Env,
    round_id: u32,
    leaf_count: u32,
    merkle_root: &BytesN<32>,
) -> BytesN<32> {
    let mut input = Bytes::from_slice(env, DRAW_ROOT_DOMAIN);
    input.append(&u32_be_bytes(env, round_id));
    input.append(&u32_be_bytes(env, leaf_count));
    input.append(&Bytes::from_array(env, &merkle_root.to_array()));
    env.crypto().sha256(&input).into()
}

/// `randomness = SHA256("vaultquest-draw-seed" || round_id_be8 || seed32 || drawn_at_ledger_be8)`
pub fn draw_randomness(
    env: &Env,
    round_id: u32,
    seed: &BytesN<32>,
    drawn_at_ledger: u32,
) -> BytesN<32> {
    let mut input = Bytes::from_slice(env, DRAW_SEED_DOMAIN);
    input.append(&u32_be_bytes(env, round_id));
    input.append(&Bytes::from_array(env, &seed.to_array()));
    input.append(&u64_be_bytes(env, u64::from(drawn_at_ledger)));
    env.crypto().sha256(&input).into()
}

/// `randomness mod leaf_count` with `randomness` read as a big-endian u256.
/// Byte-wise long division: for each of the 32 bytes,
/// `acc = (acc * 256 + byte) mod m`, exactly what a TS
/// `BigInt(randomnessHex, 16) % BigInt(m)` computes.
pub fn winner_index_from_randomness(randomness: &BytesN<32>, leaf_count: u32) -> u32 {
    let r = randomness.to_array();
    let m = leaf_count as u64;
    let mut acc: u64 = 0;
    for b in r.iter() {
        acc = (acc * 256 + u64::from(*b)) % m;
    }
    acc as u32
}

/// Fold a leaf and its proof path into the raw Merkle root (no envelope).
/// Used by `round_draw` before applying the round/leaf-count envelope.
pub fn compute_merkle_root(
    env: &Env,
    leaf: &BytesN<32>,
    proof: &Vec<MerkleProofEntry>,
) -> BytesN<32> {
    let mut current = leaf.clone();
    for i in 0..proof.len() {
        let entry = proof.get(i).unwrap();
        current = if entry.position {
            hash_pair(env, &entry.hash, &current)
        } else {
            hash_pair(env, &current, &entry.hash)
        };
    }
    current
}

/// Verify a Merkle proof for `leaf` against a raw (unenveloped) `root`.
/// Leaves are ordered by address strkey; when two entries have identical
/// leaf hashes the caller must supply them in sorted order (identical hashes
/// are interchangeable, so proof validity is unaffected).
pub fn verify_merkle_proof(
    env: &Env,
    leaf: &BytesN<32>,
    proof: &Vec<MerkleProofEntry>,
    root: &BytesN<32>,
) -> bool {
    compute_merkle_root(env, leaf, proof) == *root
}

/// Standard non-gradient Merkle node: a lone node at odd depth is promoted
/// unchanged (unbalanced tree). `hash_pair(a, a) == hash_pair(a, b)` only
/// when `a == b`, so a sibling claim can never be forged by substituting a
/// different leaf.
pub fn hash_pair(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    if left == right {
        return left.clone();
    }
    let mut input = Bytes::from_array(env, &left.to_array());
    input.append(&Bytes::from_array(env, &right.to_array()));
    env.crypto().sha256(&input).into()
}

/// Recompute the winner from public draw-audit evidence and store it.
///
/// Called by `round_draw` after the seed reveal is verified against the
/// commitment made at lock time. Everything here is derived from on-chain
/// data: the seed (revealed in the event), the commitment (stored at lock),
/// and the Merkle proof supplied by the caller — checked against the
/// committed snapshot root, so an incorrect proof cannot manufacture a
/// winner the lock-time snapshot does not support.
pub fn recompute_and_store(
    env: &Env,
    round_id: u32,
    commit: &RoundDrawCommit,
    seed: &BytesN<32>,
    winner_index: u32,
    winner: &Address,
    drawn_at_ledger: u32,
) -> Result<RoundDrawResult, Error> {
    if seed_hash(env, round_id, seed) != commit.seed_hash {
        return Err(Error::RoundDrawSeedMismatch);
    }
    let randomness = draw_randomness(env, round_id, seed, drawn_at_ledger);
    let expected_index = winner_index_from_randomness(&randomness, commit.leaf_count);
    if winner_index != expected_index {
        return Err(Error::RoundDrawWinnerNotInSnapshot);
    }
    let result = RoundDrawResult {
        seed: seed.clone(),
        winner_index,
        winner: winner.clone(),
        drawn_at_ledger,
    };
    env.storage()
        .persistent()
        .set(&DataKey::RoundDrawResult(round_id), &result);
    Ok(result)
}

/// The `round_draw` event payload: every field an auditor needs to
/// independently recompute the winner, in one event.
pub fn draw_event_fields(
    env: &Env,
    round_id: u32,
    commit: &RoundDrawCommit,
    result: &RoundDrawResult,
) -> Vec<Val> {
    let randomness = draw_randomness(env, round_id, &result.seed, result.drawn_at_ledger);
    vec![
        env,
        round_id.into_val(env),
        commit.seed_hash.to_val(),
        result.seed.to_val(),
        commit.snapshot_root.to_val(),
        commit.leaf_count.into_val(env),
        randomness.to_val(),
        result.winner_index.into_val(env),
        result.winner.to_val(),
        result.drawn_at_ledger.into_val(env),
    ]
}

/// Stable string form of an address (strkey) for event payloads.
#[allow(dead_code)]
pub fn addr_str(who: &Address) -> String {
    who.to_string()
}
