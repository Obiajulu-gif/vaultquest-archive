import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import WalletFundingModal from "./WalletFundingModal";

// #629: the funding modal must show which network (testnet/mainnet) the
// funding action targets, with mainnet given a visually distinct warning
// treatment so users don't fund the wrong-network account by mistake.
describe("WalletFundingModal - network indicator (#629)", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <WalletFundingModal
        isOpen={false}
        onClose={vi.fn()}
        exists={false}
        balance={0}
        minRequired={1}
        network="testnet"
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a testnet indicator without the mainnet warning", () => {
    render(
      <WalletFundingModal
        isOpen={true}
        onClose={vi.fn()}
        exists={false}
        balance={0}
        minRequired={1}
        network="testnet"
      />
    );

    const indicator = screen.getByRole("status");
    expect(indicator).toHaveTextContent(/funding on testnet/i);
    expect(indicator).toHaveAttribute("data-network", "testnet");
    expect(
      screen.queryByText(/any funds you send here are real/i)
    ).not.toBeInTheDocument();
  });

  it("shows a distinct mainnet indicator and warning banner", () => {
    render(
      <WalletFundingModal
        isOpen={true}
        onClose={vi.fn()}
        exists={false}
        balance={0}
        minRequired={1}
        network="mainnet"
      />
    );

    const indicator = screen.getByRole("status");
    expect(indicator).toHaveTextContent(/funding on mainnet/i);
    expect(indicator).toHaveAttribute("data-network", "mainnet");
    expect(screen.getByText(/any funds you send here are real/i)).toBeInTheDocument();
  });

  it("defaults to testnet when no network prop is supplied", () => {
    render(
      <WalletFundingModal
        isOpen={true}
        onClose={vi.fn()}
        exists={false}
        balance={0}
        minRequired={1}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(/funding on testnet/i);
  });

  it("still shows funding messaging content alongside the network indicator", () => {
    render(
      <WalletFundingModal
        isOpen={true}
        onClose={vi.fn()}
        exists={true}
        balance={0.5}
        minRequired={1}
        network="mainnet"
      />
    );

    expect(screen.getByText(/Low XLM Balance/i)).toBeInTheDocument();
    expect(screen.getByText(/0.50 XLM/i)).toBeInTheDocument();
  });
});
