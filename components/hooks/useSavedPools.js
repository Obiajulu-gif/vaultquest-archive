import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";

/**
 * Hook for managing saved pools watchlist
 */
export function useSavedPools() {
  const { address } = useAccount();
  const [savedPools, setSavedPools] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchSavedPools = useCallback(async () => {
    if (!address) {
      setSavedPools([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/saved-pools?wallet=${encodeURIComponent(address)}`
      );

      if (!response.ok) {
        throw new Error("Failed to fetch saved pools");
      }

      const data = await response.json();
      setSavedPools(data.data || []);
    } catch (err) {
      setError(err.message);
      console.error("Error fetching saved pools:", err);
    } finally {
      setLoading(false);
    }
  }, [address]);

  const savePool = useCallback(
    async (pool) => {
      if (!address) return false;

      try {
        const response = await fetch("/api/saved-pools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet_address: address,
            pool: {
              pool_id: pool.id,
              pool_name: pool.name,
              status: pool.status,
              tvl: String(pool.tvl),
              asset: pool.asset,
              participant_count: pool.participantCount || 0,
              expected_yield: String(pool.apy || 0),
              prize: pool.prize ? String(pool.prize) : null,
              opens_at: pool.opensAt || null,
              locks_at: pool.locksAt || null,
              draws_at: pool.drawsAt || null,
            },
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to save pool");
        }

        await fetchSavedPools();
        return true;
      } catch (err) {
        setError(err.message);
        console.error("Error saving pool:", err);
        return false;
      }
    },
    [address, fetchSavedPools]
  );

  const unsavePool = useCallback(
    async (poolId) => {
      if (!address) return false;

      try {
        const response = await fetch(
          `/api/saved-pools/${encodeURIComponent(poolId)}?wallet=${encodeURIComponent(address)}`,
          { method: "DELETE" }
        );

        if (!response.ok) {
          throw new Error("Failed to remove pool");
        }

        await fetchSavedPools();
        return true;
      } catch (err) {
        setError(err.message);
        console.error("Error removing pool:", err);
        return false;
      }
    },
    [address, fetchSavedPools]
  );

  const isPoolSaved = useCallback(
    (poolId) => {
      return savedPools.some((p) => p.pool_id === poolId);
    },
    [savedPools]
  );

  useEffect(() => {
    fetchSavedPools();
  }, [fetchSavedPools]);

  return {
    savedPools,
    loading,
    error,
    savePool,
    unsavePool,
    isPoolSaved,
    refetch: fetchSavedPools,
  };
}
