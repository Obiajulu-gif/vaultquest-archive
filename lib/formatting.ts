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

export function formatAssetAmount(
  value: string | number,
  asset?: string,
  options: NumberFormatOptions = {},
): string {
  const formatted = formatNumber(value, options);
  return asset ? `${formatted} ${asset}` : formatted;
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

