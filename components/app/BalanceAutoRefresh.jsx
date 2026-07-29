"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Pause, Play, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const REFRESH_OPTIONS = [
  { label: "15s", value: 15000 },
  { label: "30s", value: 30000 },
  { label: "1m", value: 60000 },
  { label: "Off", value: null },
];

/**
 * BalanceAutoRefresh Component
 * 
 * Provides a toggle and countdown for automatic wallet balance refreshes.
 * Pauses automatically when the window is hidden.
 */
export default function BalanceAutoRefresh() {
  const [refreshInterval, setRefreshInterval] = useState(REFRESH_OPTIONS[1].value); // Default 30s
  const [timeLeft, setTimeLeft] = useState(refreshInterval || 0);
  const [isOpen, setIsOpen] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  
  const queryClient = useQueryClient();
  const requestRef = useRef();
  const lastUpdateRef = useRef(performance.now());
  const dropdownRef = useRef();

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries();
    setTimeLeft(refreshInterval);
  }, [queryClient, refreshInterval]);

  // Handle Visibility API
  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsPaused(document.hidden);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // Main Loop
  useEffect(() => {
    if (refreshInterval === null || isPaused) {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      return;
    }

    const animate = (time) => {
      const delta = time - lastUpdateRef.current;
      lastUpdateRef.current = time;

      setTimeLeft((prev) => {
        const next = prev - delta;
        if (next <= 0) {
          handleRefresh();
          return refreshInterval;
        }
        return next;
      });

      requestRef.current = requestAnimationFrame(animate);
    };

    lastUpdateRef.current = performance.now();
    requestRef.current = requestAnimationFrame(animate);

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [refreshInterval, isPaused, handleRefresh]);

  // Sync timeLeft when interval changes
  useEffect(() => {
    setTimeLeft(refreshInterval || 0);
  }, [refreshInterval]);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const progress = refreshInterval ? (timeLeft / refreshInterval) * 100 : 0;
  const activeOption = REFRESH_OPTIONS.find(opt => opt.value === refreshInterval);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="vq-btn-ghost flex h-10 items-center gap-2 px-3 py-1.5"
        aria-label="Balance refresh settings"
      >
        <div className="relative flex h-5 w-5 items-center justify-center">
          {/* Circular Progress Background */}
          <svg className="absolute inset-0 h-full w-full -rotate-90 transform">
            <circle
              cx="10"
              cy="10"
              r="8"
              stroke="currentColor"
              strokeWidth="2"
              fill="transparent"
              className="text-vault-border/30"
            />
            {refreshInterval && !isPaused && (
              <motion.circle
                cx="10"
                cy="10"
                r="8"
                stroke="currentColor"
                strokeWidth="2"
                fill="transparent"
                strokeDasharray={50.27} // 2 * PI * r
                animate={{ strokeDashoffset: 50.27 * (1 - progress / 100) }}
                transition={{ duration: 0, ease: "linear" }}
                className="text-red-500"
              />
            )}
          </svg>
          {isPaused ? (
            <Pause className="relative z-10 h-3 w-3 text-vault-muted" />
          ) : (
            <RefreshCw className={`relative z-10 h-3 w-3 ${refreshInterval ? "animate-spin-slow text-red-500" : "text-vault-muted"}`} />
          )}
        </div>
        <span className="text-xs font-semibold">{activeOption?.label || "Off"}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-vault-muted transition-transform duration-300 ${isOpen ? "rotate-180" : ""}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            className="absolute right-0 mt-2 z-[60] w-40 overflow-hidden rounded-2xl border border-vault-border bg-vault-surface p-1 shadow-glass backdrop-blur-xl"
          >
            <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-vault-muted">
              Auto-Refresh
            </div>
            {REFRESH_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => {
                  setRefreshInterval(option.value);
                  setIsOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition-all duration-200 ${
                  refreshInterval === option.value
                    ? "bg-red-500/10 text-red-600 font-semibold"
                    : "text-vault-muted hover:bg-vault-surface/50 hover:text-vault-text"
                }`}
              >
                {option.label}
                {refreshInterval === option.value && (
                  <Play className="h-3 w-3 fill-current" />
                )}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
