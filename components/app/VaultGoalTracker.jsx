"use client";

import { useState, useEffect } from "react";
import { Target, Edit3, Check, X, Plus, TrendingUp, PiggyBank } from "lucide-react";

const STORAGE_KEY = "vq_goal_tracker";

const EMPTY_STATES = {
  noGoal: {
    Icon: Target,
    title: "No savings goal set",
    description: "Set a target to track your progress toward a specific savings goal.",
  },
  noProgress: {
    Icon: PiggyBank,
    title: "Start saving to track progress",
    description: "Make your first deposit to begin tracking progress toward your goal.",
  },
};

export default function VaultGoalTracker({ currentBalance = 0 }) {
  const [goal, setGoal] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setGoal(parsed);
        setEditValue(String(parsed.amount));
      }
    } catch {
      // storage unavailable
    }
    setMounted(true);
  }, []);

  const saveGoal = (amount) => {
    const newGoal = { amount, createdAt: Date.now() };
    setGoal(newGoal);
    setEditValue(String(amount));
    setIsEditing(false);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newGoal));
    } catch {
      // storage unavailable
    }
  };

  const handleSetGoal = () => {
    const amount = parseFloat(editValue);
    if (isNaN(amount) || amount <= 0) return;
    saveGoal(amount);
  };

  const handleEdit = () => {
    setIsEditing(true);
    setEditValue(String(goal.amount));
  };

  const handleCancel = () => {
    setIsEditing(false);
    if (goal) {
      setEditValue(String(goal.amount));
    } else {
      setEditValue("");
    }
  };

  const handleRemoveGoal = () => {
    setGoal(null);
    setEditValue("");
    setIsEditing(false);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable
    }
  };

  if (!mounted) {
    return (
      <section className="vq-glass-hover p-5 sm:p-6 animate-pulse">
        <div className="h-4 w-24 bg-vault-border/30 rounded" />
        <div className="mt-4 h-8 w-full bg-vault-border/20 rounded" />
      </section>
    );
  }

  if (!goal) {
    return (
      <section aria-label="Vault savings goal" className="vq-glass-hover p-5 sm:p-6">
        <div className="flex flex-col items-center text-center py-6">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-vault-border bg-vault-surface text-vault-muted">
            <Target className="h-6 w-6" aria-hidden="true" />
          </span>
          <h3 className="mt-4 text-base font-semibold text-vault-text">
            {EMPTY_STATES.noGoal.title}
          </h3>
          <p className="mt-1 text-sm text-vault-muted max-w-sm">
            {EMPTY_STATES.noGoal.description}
          </p>
          {isEditing ? (
            <div className="mt-5 w-full max-w-xs space-y-3">
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-sm font-semibold text-vault-muted">$</span>
                <input
                  type="number"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSetGoal()}
                  placeholder="5000"
                  className="w-full pl-7 pr-4 py-2 rounded-xl border border-vault-border bg-vault-surface text-vault-text font-semibold focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/30"
                  aria-label="Set savings goal amount"
                  autoFocus
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSetGoal}
                  className="vq-btn-primary flex-1"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Set Goal
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="vq-btn-ghost px-3"
                  aria-label="Cancel"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="vq-btn-primary mt-5"
            >
              <Target className="h-4 w-4" aria-hidden="true" />
              Set Savings Goal
            </button>
          )}
        </div>
      </section>
    );
  }

  const progress = Math.min(1, Math.max(0, currentBalance / goal.amount));
  const remaining = Math.max(0, goal.amount - currentBalance);
  const percentage = Math.round(progress * 100);

  return (
    <section aria-label="Vault savings goal tracker" className="vq-glass-hover p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-vault-border bg-vault-surface text-vault-accent">
            <TrendingUp className="h-4 w-4" aria-hidden="true" />
          </span>
          <h3 className="text-sm font-semibold text-vault-text">Savings Goal</h3>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={handleEdit}
            className="rounded-lg p-1.5 text-vault-muted transition-colors hover:bg-vault-surface hover:text-vault-text"
            aria-label="Edit savings goal"
          >
            <Edit3 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {isEditing ? (
        <div className="mt-4 space-y-3">
          <div className="relative">
            <span className="absolute left-3 top-2.5 text-sm font-semibold text-vault-muted">$</span>
            <input
              type="number"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSetGoal()}
              className="w-full pl-7 pr-4 py-2 rounded-xl border border-vault-border bg-vault-surface text-vault-text font-semibold focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/30"
              aria-label="Edit savings goal amount"
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSetGoal}
              className="vq-btn-primary flex-1"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Save
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="vq-btn-ghost px-3"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-vault-muted">
              ${currentBalance.toLocaleString()} saved
            </span>
            <span className="font-semibold text-vault-text">
              ${goal.amount.toLocaleString()}
            </span>
          </div>

          <div className="relative h-3 w-full overflow-hidden rounded-full bg-vault-border/30" role="progressbar" aria-valuenow={percentage} aria-valuemin={0} aria-valuemax={100} aria-label={`${percentage}% of savings goal reached`}>
            <div
              className="h-full rounded-full bg-gradient-to-r from-red-500 to-red-400 transition-all duration-500 ease-out"
              style={{ width: `${percentage}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className={`font-semibold ${percentage >= 100 ? "text-emerald-500" : "text-vault-accent"}`}>
              {percentage >= 100 ? "Goal reached!" : `${percentage}% complete`}
            </span>
            {remaining > 0 && (
              <span className="text-vault-muted">
                ${remaining.toLocaleString()} remaining
              </span>
            )}
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleRemoveGoal}
              className="text-xs text-vault-muted hover:text-red-500 transition-colors underline underline-offset-2"
            >
              Remove goal
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
