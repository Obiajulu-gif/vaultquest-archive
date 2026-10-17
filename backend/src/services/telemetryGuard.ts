/**
 * High-cardinality telemetry protection (#925).
 *
 * Metric labels and log event names must stay bounded no matter what a caller
 * sends. Two failure modes are covered here:
 *
 *   - **Unsafe or unbounded label values** - {@link sanitizeLabel} rejects
 *     anything outside a small charset, redacts wallet addresses and
 *     transaction hashes, and caps length; {@link LabelCardinalityGuard}
 *     admits at most N distinct values per (metric, label) and collapses the
 *     rest into {@link OVERFLOW_LABEL}, so one abusive client cannot create an
 *     unbounded number of time series.
 *   - **Log floods** - {@link LogSampler} lets the first N events per key
 *     through each window and counts the rest, so dashboards keep the signal
 *     ("this happened 4,000 more times") without the volume.
 *
 * Everything is in-memory and deterministic given an injected clock.
 */

/** Used for a value that failed validation. */
export const INVALID_LABEL = "invalid";
/** Used for a value that arrived after the distinct-value budget was spent. */
export const OVERFLOW_LABEL = "other";
/** Used when a value contained a wallet address or transaction hash. */
export const REDACTED_LABEL = "redacted";

export const DEFAULT_MAX_LABEL_LENGTH = 64;
export const DEFAULT_MAX_VALUES_PER_LABEL = 100;

// Route patterns (`/api/actions/:id`), operation names and error codes only.
const SAFE_LABEL = /^[A-Za-z0-9_.:/*-]+$/;
const WALLET = /G[A-Z2-7]{55}/;
const TX_HASH = /[0-9a-fA-F]{64}/;

/**
 * Normalizes one raw label value. Never throws and never returns user text
 * that could carry a secret: unsafe input maps to a fixed placeholder.
 */
export function sanitizeLabel(value: unknown, maxLength = DEFAULT_MAX_LABEL_LENGTH): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  if (text.length === 0) return INVALID_LABEL;
  if (WALLET.test(text) || TX_HASH.test(text)) return REDACTED_LABEL;
  if (!SAFE_LABEL.test(text)) return INVALID_LABEL;
  return text.slice(0, maxLength);
}

export interface LabelGuardReportEntry {
  metric: string;
  label: string;
  /** Distinct values admitted so far (never exceeds the budget). */
  distinct: number;
  /** Values collapsed into {@link OVERFLOW_LABEL} after the budget was spent. */
  overflowed: number;
  /** Values replaced by {@link INVALID_LABEL} or {@link REDACTED_LABEL}. */
  rejected: number;
}

interface LabelState {
  values: Set<string>;
  overflowed: number;
  rejected: number;
}

export class LabelCardinalityGuard {
  private readonly states = new Map<string, LabelState>();

  constructor(
    private readonly maxValuesPerLabel = DEFAULT_MAX_VALUES_PER_LABEL,
    private readonly maxLength = DEFAULT_MAX_LABEL_LENGTH,
  ) {}

  /** Returns the value to use as the label: the sanitized input, or a bounded placeholder. */
  resolve(metric: string, label: string, raw: unknown): string {
    const key = `${metric}:${label}`;
    let state = this.states.get(key);
    if (!state) {
      state = { values: new Set(), overflowed: 0, rejected: 0 };
      this.states.set(key, state);
    }

    const value = sanitizeLabel(raw, this.maxLength);
    if (value === INVALID_LABEL || value === REDACTED_LABEL) {
      state.rejected += 1;
      return value;
    }
    if (state.values.has(value)) return value;
    if (state.values.size >= this.maxValuesPerLabel) {
      state.overflowed += 1;
      return OVERFLOW_LABEL;
    }
    state.values.add(value);
    return value;
  }

  report(): LabelGuardReportEntry[] {
    return [...this.states.entries()]
      .map(([key, state]) => {
        const split = key.indexOf(":");
        return {
          metric: key.slice(0, split),
          label: key.slice(split + 1),
          distinct: state.values.size,
          overflowed: state.overflowed,
          rejected: state.rejected,
        };
      })
      .sort((a, b) => `${a.metric}:${a.label}`.localeCompare(`${b.metric}:${b.label}`));
  }
}

export interface LogSamplerOptions {
  /** Events per key let through in each window. */
  maxPerWindow?: number;
  windowMs?: number;
  /** Distinct keys tracked at once; further keys share one overflow bucket. */
  maxKeys?: number;
  now?: () => number;
}

interface SampleWindow {
  startedAt: number;
  seen: number;
  suppressed: number;
}

/**
 * Per-key rate sampler for noisy log events. `shouldLog` is true for the first
 * `maxPerWindow` calls with a given key in a window; the rest are counted and
 * handed back through `takeSuppressed` so the next logged event can say how
 * many were dropped.
 */
export class LogSampler {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, SampleWindow>();

  constructor(opts: LogSamplerOptions = {}) {
    this.maxPerWindow = opts.maxPerWindow ?? 10;
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxKeys = opts.maxKeys ?? 1_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private windowFor(rawKey: string): { key: string; window: SampleWindow } {
    const now = this.now();
    let key = sanitizeLabel(rawKey);
    let window = this.windows.get(key);
    if (!window && this.windows.size >= this.maxKeys) {
      for (const [k, w] of this.windows) {
        if (now - w.startedAt >= this.windowMs && w.suppressed === 0) this.windows.delete(k);
      }
      if (this.windows.size >= this.maxKeys) {
        key = OVERFLOW_LABEL;
        window = this.windows.get(key);
      }
    }
    if (!window || now - window.startedAt >= this.windowMs) {
      // A new window keeps any unreported suppressed count so it is never lost.
      window = { startedAt: now, seen: 0, suppressed: window?.suppressed ?? 0 };
      this.windows.set(key, window);
    }
    return { key, window };
  }

  shouldLog(rawKey: string): boolean {
    const { window } = this.windowFor(rawKey);
    window.seen += 1;
    if (window.seen <= this.maxPerWindow) return true;
    window.suppressed += 1;
    return false;
  }

  /** Returns and resets the number of events dropped for `rawKey` since the last call. */
  takeSuppressed(rawKey: string): number {
    const { window } = this.windowFor(rawKey);
    const dropped = window.suppressed;
    window.suppressed = 0;
    return dropped;
  }
}
