import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import VaultActivityExport from "@/components/app/VaultActivityExport";

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function makeRow(id) {
  return {
    id,
    created_at: `2026-08-0${id}T10:00:00Z`,
    action_type: "deposit",
    action_payload: { vault_id: "42", token: "USDC", amount: "100" },
    status: "confirmed",
    tx_hash: `tx-${id}`,
    error_code: null,
    submitted_at: null,
    confirmed_at: `2026-08-0${id}T10:05:00Z`,
  };
}

describe("VaultActivityExport pagination (#576)", () => {
  let capturedBlob;

  beforeEach(() => {
    capturedBlob = null;
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pages through the API until next_cursor is null and exports every row", async () => {
    const fetchImpl = vi.fn((url) => {
      if (url.includes("cursor=id-2")) {
        return Promise.resolve(
          jsonResponse({
            data: [makeRow(3)],
            meta: { pagination: { next_cursor: null, limit: 2, has_more: false } },
          })
        );
      }
      return Promise.resolve(
        jsonResponse({
          data: [makeRow(1), makeRow(2)],
          meta: { pagination: { next_cursor: "id-2", limit: 2, has_more: true } },
        })
      );
    });

    render(<VaultActivityExport wallet="GABCDEF1234567890" pageSize={2} fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByText("Export"));

    // Both pages fetched; the second request resumes from the returned cursor.
    expect(await screen.findByText(/Downloaded/)).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain("wallet=GABCDEF1234567890");
    expect(fetchImpl.mock.calls[0][0]).toContain("limit=2");
    expect(fetchImpl.mock.calls[1][0]).toContain("cursor=id-2");

    // Row count correctness: header + 3 rows across 2 pages.
    const blob = URL.createObjectURL.mock.calls[0][0];
    const text = await blob.text();
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      "id,date,action_type,pool_id,asset,amount,status,tx_hash,error_code,submitted_at,confirmed_at"
    );
    expect(lines[1]).toContain("tx-1");
    expect(lines[3]).toContain("tx-3");
    expect(screen.getByText(/3 rows/)).toBeDefined();
  });

  it("shows progress while exporting across multiple pages", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          data: [makeRow(1)],
          meta: { pagination: { next_cursor: null, limit: 1, has_more: false } },
        })
      )
    );

    render(<VaultActivityExport wallet="GABCDEF1234567890" pageSize={1} fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByText("Export"));

    expect(await screen.findByText(/Exporting…/)).toBeDefined();
    expect(await screen.findByText(/1 rows/)).toBeDefined();
  });

  it("cancels an in-flight export without paging further", async () => {
    const fetchImpl = vi.fn((_url, opts) => {
      // First (and only) page hangs until the user cancels.
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      });
    });

    render(<VaultActivityExport wallet="GABCDEF1234567890" fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByText("Export"));

    expect(await screen.findByText(/Exporting…/)).toBeDefined();
    fireEvent.click(screen.getByText("Cancel"));

    expect(await screen.findByText(/Export cancelled/)).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires a wallet address before exporting", async () => {
    const fetchImpl = vi.fn();
    render(<VaultActivityExport fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByText("Export"));

    expect(
      await screen.findByText("A wallet address is required to export activity.")
    ).toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
