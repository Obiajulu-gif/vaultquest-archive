import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import VaultFilters from "./VaultFilters";

const defaults = { search: "", networks: [], minApy: 0, minTvl: 0, lockups: [], statuses: [], strategies: [], sortBy: "apy" };

describe("VaultFilters", () => {
  it("reports selected filter and sort changes", async () => {
    const user = userEvent.setup();
    const setFilters = vi.fn();
    render(<VaultFilters filters={defaults} setFilters={setFilters} onClear={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Stellar" }));
    expect(setFilters).toHaveBeenCalledWith({ ...defaults, networks: ["Stellar"] });
    await user.click(screen.getByRole("button", { name: "Pending" }));
    expect(setFilters).toHaveBeenCalledWith({ ...defaults, statuses: ["pending"] });
    await user.click(screen.getByRole("checkbox", { name: "Growth" }));
    expect(setFilters).toHaveBeenCalledWith({ ...defaults, strategies: ["Growth"] });
    await user.selectOptions(screen.getByRole("combobox"), "activity");
    expect(setFilters).toHaveBeenCalledWith({ ...defaults, sortBy: "activity" });
  });

  it("invokes reset behavior", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<VaultFilters filters={{ ...defaults, networks: ["Solana"] }} setFilters={vi.fn()} onClear={onClear} />);
    await user.click(screen.getByRole("button", { name: "Reset All Filters" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
