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

function isStepDone(id: string, walletConnected: boolean, hasJoinedVault: boolean): boolean {
  switch (id) {
    case "connect-wallet": return walletConnected;
    case "correct-network": return walletConnected;
    case "choose-vault": return hasJoinedVault;
    case "join-pool": return hasJoinedVault;
    case "follow-rewards": return hasJoinedVault;
    default: return false;
  }
}

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
  hasJoinedVault?: boolean;
  loading?: boolean;
}

export const OnboardingChecklist: FC<OnboardingChecklistProps> = ({
  className = "",
  walletConnected = false,
  hasJoinedVault = false,
  loading = false,
}) => {
  const [dismissed, setDismissed] = useState(() => readDismissed());
  const [expanded, setExpanded] = useState(() => !readDismissed());

  if (loading) return <ChecklistSkeleton />;

  const dismiss = () => { writeDismissed(true); setDismissed(true); setExpanded(false); };
  const revisit = () => { writeDismissed(false); setDismissed(false); setExpanded(true); };
  const completedCount = STEPS.filter((s) => isStepDone(s.id, walletConnected, hasJoinedVault)).length;
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
          {allDone ? (
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-900/20 p-4">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-300" aria-hidden="true" />
              <p className="text-sm font-medium text-emerald-200">All steps complete — you're ready to use VaultQuest.</p>
            </div>
          ) : (
            <ol className="mt-4 grid gap-3 md:grid-cols-2">
              {STEPS.map((step) => {
                const done = isStepDone(step.id, walletConnected, hasJoinedVault);
                return (
                  <li key={step.id} className="flex gap-3 rounded-xl border border-red-900/20 bg-black/20 p-3">
                    {done
                      ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                      : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-600" aria-hidden="true" />}
                    <div>
                      <h3 className={`text-sm font-semibold ${done ? "text-emerald-200" : "text-white"}`}>{step.title}</h3>
                      <p className="mt-1 text-sm leading-5 text-gray-400">{step.body}</p>
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
