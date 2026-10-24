/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles for PrismaClient and deliberately malformed receipts */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  InMemoryReceiptStore,
  RECEIPT_OPERATIONS,
  ReceiptAccessError,
  ReceiptService,
  StellarReceiptSigner,
  buildReceiptPayload,
  receiptMessage,
  verifyReceiptSignature,
  type ReceiptActionSnapshot,
  type ReceiptActionSource,
  type SignedReceipt,
  type StoredReceipt,
} from "../src/services/receipts.js";

// #812 — signed activity receipts for critical operations.

const ACTION_ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "GOWNERWALLET";

function action(overrides: Partial<ReceiptActionSnapshot> = {}): ReceiptActionSnapshot {
  return {
    id: ACTION_ID,
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    walletAddress: OWNER,
    actionType: "deposit",
    actionPayload: { vault_id: "vault-1", amount: "100" },
    status: "pending",
    txHash: null,
    sorobanEventId: null,
    correlationId: "33333333-3333-4333-8333-333333333333",
    errorCode: null,
    createdAt: new Date("2026-09-29T10:00:00.000Z"),
    updatedAt: new Date("2026-09-29T10:00:00.000Z"),
    submittedAt: null,
    confirmedAt: null,
    ...overrides,
  };
}

class FakeLedger implements ReceiptActionSource {
  rows = new Map<string, ReceiptActionSnapshot>();
  put(a: ReceiptActionSnapshot) {
    this.rows.set(a.id, structuredClone(a));
  }
  async getAction(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findByTxHash(txHash: string) {
    return [...this.rows.values()].find((r) => r.txHash === txHash) ?? null;
  }
}

function setup(opts: { signer?: StellarReceiptSigner; previousKeyIds?: string[]; now?: () => Date } = {}) {
  const ledger = new FakeLedger();
  const store = new InMemoryReceiptStore();
  const signer = opts.signer ?? StellarReceiptSigner.fromSecret(Keypair.random().secret());
  const svc = new ReceiptService({
    store,
    signer,
    actions: ledger,
    previousKeyIds: opts.previousKeyIds,
    now: opts.now,
  });
  return { ledger, store, signer, svc };
}

const OWNER_VIEW = { walletAddress: OWNER, canReadAny: false };

describe("receipt creation (#812)", () => {
  it("issues a signed 'requested' receipt with actor, timestamps, status and external refs", async () => {
    const { svc, signer } = setup();
    const result = await svc.issueForAction(action());
    expect(result?.created).toBe(true);
    const { payload, keyId, algorithm, signature } = result!.receipt;

    expect(payload).toMatchObject({
      version: 1,
      operation: "deposit",
      stage: "requested",
      actionId: ACTION_ID,
      actor: { walletAddress: OWNER },
      requestedAt: "2026-09-29T10:00:00.000Z",
      occurredAt: "2026-09-29T10:00:00.000Z",
      externalRefs: { txHash: null, sorobanEventId: null, correlationId: "33333333-3333-4333-8333-333333333333" },
      errorCode: null,
    });
    expect(payload.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.receiptId).toMatch(/^rcpt_[0-9a-f]{40}$/);
    expect(algorithm).toBe("ed25519");
    expect(keyId).toBe(signer.keyId);
    // Verifiable offline with nothing but stellar-sdk and the public key.
    expect(Keypair.fromPublicKey(keyId).verify(receiptMessage(payload), Buffer.from(signature, "base64"))).toBe(true);
  });

  it("never includes the raw action payload", async () => {
    const { svc } = setup();
    const { receipt } = (await svc.issueForAction(action({ actionPayload: { secretNote: "hidden-value" } })))!;
    expect(JSON.stringify(receipt)).not.toContain("hidden-value");
  });

  it("covers every selected critical operation and skips compensating actions", async () => {
    const { svc } = setup();
    for (const [i, op] of RECEIPT_OPERATIONS.entries()) {
      const r = await svc.issueForAction(action({ id: `op-${i}`, actionType: op }));
      expect(r?.receipt.payload.operation).toBe(op);
    }
    expect(await svc.issueForAction(action({ actionType: "compensating" }))).toBeNull();
  });

  it("issues one receipt per lifecycle stage and lists them in order", async () => {
    const { svc, ledger } = setup();
    const a = action();
    ledger.put(a);
    await svc.issueForAction(a);
    const submitted = { ...a, status: "submitted", txHash: "ab".repeat(32), submittedAt: new Date("2026-09-29T10:01:00.000Z"), updatedAt: new Date("2026-09-29T10:01:00.000Z") };
    ledger.put(submitted);
    await svc.issueForAction(submitted);
    const confirmed = { ...submitted, status: "confirmed", sorobanEventId: "evt-9", confirmedAt: new Date("2026-09-29T10:02:00.000Z"), updatedAt: new Date("2026-09-29T10:02:00.000Z") };
    ledger.put(confirmed);
    await svc.issueForTxHash(confirmed.txHash!);

    const list = await svc.listForAction(ACTION_ID, OWNER_VIEW);
    expect(list!.map((r) => r.payload.stage)).toEqual(["requested", "submitted", "confirmed"]);
    expect(list![2]!.payload.occurredAt).toBe("2026-09-29T10:02:00.000Z");
    expect(list![2]!.payload.externalRefs).toMatchObject({ txHash: "ab".repeat(32), sorobanEventId: "evt-9" });
  });

  it("records the error code on failure receipts", async () => {
    const { svc } = setup();
    const r = await svc.issueForAction(action({ status: "failed", errorCode: "WALLET_REJECTED", updatedAt: new Date("2026-09-29T10:05:00.000Z") }));
    expect(r!.receipt.payload).toMatchObject({ stage: "failed", errorCode: "WALLET_REJECTED", occurredAt: "2026-09-29T10:05:00.000Z" });
  });

  it("lookups heal a missing receipt for the current stage", async () => {
    const { svc, ledger } = setup();
    ledger.put(action({ status: "submitted", txHash: "cd".repeat(32), submittedAt: new Date("2026-09-29T10:01:00.000Z") }));
    const list = await svc.listForAction(ACTION_ID, OWNER_VIEW);
    expect(list!.map((r) => r.payload.stage)).toEqual(["submitted"]);
  });
});

describe("stable payloads and duplicate requests (#812)", () => {
  it("derives byte-identical payloads regardless of clock, key or payload key order", () => {
    const a = buildReceiptPayload(action({ actionPayload: { amount: "100", vault_id: "vault-1" } }));
    const b = buildReceiptPayload(action({ actionPayload: { vault_id: "vault-1", amount: "100" } }));
    expect(receiptMessage(a!).equals(receiptMessage(b!))).toBe(true);
  });

  it("a duplicate request returns the stored receipt instead of creating another", async () => {
    let t = Date.parse("2026-09-29T12:00:00.000Z");
    const { svc, store } = setup({ now: () => new Date((t += 60_000)) });
    const first = await svc.issueForAction(action());
    const second = await svc.issueForAction(action());
    expect(first!.created).toBe(true);
    expect(second!.created).toBe(false);
    expect(second!.receipt).toEqual(first!.receipt);
    expect(await store.listByAction(ACTION_ID)).toHaveLength(1);
  });

  it("concurrent duplicate issuance stores exactly one receipt", async () => {
    const { svc, store } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => svc.issueForAction(action())));
    expect(results.filter((r) => r!.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r!.receipt.signature)).size).toBe(1);
    expect(await store.listByAction(ACTION_ID)).toHaveLength(1);
  });
});

