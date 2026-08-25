"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Award, ChevronRight, Gift, Sparkles, ShieldCheck, Trophy, Zap } from "lucide-react";

const LEVELS = [
  { name: "Bronze", min: 0, perk: "Starter prize pools" },
  { name: "Silver", min: 1500, perk: "Fee waiver weekends" },
  { name: "Gold", min: 3500, perk: "Exclusive rounds" },
  { name: "Platinum", min: 7000, perk: "Priority draw access" },
  { name: "Diamond", min: 12000, perk: "Elite saver badge" },
];

const PERKS = [
  {
    id: "fee-waiver",
    title: "Fee waivers",
    requirement: 1500,
    description: "Unlock deposit fee waivers during selected network windows.",
    icon: ShieldCheck,
  },
  {
    id: "exclusive-pool",
    title: "Exclusive prize pools",
    requirement: 3500,
    description: "Access higher-yield prize rounds reserved for Gold members and above.",
    icon: Trophy,
  },
  {
    id: "bonus-xp",
    title: "Bonus XP boost",
    requirement: 7000,
    description: "Earn accelerated XP accumulation on recurring deposits.",
    icon: Zap,
  },
  {
    id: "diamond-draw",
    title: "Diamond draw access",
    requirement: 12000,
    description: "Join the highest-tier weekly draw with premium eligibility.",
    icon: Gift,
  },
];

function getLevelIndex(balance) {
  let activeIndex = 0;

  LEVELS.forEach((level, index) => {
    if (balance >= level.min) {
      activeIndex = index;
    }
  });

  return activeIndex;
}

function buildConfetti() {
  return Array.from({ length: 18 }, (_, index) => ({
    id: `${Date.now()}-${index}`,
    left: `${12 + ((index * 7) % 76)}%`,
    delay: (index % 6) * 0.06,
    drift: (index % 2 === 0 ? 1 : -1) * (18 + index * 1.7),
    size: 6 + (index % 3) * 2,
  }));
}

