"use client";

import { useEffect } from "react";
import RouteErrorFallback from "@/components/app/RouteErrorFallback";

export default function AdminRouteError({ error, reset }) {
  useEffect(() => {
    console.error("[app/admin/error]", error);
  }, [error]);

  return <RouteErrorFallback error={error} reset={reset} title="Admin view failed to load" />;
}

