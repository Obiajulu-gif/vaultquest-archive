import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DataRefreshControl } from "./DataRefreshControl";

describe("DataRefreshControl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the timestamp correctly", () => {
    const now = Date.now();
    const { rerender } = render(
      <DataRefreshControl updatedAt={now} stale={false} fetching={false} partialError={null} onRefresh={() => {}} />
    );
    expect(screen.getByText("Updated: Just now")).toBeDefined();

    // Advance 30 seconds
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    
    // The component updates its text every 10s
    expect(screen.getByText("Updated: 30s ago")).toBeDefined();
  });

  it("shows stale indicator when stale is true", () => {
    render(<DataRefreshControl updatedAt={Date.now()} stale={true} fetching={false} partialError={null} onRefresh={() => {}} />);
    expect(screen.getByText("Stale")).toBeDefined();
  });

  it("shows fetching indicator and disables button when fetching is true", () => {
    render(<DataRefreshControl updatedAt={Date.now()} stale={false} fetching={true} partialError={null} onRefresh={() => {}} />);
    expect(screen.getByText("Refreshing…")).toBeDefined();
    expect(screen.queryByText(/Updated:/)).toBeNull(); // Should hide timestamp
    const button = screen.getByRole("button", { name: "Refresh data" });
    expect(button).toHaveProperty("disabled", true);
  });

  it("shows partialError when present", () => {
    render(
      <DataRefreshControl
        updatedAt={Date.now()}
        stale={false}
        fetching={false}
        partialError={new Error("Network fail")}
        onRefresh={() => {}}
      />
    );
    expect(screen.getByText("Update failed")).toBeDefined();
    // The timestamp should be hidden because error takes precedence
    expect(screen.queryByText(/Updated:/)).toBeNull();
  });

  it("calls onRefresh when clicked", () => {
    const onRefresh = vi.fn();
    render(<DataRefreshControl updatedAt={Date.now()} stale={false} fetching={false} partialError={null} onRefresh={onRefresh} />);
    
    const button = screen.getByRole("button", { name: "Refresh data" });
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
