//! Draw auditability tests (#718): commit/reveal, Merkle snapshot proofs,
//! winner recomputation, and event completeness for independent verification.
//!
//! These tests live inside the contract's own test module so they run with
//! `cargo test` exactly like the existing regression suites (#139/#140/#141).

use super::draw_audit as da;
use super::*;
// The crate is #![no_std]; the std-formatting macros used by the golden
// fixture emitter below must be imported explicitly (they are available in
// test builds via the harness's std).
use soroban_sdk::{BytesN, Env, FromVal, Symbol, Val, Vec};
use std::{format, println};

// ── helpers ────────────────────────────────────────────────────────────────

/// Build the Merkle tree over leaf hashes exactly like the documented
/// canonicalization: leaves in the given (address-sorted) order; a lone
/// node at odd depth promotes unchanged. Returns (root, per-leaf proofs in
/// the same order as the input leaves).
fn build_merkle(
    env: &Env,
    leaves: &[(&Address, i128, BytesN<32>)],
) -> (BytesN<32>, Vec<Vec<MerkleProofEntry>>) {
    // levels[cur] holds the hashes at tree depth cur (leaves at 0).
    let mut levels: Vec<Vec<BytesN<32>>> = Vec::new(env);
    let mut level0: Vec<BytesN<32>> = Vec::new(env);
    for (_, _, h) in leaves.iter() {
        level0.push_back(h.clone());
    }
    levels.push_back(level0);

    let mut cur: u32 = 0;
    while levels.get(cur).unwrap().len() > 1 {
        let prev = levels.get(cur).unwrap();
        let mut next: Vec<BytesN<32>> = Vec::new(env);
        let mut i: u32 = 0;
        while i < prev.len() {
            let left = prev.get(i).unwrap();
            let right = if i + 1 < prev.len() {
                prev.get(i + 1).unwrap()
            } else {
                prev.get(i).unwrap() // lone node promotes unchanged
            };
            next.push_back(da::hash_pair(env, &left, &right));
            i += 2;
        }
        levels.push_back(next);
        cur += 1;
    }

    let root = levels.get(cur).unwrap().get(0).unwrap();

    // Proofs: for leaf j, at each level the sibling index is j^1 (or the
    // promoted self when j is the last odd index).
    let mut proofs: Vec<Vec<MerkleProofEntry>> = Vec::new(env);
    for j in 0..leaves.len() as u32 {
        let mut proof: Vec<MerkleProofEntry> = Vec::new(env);
        let mut idx = j;
        for level in 0..levels.len() - 1 {
            let nodes = levels.get(level).unwrap();
            let sib = if idx % 2 == 0 {
                if idx + 1 < nodes.len() {
                    idx + 1
                } else {
                    idx // promoted lone node
                }
            } else {
                idx - 1
            };
            let position = idx % 2 == 1; // true when our node is the right one
            proof.push_back(MerkleProofEntry {
                hash: nodes.get(sib).unwrap(),
                position,
            });
            idx /= 2;
        }
        proofs.push_back(proof);
    }

    (root, proofs)
}

/// Leaf hashes for all participants, sorted by address strkey ascending —
/// the contract's documented leaf order. Host-side std Vec is used so the
/// helper can sort with plain owned types.
fn sorted_leaves(
    env: &Env,
    round_id: u32,
    participants: std::vec::Vec<Address>,
    deposits: std::vec::Vec<i128>,
) -> std::vec::Vec<(Address, i128, BytesN<32>)> {
    let mut entries: std::vec::Vec<(Address, i128, BytesN<32>)> = participants
        .into_iter()
        .zip(deposits)
        .map(|(who, dep)| {
            let h = da::leaf_hash(env, round_id, &who, &dep);
            (who, dep, h)
        })
        .collect();
    entries.sort_by(|a, b| a.0.to_string().cmp(&b.0.to_string()));
    entries
}

const SEED: [u8; 32] = [
    0x2a, 0x71, 0x9d, 0x03, 0x5c, 0xbb, 0x16, 0x8f, 0x41, 0xe0, 0x77, 0x92, 0x63, 0x54, 0xa8, 0x1c,
    0x0f, 0xe3, 0x6b, 0xd2, 0x84, 0x19, 0xc7, 0x50, 0x9a, 0x2e, 0xfd, 0x60, 0x33, 0xb5, 0x88, 0x11,
];

// ── canonical hashing ──────────────────────────────────────────────────────

