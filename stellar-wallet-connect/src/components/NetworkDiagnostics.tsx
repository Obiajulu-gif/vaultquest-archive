import { useState, type FC } from "react";
import { useStore } from "@nanostores/react";
import {
  AlertTriangle,
  Clipboard,
  Check,
  Terminal,
  Settings,
  AlertCircle
} from "lucide-react";
import { connectedPublicKey, connectedNetwork, isNetworkMismatch } from "../core/store";
import { EXPECTED_NETWORK, STELLAR_NETWORKS, type NetworkType } from "../lib/wallets";
import { getFrontendEnv } from "../core/env";
import { resolveHorizonUrl } from "../core/horizonConfig";

export const NetworkDiagnostics: FC = () => {
  const publicKey = useStore(connectedPublicKey);
  const network = useStore(connectedNetwork);
  const mismatch = useStore(isNetworkMismatch);

  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Read environment variables safely
  let env: any = {};
  let envError: string | null = null;
  try {
    env = getFrontendEnv();
  } catch (err: any) {
    envError = err.message || String(err);
  }

  const expectedNetworkConfig = STELLAR_NETWORKS[EXPECTED_NETWORK as NetworkType];
  const connectedNetworkConfig = network ? STELLAR_NETWORKS[network as NetworkType] : null;
  const activeHorizonUrl = resolveHorizonUrl(
    env.NEXT_PUBLIC_HORIZON_URL ?? "",
    expectedNetworkConfig?.horizonUrl ?? "",
  );

  const handleCopy = () => {
    const info = `### VaultQuest Diagnostic Report
- **Timestamp**: ${new Date().toISOString()}
- **Wallet Connected**: ${publicKey ? "Yes" : "No"}
- **Wallet Public Key**: ${publicKey || "N/A"}
- **Connected Network**: ${network || "Unknown"} (Passphrase: ${connectedNetworkConfig?.passphrase || "N/A"})
- **Expected Network**: ${EXPECTED_NETWORK} (Passphrase: ${expectedNetworkConfig?.passphrase || "N/A"})
- **Network Mismatch Detected**: ${mismatch ? "Yes" : "No"}

#### Configuration Info:
- **Drip Pool Contract ID**: ${env.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID || "Not Set"}
- **Escrow Contract ID**: ${env.NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID || "Not Set"}
- **Soroban RPC URL**: ${env.NEXT_PUBLIC_SOROBAN_RPC_URL || "Not Set"}
- **Horizon URL**: ${activeHorizonUrl || env.NEXT_PUBLIC_HORIZON_URL || "Not Set"}
- **Escrow Service API Base URL**: ${env.TRUSTLESS_WORK_API_BASE_URL || "Not Set"}
- **Escrow Service API Key**: ${env.TRUSTLESS_WORK_API_KEY ? "[HIDDEN / PRESENT]" : "[NOT SET]"}
- **Environment Status**: ${envError ? `Degraded (${envError})` : "Healthy"}
`;

    navigator.clipboard.writeText(info);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4 w-full">
      {/* Network Mismatch Banner */}
      {mismatch && publicKey && (
        <div
          role="alert"
          aria-live="assertive"
          className="relative rounded-2xl border border-red-500/30 bg-red-950/40 backdrop-blur-md p-4 text-red-200 animate-in fade-in slide-in-from-top-4 duration-300 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-[0_0_15px_rgba(239,68,68,0.15)]"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-400">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-white">Network Mismatch Blocked Action</h2>
              <p className="text-xs text-red-300 mt-0.5">
                Your wallet is connected to <span className="font-bold uppercase">{network}</span>, but the VaultQuest dApp expects <span className="font-bold uppercase">{EXPECTED_NETWORK}</span>. Core transaction options are disabled.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-xs shrink-0 font-semibold text-red-300 hover:text-white underline underline-offset-2 transition-colors focus:outline-none focus:ring-1 focus:ring-red-400 p-1 rounded"
          >
            Open Diagnostics Panel
          </button>
        </div>
      )}

      {/* Diagnostics Toggle Button */}
      <div className="flex justify-end w-full">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-2 rounded-xl border border-red-900/30 bg-[#1A0505]/40 px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white hover:bg-red-900/10 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <Settings className={`h-3.5 w-3.5 ${expanded ? "rotate-90" : ""} transition-transform duration-300`} aria-hidden="true" />
          {expanded ? "Hide Diagnostics" : "System Diagnostics"}
        </button>
      </div>

      {/* Diagnostics Panel */}
      {expanded && (
        <aside
          aria-label="System Diagnostics"
          className="rounded-2xl border border-red-900/20 bg-[#120303]/90 backdrop-blur-md p-4 sm:p-5 text-gray-300 animate-in zoom-in-95 duration-200 shadow-xl space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-900/20 pb-3">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-red-900/20 text-red-400">
                <Terminal className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-white">System & Configuration Diagnostics</h3>
                <p className="text-[11px] text-gray-400">Useful metadata for network and smart contract status.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-900/20 border border-red-900/40 hover:bg-red-900/40 px-3 py-1.5 text-xs font-medium text-white transition-colors focus:outline-none focus:ring-1 focus:ring-red-400"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                  Copied!
                </>
              ) : (
                <>
                  <Clipboard className="h-3.5 w-3.5" aria-hidden="true" />
                  Copy Diagnostics
                </>
              )}
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 text-xs">
            {/* Wallet State */}
            <div className="space-y-2 rounded-xl border border-red-900/10 bg-black/10 p-3">
              <h4 className="font-semibold text-white uppercase tracking-wider text-[10px] text-red-400">Wallet Connectivity</h4>
              <dl className="space-y-1">
                <div className="flex justify-between">
                  <dt className="text-gray-400">Status:</dt>
                  <dd className={publicKey ? "text-emerald-400 font-semibold" : "text-gray-400"}>
                    {publicKey ? "Connected" : "Disconnected"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-400">Wallet Public Key:</dt>
                  <dd className="font-mono text-gray-200 select-all max-w-[200px] truncate" title={publicKey || ""}>
                    {publicKey || "N/A"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-400">Detected Wallet Network:</dt>
                  <dd className={`font-semibold uppercase ${mismatch ? "text-red-400" : "text-emerald-400"}`}>
                    {network || "Unknown"}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Network State */}
            <div className="space-y-2 rounded-xl border border-red-900/10 bg-black/10 p-3">
              <h4 className="font-semibold text-white uppercase tracking-wider text-[10px] text-red-400">Stellar Network Targets</h4>
              <dl className="space-y-1">
                <div className="flex justify-between">
                  <dt className="text-gray-400">Expected Network Name:</dt>
                  <dd className="font-semibold uppercase text-emerald-400">{EXPECTED_NETWORK}</dd>
                </div>
                <div className="flex flex-col gap-0.5 mt-1 border-t border-red-900/10 pt-1">
                  <dt className="text-gray-400 text-[10px]">Expected Network Passphrase:</dt>
                  <dd className="font-mono text-[10px] text-gray-200 break-all select-all bg-black/30 p-1 rounded mt-0.5">
                    {expectedNetworkConfig?.passphrase || "N/A"}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Smart Contracts Configuration */}
            <div className="space-y-2 rounded-xl border border-red-900/10 bg-black/10 p-3 md:col-span-2">
              <h4 className="font-semibold text-white uppercase tracking-wider text-[10px] text-red-400">Registered Smart Contracts & API</h4>
              <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                <div>
                  <dt className="text-gray-400">Drip Pool Contract ID:</dt>
                  <dd className="font-mono text-gray-200 break-all bg-black/30 p-1 rounded mt-0.5 select-all">
                    {env.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID || "Not Set"}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-400">Horizon Endpoint URL:</dt>
                  <dd className="font-mono text-gray-200 break-all bg-black/30 p-1 rounded mt-0.5 select-all">
                    {activeHorizonUrl || env.NEXT_PUBLIC_HORIZON_URL || "Not Set"}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-400">Soroban RPC Server URL:</dt>
                  <dd className="font-mono text-gray-200 break-all bg-black/30 p-1 rounded mt-0.5 select-all">
                    {env.NEXT_PUBLIC_SOROBAN_RPC_URL || "Not Set"}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-400">Escrow Service API Base URL:</dt>
                  <dd className="font-mono text-gray-200 break-all bg-black/30 p-1 rounded mt-0.5 select-all">
                    {env.TRUSTLESS_WORK_API_BASE_URL || "Not Set"}
                  </dd>
                </div>
                {env.NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID && (
                  <div className="sm:col-span-2">
                    <dt className="text-gray-400">Escrow Contract ID:</dt>
                    <dd className="font-mono text-gray-200 break-all bg-black/30 p-1 rounded mt-0.5 select-all text-xs">
                      {env.NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </div>

          {envError && (
            <div className="rounded-xl border border-red-500/20 bg-red-950/20 p-3 text-xs text-red-300 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <span className="font-semibold text-white">Environment Warnings:</span>
                <p className="mt-0.5 font-mono text-[10px] break-all">{envError}</p>
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
};
