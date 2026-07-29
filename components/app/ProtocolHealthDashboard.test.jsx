import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../../tests/test-utils";
import ProtocolHealthDashboard from "./ProtocolHealthDashboard";

describe("ProtocolHealthDashboard", () => {
  const healthyData = {
    rpc: { status: "healthy", endpoint: "https://horizon.stellar.org", latencyMs: 50, error: null },
    backend: { status: "healthy", uptime: "99.9%", environment: "production", error: null },
    indexer: { status: "healthy", latestLedger: 1234567, syncLagLedgers: 2, error: null },
    contracts: { status: "healthy", dripPool: "CDRIPPOOL123", availability: "100%", error: null },
  };

  it("renders all four service layers and health indicators", () => {
    render(<ProtocolHealthDashboard healthData={healthyData} />);

    expect(screen.getByTestId("card-rpc")).toBeInTheDocument();
    expect(screen.getByTestId("card-backend")).toBeInTheDocument();
    expect(screen.getByTestId("card-indexer")).toBeInTheDocument();
    expect(screen.getByTestId("card-contracts")).toBeInTheDocument();
  });

  it("displays indexer lag and latest processed ledger clearly", () => {
    render(<ProtocolHealthDashboard healthData={healthyData} />);

    expect(screen.getByTestId("latest-ledger")).toHaveTextContent("1234567");
    expect(screen.getByTestId("indexer-lag")).toHaveTextContent("2 ledgers");
  });

  it("allows maintainers to identify a specific failing layer", () => {
    const degradedData = {
      ...healthyData,
      indexer: { status: "degraded", latestLedger: 1234500, syncLagLedgers: 15, error: "Indexer tick timeout" },
    };

    render(<ProtocolHealthDashboard healthData={degradedData} />);

    expect(screen.getByTestId("status-degraded")).toBeInTheDocument();
    expect(screen.getByTestId("indexer-error")).toHaveTextContent("Indexer tick timeout");
  });

  it("redacts sensitive information in endpoint and error outputs", () => {
    const secretData = {
      ...healthyData,
      rpc: {
        status: "unavailable",
        endpoint: "https://rpc.stellar.org?api-key=super_secret_token_12345",
        latencyMs: 0,
        error: "Failed auth token=super_secret_token_12345",
      },
    };

    render(<ProtocolHealthDashboard healthData={secretData} />);

    expect(screen.queryByText(/super_secret_token_12345/)).not.toBeInTheDocument();
    expect(screen.getByTestId("rpc-error")).toHaveTextContent("***REDACTED***");
  });
});
