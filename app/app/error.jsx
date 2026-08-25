"use client";

import { useEffect } from "react";
import RouteErrorFallback from "@/components/app/RouteErrorFallback";

export default function ErrorBoundary({ error, reset }) {
  useEffect(() => {
    console.error("[app/error]", error);
  }, [error]);

  return <RouteErrorFallback error={error} reset={reset} title="Dashboard failed to load" />;
}

