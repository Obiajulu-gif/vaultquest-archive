"use client";

import { useEffect, useState } from "react";
import { yieldPerSecond } from "@/lib/yield-counter";

/**
 * Simple per-second accrued-yield display using setInterval.
 * Accrues in real time at the rate implied by APY on principal.
 */
export function useYieldCounter(principal, apyPercent, baseAccrued = 0, enabled = true) {
  const [displayValue, setDisplayValue] = useState(baseAccrued);
  // Calculate per-second rate once when inputs change
  const rate = yieldPerSecond(principal, apyPercent);

  useEffect(() => {
    if (!enabled) {
      setDisplayValue(baseAccrued);
      return;
    }
    // Initialize display to baseAccrued on (re)enable
    setDisplayValue(baseAccrued);
    const intervalId = setInterval(() => {
      // Increment by rate per second
      setDisplayValue((prev) => prev + rate);
    }, 1000);
    return () => clearInterval(intervalId);
  }, [enabled, principal, apyPercent, baseAccrued, rate]);

  return displayValue;
}