describe("receipt lookup permissions (#812)", () => {
  it("lets the owner (case-insensitive) and maintainers read, and denies other wallets", async () => {
    const { svc, ledger } = setup();
    ledger.put(action());
    const { receipt } = (await svc.issueForAction(action()))!;
    const id = receipt.payload.receiptId;

    await expect(svc.get(id, { walletAddress: OWNER.toLowerCase(), canReadAny: false })).resolves.toMatchObject({ signature: receipt.signature });
    await expect(svc.get(id, { walletAddress: "GMAINTAINER", canReadAny: true })).resolves.toBeTruthy();
    await expect(svc.get(id, { walletAddress: "GSOMEONEELSE", canReadAny: false })).rejects.toBeInstanceOf(ReceiptAccessError);
    await expect(svc.get(id, { canReadAny: false })).rejects.toBeInstanceOf(ReceiptAccessError);
    await expect(svc.listForAction(ACTION_ID, { walletAddress: "GSOMEONEELSE", canReadAny: false })).rejects.toBeInstanceOf(ReceiptAccessError);
  });

  it("returns null for unknown receipts and actions", async () => {
    const { svc } = setup();
    expect(await svc.get("rcpt_missing", OWNER_VIEW)).toBeNull();
    expect(await svc.listForAction("99999999-9999-4999-8999-999999999999", OWNER_VIEW)).toBeNull();
  });
});

