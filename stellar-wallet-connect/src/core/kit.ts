import {
  StellarWalletsKit,
  FreighterModule,
  AlbedoModule,
  xBullModule,
  HanaModule,
  RabetModule,
  LobstrModule,
  WalletNetwork,
} from "@creit.tech/stellar-wallets-kit";
import { LedgerModule } from "@creit.tech/stellar-wallets-kit/modules/ledger";
import { getFrontendEnv } from "./env.js";

// Re-exported for the wallet layer (#rate-limits): the Horizon connection pool
// balances on-chain reads across the nodes resolved here. The implementation
// lives in horizonPool.ts to keep it free of the wallets-kit dependency.
export { resolveHorizonNodes } from "./horizonPool.js";

const resolveWalletNetwork = (networkPassphrase?: string): WalletNetwork => {
  const env = getFrontendEnv();
  const configuredNetwork =
    networkPassphrase || env.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE;

  switch (configuredNetwork) {
    case WalletNetwork.PUBLIC:
      return WalletNetwork.PUBLIC;
    case WalletNetwork.FUTURENET:
      return WalletNetwork.FUTURENET;
    case WalletNetwork.SANDBOX:
      return WalletNetwork.SANDBOX;
    case WalletNetwork.STANDALONE:
      return WalletNetwork.STANDALONE;
    case WalletNetwork.TESTNET:
    default:
      return WalletNetwork.TESTNET;
  }
};

export const createKit = (networkPassphrase?: string) => {
  return new StellarWalletsKit({
    modules: [
      new FreighterModule(),
      new AlbedoModule(),
      new xBullModule(),
      new HanaModule(),
      new RabetModule(),
      new LobstrModule(),
      new LedgerModule()
    ],
    network: resolveWalletNetwork(networkPassphrase),
  });
};

// Lazy-initialized kit instance to avoid SSR "window is not defined" errors
let _kit: StellarWalletsKit;

export const kit = new Proxy({} as StellarWalletsKit, {
  get(_, prop) {
    if (typeof window === 'undefined') {
      return undefined;
    }
    if (!_kit) {
      _kit = createKit();
    }
    const value = (_kit as any)[prop];
    return typeof value === 'function' ? value.bind(_kit) : value;
  },
});
