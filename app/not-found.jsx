import Link from "next/link";
import { Home, SearchX } from "lucide-react";

export const metadata = {
  title: "Page Not Found — VaultQuest",
};

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="vq-glass max-w-lg px-8 py-12 sm:px-12 sm:py-16">
        <div className="mb-6 flex justify-center">
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-vault-accent/10 border border-vault-accent/20">
            <SearchX size={40} className="text-vault-accent" />
          </span>
        </div>
        <p className="text-sm font-medium uppercase tracking-widest text-vault-accent">
          404 &mdash; Not Found
        </p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-vault-text sm:text-5xl">
          Lost in the vault
        </h1>
        <p className="mx-auto mt-4 max-w-sm text-lg text-vault-muted">
          This page doesn&apos;t exist or was moved. Head back home to keep
          saving and winning.
        </p>
        <Link
          href="/"
          className="vq-btn-primary mt-8 inline-flex items-center gap-2 text-base"
        >
          <Home size={18} />
          Go back home
        </Link>
      </div>
    </main>
  );
}
