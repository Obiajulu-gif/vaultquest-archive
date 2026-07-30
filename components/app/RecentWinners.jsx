"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useAnimationFrame, useMotionValue } from "framer-motion";
import { Trophy, Gift, ShieldCheck } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_VAULTQUEST_API_BASE_URL || "/api";

const MOCK_WINNERS = [
  {
    id: 1,
    name: "Obiajulu",
    address: "GBBD...LLFL",
    amount: 1250,
    asset: "USDC",
    poolName: "30-Day Savings Sprint",
    date: "2 hours ago",
    avatarGrad: "from-amber-400 to-yellow-600",
    verified: false,
  },
  {
    id: 2,
    name: "Sarah K.",
    address: "GD72...3J5D",
    amount: 350,
    asset: "USDC",
    poolName: "USDC Yield Pool",
    date: "1 day ago",
    avatarGrad: "from-purple-500 to-indigo-500",
    verified: false,
  },
  {
    id: 3,
    name: "David E.",
    address: "GC4A...K9Q2",
    amount: 1500,
    asset: "USDC",
    poolName: "30-Day Savings Sprint",
    date: "2 days ago",
    avatarGrad: "from-yellow-400 to-orange-500",
    verified: false,
  },
  {
    id: 4,
    name: "Elena R.",
    address: "GAT5...F92A",
    amount: 720,
    asset: "USDC",
    poolName: "Student Saver Quest",
    date: "3 days ago",
    avatarGrad: "from-teal-400 to-emerald-600",
    verified: false,
  },
  {
    id: 5,
    name: "Liam M.",
    address: "GDBK...W4XP",
    amount: 2100,
    asset: "USDC",
    poolName: "Grand Prize Pool",
    date: "4 days ago",
    avatarGrad: "from-amber-500 to-rose-600",
    verified: false,
  },
  {
    id: 6,
    name: "Sakura S.",
    address: "GBR6...M32L",
    amount: 120,
    asset: "USDC",
    poolName: "Student Saver Quest",
    date: "5 days ago",
    avatarGrad: "from-pink-500 to-rose-400",
    verified: false,
  },
  {
    id: 7,
    name: "Marcus V.",
    address: "GD5W...P67T",
    amount: 980,
    asset: "USDC",
    poolName: "USDC Yield Pool",
    date: "1 week ago",
    avatarGrad: "from-blue-500 to-cyan-500",
    verified: false,
  },
];

