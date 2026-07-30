"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { Shield, Activity } from "lucide-react";
import IndexerReplayControl from "@/components/app/IndexerReplayControl";
import PoolApprovalQueue from "@/components/app/PoolApprovalQueue";
import { ADMIN_ADDRESSES } from "../admin-config";

export default function AdminOperationsPage() {
  const { address, isConnected } = useAccount();
  const [isMockConnected, setIsMockConnected] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("mockConnected") === "true") {
        setIsMockConnected(true);
      }
    }
  }, []);

  const isAdmin =
    (isConnected &&
      ADMIN_ADDRESSES.some(
        (addr) => addr.toLowerCase() === address?.toLowerCase(),
      )) ||
    isMockConnected;

  return (
    <div className="space-y-8">
      <header>
        <div className="flex items-center gap-2">
          <Activity className="h-8 w-8 text-vault-accent" aria-hidden="true" />
          <h1 className="text-3xl font-bold text-vault-text">
            Operations Control
          </h1>
        </div>
        <p className="mt-2 text-vault-muted">
          Maintainer tools for pool approval and indexer management
        </p>
      </header>

      {!isConnected && !isMockConnected ? (
        <div className="vq-glass flex flex-col items-center px-6 py-16 text-center">
          <Shield className="h-16 w-16 text-vault-muted" aria-hidden="true" />
          <h2 className="mt-6 text-xl font-semibold text-vault-text">
            Wallet Not Connected
          </h2>
          <p className="mt-2 max-w-md text-sm text-vault-muted">
            Connect your wallet to access admin operations.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <PoolApprovalQueue isAdmin={isAdmin} />
          <IndexerReplayControl isAuthorized={isAdmin} />
        </div>
      )}
    </div>
  );
}
