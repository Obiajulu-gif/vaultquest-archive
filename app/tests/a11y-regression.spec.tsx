/**
 * Accessibility regression coverage for dense forms, tables and error-recovery
 * flows: keyboard operation, focus management, screen-reader names and
 * descriptions, error announcements, and reduced motion.
 *
 * Assertions go through roles, accessible names/descriptions and live-region
 * text — what assistive tech exposes — rather than CSS or test ids where possible.
 * See docs/ACCESSIBILITY_REGRESSION.md for what each block protects.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PoolCreationForm from "@/components/app/PoolCreationForm";
import VaultComparisonTable from "@/components/app/VaultComparisonTable";
import VaultRetryQueue from "@/components/app/VaultRetryQueue";

vi.mock("@/components/hooks/useSavedPools", () => ({
  useSavedPools: () => ({ savePool: vi.fn(), unsavePool: vi.fn(), isPoolSaved: () => false }),
}));

function setReducedMotion(on: boolean) {
  (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation((query: string) => ({
    matches: on && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => setReducedMotion(false));

// ─── Dense form: pool creation ───────────────────────────────────────────────

describe("PoolCreationForm (dense form)", () => {
  async function fillValid(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/pool name/i), "USDC Stable Pool");
    await user.type(screen.getByLabelText(/start date/i), "2026-11-01");
    await user.type(screen.getByLabelText(/end date/i), "2026-12-01");
  }

  it("exposes every control by label and marks required fields", () => {
    render(<PoolCreationForm onSubmit={vi.fn()} />);
    for (const label of [/pool name/i, /start date/i, /end date/i]) {
      expect(screen.getByLabelText(label)).toHaveAttribute("aria-required", "true");
    }
    for (const label of [/^asset$/i, /default lockup/i, /minimum deposit/i, /maximum deposit/i, /maximum participants/i, /reward yield/i, /description/i]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("img", { name: "Step 1 of 3" })).toBeInTheDocument();
  });

  it("tabs through fields in visual order and ends on the Review button", async () => {
    const user = userEvent.setup();
    render(<PoolCreationForm onSubmit={vi.fn()} />);
    const expected = [
      /pool name/i, /^asset$/i, /default lockup/i, /minimum deposit/i, /maximum deposit/i,
      /maximum participants/i, /reward yield/i, /start date/i, /end date/i, /description/i,
    ];
    for (const label of expected) {
      await user.tab();
      expect(document.activeElement).toBe(screen.getByLabelText(label));
    }
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /review/i }));
  });

  it("on invalid submit: focuses the first invalid field, links errors, and announces once", async () => {
    const user = userEvent.setup();
    render(<PoolCreationForm onSubmit={vi.fn()} />);
    await user.clear(screen.getByLabelText(/minimum deposit/i));

    screen.getByRole("button", { name: /review/i }).focus();
    await user.keyboard("{Enter}");

    const name = screen.getByLabelText(/pool name/i);
    expect(document.activeElement).toBe(name);
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(/at least 3 characters/i);
    expect(screen.getByLabelText(/minimum deposit/i)).toHaveAccessibleDescription(/minimum deposit must be at least 1/i);
    expect(screen.getByLabelText(/end date/i)).toHaveAccessibleDescription(/end date is required/i);

    // Exactly one alert summarises the failure; per-field messages are not live regions.
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("4 fields need attention.");
  });

  it("clears invalid state per field and drops the summary when everything is fixed", async () => {
    const user = userEvent.setup();
    render(<PoolCreationForm onSubmit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /review/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("3 fields need attention.");

    await user.type(screen.getByLabelText(/pool name/i), "USDC Stable Pool");
    expect(screen.getByLabelText(/pool name/i)).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("alert")).toHaveTextContent("2 fields need attention.");

    await user.type(screen.getByLabelText(/start date/i), "2026-11-01");
    await user.type(screen.getByLabelText(/end date/i), "2026-12-01");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Review all values before proceeding.")).toBeInTheDocument();
  });

  it("moves focus to the new step heading when the step changes", async () => {
    const user = userEvent.setup();
    render(<PoolCreationForm onSubmit={vi.fn()} />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /review/i }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review before submission" }));

    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Configure pool parameters" }));
    // Values survive the round trip.
    expect(screen.getByLabelText(/pool name/i)).toHaveValue("USDC Stable Pool");
  });

  it("announces a failed submission in the page and keeps the user's settings", async () => {
    const user = userEvent.setup();
    let reject!: (e: Error) => void;
    const onSubmit = vi.fn(() => new Promise<void>((_, r) => { reject = r; }));
    render(<PoolCreationForm onSubmit={onSubmit} />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /review/i }));
    await user.click(screen.getByRole("button", { name: /sign & create pool/i }));

    // While the wallet is open, progress is exposed as a busy status.
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent(/approve the transaction/i);

    await act(async () => reject(new Error("user rejected")));
    expect(screen.getByRole("alert")).toHaveTextContent(/pool creation failed\. your settings were kept/i);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review before submission" }));
    expect(screen.getByText("USDC Stable Pool")).toBeInTheDocument();

    // Retrying clears the stale error.
    onSubmit.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: /sign & create pool/i }));
    expect(await screen.findByRole("heading", { name: "Pool created" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Step 3 of 3" })).toBeInTheDocument();
  });

  it("drops spinner and step transitions under prefers-reduced-motion", async () => {
    const user = userEvent.setup();
    const pendingForever = () => new Promise<void>(() => {});

    const { unmount } = render(<PoolCreationForm onSubmit={pendingForever} />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /review/i }));
    await user.click(screen.getByRole("button", { name: /sign & create pool/i }));
    expect(screen.getByTestId("pool-submit-spinner").getAttribute("class")).toContain("animate-spin");
    unmount();

    setReducedMotion(true);
    render(<PoolCreationForm onSubmit={pendingForever} />);
    const dots = screen.getByRole("img", { name: "Step 1 of 3" }).querySelectorAll("span");
    dots.forEach((dot) => expect(dot.getAttribute("class")).not.toContain("transition"));
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /review/i }));
    await user.click(screen.getByRole("button", { name: /sign & create pool/i }));
    expect(screen.getByTestId("pool-submit-spinner").getAttribute("class")).not.toContain("animate-spin");
  });
});

// ─── Table: vault comparison ─────────────────────────────────────────────────

const VAULTS = [
  { id: "a", name: "Alpha Pool", network: "Stellar", asset: "USDC", tvl: 3_000_000, participantCount: 10, apy: 5, lockup: 0, lastActivity: new Date("2026-10-01") },
  { id: "b", name: "Beta Pool", network: "Stellar", asset: "XLM", tvl: 1_000_000, participantCount: 30, apy: 9, lockup: 7, lastActivity: new Date("2026-10-03") },
  { id: "c", name: "Gamma Pool", network: "Stellar", asset: "USDC", tvl: 2_000_000, participantCount: 20, apy: 7, lockup: 14, lastActivity: new Date("2026-10-02") },
];

function rowOrder() {
  const body = screen.getAllByRole("rowgroup")[1]!;
  return within(body).getAllByRole("rowheader").map((th) => th.textContent?.match(/(Alpha|Beta|Gamma) Pool/)?.[0]);
}

describe("VaultComparisonTable (data table)", () => {
  it("has a caption, column headers and per-row headers", () => {
    render(<VaultComparisonTable vaults={VAULTS} />);
    expect(screen.getByRole("table", { name: /vault comparison table/i })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
    expect(screen.getAllByRole("rowheader")).toHaveLength(3);
    expect(rowOrder()).toEqual(["Beta Pool", "Gamma Pool", "Alpha Pool"]); // default: yield, descending
    expect(screen.getByRole("columnheader", { name: "Est. Yield" })).toHaveAttribute("aria-sort", "descending");
  });

  it("sorts from the keyboard and announces the new order", async () => {
    const user = userEvent.setup();
    render(<VaultComparisonTable vaults={VAULTS} />);
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement(); // nothing announced before the user acts

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Deposits (TVL)" }));
    await user.keyboard("{Enter}");
    expect(rowOrder()).toEqual(["Beta Pool", "Gamma Pool", "Alpha Pool"]);
    expect(screen.getByRole("columnheader", { name: "Deposits (TVL)" })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: "Est. Yield" })).not.toHaveAttribute("aria-sort");
    expect(status).toHaveTextContent("Sorted by Deposits (TVL), ascending.");

    await user.keyboard(" ");
    expect(rowOrder()).toEqual(["Alpha Pool", "Gamma Pool", "Beta Pool"]);
    expect(status).toHaveTextContent("Sorted by Deposits (TVL), descending.");
  });

  it("gives every per-row control a distinct accessible name", () => {
    const comparisonMode = { isSelected: (id: string) => id === "b", addPool: vi.fn(), removePool: vi.fn(), canAddMore: true };
    render(<VaultComparisonTable vaults={VAULTS} comparisonMode={comparisonMode} />);
    expect(screen.getByRole("link", { name: "View Alpha Pool" })).toHaveAttribute("href", "/app/vaults/a");
    expect(screen.getByRole("button", { name: "Add Gamma Pool to watchlist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare Alpha Pool" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Selected Beta Pool" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders rows without the entrance animation under prefers-reduced-motion", () => {
    setReducedMotion(true);
    render(<VaultComparisonTable vaults={VAULTS} />);
    for (const row of screen.getAllByRole("rowheader").map((th) => th.closest("tr")!)) {
      expect(row.style.opacity).not.toBe("0");
      expect(row.style.transform).not.toMatch(/translateY\(10px\)/);
    }
  });
});

// ─── Error recovery: retry queue ─────────────────────────────────────────────

describe("VaultRetryQueue (error recovery)", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    // Testing Library only recognises fake timers when a global `jest` exists;
    // without it, its async wrapper awaits a faked setTimeout(0) forever.
    (globalThis as any).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };
    // delay: null — user-event must not wait on timers that are faked here.
    user = userEvent.setup({ delay: null });
  });
  afterEach(() => {
    delete (globalThis as any).jest;
    vi.useRealTimers();
  });

  const politeText = () => screen.getByTestId("retry-queue-status").textContent;
  const alertText = () => screen.getByTestId("retry-queue-alert").textContent;

  it("names each retry control after its action, keeping the visible text first", () => {
    render(<VaultRetryQueue />);
    const retry = screen.getByRole("button", { name: "Retry deposit of 500 USDC in USDC Yield Pool" });
    expect(retry).toHaveAccessibleDescription(/rejected in your wallet/i);
    expect(screen.getByRole("button", { name: "Retry deposit of 320 USDC in DOT Staking Vault" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel pending deposit of 1000 USDC in BTC Synthetic Pool" })).toBeInTheDocument();
    const dismissNames = screen.getAllByRole("button", { name: /^Dismiss / }).map((b) => b.getAttribute("aria-label"));
    expect(new Set(dismissNames).size).toBe(dismissNames.length);
  });

  it("announces 'already resolved' and moves focus to the row's remaining control", async () => {
    render(<VaultRetryQueue />);
    const retry = screen.getByRole("button", { name: /^Retry withdraw of 750 USDC in SOL Yield Vault/ });
    act(() => retry.focus());
    await user.keyboard("{Enter}");
    await act(() => vi.advanceTimersByTimeAsync(200));

    expect(politeText()).toBe("withdraw of 750 USDC in SOL Yield Vault was already confirmed on-chain. No retry needed.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss withdraw of 750 USDC in SOL Yield Vault" }));
  });

  it("announces a submitted retry and keeps focus on the row", async () => {
    render(<VaultRetryQueue />);
    act(() => screen.getByRole("button", { name: /^Retry deposit of 500 USDC/ }).focus());
    await user.keyboard("{Enter}");
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(politeText()).toBe("Retry submitted for deposit of 500 USDC in USDC Yield Pool. It is now pending.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel pending deposit of 500 USDC in USDC Yield Pool" }));
  });

  it("announces backoff politely and exhaustion assertively", async () => {
    render(<VaultRetryQueue />);
    await user.click(screen.getByRole("button", { name: /^Retry withdraw of 250 USDC/ }));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(politeText()).toBe("Retry failed for withdraw of 250 USDC in ETH Staking Vault. Retrying automatically in 4 seconds.");
    expect(alertText()).toBe("");
    // The countdown is visible and in the button's name, but not re-announced every tick.
    expect(screen.getByRole("button", { name: /^Retrying in \ds withdraw of 250 USDC/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /^Retry deposit of 320 USDC/ }));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(alertText()).toBe("Retry failed for deposit of 320 USDC in DOT Staking Vault after 3 attempts. Manual intervention required.");
    expect(screen.getByRole("button", { name: /^Retry deposit of 320 USDC/ })).toHaveAccessibleDescription(/manual intervention required/i);
  });

  it("hands focus to the next row when a row is dismissed from the keyboard", async () => {
    render(<VaultRetryQueue />);
    act(() => screen.getByRole("button", { name: "Dismiss withdraw of 250 USDC in ETH Staking Vault" }).focus());
    await user.keyboard("{Enter}");

    expect(politeText()).toBe("Dismissed withdraw of 250 USDC in ETH Staking Vault.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel pending deposit of 1000 USDC in BTC Synthetic Pool" }));
  });

  it("still announces when the queue is cleared and the region disappears", async () => {
    render(<VaultRetryQueue />);
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByRole("region", { name: /retry queue/i })).not.toBeInTheDocument();
    expect(politeText()).toBe("All pending actions cleared.");
  });

  it("keeps the retry spinner still under prefers-reduced-motion", async () => {
    const spinnerClass = () =>
      screen.getByTestId("retry-button-act-001").querySelector("svg")!.getAttribute("class") ?? "";

    const { unmount } = render(<VaultRetryQueue />);
    await user.click(screen.getByTestId("retry-button-act-001"));
    expect(spinnerClass()).toContain("animate-spin");
    unmount();

    setReducedMotion(true);
    render(<VaultRetryQueue />);
    await user.click(screen.getByTestId("retry-button-act-001"));
    expect(spinnerClass()).not.toContain("animate-spin");
  });
});
