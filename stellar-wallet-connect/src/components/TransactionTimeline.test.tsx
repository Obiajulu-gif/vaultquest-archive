import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TransactionTimeline } from "./TransactionTimeline";

const TX_HASH = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

function rows() {
  return within(screen.getByRole("list")).getAllByRole("listitem");
}

describe("TransactionTimeline keyboard and async status accessibility (#1133)", () => {
  it("announces the current step politely and marks it as the current step", () => {
    const { rerender } = render(<TransactionTimeline stage="awaiting-signature" />);

    expect(screen.getByRole("region", { name: "Transaction in progress" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Awaiting signature: Approve in your wallet");
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
    expect(rows()[0]).toHaveTextContent("Preparing, completed");
    expect(rows()[1]).toHaveAttribute("aria-current", "step");
    expect(rows()[1]).toHaveTextContent("Awaiting signature, in progress");
    expect(rows()[2]).toHaveTextContent("Submitting, not started");

    rerender(<TransactionTimeline stage="confirming" txHash={TX_HASH} />);

    expect(screen.getByRole("status")).toHaveTextContent("Confirming: Waiting for ledger inclusion");
    expect(rows()[1]).not.toHaveAttribute("aria-current");
    expect(rows()[3]).toHaveAttribute("aria-current", "step");
  });

  it("reports every step as completed once the transaction is confirmed", () => {
    render(<TransactionTimeline stage="success" txHash={TX_HASH} />);

    expect(screen.getByRole("region", { name: "Transaction completed" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Transaction confirmed");
    rows().forEach((row) => {
      expect(row).toHaveTextContent("completed");
      expect(row).not.toHaveAttribute("aria-current");
    });
  });

  it("raises an assertive alert with the failed step and reason", () => {
    render(
      <TransactionTimeline stage="failed" failedAtStage="submitting" errorMessage="RPC unavailable" />,
    );

    expect(screen.getByRole("region", { name: "Transaction failed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Transaction failed at Submitting. RPC unavailable");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(rows()[1]).toHaveTextContent("Awaiting signature, completed");
    expect(rows()[2]).toHaveTextContent("Submitting, failed");
    expect(rows()[3]).toHaveTextContent("Confirming, not started");
  });

  it("names the wallet authorization step when the signature is declined", () => {
    render(
      <TransactionTimeline
        stage="failed"
        failedAtStage="awaiting-signature"
        errorMessage="You declined the request in your wallet."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Transaction failed at Awaiting signature. You declined the request in your wallet.",
    );
    expect(rows()[0]).toHaveTextContent("Preparing, completed");
  });

  it("reaches the explorer link, Close and Retry by keyboard and announces the retry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <TransactionTimeline
        stage="failed"
        failedAtStage="confirming"
        txHash={TX_HASH}
        explorerUrl={(hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`}
        errorMessage="Confirmation timed out."
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );

    await user.tab();
    expect(screen.getByRole("link")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.keyboard(" ");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<TransactionTimeline stage="preparing" onRetry={onRetry} onDismiss={onDismiss} />);

    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
    expect(screen.getByRole("status")).toHaveTextContent("Preparing: Building the transaction");
  });
});
