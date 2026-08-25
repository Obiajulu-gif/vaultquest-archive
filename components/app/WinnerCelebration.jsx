"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trophy, X, Share2, Twitter } from "lucide-react";
import confetti from "canvas-confetti";

export default function WinnerCelebration({
  isWinner = false,
  prizeAmount = "0",
  prizeCurrency = "USDC",
  drawDate = new Date().toISOString(),
  onClose = null,
  autoShow = true,
}) {
  const [isVisible, setIsVisible] = useState(false);
  const [hasShownOnce, setHasShownOnce] = useState(false);

  const fireConfetti = useCallback(() => {
    const duration = 3000;
    const animationEnd = Date.now() + duration;
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999 };

    function randomInRange(min, max) {
      return Math.random() * (max - min) + min;
    }

    const interval = setInterval(() => {
      const timeLeft = animationEnd - Date.now();

      if (timeLeft <= 0) {
        return clearInterval(interval);
      }

      const particleCount = 50 * (timeLeft / duration);

      confetti({
        ...defaults,
        particleCount,
        origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 },
        colors: ["#dc2626", "#f87171", "#fca5a5", "#fef2f2"],
      });
      confetti({
        ...defaults,
        particleCount,
        origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 },
        colors: ["#dc2626", "#f87171", "#fca5a5", "#fef2f2"],
      });
    }, 250);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isWinner && autoShow && !hasShownOnce) {
      setIsVisible(true);
      setHasShownOnce(true);
      const cleanup = fireConfetti();
      return cleanup;
    }
  }, [isWinner, autoShow, hasShownOnce, fireConfetti]);

  const handleClose = () => {
    setIsVisible(false);
    onClose?.();
  };

  const handleShare = () => {
    const text = `🎉 I just won ${prizeAmount} ${prizeCurrency} on VaultQuest! Prize-linked savings that actually reward savers. Join me at vaultquest.io`;
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      alert("Link copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const formattedDate = new Date(drawDate).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  if (!isWinner) return null;

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={handleClose}
        >
          <motion.div
            initial={{ scale: 0.8, opacity: 0, y: 50 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.8, opacity: 0, y: 50 }}
            transition={{ type: "spring", duration: 0.5 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md overflow-hidden rounded-3xl border border-red-500/30 bg-gradient-to-br from-vault-surface via-vault-bg to-vault-surface shadow-2xl"
          >
            <button
              type="button"
              onClick={handleClose}
              className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-vault-surface/80 text-vault-muted backdrop-blur-sm transition-all duration-300 hover:bg-red-500/20 hover:text-red-500"
              aria-label="Close celebration"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="relative p-8 text-center">
              <motion.div
                initial={{ scale: 0, rotate: -180 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
                className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-red-500 to-red-600 shadow-xl"
              >
                <Trophy className="h-12 w-12 text-white" aria-hidden="true" />
              </motion.div>

              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="mb-2 text-3xl font-bold text-vault-text sm:text-4xl"
              >
                Congratulations!
              </motion.h2>

              <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                className="mb-6 text-lg text-vault-muted"
              >
                You won the savings draw!
              </motion.p>

              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.5 }}
                className="mb-6 rounded-2xl border border-red-500/30 bg-red-500/10 p-6"
              >
                <div className="mb-1 text-sm font-medium text-vault-muted">
                  Prize Amount
                </div>
                <div className="text-4xl font-bold text-red-500 sm:text-5xl">
                  {prizeAmount}
                  <span className="ml-2 text-2xl text-vault-muted">
                    {prizeCurrency}
                  </span>
                </div>
                <div className="mt-2 text-xs text-vault-muted">{formattedDate}</div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.6 }}
                className="space-y-3"
              >
                <button
                  type="button"
                  onClick={handleShare}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#1DA1F2] px-6 py-3 text-sm font-semibold text-white shadow-lg transition-all duration-300 hover:bg-[#1a8cd8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1DA1F2] focus-visible:ring-offset-2 focus-visible:ring-offset-vault-bg"
                >
                  <Twitter className="h-4 w-4" aria-hidden="true" />
                  Share on Twitter
                </button>

                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-vault-border bg-vault-surface px-6 py-3 text-sm font-semibold text-vault-text backdrop-blur-md transition-all duration-300 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                >
                  <Share2 className="h-4 w-4" aria-hidden="true" />
                  Copy Link
                </button>
              </motion.div>

              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.7 }}
                className="mt-6 text-xs text-vault-muted"
              >
                Your prize has been automatically credited to your account.
              </motion.p>
            </div>

            <div className="absolute inset-0 -z-10 bg-gradient-to-r from-red-500/5 via-transparent to-red-500/5" />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
