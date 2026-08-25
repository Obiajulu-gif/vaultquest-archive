"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Search, SortAsc, SortDesc, Ticket, TrendingUp } from "lucide-react";

export default function TicketDistributionGrid({
  tickets = [],
  userAddress = null,
  onTicketClick = null,
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortConfig, setSortConfig] = useState({ key: "ticketNumber", direction: "asc" });
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef(null);

  const filteredAndSortedTickets = useMemo(() => {
    const startTime = performance.now();
    let result = [...tickets];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (ticket) =>
          ticket.ticketNumber?.toString().includes(query) ||
          ticket.ownerAddress?.toLowerCase().includes(query)
      );
    }

    result.sort((a, b) => {
      let aVal = a[sortConfig.key];
      let bVal = b[sortConfig.key];

      if (typeof aVal === "string") {
        aVal = aVal.toLowerCase();
        bVal = bVal.toLowerCase();
      }

      if (aVal < bVal) return sortConfig.direction === "asc" ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === "asc" ? 1 : -1;
      return 0;
    });

    const endTime = performance.now();
    console.log(`Filtering completed in ${(endTime - startTime).toFixed(2)}ms`);

    return result;
  }, [tickets, searchQuery, sortConfig]);

  const handleSort = useCallback((key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === "asc" ? "desc" : "asc",
    }));
  }, []);

  const handleSearchChange = useCallback((e) => {
    setSearchQuery(e.target.value);
  }, []);

  const handleScroll = useCallback((e) => {
    setScrollTop(e.target.scrollTop);
  }, []);

  // Virtual scrolling parameters
  const ITEM_HEIGHT = 52;
  const CONTAINER_HEIGHT = 520;
  const OVERSCAN = 3;

  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    filteredAndSortedTickets.length,
    Math.ceil((scrollTop + CONTAINER_HEIGHT) / ITEM_HEIGHT) + OVERSCAN
  );

  const visibleTickets = filteredAndSortedTickets.slice(startIndex, endIndex);
  const totalHeight = filteredAndSortedTickets.length * ITEM_HEIGHT;
  const offsetY = startIndex * ITEM_HEIGHT;

  const TicketRow = useCallback(
    ({ ticket, style }) => {
      const isUserTicket = ticket.ownerAddress === userAddress;
      const probability = ((ticket.winProbability || 0) * 100).toFixed(4);

      return (
        <div
          style={style}
          className={`flex items-center gap-4 border-b border-vault-border px-4 transition-all duration-200 hover:bg-red-500/5 cursor-pointer ${
            isUserTicket ? "bg-red-500/10" : ""
          }`}
          onClick={() => onTicketClick?.(ticket)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onTicketClick?.(ticket);
            }
          }}
        >
          <div className="flex w-32 items-center gap-2 text-sm font-mono text-vault-text">
            <Ticket className="h-4 w-4 text-red-500" aria-hidden="true" />
            #{ticket.ticketNumber}
          </div>
          <div className="flex-1 truncate text-sm text-vault-muted font-mono">
            {ticket.ownerAddress}
          </div>
          <div className="flex w-32 items-center gap-1.5 text-sm text-vault-muted">
            <TrendingUp className="h-3.5 w-3.5 text-green-500" aria-hidden="true" />
            {probability}%
          </div>
          {isUserTicket && (
            <div className="rounded-full bg-red-500 px-2 py-0.5 text-xs font-medium text-white">
              You
            </div>
          )}
        </div>
      );
    },
    [userAddress, onTicketClick]
  );

  const SortButton = ({ sortKey, label }) => {
    const isActive = sortConfig.key === sortKey;
    const Icon = isActive && sortConfig.direction === "desc" ? SortDesc : SortAsc;

    return (
      <button
        type="button"
        onClick={() => handleSort(sortKey)}
        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-300 ${
          isActive
            ? "bg-red-500/20 text-red-500"
            : "bg-vault-surface text-vault-muted hover:bg-vault-surface/80 hover:text-vault-text"
        }`}
      >
        {label}
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  };

  return (
    <div className="vq-glass w-full space-y-4 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-vault-text">Ticket Distribution</h3>
          <p className="mt-1 text-sm text-vault-muted">
            {filteredAndSortedTickets.length} ticket{filteredAndSortedTickets.length !== 1 ? "s" : ""} found
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SortButton sortKey="ticketNumber" label="Ticket #" />
          <SortButton sortKey="winProbability" label="Probability" />
        </div>
      </div>

      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vault-muted"
          aria-hidden="true"
        />
        <input
          type="text"
          value={searchQuery}
          onChange={handleSearchChange}
          placeholder="Search by ticket number or address..."
          className="w-full rounded-xl border border-vault-border bg-vault-surface px-10 py-2.5 text-sm text-vault-text placeholder-vault-muted backdrop-blur-md transition-all duration-300 focus:border-red-500/50 focus:outline-none focus:ring-2 focus:ring-red-500/20"
          aria-label="Search tickets"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-red-500 transition-colors duration-300 hover:text-red-600"
            aria-label="Clear search"
          >
            Clear
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-vault-border bg-vault-surface/50 backdrop-blur-md">
        <div className="flex items-center gap-4 border-b border-vault-border bg-vault-surface px-4 py-3">
          <div className="w-32 text-xs font-semibold uppercase tracking-wide text-vault-muted">
            Ticket #
          </div>
          <div className="flex-1 text-xs font-semibold uppercase tracking-wide text-vault-muted">
            Owner Address
          </div>
          <div className="w-32 text-xs font-semibold uppercase tracking-wide text-vault-muted">
            Win Probability
          </div>
          <div className="w-12" />
        </div>

        {filteredAndSortedTickets.length > 0 ? (
          <div
            ref={containerRef}
            onScroll={handleScroll}
            style={{ height: CONTAINER_HEIGHT, overflowY: "auto" }}
            className="relative"
          >
            <div style={{ height: totalHeight, position: "relative" }}>
              <div style={{ transform: `translateY(${offsetY}px)` }}>
                {visibleTickets.map((ticket) => (
                  <TicketRow
                    key={ticket.ticketNumber}
                    ticket={ticket}
                    style={{ height: ITEM_HEIGHT }}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Ticket className="mb-3 h-12 w-12 text-vault-muted/50" aria-hidden="true" />
            <p className="text-sm font-medium text-vault-muted">
              {searchQuery ? "No tickets match your search" : "No tickets available"}
            </p>
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="mt-2 text-xs text-red-500 hover:text-red-600"
              >
                Clear search
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between rounded-xl border border-vault-border bg-vault-surface/50 px-4 py-3 backdrop-blur-md">
        <div className="text-xs text-vault-muted">
          Showing {filteredAndSortedTickets.length} of {tickets.length} total tickets
        </div>
        <div className="text-xs text-vault-muted">
          Virtual scrolling enabled for optimal performance
        </div>
      </div>
    </div>
  );
}