#[test]
fn leaf_hash_is_domain_separated_and_deterministic() {
    let env = Env::default();
    let who = Address::generate(&env);
    let h1 = da::leaf_hash(&env, 3, &who, &1_000);
    let h2 = da::leaf_hash(&env, 3, &who, &1_000);
    assert_eq!(h1, h2);

    assert_ne!(h1, da::leaf_hash(&env, 4, &who, &1_000));
    assert_ne!(h1, da::leaf_hash(&env, 3, &who, &2_000));
    assert_ne!(h1, da::leaf_hash(&env, 3, &Address::generate(&env), &1_000));
}

#[test]
fn deposit_encoding_is_minimal_be() {
    let env = Env::default();
    // 0 -> empty (matches BigInt(0).toString(16) in the TS verifier)
    assert_eq!(da::deposit_be_bytes(&env, &0).len(), 0);
    // 256 -> 0x01 0x00
    assert_eq!(da::deposit_be_bytes(&env, &256).len(), 2);
    assert_eq!(da::deposit_be_bytes(&env, &256).get(0), Some(1));
    assert_eq!(da::deposit_be_bytes(&env, &256).get(1), Some(0));
    // 255 -> single 0xff byte
    assert_eq!(da::deposit_be_bytes(&env, &255).len(), 1);
    assert_eq!(da::deposit_be_bytes(&env, &255).get(0), Some(255));
}

#[test]
fn seed_hash_and_randomness_bind_round_and_ledger() {
    let env = Env::default();
    let seed = BytesN::from_array(&env, &SEED);
    let h = da::seed_hash(&env, 1, &seed);
    assert_ne!(h, da::seed_hash(&env, 2, &seed));
    assert_ne!(
        h,
        da::seed_hash(&env, 1, &BytesN::from_array(&env, &[0u8; 32]))
    );

    let r1 = da::draw_randomness(&env, 1, &seed, 100);
    let r2 = da::draw_randomness(&env, 1, &seed, 101);
    assert_ne!(
        r1, r2,
        "different draw ledgers must yield different randomness"
    );
    assert_eq!(r1, da::draw_randomness(&env, 1, &seed, 100));
}

#[test]
fn winner_index_matches_documented_mod_formula() {
    // The byte-wise long division must equal (u256 % count): randomness of
    // 0x0103 = 259 -> mod 100 = 59, mod 1 = 0, mod 259 = 0, mod 260 = 259.
    let env = Env::default();
    let mut bytes = [0u8; 32];
    bytes[30] = 0x01;
    bytes[31] = 0x03;
    let r = BytesN::from_array(&env, &bytes);
    assert_eq!(da::winner_index_from_randomness(&r, 100), 59);
    assert_eq!(da::winner_index_from_randomness(&r, 1), 0);
    assert_eq!(da::winner_index_from_randomness(&r, 259), 0);
    assert_eq!(da::winner_index_from_randomness(&r, 260), 259);
}

// ── Merkle verification ────────────────────────────────────────────────────

#[test]
fn merkle_proof_verifies_and_rejects_forgeries() {
    let env = Env::default();
    let round_id = 7;
    let participants: std::vec::Vec<Address> = (0..5).map(|_| Address::generate(&env)).collect();
    let deposits: std::vec::Vec<i128> = (0..5).map(|i| 100i128 * (i + 1)).collect();

    let leaves = sorted_leaves(&env, round_id, participants, deposits);
    let refs: std::vec::Vec<(&Address, i128, BytesN<32>)> =
        leaves.iter().map(|(w, d, h)| (w, *d, h.clone())).collect();
    let (root, proofs) = build_merkle(&env, &refs);

    for j in 0..5u32 {
        let (who, dep, leaf) = {
            let e = &leaves[j as usize];
            (e.0.clone(), e.1, e.2.clone())
        };
        let proof = proofs.get(j).unwrap();
        assert!(
            da::verify_merkle_proof(&env, &leaf, &proof, &root),
            "proof for participant {} must verify",
            j
        );

        // Forged leaf (wrong deposit) fails.
        let forged = da::leaf_hash(&env, round_id, &who, &(dep + 1));
        assert!(!da::verify_merkle_proof(&env, &forged, &proof, &root));

        // Forged root fails.
        let other_root = BytesN::from_array(&env, &[9u8; 32]);
        assert!(!da::verify_merkle_proof(&env, &leaf, &proof, &other_root));
    }
}

