"use client";

import { useEffect } from "react";
import RouteErrorFallback from "@/components/app/RouteErrorFallback";

export default function PrizesRouteError({ error, reset }) {
  useEffect(() => {
    console.error("[app/prizes/error]", error);
  }, [error]);

  return <RouteErrorFallback error={error} reset={reset} title="Prizes view failed to load" />;
}

