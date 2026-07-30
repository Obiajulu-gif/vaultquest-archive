export const VAULT_ABI = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "vaultConfig",
    outputs: [
      { internalType: "uint256", name: "maxCapacity", type: "uint256" },
      { internalType: "uint256", name: "currentTotal", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getAPY",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const PLACEHOLDER_ADDRESS = "0x1234567890123456789012345678901234567890";

let _manifestAddress: string | undefined;

export function setVaultAddressFromManifest(address: string): void {
  _manifestAddress = address;
}

export function getVaultAddress(): string {
  return _manifestAddress || PLACEHOLDER_ADDRESS;
}

export const VAULT_ADDRESS = PLACEHOLDER_ADDRESS;
