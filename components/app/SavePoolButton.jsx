"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { useSavedPools } from "@/components/hooks/useSavedPools";

export default function SavePoolButton({ pool, className = "" }) {
  const { savePool, unsavePool, isPoolSaved } = useSavedPools();
  const [isProcessing, setIsProcessing] = useState(false);
  const isSaved = isPoolSaved(pool.id);

  const handleToggle = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    setIsProcessing(true);
    try {
      if (isSaved) {
        await unsavePool(pool.id);
      } else {
        await savePool(pool);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={isProcessing}
      className={`p-2 rounded-lg transition-all ${
        isSaved
          ? "bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30"
          : "bg-vault-surface text-vault-muted hover:bg-vault-surface/80 hover:text-yellow-500"
      } ${isProcessing ? "opacity-50 cursor-not-allowed" : ""} ${className}`}
      aria-label={isSaved ? "Remove from watchlist" : "Add to watchlist"}
      title={isSaved ? "Remove from watchlist" : "Add to watchlist"}
    >
      <Star
        size={18}
        fill={isSaved ? "currentColor" : "none"}
        aria-hidden="true"
      />
    </button>
  );
}
