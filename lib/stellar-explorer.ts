export type StellarExplorerNetwork = "public" | "testnet" | "futurenet";
export type StellarExplorerReferenceType = "transaction" | "account" | "contract" | "ledger";

export interface StellarExplorerReference {
  type: StellarExplorerReferenceType;
  reference: string | number;
}

const NETWORK_ALIASES: Record<string, StellarExplorerNetwork> = {
  public: "public",
  mainnet: "public",
  production: "public",
  testnet: "testnet",
  futurenet: "futurenet",
};

const PATH_SEGMENTS: Record<StellarExplorerReferenceType, string> = {
  transaction: "tx",
  account: "account",
  contract: "contract",
  ledger: "ledger",
};

export function resolveStellarExplorerNetwork(
  network?: string | null,
): StellarExplorerNetwork | null {
  if (!network) return null;
  const normalized = network.trim().toLowerCase();
  return NETWORK_ALIASES[normalized] ?? null;
}

export function buildStellarExplorerUrl(
  reference: StellarExplorerReference,
  network?: string | null,
): string | null {
  const resolvedNetwork = resolveStellarExplorerNetwork(network);
  if (!resolvedNetwork) {
    return null;
  }

  const segment = PATH_SEGMENTS[reference.type];
  const ref = encodeURIComponent(String(reference.reference));
  return `https://stellar.expert/explorer/${resolvedNetwork}/${segment}/${ref}`;
}

export function explorerTransactionUrl(
  reference: string,
  network?: string | null,
): string | null {
  return buildStellarExplorerUrl({ type: "transaction", reference }, network);
}

export function explorerAccountUrl(
  reference: string,
  network?: string | null,
): string | null {
  return buildStellarExplorerUrl({ type: "account", reference }, network);
}

export function explorerContractUrl(
  reference: string,
  network?: string | null,
): string | null {
  return buildStellarExplorerUrl({ type: "contract", reference }, network);
}

export function explorerLedgerUrl(
  reference: string | number,
  network?: string | null,
): string | null {
  return buildStellarExplorerUrl({ type: "ledger", reference }, network);
}

