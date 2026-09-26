"use client";

import Link from "next/link";
import { ArrowLeft, Plus } from "lucide-react";
import PoolCreationForm from "@/components/app/PoolCreationForm";

async function handleCreatePool(form) {
  // In production this would call the wallet signing flow and submit
  // the pool creation transaction to the Soroban contract.
  return new Promise((resolve) => setTimeout(resolve, 1500));
}

export default function CreatePoolPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/app/admin/settings"
          className="vq-btn-ghost h-10 w-10 p-0"
          aria-label="Back to admin settings"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-vault-muted">
            Admin action
          </p>
          <h1 className="text-2xl font-bold text-vault-text">Create new pool</h1>
        </div>
      </div>

      <PoolCreationForm onSubmit={handleCreatePool} />
    </div>
  );
}
