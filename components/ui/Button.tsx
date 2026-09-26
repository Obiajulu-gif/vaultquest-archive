"use client";

import { type ButtonHTMLAttributes, type ReactNode } from "react";
import Spinner from "./Spinner";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  isLoading?: boolean;
  variant?: "primary" | "ghost";
  children: ReactNode;
}

export default function Button({
  isLoading = false,
  variant = "primary",
  children,
  disabled,
  className = "",
  ...props
}: ButtonProps) {
  const base =
    variant === "primary"
      ? "vq-btn-primary"
      : "vq-btn-ghost";

  return (
    <button
      disabled={disabled || isLoading}
      className={`${base} relative ${className}`}
      {...props}
    >
      {isLoading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size={18} />
        </span>
      )}
      <span className={isLoading ? "invisible" : ""}>{children}</span>
    </button>
  );
}
