export const SUPPORTED_LOCALES = ["en", "es", "fr", "de"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";
export const LOCALE_STORAGE_KEY = "vaultquest-locale";

export function isSupportedLocale(value: string | null | undefined): value is SupportedLocale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function normalizeLocale(value: string | null | undefined): SupportedLocale {
  if (!value) return DEFAULT_LOCALE;
  const base = value.toLowerCase().split("-")[0];
  return isSupportedLocale(base) ? base : DEFAULT_LOCALE;
}

export function getStoredLocale(storage: Pick<Storage, "getItem"> | null | undefined): SupportedLocale {
  if (!storage) return DEFAULT_LOCALE;
  try {
    return normalizeLocale(storage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function setStoredLocale(storage: Pick<Storage, "setItem"> | null | undefined, locale: string): void {
  if (!storage) return;
  try {
    storage.setItem(LOCALE_STORAGE_KEY, normalizeLocale(locale));
  } catch {
    // Ignore storage quota / privacy mode failures.
  }
}

