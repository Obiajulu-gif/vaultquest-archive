"use client";

import { useTranslation } from "next-i18next";
import { setStoredLocale } from "@/lib/locale";

const LOCALES = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
];

export default function Footer() {
  const { t, i18n } = useTranslation("common");
  const currentLocale = i18n.resolvedLanguage || i18n.language || "en";

  return (
    <footer className="border-t border-vault-border/60 bg-vault-surface/60">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 md:flex-row md:items-center md:justify-between">
        <span className="text-sm text-vault-muted">
          {t("footer.copyright", { year: new Date().getFullYear() })}
        </span>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-vault-muted">{t("footer.language")}:</span>
          <select
            className="rounded-md border border-vault-border bg-vault-bg px-2 py-1 text-vault-text"
            value={currentLocale}
            onChange={(e) => {
              const code = e.target.value;
              setStoredLocale(window.localStorage, code);
              void i18n.changeLanguage(code);
              document.documentElement.lang = code;
            }}
          >
            {LOCALES.map(({ code, label }) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </footer>
  );
}
