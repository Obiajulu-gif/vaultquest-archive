import { DEFAULT_LOCALE, normalizeLocale } from "./locale";

export interface NumberFormatOptions {
  locale?: string | null;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

export interface CurrencyFormatOptions {
  locale?: string | null;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

export interface DateFormatOptions extends Intl.DateTimeFormatOptions {
  locale?: string | null;
}

function resolveLocale(locale?: string | null): string {
  return normalizeLocale(locale) || DEFAULT_LOCALE;
}

function safeNumber(value: string | number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatNumber(
  value: string | number,
  { locale, minimumFractionDigits = 0, maximumFractionDigits = 2 }: NumberFormatOptions = {},
): string {
  const parsed = safeNumber(value);
  if (parsed === null) return String(value);
  return new Intl.NumberFormat(resolveLocale(locale), {
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(parsed);
}

export function formatCurrency(
  value: string | number,
  currency = "USD",
  { locale, minimumFractionDigits = 2, maximumFractionDigits = 2 }: CurrencyFormatOptions = {},
): string {
  const parsed = safeNumber(value);
  if (parsed === null) return String(value);
  return new Intl.NumberFormat(resolveLocale(locale), {
    style: "currency",
    currency,
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(parsed);
}

export function formatPercent(
  value: string | number,
  { locale, minimumFractionDigits = 0, maximumFractionDigits = 2 }: NumberFormatOptions = {},
): string {
  const parsed = safeNumber(value);
  if (parsed === null) return String(value);
  return `${new Intl.NumberFormat(resolveLocale(locale), {
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(parsed)}%`;
}

// ── Yield-label formatting (#646) ──────────────────────────────────────────

/**
 * VaultQuest's displayed "expected yield" is a forward-looking estimate, not
 * a realized historical return: base yield comes from a deployed strategy
 * (variable), and any additional prize amount is only paid out to a drawn
 * winner (not guaranteed to every participant). Neither dimension is
 * currently modeled per-pool, so this does not fabricate a "realized"
 * figure — it labels the one number that exists honestly, so it isn't
 * mistaken for a guaranteed or already-earned rate.
 */
export const YIELD_LABEL_QUALIFIER = "Projected";

export const YIELD_LABEL_TOOLTIP =
  "Estimated rate, not a guaranteed or realized return. Includes strategy yield, which varies, and may assume a prize draw outcome that is not guaranteed to every participant.";

/**
 * Format a raw expected-yield string/value (e.g. "5.2% APY") with a
 * "Projected" qualifier so it isn't read as realized/historical performance.
 * Returns the qualifier plus the original value unchanged; falsy input
 * renders as an em dash, matching other formatters in this module.
 */
export function formatYieldLabel(expectedYield: string | null | undefined): string {
  if (!expectedYield) return "—";
  return `${YIELD_LABEL_QUALIFIER} ${expectedYield}`;
}

export const ASSET_DECIMALS: Record<string, number> = {
  XLM: 7,
  USDC: 6,
  USDT: 6,
  ETH: 18,
  SOL: 9,
  BTC: 8,
};

export const DEFAULT_DECIMALS = 6;

export function parseAssetAmount(value: string, assetSymbol: string): bigint {
  const decimals = ASSET_DECIMALS[assetSymbol.toUpperCase()] ?? DEFAULT_DECIMALS;
  if (!value || isNaN(Number(value))) return 0n;
  const [integerPart, fractionalPart = ""] = value.split(".");
  const paddedFractional = fractionalPart.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(integerPart + paddedFractional);
}

export function formatAssetAmount(
  value: string | number | bigint,
  assetSymbol?: string,
  options: NumberFormatOptions & {
    showSymbol?: boolean;
    roundingMode?: "round" | "floor" | "ceil";
  } = {},
): string {
  const symbol = assetSymbol?.toUpperCase() || "";
  const decimals = ASSET_DECIMALS[symbol] ?? DEFAULT_DECIMALS;
  let numValue: number;

  if (typeof value === "bigint") {
    const str = value.toString();
    const isNegative = str.startsWith("-");
    const absStr = isNegative ? str.slice(1) : str;
    const padded = absStr.padStart(decimals + 1, "0");
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals);
    const floatStr = `${isNegative ? "-" : ""}${intPart}.${fracPart}`;
    numValue = Number(floatStr);
  } else {
    numValue = typeof value === "number" ? value : Number(value);
  }

  if (isNaN(numValue) || !isFinite(numValue)) {
    return "0.00" + (assetSymbol ? ` ${assetSymbol}` : "");
  }

  const {
    showSymbol = true,
    locale,
    minimumFractionDigits,
    maximumFractionDigits,
    roundingMode = "round",
  } = options;

  const resolvedMinFrac = minimumFractionDigits ?? (symbol === "XLM" ? 6 : 2);
  let resolvedMaxFrac = maximumFractionDigits ?? (symbol === "XLM" ? 7 : (symbol === "USDC" || symbol === "USDT" ? 2 : 4));
  if (resolvedMaxFrac < resolvedMinFrac) {
    resolvedMaxFrac = resolvedMinFrac;
  }

  let roundedValue = numValue;
  const factor = Math.pow(10, resolvedMaxFrac);
  if (roundingMode === "floor") {
    roundedValue = Math.floor(numValue * factor) / factor;
  } else if (roundingMode === "ceil") {
    roundedValue = Math.ceil(numValue * factor) / factor;
  } else {
    roundedValue = Math.round(numValue * factor) / factor;
  }

  const formatted = new Intl.NumberFormat(resolveLocale(locale), {
    minimumFractionDigits: resolvedMinFrac,
    maximumFractionDigits: resolvedMaxFrac,
  }).format(roundedValue);

  return assetSymbol && showSymbol ? `${formatted} ${assetSymbol}` : formatted;
}

export function formatDateTime(
  value: string | number | Date | null | undefined,
  { locale, ...options }: DateFormatOptions = {},
): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
    ...options,
  }).format(date);
}

export function formatDateOnly(
  value: string | number | Date | null | undefined,
  { locale, ...options }: DateFormatOptions = {},
): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...options,
  }).format(date);
}

// ── Exact amount formatting (#599) ─────────────────────────────────────────

export { ExactAmount, fromContract, proRataShare, toBasisPoints } from "./safe-amount";
export type { ExactAmount as ExactAmountType } from "./safe-amount";

