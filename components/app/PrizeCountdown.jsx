"use client";

import { useEffect, useState, useRef, memo } from "react";
import { Timer, CheckCircle2 } from "lucide-react";

/**
 * PrizeCountdown Component
 * 
 * Displays a high-precision countdown to the next prize draw.
 * Uses requestAnimationFrame for millisecond accuracy and smooth animations.
 * 
 * @param {Object} props
 * @param {Date|string} props.targetDate - The ISO date string or Date object for the next draw.
 */
export default function PrizeCountdown({ targetDate }) {
  const [timeLeft, setTimeLeft] = useState(null);
  const requestRef = useRef();

  const calculateTimeLeft = (target) => {
    const diff = new Date(target).getTime() - Date.now();
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
      const remaining = calculateTimeLeft(targetDate);
      setTimeLeft(remaining);
      
      if (!remaining.isComplete) {
        requestRef.current = requestAnimationFrame(update);
      }
    };

    requestRef.current = requestAnimationFrame(update);
    
    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
    };
  }, [targetDate]);

  if (!timeLeft) return null;

  return (
    <div className="vq-glass relative overflow-hidden p-4 xs:p-6 sm:p-8">
      {/* Background Decorative Glows */}
      <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-red-500/10 blur-[80px]" />
      <div className="absolute -right-20 -bottom-20 h-40 w-40 rounded-full bg-red-500/10 blur-[80px]" />

      <div className="relative flex flex-col items-center gap-4 sm:gap-6">
        <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold uppercase tracking-widest text-red-500">
          {timeLeft.isComplete ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <Timer className="h-4 w-4 animate-pulse" />
          )}
          {timeLeft.isComplete ? "Draw in Progress" : "Next Prize Draw In"}
        </div>

        <div className="flex items-end justify-center gap-1.5 xs:gap-3 sm:gap-6">
          <TimerSegment value={timeLeft.days} label="Days" />
          <div className="mb-4 text-xl font-light text-vault-border xs:text-2xl sm:mb-8 sm:text-4xl">:</div>
          <TimerSegment value={timeLeft.hours} label="Hours" />
          <div className="mb-4 text-xl font-light text-vault-border xs:text-2xl sm:mb-8 sm:text-4xl">:</div>
          <TimerSegment value={timeLeft.minutes} label="Mins" />
          <div className="mb-4 text-xl font-light text-vault-border xs:text-2xl sm:mb-8 sm:text-4xl">:</div>
          <TimerSegment value={timeLeft.seconds} label="Secs" />
          <div className="mb-3 text-lg font-light text-red-400/60 xs:text-xl sm:mb-6 sm:text-2xl">.</div>
          <div className="w-8 text-left xs:w-10 sm:w-16">
            <TimerSegment value={timeLeft.ms} label="MS" animate={false} small />
          </div>
        </div>

        {timeLeft.isComplete && (
          <div className="animate-in fade-in slide-in-from-top-2 text-xs sm:text-sm text-vault-muted duration-700">
            Hold tight! We&apos;re picking the lucky winners right now.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * TimerSegment Component
 * 
 * Individual time unit display with scale animation on change.
 */
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
    <div className={`flex flex-col items-center ${small ? "min-w-[1.5rem] xs:min-w-[2rem] sm:min-w-[3rem]" : "min-w-[2.2rem] xs:min-w-[3rem] sm:min-w-[4.5rem]"}`}>
      <div
        className={`font-mono font-bold tabular-nums transition-all duration-150 ${
          shouldAnimate 
            ? "scale-110 text-red-500 drop-shadow-[0_0_8px_rgba(220,38,38,0.3)]" 
            : "scale-100 text-vault-text"
        } ${small ? "text-lg xs:text-xl sm:text-3xl" : "text-2xl xs:text-4xl sm:text-6xl"}`}
      >
        {value.toString().padStart(2, "0")}
      </div>
      <div className={`mt-1 font-medium uppercase tracking-wider text-vault-muted ${small ? "text-[6px] xs:text-[8px]" : "text-[8px] xs:text-[10px]"}`}>
        {label}
      </div>
    </div>
  );
});