#[test]
fn envelope_root_binds_round_and_count() {
    let env = Env::default();
    let inner = BytesN::from_array(&env, &[7u8; 32]);
    let a = da::envelope_snapshot_root(&env, 1, 5, &inner);
    assert_ne!(a, da::envelope_snapshot_root(&env, 2, 5, &inner));
    assert_ne!(a, da::envelope_snapshot_root(&env, 1, 6, &inner));
    assert_ne!(
        a,
        da::envelope_snapshot_root(&env, 1, 5, &BytesN::from_array(&env, &[8u8; 32]))
    );
}

// ── full round lifecycle through the contract ──────────────────────────────

/// End-to-end: create pool, open round, deposits, lock, commit, settle,
/// draw. The winner must equal the recomputation and the stored result and
/// events must carry every field needed for independent verification.
#[test]
fn round_draw_end_to_end_recomputes_and_credits_winner() {
    let (env, client, admin) = setup();

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);
    let round_id = client.open_round(&admin);
    client.round_deposit(&alice, &round_id, &1_000);
    client.round_deposit(&bob, &round_id, &500);
    client.round_deposit(&carol, &round_id, &2_000);
    client.lock_round(&admin, &round_id);

    let participants = std::vec::Vec::from([alice, bob, carol]);
    let deposits = std::vec::Vec::from([1_000i128, 500, 2_000]);
    let leaves = sorted_leaves(&env, round_id, participants, deposits);
    let refs: std::vec::Vec<(&Address, i128, BytesN<32>)> =
        leaves.iter().map(|(w, d, h)| (w, *d, h.clone())).collect();
    let (merkle_root, proofs) = build_merkle(&env, &refs);

    let seed = BytesN::from_array(&env, &SEED);
    let commit_seed_hash = da::seed_hash(&env, round_id, &seed);
    // The contract takes the RAW Merkle root and applies the envelope
    // itself; `published_root` is what storage and the event will carry.
    let published_root = da::envelope_snapshot_root(&env, round_id, 3, &merkle_root);

    client.round_commit_draw(&admin, &round_id, &commit_seed_hash, &merkle_root, &3);

    // Commitment is readable and immutable.
    let stored = client.round_draw_commit(&round_id).unwrap();
    assert_eq!(stored.seed_hash, commit_seed_hash);
    assert_eq!(stored.snapshot_root, published_root);
    assert_eq!(stored.leaf_count, 3);
    assert_eq!(
        client.try_round_commit_draw(&admin, &round_id, &commit_seed_hash, &published_root, &3),
        Err(Ok(Error::RoundDrawAlreadyCommitted))
    );

    client.settle_round(&admin, &round_id, &1_500, &800);

    // Derive the winner exactly like the contract will.
    let drawn_at = env.ledger().sequence();
    let randomness = da::draw_randomness(&env, round_id, &seed, drawn_at);
    let expected_index = da::winner_index_from_randomness(&randomness, 3);
    let (expected_winner, expected_deposit) = {
        let e = &leaves[expected_index as usize];
        (e.0.clone(), e.1)
    };
    let winner_proof = proofs.get(expected_index).unwrap();

    // Serialize the proof + raw root now: the evidence (and with it the
    // proof vector) is moved into the contract call below.
    let proof_json = winner_proof
        .iter()
        .map(|e| {
            format!(
                "{{\"hash\":\"{}\",\"position\":{}}}",
                hex32(&e.hash),
                e.position
            )
        })
        .collect::<std::vec::Vec<_>>()
        .join(",");

    let credited = client
        .try_round_draw(
            &admin,
            &round_id,
            &DrawEvidence {
                seed: seed.clone(),
                winner: expected_winner.clone(),
                deposit: expected_deposit,
                proof: winner_proof,
            },
            &800,
        )
        .unwrap()
        .unwrap();
    assert_eq!(credited, expected_winner);

    // Winner's participant prize was credited through the #377 bookkeeping.
    let p = client.savings(&expected_winner);
    assert_eq!(p.prize, 800);

    // Stored result is readable for auditors.
    let result = client.round_draw_result(&round_id).unwrap();
    assert_eq!(result.winner, expected_winner);
    assert_eq!(result.winner_index, expected_index);
    assert_eq!(result.drawn_at_ledger, drawn_at);

    // Golden-fixture capture (#718): with CAPTURE_DRAW_FIXTURE set, dump
    // every value a live verifier would see (event payloads + the
    // contract-verified evidence) so scripts/capture-draw-fixture.mjs can
    // normalize it into tools/draw-verifier/testdata/round-fixture.json.
    // All fields come from canonical contract code paths: stored commit,
    // stored result, and the da:: hash functions the contract itself uses.
    if std::env::var("CAPTURE_DRAW_FIXTURE").is_ok() {
        let stored = client.round_draw_commit(&round_id).unwrap();
        let winner_leaf = da::leaf_hash(&env, round_id, &result.winner, &expected_deposit);
        let winner_randomness =
            da::draw_randomness(&env, round_id, &result.seed, result.drawn_at_ledger);
        let json = format!(
            "{{\"roundId\":{},\"committed\":{{\"seedHash\":\"{}\",\"snapshotRoot\":\"{}\",\"leafCount\":{}}},\"drawn\":{{\"seed\":\"{}\",\"seedHash\":\"{}\",\"merkleRoot\":\"{}\",\"leafCount\":{},\"randomness\":\"{}\",\"winnerIndex\":{},\"winner\":\"{}\",\"drawnAtLedger\":{},\"winnerDeposit\":{},\"winnerLeaf\":\"{}\",\"winnerProof\":[{}]}}}}\n",
            round_id,
            hex32(&stored.seed_hash),
            hex32(&stored.snapshot_root),
            stored.leaf_count,
            hex32(&result.seed),
            hex32(&stored.seed_hash),
            hex32(&stored.snapshot_root), // events publish the ENVELOPED root
            stored.leaf_count,
            hex32(&winner_randomness),
            result.winner_index,
            result.winner.to_string(),
            result.drawn_at_ledger,
            expected_deposit,
            hex32(&winner_leaf),
            proof_json,
        );
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("draw-event-fixture.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, json).unwrap();
        println!("DRAW_EVENT_FIXTURE written to {}", path.display());
    }
}

