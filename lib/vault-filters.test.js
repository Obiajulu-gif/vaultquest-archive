import { describe, expect, it } from "vitest";
import { filterVaults } from "./vault-filters";

const defaults = { search: "", networks: [], minApy: 0, minTvl: 0, lockups: [], statuses: [], strategies: [], sortBy: "apy" };
const vaults = [
  { id: 1, name: "USDC Reserve", asset: "USDC", network: "Avalanche", apy: 5.2, tvl: 1_200_000, lockup: 7, status: "active", strategy: "Stable Yield", participantCount: 428 },
  { id: 2, name: "XLM Flex", asset: "XLM", network: "Stellar", apy: 3.8, tvl: 450_000, lockup: 0, status: "pending", strategy: "Flexible Drip", participantCount: 196 },
  { id: 3, name: "SOL Max", asset: "SOL", network: "Solana", apy: 12.4, tvl: 2_100_000, lockup: 45, status: "completed", strategy: "High Yield", participantCount: 265 },
];

describe("filterVaults", () => {
  it.each([
    ["search", { search: "xlm" }, [2]],
    ["network", { networks: ["Solana"] }, [3]],
    ["minimum APY", { minApy: 10 }, [3]],
    ["minimum TVL", { minTvl: 2 }, [3]],
    ["lockup", { lockups: [0] }, [2]],
    ["status", { statuses: ["active"] }, [1]],
    ["strategy", { strategies: ["High Yield"] }, [3]],
  ])("applies the selected %s filter", (_label, selected, expectedIds) => {
    expect(filterVaults(vaults, { ...defaults, ...selected }).map(({ id }) => id)).toEqual(expectedIds);
  });
});
