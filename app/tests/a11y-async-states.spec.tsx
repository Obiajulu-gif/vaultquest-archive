/**
 * Accessibility coverage for keyboard, focus, and async status states (#969).
 *
 * Verifies:
 * - Normal path: keyboard navigation, focus trap, focus restoration, async busy state, success state
 * - Failure path: input validation alert, async operation failure alert, error linking (aria-invalid/aria-describedby)
 * - Retry path: keyboard retry activation, re-broadcasting without state loss, focus retention
 * - Authorization path: wallet disconnected state, disabled actions, accessible connect trigger
 * - Reduced motion: spinners and animations respect prefers-reduced-motion
 * - Conflict resolution UI: accessible alerts and busy states during state resolution
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DepositModal from "@/components/app/DepositModal";
import {
  ConflictResolutionUI,
  ConflictBanner,
} from "@/lib/useConflictAwareOperation";
import type { ConflictError } from "@/lib/concurrencyControl";
import { VAULT_REJECTION_REASONS } from "@/lib/rejectionReasons";

function setReducedMotion(on: boolean) {
  (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (query: string) => ({
      matches: on && query.includes("prefers-reduced-motion: reduce"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
}

afterEach(() => setReducedMotion(false));

describe("DepositModal - Keyboard & Focus Management (#969)", () => {
  it("has dialog role, aria-modal, and aria-labelledby pointing to title", () => {
    render(<DepositModal isOpen={true} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "deposit-modal-title");
    expect(screen.getByRole("heading", { name: /review gas before signing/i })).toHaveAttribute(
      "id",
      "deposit-modal-title",
    );
  });

  it("traps focus inside the modal with Tab and Shift+Tab", async () => {
    const user = userEvent.setup();
    render(<DepositModal isOpen={true} onClose={vi.fn()} />);

    const closeBtn = screen.getByRole("button", { name: /close deposit modal/i });
    const confirmBtn = screen.getByRole("button", { name: /confirm deposit/i });

    // Focus close button (first interactive element)
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);

    // Shift+Tab from first element should wrap to last focusable (confirm deposit button)
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(confirmBtn);

    // Tab from last element should wrap back to first element (close button)
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(closeBtn);
  });

  it("closes modal on Escape key press", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DepositModal isOpen={true} onClose={onClose} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to trigger element when closed", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open Deposit";
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(<DepositModal isOpen={true} onClose={vi.fn()} />);
    expect(document.activeElement).not.toBe(trigger);

    rerender(<DepositModal isOpen={false} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
  });

  it("shifts focus to heading when step changes", async () => {
    const user = userEvent.setup();
    render(<DepositModal isOpen={true} onClose={vi.fn()} initialAmount="50" />);

    const confirmBtn = screen.getByRole("button", { name: /confirm deposit/i });
    await user.click(confirmBtn);

    const stepHeading = screen.getByRole("heading", { name: /confirm transaction/i });
    expect(document.activeElement).toBe(stepHeading);
  });
});

describe("DepositModal - Async Status States (#969)", () => {
  it("normal path: exposes aria-busy and live region during broadcasting, then confirmed success", async () => {
    const user = userEvent.setup();
    let resolveDeposit!: () => void;
    const depositPromise = new Promise<void>((res) => {
      resolveDeposit = res;
    });

    render(
      <DepositModal
        isOpen={true}
        onClose={vi.fn()}
        initialAmount="100"
        onDeposit={vi.fn().mockImplementation(() => depositPromise)}
      />,
    );

    // Step 1: Input -> Confirm
    await user.click(screen.getByRole("button", { name: /confirm deposit/i }));

    // Step 2: Confirm -> Loading (Async broadcasting)
    await user.click(screen.getByRole("button", { name: /sign & submit/i }));

    // Status region during loading
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toHaveAttribute("aria-busy", "true");
    expect(statusRegion).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(/processing deposit/i)).toBeInTheDocument();
    expect(screen.getByText(/broadcasting to the network/i)).toBeInTheDocument();

    // Escape should NOT close modal while loading
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Step 3: Complete async action
    await act(async () => {
      resolveDeposit();
    });

    // Success state is exposed in status live region
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /deposit successful!/i })).toBeInTheDocument();
    });
    const successRegion = screen.getByRole("status");
    expect(successRegion).not.toHaveAttribute("aria-busy", "true");
    expect(successRegion).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(/100 USDC/i)).toBeInTheDocument();
  });

  it("failure path: announces validation errors with role='alert' and aria-invalid", async () => {
    const user = userEvent.setup();
    render(<DepositModal isOpen={true} onClose={vi.fn()} initialAmount="0" />);

    const amountInput = screen.getByLabelText(/deposit amount/i);
    expect(amountInput).toHaveAttribute("aria-invalid", "false");

    const confirmBtn = screen.getByRole("button", { name: /confirm deposit/i });
    await user.click(confirmBtn);

    expect(amountInput).toHaveAttribute("aria-invalid", "true");
    expect(amountInput).toHaveAttribute("aria-describedby", "deposit-amount-error");

    const errorAlert = screen.getByText(/please enter a valid deposit amount/i);
    expect(errorAlert).toHaveAttribute("role", "alert");
    expect(errorAlert).toHaveAttribute("aria-live", "assertive");
  });

  it("failure & retry path: announces execution failure with role='alert' and allows keyboard retry", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const onDeposit = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("Transaction rejected by wallet signer.");
      }
    });

    render(
      <DepositModal
        isOpen={true}
        onClose={vi.fn()}
        initialAmount="75"
        onDeposit={onDeposit}
      />,
    );

    // Proceed to sign
    await user.click(screen.getByRole("button", { name: /confirm deposit/i }));
    await user.click(screen.getByRole("button", { name: /sign & submit/i }));

    // Async failure enters error state
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    const failureAlert = screen.getByRole("alert");
    expect(failureAlert).toHaveAttribute("aria-live", "assertive");
    expect(failureAlert).toHaveTextContent(/transaction rejected by wallet signer/i);
    expect(screen.getByText(/your entered amount \(75 usdc\) was preserved/i)).toBeInTheDocument();

    // Retry button is keyboard accessible and clearly labelled
    const retryBtn = screen.getByRole("button", { name: /retry deposit of 75 usdc/i });
    expect(retryBtn).toBeInTheDocument();

    // Activate retry via keyboard
    retryBtn.focus();
    await user.keyboard("{Enter}");

    // Succeeded on retry
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /deposit successful!/i })).toBeInTheDocument();
    });
    expect(attempts).toBe(2);
  });

  it("authorization path: warns when wallet is disconnected and provides accessible connect action", async () => {
    const user = userEvent.setup();
    const onConnectWallet = vi.fn();

    render(
      <DepositModal
        isOpen={true}
        onClose={vi.fn()}
        isConnected={false}
        onConnectWallet={onConnectWallet}
      />,
    );

    // Shows authorization alert
    const authAlert = screen.getByText(/wallet connection required to deposit/i).closest('[role="alert"]');
    expect(authAlert).toBeInTheDocument();
    expect(authAlert).toHaveTextContent(/wallet connection required to deposit/i);

    // Connect wallet button is accessible
    const connectBtn = screen.getByRole("button", { name: /connect wallet to continue/i });
    expect(connectBtn).toBeInTheDocument();
    await user.click(connectBtn);
    expect(onConnectWallet).toHaveBeenCalledTimes(1);

    // Confirm button is marked aria-disabled
    const confirmBtn = screen.getByRole("button", { name: /confirm deposit/i });
    expect(confirmBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("reduced motion: suppresses spinner animation when prefers-reduced-motion is active", async () => {
    setReducedMotion(true);
    const user = userEvent.setup();

    render(
      <DepositModal
        isOpen={true}
        onClose={vi.fn()}
        initialAmount="50"
        onDeposit={vi.fn().mockImplementation(() => new Promise(() => {}))}
      />,
    );

    await user.click(screen.getByRole("button", { name: /confirm deposit/i }));
    await user.click(screen.getByRole("button", { name: /sign & submit/i }));

    const statusRegion = screen.getByRole("status");
    const spinner = statusRegion.querySelector("svg");
    expect(spinner).not.toHaveClass("animate-spin");
  });
});

describe("ConflictResolutionUI - Accessibility & Busy States (#969)", () => {
  const mockConflict: ConflictError = {
    reasonCode: VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION,
    userMessage: "Item was modified by another operation.",
    recoveryHint: "Refresh to fetch the latest state.",
    expectedVersion: { entityId: "pool-1", entityType: "saved_pool", version: 10 },
    actualVersion: { entityId: "pool-1", entityType: "saved_pool", version: 11 },
    retryable: true,
  };

  it("renders with role='alert', aria-live='polite', and indicates aria-busy during resolution", () => {
    const { rerender } = render(
      <ConflictResolutionUI
        conflict={mockConflict}
        onResolve={vi.fn()}
        onDismiss={vi.fn()}
        isResolving={false}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "polite");
    expect(alert).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("button", { name: /refresh data to latest version/i })).toBeInTheDocument();

    rerender(
      <ConflictResolutionUI
        conflict={mockConflict}
        onResolve={vi.fn()}
        onDismiss={vi.fn()}
        isResolving={true}
      />,
    );

    expect(alert).toHaveAttribute("aria-busy", "true");
    const busyBtn = screen.getByRole("button", { name: /refreshing data, please wait/i });
    expect(busyBtn).toBeDisabled();
    expect(busyBtn).toHaveAttribute("aria-busy", "true");
  });

  it("ConflictBanner exposes role='alert' and accessible action names", () => {
    render(
      <ConflictBanner
        conflict={mockConflict}
        onResolve={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh data to latest version/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss conflict alert/i })).toBeInTheDocument();
  });
});