/// Lowercase hex of a 32-byte hash for the JSON fixture.
fn hex32(v: &BytesN<32>) -> std::string::String {
    v.to_array()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<std::string::String>()
}

#[test]
fn round_draw_rejects_wrong_seed_and_missing_commit() {
    let (env, client, admin) = setup();

    let alice = Address::generate(&env);

    // Round 1: draw before any commit fails (must settle first — status is
    // checked before the commitment lookup).
    let round_a = client.open_round(&admin);
    client.round_deposit(&alice, &round_a, &1_000);
    client.lock_round(&admin, &round_a);

    let evidence = DrawEvidence {
        seed: BytesN::from_array(&env, &SEED),
        winner: alice.clone(),
        deposit: 1_000,
        proof: Vec::new(&env),
    };
    assert_eq!(
        client.try_round_draw(&admin, &round_a, &evidence, &50),
        Err(Ok(Error::RoundDrawNotSettled))
    );
    client.settle_round(&admin, &round_a, &100, &50);
    assert_eq!(
        client.try_round_draw(&admin, &round_a, &evidence, &50),
        Err(Ok(Error::RoundDrawNotLocked))
    );

    // Round 2: commit with seed A, reveal seed B -> mismatch.
    let round_b = client.open_round(&admin);
    client.round_deposit(&alice, &round_b, &1_000);
    client.lock_round(&admin, &round_b);

    let seed_a = BytesN::from_array(&env, &SEED);
    client.round_commit_draw(
        &admin,
        &round_b,
        &da::seed_hash(&env, round_b, &seed_a),
        &da::leaf_hash(&env, round_b, &alice, &1_000),
        &1,
    );
    client.settle_round(&admin, &round_b, &100, &50);

    let seed_b = BytesN::from_array(&env, &[1u8; 32]);
    let bad = DrawEvidence {
        seed: seed_b,
        winner: alice.clone(),
        deposit: 1_000,
        proof: Vec::new(&env),
    };
    assert_eq!(
        client.try_round_draw(&admin, &round_b, &bad, &50),
        Err(Ok(Error::RoundDrawSeedMismatch))
    );
}

