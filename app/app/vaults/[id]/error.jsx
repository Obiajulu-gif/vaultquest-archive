"use client";

import { useEffect } from "react";
import RouteErrorFallback from "@/components/app/RouteErrorFallback";

export default function VaultDetailRouteError({ error, reset }) {
  useEffect(() => {
    console.error("[app/vaults/[id]/error]", error);
  }, [error]);

  return <RouteErrorFallback error={error} reset={reset} title="Vault details failed to load" />;
}

