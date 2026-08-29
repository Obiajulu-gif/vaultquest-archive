import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "../../tests/test-utils";
import VaultRetryQueue, {
  BACKOFF_BASE_MS,
  getBackoffDelay,
} from "./VaultRetryQueue";

describe("VaultRetryQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders failed actions with retry controls and pending actions without", () => {
    render(<VaultRetryQueue />);

    expect(screen.getByTestId("retry-action-act-001")).toBeInTheDocument();
    expect(screen.getByTestId("retry-button-act-001")).toBeInTheDocument();

    // act-003 is pending — no retry button for it.
    expect(screen.getByTestId("retry-action-act-003")).toBeInTheDocument();
    expect(screen.queryByTestId("retry-button-act-003")).not.toBeInTheDocument();
  });

  it("re-checks the server-side status before retrying and skips already-resolved actions", async () => {
    render(<VaultRetryQueue />);

    // act-004 is shown as failed in the UI but the server has already
    // confirmed it (serverStatus: "confirmed") — retrying must not resubmit.
    fireEvent.click(screen.getByTestId("retry-button-act-004"));

    // Advance past the status re-check round-trip only.
    await vi.advanceTimersByTimeAsync(200);

    expect(screen.getByText("Resolved on-chain")).toBeInTheDocument();
    // No retry button remains — the action was not resubmitted.
    expect(screen.queryByTestId("retry-button-act-004")).not.toBeInTheDocument();
  });

  it("dedups rapid double-clicks into a single retry attempt", async () => {
    render(<VaultRetryQueue />);

    const button = screen.getByTestId("retry-button-act-001");
    fireEvent.click(button);
    fireEvent.click(button); // second click while the first is in flight

    // act-001 succeeds on its first attempt (0 mock failures).
    await vi.advanceTimersByTimeAsync(1200);

    // Exactly one submission happened: retry count is 1, not 2.
    expect(screen.getByTestId("retry-count-act-001")).toHaveTextContent("Retry #1");
  });

  it("schedules an exponential backoff after a failed retry and auto-retries", async () => {
    render(<VaultRetryQueue />);

    // act-002 already failed once and the mock fails the next attempt too,
    // then succeeds — exercising the backoff/scheduled state.
    fireEvent.click(screen.getByTestId("retry-button-act-002"));

    // Status re-check (150ms) + failed submit (800ms) → scheduled.
    await vi.advanceTimersByTimeAsync(1000);

    expect(screen.getByText("Retrying soon")).toBeInTheDocument();
    expect(screen.getByTestId("retry-button-act-002")).toBeDisabled();

    // Backoff grows exponentially with the attempt number.
    expect(getBackoffDelay(1)).toBe(BACKOFF_BASE_MS);
    expect(getBackoffDelay(2)).toBe(BACKOFF_BASE_MS * 2);

    // Let the backoff elapse; the automatic attempt then succeeds.
    await vi.advanceTimersByTimeAsync(getBackoffDelay(2));
    await vi.advanceTimersByTimeAsync(1200);

    expect(screen.getByTestId("retry-count-act-002")).toHaveTextContent("Retry #2");
  });

  it("marks actions as exhausted (manual intervention) once the retry budget is spent", async () => {
    render(<VaultRetryQueue />);

    // act-005 has already been attempted twice and the mock always fails —
    // the next attempt crosses MAX_RETRY_ATTEMPTS.
    fireEvent.click(screen.getByTestId("retry-button-act-005"));

    await vi.advanceTimersByTimeAsync(1200);

    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(
      screen.getByText(/Automatic retries exhausted.*manual intervention/i),
    ).toBeInTheDocument();

    // A manual retry remains available — no more automatic attempts.
    expect(screen.getByTestId("retry-button-act-005")).not.toBeDisabled();
  });
});
