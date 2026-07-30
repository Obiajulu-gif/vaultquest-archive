"use client";

import { useEffect, useRef, useCallback, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

interface InfiniteFeedProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  onLoadMore: () => void;
  hasMore: boolean;
  isLoading: boolean;
  /** Message shown when all items have been loaded (default: "You've reached the end") */
  endMessage?: string;
  /** Skeleton component shown while loading the next page */
  loadingSkeleton?: ReactNode;
  className?: string;
}

/**
 * Infinite-scroll feed component.
 *
 * - Uses Intersection Observer to detect when the user reaches the bottom
 * - Shows a loading skeleton/spinner while fetching the next page
 * - Appends new items without resetting scroll position
 * - Displays an "End of Feed" message when no more data is available
 */
export default function InfiniteFeed<T>({
  items,
  renderItem,
  onLoadMore,
  hasMore,
  isLoading,
  endMessage = "You've reached the end",
  loadingSkeleton,
  className = "",
}: InfiniteFeedProps<T>) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const [entry] = entries;
      if (entry.isIntersecting && hasMore && !isLoading) {
        onLoadMore();
      }
    },
    [hasMore, isLoading, onLoadMore],
  );

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(handleIntersect, {
      root: null,
      rootMargin: "200px",
      threshold: 0,
    });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleIntersect]);

  return (
    <div className={className}>
      {/* Items */}
      {items.map((item, i) => (
        <div key={i}>{renderItem(item, i)}</div>
      ))}

      {/* Loading indicator */}
      {isLoading && (
        <div className="py-8">
          {loadingSkeleton ?? (
            <div className="flex items-center justify-center gap-2 text-vault-muted">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading more…</span>
            </div>
          )}
        </div>
      )}

      {/* End of feed message */}
      {!hasMore && items.length > 0 && (
        <div className="py-8 text-center text-sm text-vault-muted">
          {endMessage}
        </div>
      )}

      {/* Sentinel element for Intersection Observer */}
      {hasMore && <div ref={sentinelRef} className="h-px" aria-hidden="true" />}
    </div>
  );
}
