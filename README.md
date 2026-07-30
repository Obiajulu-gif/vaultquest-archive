# VaultQuest

A Stellar/Soroban no-loss prize-savings dApp. Users deposit into pooled
vaults; yield is awarded to a random winner each round while every deposit
remains withdrawable in full.

## Packages

| Path | What it does |
|---|---|
| [`backend/`](./backend) | Fastify action-ledger and reconciliation service |
| [`contracts/`](./contracts) | Soroban smart contracts (Rust) |
| [`stellar-wallet-connect/`](./stellar-wallet-connect) | Drop-in wallet module — React + Astro components |
| [`services/`](./services) | Shared TypeScript service helpers (escrow, quests, savings) |
| [`e2e/`](./e2e) | Playwright end-to-end tests |
| [`docs/`](./docs) | Architecture, state model, testing notes |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Cross-stack architecture diagram and action/event flow |

## Quick start

```bash
git clone https://github.com/Obiajulu-gif/vaultquest.git
cd vaultquest
pnpm install

# Setup database (migrations and mock seed data)
pnpm db:setup

# Start development
pnpm dev
```

For per-package setup, see the README inside each folder.

## Contributing

We welcome contributions from everyone. Before opening a PR, please read
[**CONTRIBUTING.md**](./CONTRIBUTING.md) — it covers:

- How to choose an issue (good-first, frontend, backend, contracts, docs)
- Local setup and validation commands
- PR expectations (screenshots, tests, linked issues)
- When to ask maintainers before starting
- Accessibility and code style expectations

## License

License details are managed separately.

// Comment befire starting
