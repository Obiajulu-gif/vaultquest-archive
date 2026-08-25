"use client";

import { motion } from "framer-motion";
import { Award, Lock, Calendar, Info } from "lucide-react";
import { useState } from "react";

/**
 * ACHIEVEMENT_BADGES_DATA
 * Mock data for the badges. In a production app, this would come from a database.
 */
const ACHIEVEMENT_BADGES_DATA = [
  {
    id: "early-adopter",
    name: "Early Adopter",
    description: "Joined VaultQuest during the beta phase.",
    condition: "Automatic for beta users",
    unlocked: true,
    earnedAt: "2026-03-15T10:00:00Z",
    color: "from-blue-500 to-indigo-600",
  },
  {
    id: "first-deposit",
    name: "First Deposit",
    description: "Took the first step towards no-loss savings.",
    condition: "Make any deposit",
    unlocked: true,
    earnedAt: "2026-03-16T14:30:00Z",
    color: "from-emerald-500 to-teal-600",
  },
  {
    id: "prize-winner",
    name: "Prize Winner",
    description: "Successfully won a weekly prize draw.",
    condition: "Win any prize",
    unlocked: true,
    earnedAt: "2026-04-12T18:05:00Z",
    color: "from-amber-400 to-orange-500",
  },
  {
    id: "savings-streak",
    name: "30-Day Streak",
    description: "Maintained an active deposit for 30 consecutive days.",
    condition: "Hold for 30 days",
    unlocked: true,
    earnedAt: "2026-05-20T09:00:00Z",
    color: "from-purple-500 to-pink-600",
  },
  {
    id: "whale",
    name: "Vault Whale",
    description: "Reached a total deposit balance of over $10,000.",
    condition: "Deposit $10k+",
    unlocked: false,
    earnedAt: null,
    color: "from-cyan-500 to-blue-600",
  },
  {
    id: "referral-master",
    name: "Networker",
    description: "Helped 10 new savers join the VaultQuest community.",
    condition: "Refer 10 users",
    unlocked: false,
    earnedAt: null,
    color: "from-red-500 to-rose-600",
  },
  {
    id: "diamond-hands",
    name: "Diamond Hands",
    description: "Kept your principal locked for over 6 months.",
    condition: "Hold for 6 months",
    unlocked: false,
    earnedAt: null,
    color: "from-slate-700 to-slate-900",
  },
  {
    id: "governance-guru",
    name: "Voter",
    description: "Participated in 5 or more governance proposals.",
    condition: "Vote 5 times",
    unlocked: false,
    earnedAt: null,
    color: "from-yellow-500 to-amber-600",
  },
];

/**
 * BadgeIcon
 * Renders a custom vector SVG badge based on the badge's status.
 */
