import { PrismaClient, ActionType, ActionStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();

async function main() {
  console.log("Cleaning up database...");
  await prisma.savedPool.deleteMany({});
  await prisma.actionLedger.deleteMany({});
  await prisma.pendingEvent.deleteMany({});
  await prisma.indexerCheckpoint.deleteMany({});

  console.log("Seeding indexer checkpoint...");
  await prisma.indexerCheckpoint.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      latestLedger: 104523,
      lastSyncTime: new Date(),
      lastSuccessSyncTime: new Date(),
      lastError: null
    },
    update: {}
  });

  const walletA = "GBX7Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX4Y6A";
  const walletB = "GDY3PJEJZZ4YSLB2CMMMX7R6KCP2PNE7A5PXH5XN265LSL73GOHX7B8Z";
  const walletC = "GCT6Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX9C3C";

  console.log("Seeding mock SavedPool entries...");
  const pools = [
    {
      walletAddress: walletA,
      poolId: "vault-usdc-yield-high",
      poolName: "USDC High Yield Degenerate Vault",
      status: "active",
      tvl: "425900",
      asset: "USDC",
      participantCount: 84,
      expectedYield: "12.4%",
      prize: "5000 USDC"
    },
    {
      walletAddress: walletA,
      poolId: "vault-xlm-lucky-draw",
      poolName: "XLM Lucky Draw Vault",
      status: "active",
      tvl: "1050000",
      asset: "XLM",
      participantCount: 312,
      expectedYield: "4.5%",
      prize: "25000 XLM"
    },
    {
      walletAddress: walletB,
      poolId: "vault-yxlm-max-earn",
      poolName: "yXLM Max Earn Vault",
      status: "active",
      tvl: "87000",
      asset: "yXLM",
      participantCount: 19,
      expectedYield: "8.2%",
      prize: null
    },
    {
      walletAddress: walletB,
      poolId: "vault-usdc-yield-high",
      poolName: "USDC High Yield Degenerate Vault",
      status: "active",
      tvl: "425900",
      asset: "USDC",
      participantCount: 84,
      expectedYield: "12.4%",
      prize: "5000 USDC"
    },
    {
      walletAddress: walletC,
      poolId: "vault-aqua-governance-boost",
      poolName: "AQUA Governance Booster Pool",
      status: "paused",
      tvl: "18900",
      asset: "AQUA",
      participantCount: 4,
      expectedYield: "22.1%",
      prize: "100000 AQUA"
    },
    {
      walletAddress: walletC,
      poolId: "vault-btc-safe-reserve",
      poolName: "BTC Safe Reserve",
      status: "active",
      tvl: "15600000",
      asset: "BTC",
      participantCount: 1205,
      expectedYield: "10.1%",
      prize: "0.5 BTC"
    }
  ];

  for (const pool of pools) {
    await prisma.savedPool.create({ data: pool });
  }

  console.log("Seeding mock PendingEvent entries...");
  const pendingEvents = [
    {
      txHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
      sorobanEventId: "0000000000000000001-0000000001",
      eventPayload: { type: "deposit", amount: "500", from: walletA },
      statusHint: "confirmed"
    },
    {
      txHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
      sorobanEventId: "0000000000000000002-0000000001",
      eventPayload: { type: "withdraw", amount: "100", from: walletB },
      statusHint: "submitted"
    }
  ];

  for (const event of pendingEvents) {
    await prisma.pendingEvent.create({ data: event });
  }

  console.log("Seeding mock ActionLedger logs...");
  const actionsData = [
    // Wallet A
    {
      walletAddress: walletA,
      actionType: ActionType.create_vault,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-usdc-yield-high", asset: "USDC" },
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      submittedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-usdc-yield-high", amount: 1000, token: "USDC" },
      txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      submittedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-xlm-lucky-draw", amount: 5000, token: "XLM" },
      txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      submittedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.withdraw,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-usdc-yield-high", amount: 200, token: "USDC" },
      txHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
      submittedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.claim,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-usdc-yield-high", amount: 50, token: "USDC" },
      txHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
      submittedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.deposit,
      status: ActionStatus.failed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-usdc-yield-high", amount: 10000, token: "USDC" },
      txHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
      errorCode: "TX_FAILED",
      errorDetail: "Insufficient liquidity pool allowance",
      submittedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.deposit,
      status: ActionStatus.reverted,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-xlm-lucky-draw", amount: 2000, token: "XLM" },
      txHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
      errorCode: "REVERTED_ON_CHAIN",
      submittedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.deposit,
      status: ActionStatus.pending,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-usdc-yield-high", amount: 150, token: "USDC" }
    },
    {
      walletAddress: walletA,
      actionType: ActionType.withdraw,
      status: ActionStatus.submitted,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-usdc-yield-high", amount: 50, token: "USDC" },
      txHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
      submittedAt: new Date(Date.now() - 10 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.select_winner,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-xlm-lucky-draw", winner: walletA },
      txHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
      submittedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    },

    // Wallet B
    {
      walletAddress: walletB,
      actionType: ActionType.create_vault,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-yxlm-max-earn", asset: "yXLM" },
      txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      submittedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletB,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-yxlm-max-earn", amount: 10000, token: "yXLM" },
      txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      submittedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletB,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-usdc-yield-high", amount: 500, token: "USDC" },
      txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      submittedAt: new Date(Date.now() - 13 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 13 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletB,
      actionType: ActionType.withdraw,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-yxlm-max-earn", amount: 1500, token: "yXLM" },
      txHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      submittedAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletB,
      actionType: ActionType.deposit,
      status: ActionStatus.orphaned,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-yxlm-max-earn", amount: 200, token: "yXLM" },
      txHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      errorCode: "ORPHAN_TTL_EXPIRED",
      submittedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletB,
      actionType: ActionType.deposit,
      status: ActionStatus.pending,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-yxlm-max-earn", amount: 300, token: "yXLM" }
    },

    // Wallet C
    {
      walletAddress: walletC,
      actionType: ActionType.create_vault,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-aqua-governance-boost", asset: "AQUA" },
      txHash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      submittedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletC,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-aqua-governance-boost", amount: 50000, token: "AQUA" },
      txHash: "0x1212121212121212121212121212121212121212121212121212121212121212",
      submittedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletC,
      actionType: ActionType.withdraw,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-aqua-governance-boost", amount: 10000, token: "AQUA" },
      txHash: "0x1313131313131313131313131313131313131313131313131313131313131313",
      submittedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletC,
      actionType: ActionType.deposit,
      status: ActionStatus.pending,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-aqua-governance-boost", amount: 25000, token: "AQUA" }
    },
    {
      walletAddress: walletC,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-btc-safe-reserve", amount: 0.1, token: "BTC" },
      txHash: "0x2323232323232323232323232323232323232323232323232323232323232323",
      submittedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletC,
      actionType: ActionType.withdraw,
      status: ActionStatus.failed,
      idempotencyKey: randomUUID(),
      actionPayload: { vault_id: "vault-btc-safe-reserve", amount: 0.05, token: "BTC" },
      txHash: "0x2424242424242424242424242424242424242424242424242424242424242424",
      errorCode: "INSUFFICIENT_FUNDS",
      submittedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
    }
  ];

  for (const act of actionsData) {
    await prisma.actionLedger.create({ data: act });
  }

  console.log(`Seeding complete! Added ${pools.length} pools and ${actionsData.length} action ledger logs.`);
}

main()
  .catch((e) => {
    console.error("Seeding failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
