"use client";

import { Check, Plus } from "lucide-react";

export default function ComparePoolButton({ pool, isSelected, onToggle, disabled, className = "" }) {
  const handleClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onToggle(pool);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
        isSelected
          ? "bg-vault-accent text-white"
          : "bg-vault-surface border border-vault-border text-vault-text hover:border-vault-accent"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}
      aria-label={isSelected ? "Remove from comparison" : "Add to comparison"}
      title={isSelected ? "Remove from comparison" : "Add to comparison"}
    >
      {isSelected ? (
        <>
          <Check size={14} className="inline mr-1" aria-hidden="true" />
          Selected
        </>
      ) : (
        <>
          <Plus size={14} className="inline mr-1" aria-hidden="true" />
          Compare
        </>
      )}
    </button>
  );
}
