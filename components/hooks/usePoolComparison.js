import { useState, useCallback } from "react";

const MAX_POOLS = 4;

/**
 * Hook for managing pool comparison selection
 */
export function usePoolComparison() {
  const [selectedPools, setSelectedPools] = useState([]);

  const addPool = useCallback((pool) => {
    setSelectedPools((prev) => {
      if (prev.some((p) => p.id === pool.id)) {
        return prev;
      }
      
      if (prev.length >= MAX_POOLS) {
        return prev;
      }
      
      return [...prev, pool];
    });
  }, []);

  const removePool = useCallback((poolId) => {
    setSelectedPools((prev) => prev.filter((p) => p.id !== poolId));
  }, []);

  const clearAll = useCallback(() => {
    setSelectedPools([]);
  }, []);

  const isSelected = useCallback(
    (poolId) => selectedPools.some((p) => p.id === poolId),
    [selectedPools]
  );

  const canAddMore = selectedPools.length < MAX_POOLS;

  return {
    selectedPools,
    addPool,
    removePool,
    clearAll,
    isSelected,
    canAddMore,
    maxPools: MAX_POOLS,
  };
}
