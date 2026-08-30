import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import React from "react";
import AdminSettingsPage from "../app/app/admin/settings/page";

// Mock next/link
vi.mock("next/link", () => {
  return {
    default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
  };
});

// Mock next-i18next
vi.mock("next-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Mock framer-motion
vi.mock("framer-motion", () => ({
  motion: {
    header: ({ children, ...props }: any) => <header {...props}>{children}</header>,
  },
}));

// Mock stellar-wallet-connect env/attestation
const mockGetFrontendEnv = vi.fn();
const mockGetManifestAttestation = vi.fn();
const mockAttestManifest = vi.fn();

vi.mock("@vaultquest/stellar-wallet-connect", () => {
  return {
    getFrontendEnv: () => mockGetFrontendEnv(),
    getManifestAttestation: () => mockGetManifestAttestation(),
    attestManifest: (env: any) => mockAttestManifest(env),
  };
});

describe("AdminSettingsPage Health Checks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetFrontendEnv.mockReturnValue({
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-mock.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CCONTRACT123",
    });
    mockGetManifestAttestation.mockReturnValue({
      verified: true,
      mismatches: [],
    });
    mockAttestManifest.mockReturnValue({
      verified: true,
      mismatches: [],
    });
  });

  it("renders healthy status for all services when check succeeds", async () => {
    // Mock successful fetch responses
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/health/indexer")) {
        return {
          ok: true,
          json: async () => ({ data: { status: "healthy", latest_ledger: 100, sync_lag: 0 } }),
        } as any;
      }
      if (url.includes("/health")) {
        return {
          ok: true,
          json: async () => ({ data: { uptime: 500 } }),
        } as any;
      }
      if (url.includes("https://horizon-mock.stellar.org/accounts/CCONTRACT123")) {
        return { status: 200 } as any;
      }
      if (url === "https://horizon-mock.stellar.org/") {
        return { ok: true } as any;
      }
      return { ok: false } as any;
    }));

    render(<AdminSettingsPage />);

    // Wait for checks to complete
    await waitFor(() => {
      expect(screen.getAllByText("Operational").length).toBe(4);
    });

    // Check specific details
    expect(screen.getByText(/Responding healthy/)).toBeInTheDocument();
    expect(screen.getByText(/Healthy. Latest ledger/)).toBeInTheDocument();
    expect(screen.getByText(/Responsive. Latency/)).toBeInTheDocument();
    expect(screen.getByText(/Contract verified on-chain/)).toBeInTheDocument();
  });

  it("renders degraded indexer with runbook link", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/health/indexer")) {
        return {
          ok: true,
          json: async () => ({ data: { status: "degraded", latest_ledger: 100, sync_lag: 8, last_error: "Lagging sequence" } }),
        } as any;
      }
      if (url.includes("/health")) {
        return { ok: true, json: async () => ({ data: { uptime: 500 } }) } as any;
      }
      if (url.includes("/accounts/")) {
        return { status: 200 } as any;
      }
      if (url.includes("https://horizon-mock.stellar.org/")) {
        return { ok: true } as any;
      }
      return { ok: false } as any;
    }));

    render(<AdminSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Degraded")).toBeInTheDocument();
    });

    expect(screen.getByText(/Degraded: Lagging sequence/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Indexer Operations Runbook/i })).toBeInTheDocument();
  });

  it("renders configuration drift warning when attestation fails", async () => {
    mockAttestManifest.mockReturnValue({
      verified: false,
      mismatches: [
        { field: "network.passphrase", manifestValue: "mainnet", envValue: "testnet" }
      ]
    });

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }) as any));

    render(<AdminSettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Deployment Mismatch Detected")).toBeInTheDocument();
    });

    expect(screen.getByText("network.passphrase")).toBeInTheDocument();
    expect(screen.getByText(/Expected "mainnet", Active "testnet"/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Read Deployment Provenance Documentation/i })).toBeInTheDocument();
  });
});

describe("AdminSettingsPage Parameter Simulation (#649)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetFrontendEnv.mockReturnValue({
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-mock.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CCONTRACT123",
    });
    mockAttestManifest.mockReturnValue({ verified: true, mismatches: [] });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }) as any));
  });

  it("renders the simulation and diff preview section", async () => {
    render(<AdminSettingsPage />);
    expect(screen.getByRole("combobox", { name: /^Parameter$/ })).toBeInTheDocument();
    expect(screen.getByText("Parameter simulation & diff preview")).toBeInTheDocument();
    expect(screen.getByText(/Propose a change above/)).toBeInTheDocument();
  });

  it("blocks a treasury fee below the 0.5 bp stringency and reports it in the diff", async () => {
    render(<AdminSettingsPage />);

    fireEvent.change(screen.getByRole("combobox", { name: /^Parameter$/ }), { target: { value: "treasuryFeeBps" } });
    fireEvent.change(screen.getByLabelText(/Proposed value/), { target: { value: "0.1" } });
    fireEvent.click(screen.getByText("Add to simulation"));

    await waitFor(() => {
      expect(screen.getByText("Blocked change")).toBeInTheDocument();
    });
    expect(screen.getAllByText(/0\.5 bp/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("High risk")).toBeInTheDocument();
  });

  it("honors the override toggle for a blocked change", async () => {
    render(<AdminSettingsPage />);

    fireEvent.change(screen.getByRole("combobox", { name: /^Parameter$/ }), { target: { value: "treasuryFeeBps" } });
    fireEvent.change(screen.getByLabelText(/Proposed value/), { target: { value: "0.1" } });
    fireEvent.click(screen.getByText("Add to simulation"));

    await waitFor(() => {
      expect(screen.getByText("Blocked change")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Allow override of blocked stringencies/));

    await waitFor(() => {
      expect(screen.getByText("Overridden")).toBeInTheDocument();
    });
    expect(screen.queryByText("Blocked change")).not.toBeInTheDocument();
  });
});
