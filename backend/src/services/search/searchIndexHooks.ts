import type { SearchIndexDocument, VisibilityLevel } from "./types.js";
import type { SearchIndexService } from "./searchIndexService.js";

export interface VaultInput {
  id: string;
  name?: string;
  poolAddress: string;
  admin?: string;
  asset: string;
  active?: boolean;
  unlisted?: boolean;
  strategy?: string;
  network?: string;
  tvl?: number | string;
  description?: string;
  updatedAt?: Date;
  version?: number;
}

export interface SavedPoolHookInput {
  id: string;
  walletAddress: string;
  poolId: string;
  poolName: string;
  status: string;
  asset: string;
  tvl: string;
  updatedAt?: Date;
  version?: number;
}

export interface QuestHookInput {
  id: string;
  walletAddress: string;
  questId: string;
  status: string;
  progress: number;
  target: number;
  updatedAt?: Date;
  version?: number;
}

export interface SettlementHookInput {
  id: string;
  vaultId: string;
  state: string;
  settlementType: string;
  recipient?: string | null;
  amount?: string | null;
  txHash?: string | null;
  updatedAt?: Date;
  version?: number;
}

export function vaultToSearchDocument(vault: VaultInput): SearchIndexDocument {
  let visibility: VisibilityLevel = "public";
  if (vault.unlisted) {
    visibility = "unlisted";
  } else if (vault.active === false) {
    visibility = "maintainer_only";
  }

  const title = vault.name || `Vault ${vault.poolAddress.slice(0, 8)}`;

  return {
    id: `vault:${vault.id}`,
    recordType: "vault",
    recordId: vault.id,
    title,
    description: vault.description || vault.strategy,
    asset: vault.asset,
    network: vault.network || "Stellar",
    status: vault.active === false ? "inactive" : "active",
    ownerWallet: vault.admin,
    visibility,
    requiredRoles: visibility === "maintainer_only" ? ["maintainer"] : undefined,
    searchableText: "",
    metadata: {
      poolAddress: vault.poolAddress,
      tvl: vault.tvl,
      strategy: vault.strategy,
    },
    version: vault.version ?? 1,
    sourceUpdatedAt: vault.updatedAt ? new Date(vault.updatedAt) : new Date(),
    indexedAt: new Date(),
  };
}

export function savedPoolToSearchDocument(savedPool: SavedPoolHookInput): SearchIndexDocument {
  return {
    id: `saved_pool:${savedPool.walletAddress.toLowerCase()}:${savedPool.poolId}`,
    recordType: "saved_pool",
    recordId: `${savedPool.walletAddress.toLowerCase()}:${savedPool.poolId}`,
    title: savedPool.poolName,
    asset: savedPool.asset,
    status: savedPool.status,
    ownerWallet: savedPool.walletAddress,
    visibility: "owner_only",
    searchableText: "",
    metadata: {
      poolId: savedPool.poolId,
      tvl: savedPool.tvl,
    },
    version: savedPool.version ?? 1,
    sourceUpdatedAt: savedPool.updatedAt ? new Date(savedPool.updatedAt) : new Date(),
    indexedAt: new Date(),
  };
}

export function questToSearchDocument(quest: QuestHookInput): SearchIndexDocument {
  return {
    id: `quest:${quest.walletAddress.toLowerCase()}:${quest.questId}`,
    recordType: "quest",
    recordId: `${quest.walletAddress.toLowerCase()}:${quest.questId}`,
    title: `Quest ${quest.questId}`,
    status: quest.status,
    ownerWallet: quest.walletAddress,
    visibility: "owner_only",
    searchableText: "",
    metadata: {
      questId: quest.questId,
      progress: quest.progress,
      target: quest.target,
    },
    version: quest.version ?? 1,
    sourceUpdatedAt: quest.updatedAt ? new Date(quest.updatedAt) : new Date(),
    indexedAt: new Date(),
  };
}

export function settlementToSearchDocument(settlement: SettlementHookInput): SearchIndexDocument {
  const isResolved = settlement.state === "Resolved";
  const visibility: VisibilityLevel = isResolved ? "public" : "maintainer_only";

  return {
    id: `settlement:${settlement.vaultId}`,
    recordType: "settlement",
    recordId: settlement.vaultId,
    title: `Settlement for Vault ${settlement.vaultId.slice(0, 8)}`,
    status: settlement.state,
    ownerWallet: settlement.recipient || undefined,
    visibility,
    requiredRoles: visibility === "maintainer_only" ? ["maintainer"] : undefined,
    searchableText: "",
    metadata: {
      vaultId: settlement.vaultId,
      settlementType: settlement.settlementType,
      txHash: settlement.txHash,
      amount: settlement.amount,
    },
    version: settlement.version ?? 1,
    sourceUpdatedAt: settlement.updatedAt ? new Date(settlement.updatedAt) : new Date(),
    indexedAt: new Date(),
  };
}

export class SearchIndexHooks {
  constructor(private readonly indexService: SearchIndexService) {}

  public async onVaultCreated(vault: VaultInput): Promise<void> {
    const doc = vaultToSearchDocument(vault);
    await this.indexService.indexDocument(doc);
  }

  public async onVaultUpdated(vault: VaultInput): Promise<void> {
    const doc = vaultToSearchDocument(vault);
    await this.indexService.indexDocument(doc);
  }

  public async onVaultDeleted(vaultId: string): Promise<void> {
    await this.indexService.removeDocument("vault", vaultId);
  }

  public async onVaultVisibilityChanged(
    vaultId: string,
    active: boolean,
    unlisted = false,
  ): Promise<void> {
    const existing = await this.indexService.getDocument("vault", vaultId);
    if (existing) {
      existing.visibility = unlisted
        ? "unlisted"
        : active
          ? "public"
          : "maintainer_only";
      existing.status = active ? "active" : "inactive";
      existing.version = (existing.version || 1) + 1;
      existing.sourceUpdatedAt = new Date();
      await this.indexService.indexDocument(existing);
    }
  }

  public async onSavedPoolCreated(savedPool: SavedPoolHookInput): Promise<void> {
    const doc = savedPoolToSearchDocument(savedPool);
    await this.indexService.indexDocument(doc);
  }

  public async onSavedPoolDeleted(
    walletAddress: string,
    poolId: string,
  ): Promise<void> {
    const recordId = `${walletAddress.toLowerCase()}:${poolId}`;
    await this.indexService.removeDocument("saved_pool", recordId);
  }

  public async onQuestUpdated(quest: QuestHookInput): Promise<void> {
    const doc = questToSearchDocument(quest);
    await this.indexService.indexDocument(doc);
  }

  public async onQuestRevoked(
    walletAddress: string,
    questId: string,
  ): Promise<void> {
    const recordId = `${walletAddress.toLowerCase()}:${questId}`;
    await this.indexService.removeDocument("quest", recordId);
  }

  public async onSettlementUpdated(settlement: SettlementHookInput): Promise<void> {
    const doc = settlementToSearchDocument(settlement);
    await this.indexService.indexDocument(doc);
  }
}
