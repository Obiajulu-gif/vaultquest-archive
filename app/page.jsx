import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <div className="vq-glass max-w-2xl px-8 py-12 sm:px-12 sm:py-16">
        <p className="text-sm font-medium uppercase tracking-widest text-red-500">Stellar · Soroban</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-vault-text sm:text-5xl">
          VaultQuest
        </h1>
        <p className="mx-auto mt-4 max-w-md text-lg text-vault-muted">
          No-loss lottery savings on-chain. Your deposit stays safe while yield powers the prize pool.
        </p>
        <Link href="/app" className="vq-btn-primary mt-8 inline-flex text-base">
          Launch DApp
        </Link>
      </div>
    </main>
  );
}
