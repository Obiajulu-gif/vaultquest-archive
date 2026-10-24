"use client";

import { useEffect, useState } from "react";
import { loadManifestAsync, validateManifestAgainstEnv } from "@/lib/deployment-manifest";
import { registerManifestLoader } from "@vaultquest/stellar-wallet-connect/core/env";
import { registerManifestGetter } from "@vaultquest/stellar-wallet-connect/vault/data/config";
import AttestationError from "@/components/AttestationError";

export default function AttestationProvider({ children }) {
  const [mismatches, setMismatches] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadManifestAsync()
      .then((manifest) => {
        registerManifestLoader(
          () => manifest,
          (m, env) => validateManifestAgainstEnv(m, env)
        );

        registerManifestGetter(() => manifest);

        // Removed EVM address setting as lib/contracts.ts is deleted

        const envMismatches = validateManifestAgainstEnv(manifest);
        if (envMismatches.length > 0) {
          setMismatches(envMismatches);
        }
      })
      .catch(() => {
        // Manifest not available — skip attestation (dev mode)
      })
      .finally(() => {
        setReady(true);
      });
  }, []);

  if (!ready) return null;
  if (mismatches) return <AttestationError mismatches={mismatches} />;
  return children;
}
