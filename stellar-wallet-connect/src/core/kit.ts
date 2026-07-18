import {
  StellarWalletsKit,
  Networks,
} from "@creit.tech/stellar-wallets-kit";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { LedgerModule } from "@creit.tech/stellar-wallets-kit/modules/ledger";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { getFrontendEnv } from "./env";

// Re-exported for the wallet layer (#rate-limits): the Horizon connection pool
// balances on-chain reads across the nodes resolved here. The implementation
// lives in horizonPool.ts to keep it free of the wallets-kit dependency.
export { resolveHorizonNodes } from "./horizonPool";

const resolveWalletNetwork = (networkPassphrase?: string): Networks => {
  const env = getFrontendEnv();
  const configuredNetwork =
    networkPassphrase || env.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE;

  switch (configuredNetwork) {
    case Networks.PUBLIC:
      return Networks.PUBLIC;
    case Networks.FUTURENET:
      return Networks.FUTURENET;
    case Networks.SANDBOX:
      return Networks.SANDBOX;
    case Networks.STANDALONE:
      return Networks.STANDALONE;
    case Networks.TESTNET:
    default:
      return Networks.TESTNET;
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
