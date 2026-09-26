import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingChecklist, ONBOARDING_STORAGE_KEY } from "./OnboardingChecklist";

function stepListItem(title: string) {
  return screen.getByText(title).closest("li")!;
}

// jsdom's own `localStorage` global is unavailable under this project's
// current Node/vitest combination ("localStorage is not available because
// --localstorage-file was not provided" — a real, pre-existing environment
// gap; see also the 4 pre-existing failures in txStateMachine.test.tsx that
// hit the exact same root cause). Rather than touch the shared
// tests/setup.ts (out of scope for #628, and other suites may depend on its
// current behavior), this file provides its own minimal, in-memory
// polyfill so its tests — including the "persists separately from protocol
// state" acceptance criterion, which specifically exercises localStorage —
// can actually run.
function installLocalStorageStub() {
  let store: Record<string, string> = {};
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = String(value);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    },
  });
}

describe("OnboardingChecklist", () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  describe("new, disconnected user", () => {
    it("shows connect-wallet and correct-network as incomplete, and reports 0 of 5 steps complete", () => {
      render(<OnboardingChecklist walletConnected={false} networkSupported={false} hasDeposited={false} />);

      expect(screen.getByText("0 of 5 steps complete")).toBeInTheDocument();
      expect(within(stepListItem("Connect a Stellar wallet")).queryByText(/complete/i)).not.toBeInTheDocument();
    });
  });

  describe("connected, funded, deposited user (#628 — driven by real state, not booleans)", () => {
    it("marks connect-wallet, correct-network, and all deposit-gated steps complete", () => {
      render(<OnboardingChecklist walletConnected={true} networkSupported={true} hasDeposited={true} />);

      expect(screen.getByText("5 of 5 steps complete")).toBeInTheDocument();
      expect(screen.getByText(/All steps complete/i)).toBeInTheDocument();
    });
  });

  describe("network mismatch blocks progress with clear guidance (#628 acceptance criterion)", () => {
    it("does NOT mark correct-network complete just because a wallet is connected on the wrong chain", () => {
      // This is the exact regression #628 was filed against: the old
      // isStepDone conflated "connect-wallet" and "correct-network" onto
      // the same walletConnected boolean, so a wallet on an unsupported
      // chain still showed "Use the supported network" as done.
      render(<OnboardingChecklist walletConnected={true} networkSupported={false} hasDeposited={false} />);

      expect(screen.getByText("1 of 5 steps complete")).toBeInTheDocument();
    });

    it("shows an alert explaining the network mismatch when connected to an unsupported network", () => {
      render(<OnboardingChecklist walletConnected={true} networkSupported={false} hasDeposited={false} />);

      expect(screen.getByRole("alert")).toHaveTextContent(/unsupported network/i);
    });

    it("does not show the network-mismatch alert when no wallet is connected at all", () => {
      render(<OnboardingChecklist walletConnected={false} networkSupported={false} hasDeposited={false} />);

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("does not show the network-mismatch alert once on a supported network", () => {
      render(<OnboardingChecklist walletConnected={true} networkSupported={true} hasDeposited={false} />);

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("labels vault steps as network-blocked with specific guidance while on an unsupported network", () => {
      render(<OnboardingChecklist walletConnected={true} networkSupported={false} hasDeposited={false} />);

      expect(within(stepListItem("Choose a vault")).getByText(/Switch to a supported network first\./i)).toBeInTheDocument();
    });
  });

  describe("hasDeposited (real deposit state) vs. deprecated hasJoinedVault", () => {
    it("treats hasDeposited=false as not-deposited even for a connected, correctly-networked wallet", () => {
      render(<OnboardingChecklist walletConnected={true} networkSupported={true} hasDeposited={false} />);

      expect(screen.getByText("2 of 5 steps complete")).toBeInTheDocument();
    });

    it("falls back to the deprecated hasJoinedVault prop when hasDeposited is not provided", () => {
      render(<OnboardingChecklist walletConnected={true} networkSupported={true} hasJoinedVault={true} />);

      expect(screen.getByText("5 of 5 steps complete")).toBeInTheDocument();
    });

    it("prefers hasDeposited over hasJoinedVault when both are provided", () => {
      render(<OnboardingChecklist walletConnected={true} networkSupported={true} hasDeposited={false} hasJoinedVault={true} />);

      expect(screen.getByText("2 of 5 steps complete")).toBeInTheDocument();
    });
  });

  describe("disconnected user (no wallet at all)", () => {
    it("does not treat a disconnected wallet with hasDeposited=true as network-blocked", () => {
      // hasDeposited alone (e.g. a stale cache) should never fabricate
      // progress on connect-wallet/correct-network — those are gated on
      // walletConnected regardless of deposit history.
      render(<OnboardingChecklist walletConnected={false} networkSupported={false} hasDeposited={true} />);

      expect(screen.getByText("3 of 5 steps complete")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("renders a skeleton and no step content while loading", () => {
      render(<OnboardingChecklist loading={true} />);

      expect(screen.queryByText(/steps complete/)).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "First-time wallet checklist" })).not.toBeInTheDocument();
    });
  });

  describe("dismissal persists separately from protocol state (#628 acceptance criterion)", () => {
    it("collapses to a pill button after dismissal, independent of wallet/vault state", async () => {
      const user = userEvent.setup();
      render(<OnboardingChecklist walletConnected={true} networkSupported={true} hasDeposited={false} />);

      await user.click(screen.getByRole("button", { name: "Got it" }));

      expect(screen.getByRole("button", { name: /Onboarding checklist/i })).toBeInTheDocument();
      expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("true");
    });

    it("remains dismissed across a remount, and reopens on request without losing wallet/vault state", async () => {
      const user = userEvent.setup();
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");

      render(<OnboardingChecklist walletConnected={true} networkSupported={true} hasDeposited={true} />);
      expect(screen.getByRole("button", { name: /Onboarding checklist/i })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /Onboarding checklist/i }));

      expect(screen.getByText("5 of 5 steps complete")).toBeInTheDocument();
      expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("false");
    });
  });
});