function BadgeIcon({ unlocked, colorClass, name }) {
  return (
    <div className="relative flex h-16 w-16 items-center justify-center sm:h-20 sm:w-20">
      {/* Badge Shield Base */}
      <svg
        viewBox="0 0 100 100"
        className={`h-full w-full transition-all duration-500 ${
          unlocked 
            ? "drop-shadow-[0_0_8px_rgba(220,38,38,0.3)] filter" 
            : "grayscale opacity-40"
        }`}
      >
        <defs>
          <linearGradient id={`grad-${name.replace(/\s+/g, '-').toLowerCase()}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" className="stop-color-1" />
            <stop offset="100%" className="stop-color-2" />
          </linearGradient>
        </defs>
        
        {/* Outer Ring */}
        <circle
          cx="50"
          cy="50"
          r="48"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={unlocked ? "text-vault-accent/20" : "text-vault-border"}
        />
        
        {/* Badge Shape */}
        <path
          d="M50 5 L85 20 L85 55 C85 75 70 90 50 95 C30 90 15 75 15 55 L15 20 L50 5 Z"
          className={unlocked ? `fill-current text-red-500/10 stroke-red-500/30` : "fill-vault-surface stroke-vault-border"}
          strokeWidth="2"
        />
        
        {/* Inner Emblem Decor */}
        <path
          d="M50 15 L78 28 L78 55 C78 70 65 82 50 86 C35 82 22 70 22 55 L22 28 L50 15 Z"
          className={unlocked ? `fill-gradient-${name.replace(/\s+/g, '-').toLowerCase()}` : "fill-vault-border/20"}
          style={{ 
            fill: unlocked ? undefined : 'currentColor',
            fillOpacity: unlocked ? 1 : 0.2
          }}
        />
      </svg>
      
      {/* Icon Overlay */}
      <div className={`absolute inset-0 flex items-center justify-center transition-transform duration-300 ${unlocked ? "scale-100" : "scale-75 opacity-50"}`}>
        {unlocked ? (
          <Award className="h-8 w-8 text-red-500 sm:h-10 sm:w-10" />
        ) : (
          <Lock className="h-6 w-6 text-vault-muted sm:h-8 sm:w-8" />
        )}
      </div>

      {/* Glow Effect for unlocked badges */}
      {unlocked && (
        <div className="absolute inset-0 -z-10 animate-pulse rounded-full bg-red-500/10 blur-xl" />
      )}
    </div>
  );
}

/**
 * BadgesGallery Component
 * Showcase of earned achievements and locked milestones.
 */
export default function BadgesGallery() {
  const [hoveredBadge, setHoveredBadge] = useState(null);

  return (
    <section className="vq-glass p-6 sm:p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-vault-text">Achievement Gallery</h2>
          <p className="text-sm text-vault-muted">Unlock milestones by saving and participating.</p>
        </div>
        <div className="hidden sm:block">
          <div className="flex items-center gap-2 rounded-full border border-vault-border bg-vault-surface/50 px-3 py-1 text-xs font-semibold text-vault-muted">
            <Award className="h-3.5 w-3.5 text-red-500" />
            {ACHIEVEMENT_BADGES_DATA.filter(b => b.unlocked).length} / {ACHIEVEMENT_BADGES_DATA.length} Earned
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {ACHIEVEMENT_BADGES_DATA.map((badge) => (
          <div
            key={badge.id}
            className="group relative"
            onMouseEnter={() => setHoveredBadge(badge.id)}
            onMouseLeave={() => setHoveredBadge(null)}
          >
            <div
              className={`flex flex-col items-center rounded-2xl border p-4 transition-all duration-300 ${
                badge.unlocked
                  ? "border-vault-border bg-vault-surface/30 hover:border-red-500/30 hover:shadow-glow active:scale-95"
                  : "border-dashed border-vault-border bg-vault-surface/10 grayscale"
              }`}
            >
              <BadgeIcon 
                unlocked={badge.unlocked} 
                colorClass={badge.color} 
                name={badge.name} 
              />
              
              <h3 className={`mt-3 text-center text-xs font-bold uppercase tracking-wider transition-colors duration-300 ${
                badge.unlocked ? "text-vault-text" : "text-vault-muted"
              }`}>
                {badge.name}
              </h3>
              
              {!badge.unlocked && (
                <div className="mt-2 flex items-center gap-1 text-[9px] font-bold uppercase tracking-tight text-vault-muted/60">
                  <Info className="h-2.5 w-2.5" />
                  Locked
                </div>
              )}
            </div>

            {/* Tooltip on Hover */}
            {hoveredBadge === badge.id && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className="absolute left-1/2 bottom-full z-50 mb-3 w-48 -translate-x-1/2 overflow-hidden rounded-xl border border-vault-border bg-vault-bg/95 p-3 shadow-2xl backdrop-blur-md"
              >
                <div className="text-xs font-bold text-vault-text">{badge.name}</div>
                <p className="mt-1 text-[10px] leading-relaxed text-vault-muted">
                  {badge.description}
                </p>
                
                <div className="mt-2 border-t border-vault-border/50 pt-2">
                  <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-tight">
                    <span className="text-vault-muted">Status</span>
                    <span className={badge.unlocked ? "text-emerald-500" : "text-red-500"}>
                      {badge.unlocked ? "Earned" : "Locked"}
                    </span>
                  </div>
                  
                  {badge.unlocked ? (
                    <div className="mt-1 flex items-center justify-between text-[9px] font-bold uppercase tracking-tight">
                      <span className="text-vault-muted">Date</span>
                      <span className="flex items-center gap-1 text-vault-text">
                        <Calendar className="h-2.5 w-2.5" />
                        {new Date(badge.earnedAt).toLocaleDateString()}
                      </span>
                    </div>
                  ) : (
                    <div className="mt-1 text-[9px] italic text-vault-muted">
                      {badge.condition}
                    </div>
                  )}
                </div>
                
                {/* Tooltip Arrow */}
                <div className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-vault-border bg-vault-bg/95" />
              </motion.div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