export default function LevelOnboarding({ activeBalance = 0 }) {
  const [demoBalance, setDemoBalance] = useState(activeBalance);
  const [selectedPerk, setSelectedPerk] = useState(null);
  const [confetti, setConfetti] = useState([]);
  const previousLevelRef = useRef(getLevelIndex(activeBalance));

  const levelIndex = getLevelIndex(demoBalance);
  const currentLevel = LEVELS[levelIndex];
  const nextLevel = LEVELS[Math.min(LEVELS.length - 1, levelIndex + 1)];
  const previousThreshold = LEVELS[Math.max(0, levelIndex)].min;
  const nextThreshold = nextLevel.min > currentLevel.min ? nextLevel.min : currentLevel.min;
  const progress = nextThreshold === previousThreshold ? 1 : Math.min(1, Math.max(0, (demoBalance - previousThreshold) / (nextThreshold - previousThreshold)));

  const xpLabel = useMemo(() => {
    if (levelIndex >= LEVELS.length - 1) {
      return "Max level reached";
    }

    const remaining = Math.max(0, nextThreshold - demoBalance);
    return `$${remaining.toLocaleString()} to ${nextLevel.name}`;
  }, [demoBalance, levelIndex, nextLevel.name, nextThreshold]);

  useEffect(() => {
    if (levelIndex > previousLevelRef.current) {
      setConfetti(buildConfetti());
      const timer = window.setTimeout(() => setConfetti([]), 2200);
      previousLevelRef.current = levelIndex;

      return () => window.clearTimeout(timer);
    }

    previousLevelRef.current = levelIndex;
    return undefined;
  }, [levelIndex]);

  const circumference = 2 * Math.PI * 72;
  const dashOffset = circumference * (1 - progress);

  return (
    <section className="vq-glass-hover relative overflow-hidden p-5 sm:p-6">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(251,191,36,0.12),transparent_40%),radial-gradient(circle_at_bottom_left,rgba(220,38,38,0.08),transparent_35%)]" aria-hidden="true" />

      <AnimatePresence>
        {confetti.map((particle) => (
          <motion.span
            key={particle.id}
            className="pointer-events-none absolute top-0 rounded-full bg-amber-300 shadow-[0_0_18px_rgba(251,191,36,0.85)]"
            style={{ left: particle.left, width: particle.size, height: particle.size }}
            initial={{ y: 0, opacity: 0.95, rotate: 0 }}
            animate={{ y: 180, x: particle.drift, opacity: 0, rotate: 260 }}
            transition={{ duration: 1.8, delay: particle.delay, ease: "easeOut" }}
          />
        ))}
      </AnimatePresence>

      <div className="relative grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="space-y-4 rounded-3xl border border-vault-border/40 bg-vault-surface/35 p-5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
            <Sparkles className="h-4 w-4 text-amber-400" aria-hidden="true" />
            Level onboarding
          </div>

          <div className="relative mx-auto flex w-full max-w-[280px] items-center justify-center py-4">
            <svg viewBox="0 0 180 180" className="h-56 w-56 -rotate-90">
              <circle cx="90" cy="90" r="72" className="fill-none stroke-vault-border/40" strokeWidth="12" />
              <circle
                cx="90"
                cy="90"
                r="72"
                className="fill-none stroke-amber-400"
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.26em] text-amber-300">
                {currentLevel.name}
              </span>
              <p className="mt-3 text-4xl font-black text-vault-text">{levelIndex + 1}</p>
              <p className="mt-1 text-sm text-vault-muted">{xpLabel}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-amber-200">
              Current perks
            </p>
            <p className="mt-1 text-lg font-semibold text-vault-text">
              {currentLevel.perk}
            </p>
            <p className="mt-1 text-sm text-vault-muted">
              Active vault balance: ${demoBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              setDemoBalance((value) => value + 750);
            }}
            className="vq-btn-primary w-full"
          >
            <Award className="h-4 w-4" aria-hidden="true" />
            Simulate deposit milestone
          </button>
        </div>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {PERKS.map((perk) => {
              const Icon = perk.icon;
              const unlocked = demoBalance >= perk.requirement;
              const isSelected = selectedPerk === perk.id;

              return (
                <button
                  key={perk.id}
                  type="button"
                  onClick={() => setSelectedPerk(perk.id)}
                  className={`relative overflow-hidden rounded-3xl border p-4 text-left transition-all duration-300 ${
                    unlocked
                      ? "border-amber-400/30 bg-amber-500/10 shadow-[0_0_0_1px_rgba(251,191,36,0.18)]"
                      : "border-vault-border/50 bg-vault-surface/20 hover:border-amber-400/20 hover:bg-vault-surface/35"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${unlocked ? "border-amber-400/35 bg-amber-500/15 text-amber-300" : "border-vault-border bg-vault-surface text-vault-muted"}`}>
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-semibold ${unlocked ? "text-amber-200" : "text-vault-text"}`}>
                        {perk.title}
                      </p>
                      <p className="mt-1 text-xs text-vault-muted">
                        Requires ${perk.requirement.toLocaleString()} active deposits
                      </p>
                      <p className="mt-2 text-sm text-vault-muted">
                        {perk.description}
                      </p>
                    </div>
                  </div>

                  {unlocked ? (
                    <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-amber-400/15 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.24em] text-amber-200">
                      Unlocked
                    </div>
                  ) : isSelected ? (
                    <div className="mt-4 rounded-2xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs text-amber-100">
                      This perk unlocks once your active balance reaches ${perk.requirement.toLocaleString()}.
                    </div>
                  ) : (
                    <div className="mt-4 flex items-center gap-1 text-xs font-semibold text-vault-muted">
                      Tap for milestone details
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="rounded-3xl border border-vault-border/40 bg-vault-surface/30 p-4">
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
              Level ladder
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-5">
              {LEVELS.map((level, index) => {
                const unlocked = index <= levelIndex;

                return (
                  <div
                    key={level.name}
                    className={`rounded-2xl border px-3 py-3 text-center ${unlocked ? "border-amber-400/30 bg-amber-500/10" : "border-vault-border/40 bg-vault-surface/20"}`}
                  >
                    <p className={`text-xs font-semibold uppercase tracking-[0.24em] ${unlocked ? "text-amber-200" : "text-vault-muted"}`}>
                      {level.name}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-vault-text">
                      ${level.min.toLocaleString()}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}