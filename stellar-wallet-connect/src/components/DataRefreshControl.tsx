import { FC, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { StaleIndicator } from "./FallbackStates";

export interface DataRefreshControlProps {
  updatedAt: number | null;
  stale: boolean;
  fetching: boolean;
  partialError: Error | null;
  onRefresh: () => void;
  className?: string;
}

function useRelativeTime(timestamp: number | null): string {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!timestamp) {
      setText("");
      return;
    }

    const update = () => {
      const ms = Date.now() - timestamp;
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);

      if (seconds < 10) setText("Just now");
      else if (seconds < 60) setText(`${seconds}s ago`);
      else if (minutes < 60) setText(`${minutes}m ago`);
      else if (hours < 24) setText(`${hours}h ago`);
      else setText("Over 1d ago");
    };

    update();
    const interval = setInterval(update, 10000);
    return () => clearInterval(interval);
  }, [timestamp]);

  return text;
}

/**
 * Inline control displaying the age of data, alongside a manual refresh button.
 * Handles stale indicators and non-fatal refresh errors.
 */
export const DataRefreshControl: FC<DataRefreshControlProps> = ({
  updatedAt,
  stale,
  fetching,
  partialError,
  onRefresh,
  className = "",
}) => {
  const timeText = useRelativeTime(updatedAt);

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {stale && !fetching && !partialError && <StaleIndicator label="Stale" />}
      {fetching && <StaleIndicator label="Refreshing…" />}
      
      {partialError && (
        <span
          role="alert"
          title={partialError.message}
          className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-400"
        >
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          Update failed
        </span>
      )}

      {updatedAt && !fetching && !partialError && !stale && (
        <span className="text-xs text-gray-400">
          Updated: {timeText}
        </span>
      )}

      <button
        type="button"
        onClick={onRefresh}
        disabled={fetching}
        aria-label="Refresh data"
        className="inline-flex items-center justify-center rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-900/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw className={`h-4 w-4 ${fetching ? "animate-spin" : ""}`} aria-hidden="true" />
      </button>
    </div>
  );
};
