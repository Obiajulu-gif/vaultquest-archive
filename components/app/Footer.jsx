"use client";

import { useRouter } from "next/navigation";

const LOCALES = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
];

export default function Footer() {
  const router = useRouter();

  return (
    <footer className="border-t border-vault-border/60 bg-vault-surface/60">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 md:flex-row md:items-center md:justify-between">
        <span className="text-sm text-vault-muted">
          VaultQuest © {new Date().getFullYear()}
        </span>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-vault-muted">Language:</span>
          <select
            className="rounded-md border border-vault-border bg-vault-bg px-2 py-1 text-vault-text"
            defaultValue="en"
            onChange={(e) => {
              router.push(`/${e.target.value}`);
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
