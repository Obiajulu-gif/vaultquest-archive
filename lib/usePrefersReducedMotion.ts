"use client";

import { useSyncExternalStore } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener?.("change", onChange);
  return () => mql.removeEventListener?.("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? Boolean(window.matchMedia(REDUCED_MOTION_QUERY)?.matches)
    : false;
}

/**
 * True when the user asked the OS for reduced motion. Follows changes live and
 * renders `false` on the server. Use it to skip JS-driven (framer-motion)
 * animations; CSS animations should use Tailwind's `motion-safe:` variant.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
