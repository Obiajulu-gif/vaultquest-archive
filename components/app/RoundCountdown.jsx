"use client";

import { useEffect, useState, useRef, memo } from "react";
import { Timer, CheckCircle2, Clock, AlertTriangle } from "lucide-react";

export default function RoundCountdown({ startDate, endDate, label = "Round" }) {
  const [timeLeft, setTimeLeft] = useState(null);
  const requestRef = useRef();

  const getStatus = (start, end, diff) => {
    const now = Date.now();
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();

    if (!start || !end || isNaN(startMs) || isNaN(endMs)) return "invalid";
    if (now < startMs) return "upcoming";
    if (now >= startMs && now <= endMs) return "active";
    return "ended";
  };

  const calculateTimeLeft = (end) => {
    const diff = new Date(end).getTime() - Date.now();
    if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, ms: 0, isComplete: true };
    return {
      days: Math.floor(diff / (1000 * 60 * 60 * 24)),
      hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
      minutes: Math.floor((diff / (1000 * 60)) % 60),
      seconds: Math.floor((diff / 1000) % 60),
      ms: Math.floor((diff % 1000) / 10),
      isComplete: false
    };
  };

  useEffect(() => {
    const update = () => {
      const remaining = calculateTimeLeft(endDate);
      setTimeLeft(remaining);
      if (!remaining.isComplete) {
        requestRef.current = requestAnimationFrame(update);
      }
    };
    requestRef.current = requestAnimationFrame(update);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [endDate]);

  const status = getStatus(startDate, endDate, timeLeft?.isComplete);

  if (!startDate || !endDate) {
    return (
      <div className="vq-glass relative overflow-hidden p-6 sm:p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <p className="text-sm text-vault-muted">Round date information is not available.</p>
        </div>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div className="vq-glass relative overflow-hidden p-6 sm:p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <p className="text-sm text-vault-muted">Invalid round dates. Please check the configuration.</p>
        </div>
      </div>
    );
  }

  if (status === "upcoming") {
    const startsIn = calculateTimeLeft(startDate);
    return (
      <div className="vq-glass relative overflow-hidden p-6 sm:p-8">
        <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-blue-500/10 blur-[80px]" />
        <div className="relative flex flex-col items-center gap-4">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-blue-500">
            <Clock className="h-4 w-4" />
            {label} Starts In
          </div>
          <div className="flex items-end justify-center gap-2 sm:gap-6">
            <TimerSegment value={startsIn.days} label="Days" />
            <div className="mb-6 text-2xl font-light text-vault-border sm:mb-8 sm:text-4xl">:</div>
            <TimerSegment value={startsIn.hours} label="Hours" />
            <div className="mb-6 text-2xl font-light text-vault-border sm:mb-8 sm:text-4xl">:</div>
            <TimerSegment value={startsIn.minutes} label="Mins" />
          </div>
          <div className="text-xs text-vault-muted">
            Ends {new Date(endDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </div>
        </div>
      </div>
    );
  }

  if (status === "ended") {
    return (
      <div className="vq-glass relative overflow-hidden p-6 sm:p-8">
        <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-slate-500/10 blur-[80px]" />
        <div className="relative flex flex-col items-center gap-4">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-vault-muted">
            <CheckCircle2 className="h-4 w-4" />
            {label} Ended
          </div>
          <p className="text-sm text-vault-muted">
            This round ended on {new Date(endDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
      </div>
    );
  }

  if (!timeLeft) return null;

  const borderColor = timeLeft.isComplete ? "text-emerald-500" : "text-red-500";
  const bgColor = timeLeft.isComplete ? "bg-emerald-500/10" : "bg-red-500/10";

  return (
    <div className="vq-glass relative overflow-hidden p-6 sm:p-8">
      <div className={`absolute -left-20 -top-20 h-40 w-40 rounded-full ${bgColor} blur-[80px]`} />
      <div className={`absolute -right-20 -bottom-20 h-40 w-40 rounded-full ${bgColor} blur-[80px]`} />

      <div className="relative flex flex-col items-center gap-6">
        <div className={`flex items-center gap-2 text-sm font-semibold uppercase tracking-widest ${borderColor}`}>
          {timeLeft?.isComplete ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <Timer className="h-4 w-4 animate-pulse" />
          )}
          {timeLeft?.isComplete ? `${label} Complete` : `${label} Ends In`}
        </div>

        <div className="flex items-end justify-center gap-2 sm:gap-6">
          <TimerSegment value={timeLeft.days} label="Days" />
          <div className="mb-6 text-2xl font-light text-vault-border sm:mb-8 sm:text-4xl">:</div>
          <TimerSegment value={timeLeft.hours} label="Hours" />
          <div className="mb-6 text-2xl font-light text-vault-border sm:mb-8 sm:text-4xl">:</div>
          <TimerSegment value={timeLeft.minutes} label="Mins" />
          <div className="mb-6 text-2xl font-light text-vault-border sm:mb-8 sm:text-4xl">:</div>
          <TimerSegment value={timeLeft.seconds} label="Secs" />
        </div>

        <div className="flex items-center gap-4 text-xs text-vault-muted">
          <span>Started {new Date(startDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          <span className="text-vault-border">|</span>
          <span>Ends {new Date(endDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
        </div>
      </div>
    </div>
  );
}

const TimerSegment = memo(function TimerSegment({ value, label, animate = true, small = false }) {
  const prevValue = useRef(value);
  const [shouldAnimate, setShouldAnimate] = useState(false);

  useEffect(() => {
    if (animate && prevValue.current !== value) {
      setShouldAnimate(true);
      const timer = setTimeout(() => setShouldAnimate(false), 150);
      prevValue.current = value;
      return () => clearTimeout(timer);
    }
  }, [value, animate]);

  return (
    <div className="flex flex-col items-center min-w-[3rem] sm:min-w-[4.5rem]">
      <div
        className={`font-mono font-bold tabular-nums transition-all duration-150 ${
          shouldAnimate
            ? "scale-110 text-red-500 drop-shadow-[0_0_8px_rgba(220,38,38,0.3)]"
            : "scale-100 text-vault-text"
        } ${small ? "text-xl sm:text-3xl" : "text-4xl sm:text-6xl"}`}
      >
        {value.toString().padStart(2, "0")}
      </div>
      <div className={`mt-1 font-medium uppercase tracking-wider text-vault-muted ${small ? "text-[8px]" : "text-[10px]"}`}>
        {label}
      </div>
    </div>
  );
});
