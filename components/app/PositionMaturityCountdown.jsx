"use client";

import { useEffect, useState, useRef, memo } from "react";
import { Clock, CheckCircle2, AlertTriangle } from "lucide-react";

/**
 * Timezone-safe date formatter using Intl.DateTimeFormat.
 * Produces consistent output across all timezones and DST boundaries.
 */
function formatDateSafe(date, options = {}) {
  const defaults = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  };
  return new Intl.DateTimeFormat(undefined, { ...defaults, ...options }).format(
    new Date(date),
  );
}

function formatCountdown(target) {
  const diff = new Date(target).getTime() - Date.now();
  if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, isComplete: true };

  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
    isComplete: false,
  };
}

/**
 * PositionMaturityCountdown
 *
 * Shows a live countdown until a position becomes eligible for maturity actions.
 * Uses Intl.DateTimeFormat for timezone-safe display of the maturity date.
 *
 * @param {Object} props
 * @param {string|Date} props.maturityDate - When the position becomes eligible
 * @param {"active"|"matured"|"paused"|"expired"} props.status - Current position status
 * @param {string} [props.asset] - Asset label (e.g. "USDC")
 * @param {string} [props.positionLabel] - Optional label for the position
 * @param {Function} [props.onMaturityReached] - Callback when countdown completes
 */
export default function PositionMaturityCountdown({
  maturityDate,
  status = "active",
  asset = "USDC",
  positionLabel,
  onMaturityReached,
}) {
  const [timeLeft, setTimeLeft] = useState(null);
  const [alreadyCompleted, setAlreadyCompleted] = useState(false);
  const requestRef = useRef();

  const isMatured = status === "matured";
  const isExpired = status === "expired";
  const isPaused = status === "paused";

  useEffect(() => {
    if (!maturityDate || isMatured || isExpired) {
      setTimeLeft(null);
      return undefined;
    }

    const update = () => {
      const remaining = formatCountdown(maturityDate);
      setTimeLeft(remaining);

      if (remaining.isComplete) {
        if (!alreadyCompleted) {
          setAlreadyCompleted(true);
          onMaturityReached?.();
        }
        return;
      }

      requestRef.current = requestAnimationFrame(update);
    };

    requestRef.current = requestAnimationFrame(update);

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [maturityDate, isMatured, isExpired, alreadyCompleted, onMaturityReached]);

  if (!maturityDate) {
    return (
      <div className="vq-glass relative overflow-hidden p-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <AlertTriangle className="h-6 w-6 text-amber-500" />
          <p className="text-sm text-vault-muted">Maturity date information is not available.</p>
        </div>
      </div>
    );
  }

  if (isPaused) {
    return (
      <div className="vq-glass relative overflow-hidden p-5">
        <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-amber-500/10 blur-[80px]" />
        <div className="relative flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-amber-500">
            <Clock className="h-4 w-4" />
            Position Paused
          </div>
          <p className="text-xs text-vault-muted">
            Countdown is paused. Maturity date: {formatDateSafe(maturityDate)}
          </p>
        </div>
      </div>
    );
  }

  if (isExpired) {
    return (
      <div className="vq-glass relative overflow-hidden p-5">
        <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-slate-500/10 blur-[80px]" />
        <div className="relative flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-vault-muted">
            <CheckCircle2 className="h-4 w-4" />
            Position Expired
          </div>
          <p className="text-xs text-vault-muted">
            This position expired on {formatDateSafe(maturityDate)}.
          </p>
        </div>
      </div>
    );
  }

  if (isMatured || alreadyCompleted) {
    return (
      <div className="vq-glass relative overflow-hidden p-5">
        <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-emerald-500/10 blur-[80px]" />
        <div className="absolute -right-20 -bottom-20 h-40 w-40 rounded-full bg-emerald-500/10 blur-[80px]" />
        <div className="relative flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-emerald-500">
            <CheckCircle2 className="h-4 w-4" />
            Position Matured
          </div>
          <p className="text-xs text-vault-muted">
            This position became eligible on {formatDateSafe(maturityDate)}.
          </p>
          <p className="text-xs font-medium text-emerald-500">
            Withdrawal is now available.
          </p>
        </div>
      </div>
    );
  }

  if (!timeLeft) return null;

  return (
    <div className="vq-glass relative overflow-hidden p-5">
      <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-red-500/10 blur-[80px]" />
      <div className="absolute -right-20 -bottom-20 h-40 w-40 rounded-full bg-red-500/10 blur-[80px]" />

      <div className="relative flex flex-col items-center gap-4">
        {positionLabel && (
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            {positionLabel}
          </p>
        )}

        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-red-500">
          <Clock className="h-4 w-4 animate-pulse" />
          {timeLeft.isComplete ? "Maturity Reached" : "Position Matures In"}
        </div>

        <div className="flex items-end justify-center gap-2 sm:gap-4">
          <TimerSegment value={timeLeft.days} label="Days" />
          <Separator />
          <TimerSegment value={timeLeft.hours} label="Hrs" />
          <Separator />
          <TimerSegment value={timeLeft.minutes} label="Min" />
          <Separator />
          <TimerSegment value={timeLeft.seconds} label="Sec" />
        </div>

        <p className="text-[11px] text-vault-muted">
          Matures {formatDateSafe(maturityDate, { hour: undefined, minute: undefined, timeZoneName: undefined })}
        </p>
      </div>
    </div>
  );
}

function Separator() {
  return (
    <div className="mb-4 text-xl font-light text-vault-border sm:mb-6 sm:text-3xl">:</div>
  );
}

const TimerSegment = memo(function TimerSegment({ value, label }) {
  const prevValue = useRef(value);
  const [shouldAnimate, setShouldAnimate] = useState(false);

  useEffect(() => {
    if (prevValue.current !== value) {
      setShouldAnimate(true);
      const timer = setTimeout(() => setShouldAnimate(false), 150);
      prevValue.current = value;
      return () => clearTimeout(timer);
    }
  }, [value]);

  return (
    <div className="flex flex-col items-center min-w-[2.5rem] sm:min-w-[4rem]">
      <div
        className={`font-mono font-bold tabular-nums transition-all duration-150 ${
          shouldAnimate
            ? "scale-110 text-red-500 drop-shadow-[0_0_8px_rgba(220,38,38,0.3)]"
            : "scale-100 text-vault-text"
        } text-2xl sm:text-5xl`}
      >
        {value.toString().padStart(2, "0")}
      </div>
      <div className="mt-1 text-[8px] font-medium uppercase tracking-wider text-vault-muted sm:text-[10px]">
        {label}
      </div>
    </div>
  );
});