function truncateAddr(addr) {
  if (!addr || addr.length < 8) return addr || "Unknown";
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function proofToWinner(proof, idx) {
  const p = proof.proof || proof;
  const winnerAddr = p.winnerSelection?.winnerAddress || "Unknown";
  const amount = Number(p.payout?.amount || 0) / 1_000_000;
  const asset = p.payout?.asset || "USDC";
  const roundId = p.roundId ?? proof.round_id ?? idx;
  const createdAt = p.metadata?.createdAt || proof.created_at;
  const ago = createdAt ? formatAgo(new Date(createdAt)) : "";
  const gradients = [
    "from-amber-400 to-yellow-600",
    "from-purple-500 to-indigo-500",
    "from-yellow-400 to-orange-500",
    "from-teal-400 to-emerald-600",
    "from-amber-500 to-rose-600",
    "from-pink-500 to-rose-400",
    "from-blue-500 to-cyan-500",
  ];

  return {
    id: proof.draw_id || proof.id || idx,
    name: `Round #${roundId}`,
    address: winnerAddr,
    amount,
    asset,
    poolName: `Contract ${truncateAddr(p.contractId)}`,
    date: ago,
    avatarGrad: gradients[idx % gradients.length],
    verified: proof.verified || false,
    drawId: p.drawId || proof.draw_id,
  };
}

function formatAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / 604800)}w ago`;
}

export default function RecentWinners() {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [winners, setWinners] = useState(MOCK_WINNERS);

  const x = useMotionValue(0);

  useEffect(() => {
    fetch(`${API_BASE}/draw-proofs?limit=20`)
      .then((res) => res.json())
      .then((data) => {
        const proofs = data.data || [];
        if (proofs.length > 0) {
          const proofWinners = proofs.map((p, i) => proofToWinner(p, i));
          setWinners(proofWinners);
        }
      })
      .catch(() => {
        // Keep mock data
      });
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const updateWidth = () => {
      if (containerRef.current) {
        setWidth(containerRef.current.scrollWidth / 2);
      }
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [winners]);

  const DUPLICATED_WINNERS = [...winners, ...winners];

  useAnimationFrame((time, delta) => {
    if (!width || isPaused || isDragging) return;

    const currentX = x.get();
    const baseSpeed = 1.0;
    const deltaFactor = delta / 16.67;
    let nextX = currentX - baseSpeed * deltaFactor;

    if (nextX <= -width) {
      nextX = 0;
    }
    x.set(nextX);
  });

  const handleDragStart = () => {
    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    const currentX = x.get();
    if (currentX > 0) {
      x.set(0);
    } else if (currentX < -width) {
      x.set(-width);
    }
  };

  return (
    <section className="space-y-4 py-4" aria-label="Recent winners carousel">
      <div className="flex items-center justify-between px-4 sm:px-0">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-vault-text flex items-center gap-2">
            <Trophy className="h-5 w-5 text-amber-500 animate-pulse" aria-hidden="true" />
            Recent Prize Winners
          </h2>
          <p className="text-sm text-vault-muted">Live payout records of savers in VaultQuest pools</p>
        </div>
      </div>

      <div 
        className="relative overflow-hidden cursor-grab active:cursor-grabbing"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        onTouchStart={() => setIsPaused(true)}
        onTouchEnd={() => setIsPaused(false)}
      >
        <div className="pointer-events-none absolute left-0 top-0 z-10 h-full w-12 bg-gradient-to-r from-vault-bg to-transparent sm:w-20" />
        <div className="pointer-events-none absolute right-0 top-0 z-10 h-full w-12 bg-gradient-to-l from-vault-bg to-transparent sm:w-20" />

        <motion.div
          ref={containerRef}
          className="flex gap-4 px-12 py-2 w-max"
          style={{ x }}
          drag="x"
          dragConstraints={{ left: -width, right: 0 }}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {DUPLICATED_WINNERS.map((winner, idx) => {
            const isLargeWin = winner.amount >= 1000;
            return (
              <article
                key={`${winner.id}-${idx}`}
                className={`w-64 shrink-0 rounded-2xl p-5 transition-transform duration-300 select-none ${
                  isLargeWin
                    ? "bg-gradient-to-br from-amber-500/10 via-yellow-500/5 to-amber-600/10 border border-amber-500/40 shadow-[0_4px_20px_rgba(245,158,11,0.12)] hover:border-amber-400 hover:scale-[1.02]"
                    : "vq-glass border border-vault-border bg-vault-surface/40 hover:border-red-400/30 hover:scale-[1.02]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${winner.avatarGrad} text-sm font-bold text-white shadow-md`}
                    >
                      {winner.name.charAt(0)}
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-vault-text leading-tight">{winner.name}</h3>
                      <p className="font-mono text-[10px] text-vault-muted mt-0.5">
                        {truncateAddr(winner.address)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {winner.verified && (
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-label="Proof verified" />
                    )}
                    {isLargeWin && (
                      <Trophy className="h-5 w-5 text-amber-400 shrink-0" aria-hidden="true" />
                    )}
                  </div>
                </div>

                <div className="mt-4">
                  <div className="flex items-baseline gap-1.5">
                    <span
                      className={`text-2xl font-bold tracking-tight ${
                        isLargeWin ? "text-amber-500 dark:text-amber-400" : "text-vault-text"
                      }`}
                    >
                      +{winner.amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}
                    </span>
                    <span className="text-[10px] uppercase font-bold text-vault-muted">{winner.asset}</span>
                  </div>
                  
                  {isLargeWin && (
                    <span className="mt-1 inline-flex items-center rounded-full bg-amber-500/20 px-2 py-0.5 text-[9px] font-bold text-amber-300 border border-amber-500/30">
                      GRAND PRIZE
                    </span>
                  )}
                </div>

                <div className="mt-4 border-t border-vault-border/40 pt-2 flex items-center justify-between text-xs text-vault-muted">
                  <span className="truncate max-w-[140px]" title={winner.poolName}>{winner.poolName}</span>
                  <span className="shrink-0">{winner.date}</span>
                </div>
              </article>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}
