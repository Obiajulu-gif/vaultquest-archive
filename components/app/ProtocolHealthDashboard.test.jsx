import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "../../tests/test-utils";
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

  it("keeps healthy cards visible when one service fails", () => {
    render(
      <ProtocolHealthDashboard
        healthData={{ ...healthyData, backend: { status: "unavailable", error: "backend down" } }}
      />
    );

    expect(screen.getByTestId("card-rpc")).toBeInTheDocument();
    expect(screen.getByTestId("card-indexer")).toBeInTheDocument();
    expect(screen.getByTestId("backend-error")).toHaveTextContent("backend down");
  });

  it("shows each service failure instead of an endless loading state", () => {
    const failed = {
      rpc: { status: "unavailable", error: "rpc down" },
      backend: { status: "unavailable", error: "api down" },
      indexer: { status: "unavailable", error: "indexer down" },
      contracts: { status: "unavailable", error: "contracts down" },
    };

    render(<ProtocolHealthDashboard healthData={failed} />);

    expect(screen.getAllByTestId("status-unavailable")).toHaveLength(4);
    expect(screen.getByTestId("rpc-error")).toHaveTextContent("rpc down");
    expect(screen.getByTestId("contracts-error")).toHaveTextContent("contracts down");
  });

  it("always clears the refresh state when a slow refresh rejects", async () => {
    const onRefresh = vi.fn(() => Promise.reject(new Error("timeout")));
    render(<ProtocolHealthDashboard healthData={healthyData} onRefresh={onRefresh} />);

    const refresh = screen.getByTestId("refresh-health-btn");
    fireEvent.click(refresh);
    expect(refresh).toBeDisabled();
    await waitFor(() => expect(refresh).toBeEnabled());
  });

  it("degrades gracefully when a response has malformed service data", () => {
    expect(() =>
      render(<ProtocolHealthDashboard healthData={{ rpc: { status: "degraded" }, indexer: null }} />)
    ).not.toThrow();
    expect(screen.getByTestId("card-rpc")).toBeInTheDocument();
    expect(screen.getByTestId("card-indexer")).toBeInTheDocument();
  });
});
