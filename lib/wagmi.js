import { http, fallback } from "wagmi";
import { avalanche, avalancheFuji } from "wagmi/chains";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { DEFAULT_RPC, readStoredRpc } from "./customRpc";

/** Chains VaultQuest supports for EVM wallet flows (wagmi). */
export const SUPPORTED_CHAINS = [avalanche, avalancheFuji];

const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.startsWith("YOUR_")
    ? "00000000000000000000000000000000"
    : process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "00000000000000000000000000000000";

const RPC_OPTS = { retryCount: 3, retryDelay: 1000, timeout: 10_000 };

const AVAX_PUBLIC_RPCS = [
  "https://api.avax.network/ext/bc/C/rpc",
  "https://avalanche-c-chain.publicnode.com",
];

const FUJI_PUBLIC_RPCS = [
  "https://api.avax-test.network/ext/bc/C/rpc",
  "https://avalanche-fuji-c-chain.publicnode.com",
];

function buildTransport(customUrl, publicRpcs) {
  const transports = [];
  const custom = customUrl?.trim();

  if (custom) {
    transports.push(http(custom, RPC_OPTS));
  }

  for (const url of publicRpcs) {
    if (!custom || url !== custom) {
      transports.push(http(url, RPC_OPTS));
    }
  }

  if (transports.length === 0) {
    return http();
  }
  if (transports.length === 1) {
    return transports[0];
  }
  return fallback(transports, { rank: false });
}

/** @param {ReturnType<typeof readStoredRpc> | null} [stored] */
export function createWagmiConfig(stored = readStoredRpc()) {
  const avaxUrl = stored?.avalanche ?? DEFAULT_RPC.avalanche;
  const fujiUrl = stored?.avalancheFuji ?? DEFAULT_RPC.avalancheFuji;

  return getDefaultConfig({
    appName: "VaultQuest",
    projectId,
    chains: SUPPORTED_CHAINS,
    transports: {
      [avalanche.id]: buildTransport(avaxUrl, AVAX_PUBLIC_RPCS),
      [avalancheFuji.id]: buildTransport(fujiUrl, FUJI_PUBLIC_RPCS),
    },
    ssr: true,
  });
}

export const wagmiConfig = createWagmiConfig();

export const DEFAULT_CHAIN = avalancheFuji;