#[test]
fn round_draw_rejects_forged_snapshot_membership() {
    let (env, client, admin) = setup();

    let alice = Address::generate(&env);
    let outsider = Address::generate(&env);
    let round_id = client.open_round(&admin);
    client.round_deposit(&alice, &round_id, &1_000);
    client.lock_round(&admin, &round_id);

    // Snapshot contains ONLY alice (raw root; the contract envelopes it).
    let leaf = da::leaf_hash(&env, round_id, &alice, &1_000);
    let root = da::envelope_snapshot_root(&env, round_id, 1, &leaf);
    let seed = BytesN::from_array(&env, &SEED);
    client.round_commit_draw(
        &admin,
        &round_id,
        &da::seed_hash(&env, round_id, &seed),
        &leaf,
        &1,
    );
    assert_eq!(
        client.round_draw_commit(&round_id).unwrap().snapshot_root,
        root
    );

    client.settle_round(&admin, &round_id, &100, &100);

    // Outsider claims the prize with a lying witness: no frozen deposit.
    let evidence = DrawEvidence {
        seed: seed.clone(),
        winner: outsider.clone(),
        deposit: 999,
        proof: Vec::new(&env),
    };
    assert_eq!(
        client.try_round_draw(&admin, &round_id, &evidence, &100),
        Err(Ok(Error::RoundDrawWinnerNotInSnapshot))
    );
}

#[test]
fn round_commit_draw_requires_locked_round_and_signer() {
    let (env, client, admin) = setup();
    let stranger = Address::generate(&env);

    let round_id = client.open_round(&admin);
    let seed = BytesN::from_array(&env, &SEED);
    let root = BytesN::from_array(&env, &[2u8; 32]);

    // Not locked yet.
    assert_eq!(
        client.try_round_commit_draw(
            &admin,
            &round_id,
            &da::seed_hash(&env, round_id, &seed),
            &root,
            &1
        ),
        Err(Ok(Error::RoundDrawNotLocked))
    );

    client.round_deposit(&admin, &round_id, &100);
    client.lock_round(&admin, &round_id);

    // Not a signer.
    assert_eq!(
        client.try_round_commit_draw(
            &stranger,
            &round_id,
            &da::seed_hash(&env, round_id, &seed),
            &root,
            &1
        ),
        Err(Ok(Error::Unauthorized))
    );

    // Zero leaf count rejected.
    assert_eq!(
        client.try_round_commit_draw(
            &admin,
            &round_id,
            &da::seed_hash(&env, round_id, &seed),
            &root,
            &0
        ),
        Err(Ok(Error::InvalidAmount))
    );

    client.round_commit_draw(
        &admin,
        &round_id,
        &da::seed_hash(&env, round_id, &seed),
        &root,
        &1,
    );
}

#[test]
fn round_draw_requires_settled_round_and_emits_audit_event() {
    let (env, client, admin) = setup();

    let alice = Address::generate(&env);
    let round_id = client.open_round(&admin);
    client.round_deposit(&alice, &round_id, &1_000);
    client.lock_round(&admin, &round_id);

    let leaf = da::leaf_hash(&env, round_id, &alice, &1_000);
    let root = da::envelope_snapshot_root(&env, round_id, 1, &leaf);
    let seed = BytesN::from_array(&env, &SEED);
    client.round_commit_draw(
        &admin,
        &round_id,
        &da::seed_hash(&env, round_id, &seed),
        &leaf,
        &1,
    );
    assert_eq!(
        client.round_draw_commit(&round_id).unwrap().snapshot_root,
        root
    );

    // Draw before settlement is rejected.
    let evidence = DrawEvidence {
        seed: seed.clone(),
        winner: alice.clone(),
        deposit: 1_000,
        proof: Vec::new(&env),
    };
    assert_eq!(
        client.try_round_draw(&admin, &round_id, &evidence, &100),
        Err(Ok(Error::RoundDrawNotSettled))
    );

    client.settle_round(&admin, &round_id, &0, &1_000);

    let winner = client
        .try_round_draw(&admin, &round_id, &evidence, &1_000)
        .unwrap()
        .unwrap();
    assert_eq!(winner, alice);

    // The audit event carries every recompute input. Inspect the draw
    // invocation's events immediately: sdk 27's `events().all()` exposes
    // only the most recent invocation's events.
    let mut audit_fields: Option<Vec<Val>> = None;
    for e in env.events().all().events() {
        let body = match &e.body {
            soroban_sdk::xdr::ContractEventBody::V0(v0) => v0,
        };
        if body.topics.len() < 2 {
            continue;
        }
        let t1 = Symbol::from_val(&env, body.topics.get(1).unwrap());
        if t1 == symbol_short!("drawn") {
            audit_fields = Some(Vec::<Val>::from_val(&env, &body.data.clone()));
        }
    }
    // [round_id, seed_hash, seed, snapshot_root, leaf_count,
    //  randomness, winner_index, winner, drawn_at_ledger]
    let fields = audit_fields.expect("round drawn audit event must be emitted");
    assert_eq!(
        fields.len(),
        9,
        "round drawn event must carry all 9 audit fields"
    );
}
