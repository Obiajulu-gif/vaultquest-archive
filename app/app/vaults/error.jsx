"use client";

import { useEffect } from "react";
import RouteErrorFallback from "@/components/app/RouteErrorFallback";

export default function VaultsRouteError({ error, reset }) {
  useEffect(() => {
    console.error("[app/vaults/error]", error);
  }, [error]);

  return <RouteErrorFallback error={error} reset={reset} title="Vaults view failed to load" />;
}

