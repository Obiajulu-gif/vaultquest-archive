import { useState, type FC } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Copy, Loader2, RefreshCw, Wallet, WifiOff } from "lucide-react";

export interface WalletConnectionStatusProps {
  walletAddress: string | null;
  network: string | null;
  isNetworkMismatch?: boolean;
  expectedNetwork?: string;
  isConnecting?: boolean;
  connectionError?: string | null;
  onConnect?: () => void;
  onReconnect?: () => void;
  onDisconnect?: () => void;
}

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function DisconnectedState({ onConnect, connectionError }: { onConnect?: () => void; connectionError?: string | null }) {
  return (
    <div className="mt-4 space-y-3">
      {connectionError ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-700/20 px-3 py-2 text-sm text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{connectionError}</span>
        </div>
      ) : (
        <p className="text-sm text-gray-400">Connect a wallet to view your position and sign pool actions.</p>
      )}
      {onConnect && (
        <button type="button" onClick={onConnect} className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400">
          <Wallet className="h-4 w-4" aria-hidden="true" />
          Connect wallet
        </button>
      )}
    </div>
  );
}

export const WalletConnectionStatus: FC<WalletConnectionStatusProps> = ({
  walletAddress,
  network,
  isNetworkMismatch = false,
  expectedNetwork = "testnet",
  isConnecting = false,
  connectionError = null,
  onConnect,
  onReconnect,
  onDisconnect,
}) => {
  const [copied, setCopied] = useState(false);
  const isConnected = Boolean(walletAddress);

  const handleCopy = async () => {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable or permission denied — no-op
    }
  };

  return (
    <aside aria-label="Wallet connection status" className="rounded-2xl border border-red-900/30 bg-[#1A0505]/60 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`flex h-10 w-10 items-center justify-center rounded-full ${isConnected ? "bg-emerald-900/30" : "bg-red-900/30"}`}>
            {isConnected
              ? <Wallet className="h-5 w-5 text-emerald-300" aria-hidden="true" />
              : <WifiOff className="h-5 w-5 text-red-300" aria-hidden="true" />}
          </span>
          <div>
            <h2 className="text-base font-semibold text-white">Wallet</h2>
            <p className="text-xs text-gray-400">{isConnected ? "Connected" : "Not connected"}</p>
          </div>
        </div>
        {isConnected && onReconnect && (
          <button type="button" onClick={onReconnect} disabled={isConnecting} aria-label="Reconnect wallet"
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-red-900/30 disabled:cursor-not-allowed disabled:opacity-60">
            {isConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
            {isConnecting ? "Reconnecting…" : "Reconnect"}
          </button>
        )}
      </div>

      {isConnected ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-gray-300">{truncate(walletAddress!)}</span>
            <button type="button" onClick={handleCopy} aria-label="Copy wallet address"
              className="rounded p-1 text-gray-400 transition-colors hover:bg-red-900/20 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400">
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {copied && <span role="status" aria-live="polite" className="text-xs text-emerald-400">Copied!</span>}
          </div>
          {network && (
            <div className="flex items-center gap-1.5">
              {isNetworkMismatch
                ? <AlertTriangle className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
                : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />}
              <span className={`text-xs font-medium ${isNetworkMismatch ? "text-amber-300" : "text-emerald-300"}`}>
                {isNetworkMismatch ? `Wrong network · switch to ${expectedNetwork}` : `${network} · verified`}
              </span>
            </div>
          )}
          {connectionError && (
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-700/20 px-3 py-2 text-sm text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{connectionError}</span>
            </div>
          )}
          {onDisconnect && (
            <button type="button" onClick={onDisconnect} className="mt-1 text-xs text-gray-500 underline transition-colors hover:text-red-400">
              Disconnect
            </button>
          )}
        </div>
      ) : (
        <DisconnectedState onConnect={onConnect} connectionError={connectionError} />
      )}
    </aside>
  );
};

export default WalletConnectionStatus;
