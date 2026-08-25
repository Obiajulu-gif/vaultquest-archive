"use client";

import Link from "next/link";
import { ArrowUpRight, BookOpen, Code, FileText, Shield } from "lucide-react";

const DOC_GROUPS = [
  {
    topic: "Product",
    icon: Shield,
    links: [
      { label: "Protocol overview", href: "/docs#product-overview" },
      { label: "Round lifecycle", href: "/docs#round-lifecycle" },
    ],
  },
  {
    topic: "Operations",
    icon: FileText,
    links: [
      { label: "Indexer runbook", href: "https://github.com/Obiajulu-gif/vaultquest/blob/main/docs/INDEXER_RUNBOOK.md" },
      { label: "State model", href: "https://github.com/Obiajulu-gif/vaultquest/blob/main/docs/STATE_MODEL.md" },
    ],
  },
  {
    topic: "Developers",
    icon: Code,
    links: [
      { label: "API notes", href: "https://github.com/Obiajulu-gif/vaultquest/blob/main/docs/API.md" },
      { label: "Testing guide", href: "https://github.com/Obiajulu-gif/vaultquest/blob/main/docs/TESTING.md" },
    ],
  },
];

export default function VaultDocsQuickLinks({ compact = false }) {
  return (
    <section className="vq-glass p-4 sm:p-6" aria-labelledby="vault-docs-title">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-red-500">
          <BookOpen className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 id="vault-docs-title" className="text-lg font-bold text-vault-text">
            Vault Documentation
          </h2>
          <p className="mt-1 text-sm text-vault-muted">
            Quick links for savers, operators, and contributors.
          </p>
        </div>
      </div>

      <div className={`mt-5 grid gap-4 ${compact ? "grid-cols-1" : "sm:grid-cols-3"}`}>
        {DOC_GROUPS.map(({ topic, icon: Icon, links }) => (
          <div key={topic} className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-vault-text">
              <Icon className="h-4 w-4 text-red-500" aria-hidden="true" />
              {topic}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {links.map((link) => {
                const external = link.href.startsWith("http");
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    target={external ? "_blank" : undefined}
                    rel={external ? "noreferrer" : undefined}
                    className="flex min-h-10 items-center justify-between gap-3 rounded-lg border border-vault-border/60 bg-vault-bg/30 px-3 py-2 text-sm font-medium text-vault-text transition-colors hover:border-red-400/40 hover:text-red-500"
                  >
                    <span>{link.label}</span>
                    <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
