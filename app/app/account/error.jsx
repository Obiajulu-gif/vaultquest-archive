"use client";

import { useEffect } from "react";
import RouteErrorFallback from "@/components/app/RouteErrorFallback";

export default function AccountRouteError({ error, reset }) {
  useEffect(() => {
    console.error("[app/account/error]", error);
  }, [error]);

  return <RouteErrorFallback error={error} reset={reset} title="Account view failed to load" />;
}