describe("tamper detection (#812)", () => {
  async function issued() {
    const ctx = setup();
    ctx.ledger.put(action());
    const { receipt } = (await ctx.svc.issueForAction(action()))!;
    const presented: SignedReceipt = {
      payload: receipt.payload,
      algorithm: receipt.algorithm,
      keyId: receipt.keyId,
      signature: receipt.signature,
    };
    return { ...ctx, receipt, presented };
  }

  it("accepts an untouched receipt", async () => {
    const { svc, presented } = await issued();
    expect(await svc.verify(presented)).toEqual({ valid: true });
  });

  it("detects any edited payload field", async () => {
    const { svc, presented } = await issued();
    for (const mutate of [
      (p: any) => (p.operation = "withdraw"),
      (p: any) => (p.actor.walletAddress = "GATTACKER"),
      (p: any) => (p.occurredAt = "2020-01-01T00:00:00.000Z"),
      (p: any) => (p.externalRefs.txHash = "ff".repeat(32)),
      (p: any) => (p.requestDigest = "0".repeat(64)),
    ]) {
      const forged = structuredClone(presented);
      mutate(forged.payload);
      expect(await svc.verify(forged)).toEqual({ valid: false, reason: "BAD_SIGNATURE" });
    }
  });

  it("rejects receipts signed by an untrusted key, or claiming our key with a foreign signature", async () => {
    const { svc, presented } = await issued();
    const attacker = Keypair.random();
    const signature = attacker.sign(receiptMessage(presented.payload)).toString("base64");
    expect(await svc.verify({ ...presented, keyId: attacker.publicKey(), signature })).toEqual({ valid: false, reason: "UNKNOWN_KEY" });
    expect(await svc.verify({ ...presented, signature })).toEqual({ valid: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects a validly signed receipt that was never issued", async () => {
    const { svc, signer, presented } = await issued();
    const payload = { ...presented.payload, receiptId: "rcpt_" + "0".repeat(40) };
    const unissued = { ...presented, payload, signature: signer.sign(receiptMessage(payload)) };
    expect(await svc.verify(unissued)).toEqual({ valid: false, reason: "NOT_ISSUED" });
  });

  it("detects a stored receipt row edited in the database", async () => {
    const { svc, store, receipt, presented } = await issued();
    store.tamperForTest(receipt.payload.receiptId, (r: StoredReceipt) => {
      r.payload.errorCode = "EDITED";
    });
    expect(await svc.verify(presented)).toEqual({ valid: false, reason: "STORED_COPY_MISMATCH" });
    expect(await svc.verifyAgainstLedger(receipt.payload.receiptId)).toEqual({ valid: false, reason: "BAD_SIGNATURE" });
  });

  it("detects a ledger row edited after the receipt was issued, but not normal progress", async () => {
    const { svc, ledger, receipt } = await issued();
    const id = receipt.payload.receiptId;

    // Normal lifecycle progress must not invalidate the earlier receipt.
    ledger.put(action({ status: "confirmed", txHash: "ab".repeat(32), sorobanEventId: "e1", confirmedAt: new Date("2026-09-29T11:00:00.000Z"), updatedAt: new Date("2026-09-29T11:00:00.000Z") }));
    expect(await svc.verifyAgainstLedger(id)).toEqual({ valid: true });

    // Rewriting what was requested (amount) is caught.
    ledger.put(action({ actionPayload: { vault_id: "vault-1", amount: "100000" } }));
    expect(await svc.verifyAgainstLedger(id)).toEqual({ valid: false, reason: "LEDGER_MISMATCH" });
  });

  it("rejects malformed input", () => {
    for (const bad of [null, "x", {}, { payload: {}, signature: 1, keyId: "k", algorithm: "ed25519" }]) {
      expect(verifyReceiptSignature(bad, ["GX"])).toEqual({ valid: false, reason: "MALFORMED" });
    }
  });
});

describe("key rotation (#812)", () => {
  it("keeps verifying receipts from a retired key listed in previousKeyIds", async () => {
    const oldSigner = StellarReceiptSigner.fromSecret(Keypair.random().secret());
    const before = setup({ signer: oldSigner });
    const { receipt } = (await before.svc.issueForAction(action()))!;

    const newSigner = StellarReceiptSigner.fromSecret(Keypair.random().secret());
    expect(verifyReceiptSignature(receipt, [newSigner.keyId])).toEqual({ valid: false, reason: "UNKNOWN_KEY" });
    expect(verifyReceiptSignature(receipt, [newSigner.keyId, oldSigner.keyId])).toEqual({ valid: true });
  });

  it("marks an ephemeral signer so the public-key endpoint can warn", () => {
    expect(StellarReceiptSigner.ephemeral().ephemeral).toBe(true);
    expect(StellarReceiptSigner.fromSecret(Keypair.random().secret()).ephemeral).toBe(false);
  });
});
