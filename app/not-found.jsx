"use client";

import Link from "next/link";
import { Home } from "lucide-react";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="vq-glass max-w-lg px-8 py-12 sm:px-12 sm:py-16 relative overflow-hidden">
        {/* Decorative background glow */}
        <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-red-500/10 blur-3xl" />
        <div className="absolute -bottom-20 -left-20 h-40 w-40 rounded-full bg-amber-500/10 blur-3xl" />

        {/* Playful illustration */}
        <div className="mb-6 flex justify-center">
          <svg
            width="120"
            height="120"
            viewBox="0 0 120 120"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-glow"
            aria-hidden="true"
          >
            {/* Vault door */}
            <rect
              x="20"
              y="15"
              width="80"
              height="90"
              rx="12"
              className="stroke-red-500/60 dark:stroke-red-400/60"
              strokeWidth="3"
              fill="none"
            />
            {/* Door arc */}
            <path
              d="M20 35 Q60 5 100 35"
              className="stroke-red-500/60 dark:stroke-red-400/60"
              strokeWidth="3"
              fill="none"
            />
            {/* Lock */}
            <circle
              cx="60"
              cy="60"
              r="14"
              className="stroke-red-500 dark:stroke-red-400"
              strokeWidth="3"
              fill="none"
            />
            <circle
              cx="60"
              cy="60"
              r="6"
              className="fill-red-500/20 dark:fill-red-400/20"
            />
            {/* Question mark */}
            <text
              x="60"
              y="68"
              textAnchor="middle"
              className="fill-red-500 dark:fill-red-400"
              fontSize="28"
              fontWeight="bold"
              fontFamily="serif"
            >
              ?
            </text>
            {/* Keyhole */}
            <circle cx="60" cy="85" r="4" className="fill-red-500/40 dark:fill-red-400/40" />
          </svg>
        </div>

        <p className="text-sm font-medium uppercase tracking-widest text-vault-accent">
          404 &mdash; Not Found
        </p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-vault-text sm:text-5xl">
          Lost in the vault
        </h1>
        <p className="mx-auto mt-4 max-w-sm text-lg text-vault-muted">
          This page doesn&apos;t exist or was moved. Head back home to keep
          saving and winning.
        </p>
        <Link
          href="/"
          className="vq-btn-primary mt-8 inline-flex items-center gap-2 text-base"
        >
          <Home size={18} />
          Return to Home
        </Link>
      </div>
    </main>
  );
}
