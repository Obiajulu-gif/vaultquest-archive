import { useReadContracts } from "wagmi";
import { VAULT_ABI, VAULT_ADDRESS } from "../lib/contracts";

export function useVaultData(userAddress?: `0x${string}`) {
  const contractsToRead = [
    {
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "vaultConfig",
    },
    {
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "getAPY",
    },
  ];

  if (userAddress) {
    contractsToRead.push({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "balanceOf",
      args: [userAddress],
    } as any);
  }

  const { data, isError, isLoading, error } = useReadContracts({
    contracts: contractsToRead,
  });

  const configResult = data?.[0];
  const apyResult = data?.[1];
  const balanceResult = data?.[2];

  const hasPartialFailure =
    configResult?.status === "failure" ||
    apyResult?.status === "failure" ||
    (userAddress && balanceResult?.status === "failure");

  return {
    config: configResult?.status === "success" ? configResult.result : null,
    apy: apyResult?.status === "success" ? apyResult.result : null,
    balance: balanceResult?.status === "success" ? balanceResult.result : null,
    isLoading,
    isError,
    error,
    hasPartialFailure,
    configError: configResult?.error,
    apyError: apyResult?.error,
    balanceError: balanceResult?.error,
  };
}
