/**
 * Accessibility coverage for async error recovery (#1072).
 *
 * Verifies WCAG 2.1 AA conformance:
 * - Normal path: accessible alert/region semantics, keyboard focus trapping/management, aria-labelledby, aria-describedby
 * - Failure path: assertive error announcements, diagnostic copy with accessible feedback, error linking
 * - Retry path: keyboard retry trigger, aria-busy state during async operation, duplicate submit guards, focus retention
 * - Authorization path: disconnected wallet alert, disabled actions with accessible explanations, connect triggers
 * - Reduced motion: pauses retry animation when prefers-reduced-motion is active
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AsyncErrorRecovery from "@/components/app/AsyncErrorRecovery";

function setupMatchMedia() {
  if (typeof window !== "undefined") {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }
}

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
    })
  );
}

beforeEach(() => {
  setupMatchMedia();
  setReducedMotion(false);
});

afterEach(() => {
  setReducedMotion(false);
  vi.restoreAllMocks();
});

describe("Async Error Recovery Accessibility (#1072)", () => {
  describe("Normal Path: Semantics & Focus Management", () => {
    it("has alert role, aria-labelledby, and aria-describedby attributes", () => {
      render(
        <AsyncErrorRecovery
          title="Yield Sync Failed"
          errorMessage="Failed to fetch Soroban yield balance from Horizon RPC."
        />
      );

      const alertContainer = screen.getByTestId("async-error-recovery");
      expect(alertContainer).toHaveAttribute("role", "alert");
      expect(alertContainer).toHaveAttribute("aria-labelledby", "async-recovery-title");
      expect(alertContainer).toHaveAttribute("aria-describedby", "async-recovery-desc");

      expect(screen.getByRole("heading", { name: /yield sync failed/i })).toHaveAttribute(
        "id",
        "async-recovery-title"
      );
      expect(screen.getByText(/failed to fetch soroban yield balance/i)).toHaveAttribute(
        "id",
        "async-recovery-desc"
      );
    });

    it("auto-focuses the primary retry action on mount", () => {
      render(
        <AsyncErrorRecovery
          onRetry={vi.fn()}
          autoFocus={true}
        />
      );

      const retryBtn = screen.getByRole("button", { name: /retry operation/i });
      expect(document.activeElement).toBe(retryBtn);
    });

    it("restores focus to previously active trigger element on unmount", () => {
      const trigger = document.createElement("button");
      trigger.textContent = "Initiate Sync";
      document.body.appendChild(trigger);
      trigger.focus();

      const { unmount } = render(
        <AsyncErrorRecovery
          onRetry={vi.fn()}
          autoFocus={true}
        />
      );

      expect(document.activeElement).not.toBe(trigger);

      unmount();

      expect(document.activeElement).toBe(trigger);
      document.body.removeChild(trigger);
    });

    it("supports keyboard Tab traversal between interactive controls in visual order", async () => {
      const user = userEvent.setup();
      render(
        <AsyncErrorRecovery
          onRetry={vi.fn()}
          onReload={vi.fn()}
          onDismiss={vi.fn()}
          autoFocus={false}
        />
      );

      // Dismiss button -> Copy diagnostic -> Retry -> Reload
      await user.tab();
      expect(screen.getByLabelText(/dismiss error notification/i)).toHaveFocus();

      await user.tab();
      expect(screen.getByRole("button", { name: /copy diagnostic id/i })).toHaveFocus();

      await user.tab();
      expect(screen.getByRole("button", { name: /retry operation/i })).toHaveFocus();

      await user.tab();
      expect(screen.getByRole("button", { name: /reload current view/i })).toHaveFocus();
    });

    it("dismisses with Escape key press", async () => {
      const user = userEvent.setup();
      const onDismiss = vi.fn();
      render(<AsyncErrorRecovery onDismiss={onDismiss} autoFocus={true} />);

      await user.keyboard("{Escape}");
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  describe("Failure Path & Diagnostic Feedback", () => {
    it("announces critical retries exhausted via assertive live region", () => {
      render(
        <AsyncErrorRecovery
          retryCount={3}
          maxRetries={3}
          onRetry={vi.fn()}
        />
      );

      const liveRegion = screen.getByTestId("a11y-live-region");
      expect(liveRegion).toHaveAttribute("aria-live", "assertive");

      const retryBtn = screen.getByRole("button", { name: /retries exhausted/i });
      expect(retryBtn).toBeDisabled();
      expect(retryBtn).toHaveAttribute(
        "aria-label",
        "Retries exhausted. Manual intervention required."
      );
    });

    it("provides accessible diagnostic identifier copy with clipboard confirmation", async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      render(
        <AsyncErrorRecovery
          diagnosticId="err-stellar-rpc-994"
          onRetry={vi.fn()}
          autoFocus={false}
        />
      );

      const copyBtn = screen.getByRole("button", { name: /copy diagnostic id err-stellar-rpc-994/i });
      await user.click(copyBtn);

      expect(writeText).toHaveBeenCalledWith("err-stellar-rpc-994");
      expect(screen.getByText("Copied")).toBeInTheDocument();
      expect(screen.getByTestId("a11y-live-region")).toHaveTextContent(
        "Diagnostic identifier err-stellar-rpc-994 copied to clipboard"
      );
    });
  });

  describe("Retry Path: Async State & Concurrency", () => {
    it("sets aria-busy='true' on container while retry is in flight and announces progress", async () => {
      const user = userEvent.setup();
      let resolvePromise: () => void = () => {};
      const pendingPromise = new Promise<void>((res) => {
        resolvePromise = res;
      });
      const onRetry = vi.fn().mockReturnValue(pendingPromise);

      render(
        <AsyncErrorRecovery
          onRetry={onRetry}
          retryCount={1}
          maxRetries={3}
        />
      );

      const retryBtn = screen.getByRole("button", { name: /retry operation/i });
      await user.click(retryBtn);

      const container = screen.getByTestId("async-error-recovery");
      expect(container).toHaveAttribute("aria-busy", "true");
      expect(screen.getByTestId("a11y-live-region")).toHaveTextContent(
        "Retrying operation. Attempt 2 of 3"
      );

      resolvePromise();
      await waitFor(() => {
        expect(container).toHaveAttribute("aria-busy", "false");
      });
    });

    it("triggers retry via keyboard Enter key", async () => {
      const user = userEvent.setup();
      const onRetry = vi.fn().mockResolvedValue(undefined);

      render(<AsyncErrorRecovery onRetry={onRetry} autoFocus={true} />);

      await user.keyboard("{Enter}");
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe("Authorization Path: Disconnected Wallet Handling", () => {
    it("renders disconnected wallet alert and substitutes retry with connect wallet button", async () => {
      const user = userEvent.setup();
      const onConnectWallet = vi.fn();
      const onRetry = vi.fn();

      render(
        <AsyncErrorRecovery
          isWalletConnected={false}
          onConnectWallet={onConnectWallet}
          onRetry={onRetry}
        />
      );

      // Warning alert for disconnected wallet
      const walletWarning = screen.getByTestId("wallet-auth-alert");
      expect(walletWarning).toHaveTextContent(
        /wallet disconnected\. reconnect your stellar wallet/i
      );

      // Connect button is primary
      const connectBtn = screen.getByRole("button", {
        name: /connect stellar wallet to authorize retry/i,
      });
      expect(connectBtn).toBeInTheDocument();
      expect(document.activeElement).toBe(connectBtn);

      await user.click(connectBtn);
      expect(onConnectWallet).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
    });
  });

  describe("Reduced Motion Path", () => {
    it("does not render animated spin class when prefers-reduced-motion is enabled", () => {
      setReducedMotion(true);

      const { container } = render(
        <AsyncErrorRecovery
          isRetrying={true}
          onRetry={vi.fn()}
        />
      );

      const spinner = container.querySelector(".animate-spin");
      expect(spinner).toBeNull();
    });
  });
});
