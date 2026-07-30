"use client";

import { useMemo } from "react";
import {
  VAULT_FIELD_FALLBACKS,
  logVaultApiWarning,
} from "@/lib/vault-api-errors";

/**
 * Required fields every vault object must have and the type they should be.
 * A field is flagged missing if its value is null, undefined, or empty string.
 */
const REQUIRED_FIELDS = [
  { key: "name", label: "Vault name", type: "string" },
  { key: "apy", label: "APY", type: "number" },
  { key: "minDeposit", label: "Minimum deposit", type: "number" },
  { key: "status", label: "Vault status", type: "string" },
  { key: "totalDeposits", label: "Total deposits", type: "number" },
];

/**
 * Checks a single vault object for missing or inconsistent fields.
 * Returns the vault with fallback values applied and a list of warnings.
 *
 * @param {Record<string, unknown>} vault
 * @returns {{ vault: Record<string, unknown>; warnings: string[] }}
 */
function reviewVault(vault) {
  if (!vault || typeof vault !== "object") {
    logVaultApiWarning("vaultConfig", "Received null or non-object vault data");
    return {
      vault: { ...VAULT_FIELD_FALLBACKS },
      warnings: ["Vault data is missing entirely."],
    };
  }

  const warnings = [];
  const reviewed = { ...vault };

  for (const field of REQUIRED_FIELDS) {
    const value = vault[field.key];
    const isMissing = value === null || value === undefined || value === "";
    const isWrongType = !isMissing && typeof value !== field.type;

    if (isMissing) {
      warnings.push(`"${field.label}" is missing — showing fallback value.`);
      reviewed[field.key] = VAULT_FIELD_FALLBACKS[field.key];
      logVaultApiWarning("vaultConfig", `Field "${field.key}" is missing`, {
        field: field.key,
        fallback: VAULT_FIELD_FALLBACKS[field.key],
      });
    } else if (isWrongType) {
      warnings.push(
        `"${field.label}" has an unexpected format and may display incorrectly.`,
      );
      logVaultApiWarning(
        "vaultConfig",
        `Field "${field.key}" has wrong type: expected ${field.type}, got ${typeof value}`,
        { field: field.key },
      );
    }
  }

  return { vault: reviewed, warnings };
}

/**
 * Hook that validates vault data and returns safe, fallback-applied vaults
 * alongside any data warnings to surface to the UI.
 *
 * @param {Record<string, unknown> | Record<string, unknown>[] | null | undefined} vaultData
 * @returns {{
 *   vaults: Record<string, unknown>[];
 *   warnings: string[];
 *   hasWarnings: boolean;
 * }}
 */
export function useVaultDataReview(vaultData) {
  return useMemo(() => {
    const rawVaults = Array.isArray(vaultData)
      ? vaultData
      : vaultData
        ? [vaultData]
        : [];

    if (rawVaults.length === 0) {
      return { vaults: [], warnings: [], hasWarnings: false };
    }

    const allWarnings = [];
    const reviewedVaults = rawVaults.map((v) => {
      const { vault, warnings } = reviewVault(v);
      allWarnings.push(...warnings);
      return vault;
    });

    return {
      vaults: reviewedVaults,
      warnings: allWarnings,
      hasWarnings: allWarnings.length > 0,
    };
  }, [vaultData]);
}
