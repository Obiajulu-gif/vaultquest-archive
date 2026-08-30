import { useState, type FC } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, HelpCircle, Wallet } from "lucide-react";

export const ONBOARDING_STORAGE_KEY = "vaultquest.onboarding.dismissed";

const STEPS = [
  { id: "connect-wallet", title: "Connect a Stellar wallet", body: "VaultQuest uses your wallet to show your position and request signatures for pool actions." },
  { id: "correct-network", title: "Use the supported network", body: "Make sure your wallet is on the VaultQuest-supported Stellar network before joining a pool." },
  { id: "choose-vault", title: "Choose a vault", body: "Browse available pools and select one that matches your deposit size and lock period." },
  { id: "join-pool", title: "Join a pool", body: "Joining deposits the pool asset, records your shares, and keeps the action visible while it confirms." },
  { id: "follow-rewards", title: "Follow reward cycles", body: "Pools lock, draw, and settle on a schedule. Rewards appear after the cycle settles." },
];

function readDismissed(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
}

function writeDismissed(value: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(ONBOARDING_STORAGE_KEY, value ? "true" : "false");
}

/**
 * Real onboarding progress, driven by actual wallet/vault state (#628) —
 * this replaces the earlier version (#202) where "correct-network" and
 * "connect-wallet" both collapsed onto the same `walletConnected` boolean
 * (so a wallet on the wrong chain still showed the network step as done),
 * and every vault-related step collapsed onto a single, often-hardcoded
 * `hasJoinedVault` flag with no real deposit signal behind it.
 *
 * `networkSupported` is `true` when there's no wallet connected at all —
 * "wrong network" isn't a meaningful state to show before a wallet exists,
 * and the "connect-wallet" step being incomplete already communicates that.
 */
function isStepDone(
  id: string,
  walletConnected: boolean,
  networkSupported: boolean,
  hasDeposited: boolean,
): boolean {
  switch (id) {
    case "connect-wallet": return walletConnected;
    case "correct-network": return walletConnected && networkSupported;
    case "choose-vault": return hasDeposited;
    case "join-pool": return hasDeposited;
    case "follow-rewards": return hasDeposited;
    default: return false;
  }
}

/** Steps whose progress requires the wallet to be on a supported network first. */
const NETWORK_GATED_STEP_IDS = new Set(["choose-vault", "join-pool", "follow-rewards"]);

function ChecklistSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-red-900/30 bg-[#1A0505]/60 p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-full bg-red-900/30" />
        <div className="space-y-1.5">
          <div className="h-4 w-40 rounded bg-vault-border" />
          <div className="h-3 w-28 rounded bg-vault-border" />
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-red-900/20 bg-black/20 p-3">
            <div className="h-3 w-32 rounded bg-vault-border" />
            <div className="mt-2 h-8 w-full rounded bg-vault-border" />
          </div>
        ))}
      </div>
    </div>
  );
}

export interface OnboardingChecklistProps {
  className?: string;
  walletConnected?: boolean;
  /**
   * Whether the connected wallet is on a VaultQuest-supported network.
   * Ignored while `walletConnected` is false. Defaults to `true` so a
   * caller that hasn't wired real network detection yet doesn't
   * regress to a permanently-blocked checklist — see #628.
   */
  networkSupported?: boolean;
  /**
   * Whether the wallet holds a real, confirmed deposit — drive this from
   * actual backend/vault state (e.g. `usePortfolioSummary`'s
   * `active_positions.length > 0`), never a hardcoded or locally-guessed
   * value. Superseded `hasJoinedVault` (#202) is still accepted for
   * backward compatibility but is deprecated: it conflated "joined a
   * pool" with several unrelated later steps, and #628's audit found at
   * least one call site where it was a permanently-`false` placeholder.
   */
  hasDeposited?: boolean;
  /** @deprecated Use `hasDeposited`, which is what this actually maps to. */
  hasJoinedVault?: boolean;
  loading?: boolean;
}

export const OnboardingChecklist: FC<OnboardingChecklistProps> = ({
  className = "",
  walletConnected = false,
  networkSupported = true,
  hasDeposited,
  hasJoinedVault = false,
  loading = false,
}) => {
  const [dismissed, setDismissed] = useState(() => readDismissed());
  const [expanded, setExpanded] = useState(() => !readDismissed());

  if (loading) return <ChecklistSkeleton />;

  // `hasDeposited` wins when provided; `hasJoinedVault` is the deprecated
  // fallback for callers not yet migrated.
  const deposited = hasDeposited ?? hasJoinedVault;
  const networkBlocked = walletConnected && !networkSupported;

  const dismiss = () => { writeDismissed(true); setDismissed(true); setExpanded(false); };
  const revisit = () => { writeDismissed(false); setDismissed(false); setExpanded(true); };
  const completedCount = STEPS.filter((s) => isStepDone(s.id, walletConnected, networkSupported, deposited)).length;
  const allDone = completedCount === STEPS.length;

  if (dismissed) {
    return (
      <button type="button" onClick={revisit}
        className={`inline-flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-900/30 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-900/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505] ${className}`}>
        <HelpCircle className="h-4 w-4" aria-hidden="true" />
        Onboarding checklist
      </button>
    );
  }

  return (
    <aside aria-label="Onboarding checklist" className={`rounded-2xl border border-red-900/30 bg-[#1A0505]/60 p-4 text-gray-200 sm:p-5 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-red-900/30 text-red-300">
            <Wallet className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-white">First-time wallet checklist</h2>
            <p className="text-sm text-gray-400">{completedCount} of {STEPS.length} steps complete</p>
          </div>
        </div>
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-red-500/30 text-gray-200 transition-colors hover:bg-red-900/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400">
          {expanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          <span className="sr-only">{expanded ? "Collapse" : "Expand"}</span>
        </button>
      </div>

      {expanded && (
        <>
          {networkBlocked && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-900/20 p-3"
            >
              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
              <p className="text-sm leading-5 text-amber-200">
                Your wallet is on an unsupported network — switch networks to unlock vault steps below.
              </p>
            </div>
          )}
          {allDone ? (
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-900/20 p-4">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-300" aria-hidden="true" />
              <p className="text-sm font-medium text-emerald-200">All steps complete — you're ready to use VaultQuest.</p>
            </div>
          ) : (
            <ol className="mt-4 grid gap-3 md:grid-cols-2">
              {STEPS.map((step) => {
                const done = isStepDone(step.id, walletConnected, networkSupported, deposited);
                const blocked = !done && networkBlocked && NETWORK_GATED_STEP_IDS.has(step.id);
                return (
                  <li
                    key={step.id}
                    className={`flex gap-3 rounded-xl border border-red-900/20 bg-black/20 p-3 ${blocked ? "opacity-60" : ""}`}
                  >
                    {done
                      ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                      : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-600" aria-hidden="true" />}
                    <div>
                      <h3 className={`text-sm font-semibold ${done ? "text-emerald-200" : "text-white"}`}>{step.title}</h3>
                      <p className="mt-1 text-sm leading-5 text-gray-400">
                        {blocked ? "Switch to a supported network first." : step.body}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <button type="button" onClick={dismiss}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]">
            Got it
          </button>
        </>
      )}
    </aside>
  );
};
