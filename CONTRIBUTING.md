# Contributing to VaultQuest

Welcome! This guide explains how to choose an issue, set up the project,
validate your changes, and prepare a pull request that maintainers can merge
quickly. (#66)

Reading time: ~10 minutes. If something here is wrong or out of date, open
an issue with the `docs` label — that's the kind of contribution that helps
every future contributor.

## 1. Pick the right issue

VaultQuest issues live across several surfaces:

| Label / area | What it usually involves | Good for |
|---|---|---|
| `good first issue` | Self-contained, well-scoped change with clear acceptance criteria | First-time contributors |
| `frontend` | React/Astro components, state, accessibility, UI polish | Familiarity with React + Tailwind |
| `backend` | Fastify routes, Prisma schema, business logic | Node + TypeScript + Postgres |
| `contract` | Soroban (Rust) contract logic and tests | Rust + Stellar Soroban |
| `docs` | Guides, READMEs, comments, architecture notes | Any contributor |
| `devops` | CI, deployment, env management | Infra background helps |

Before claiming an issue:

1. **Skim recent comments** — confirm the issue isn't already in flight.
2. **Check for blockers** — if the description references "blocked by #N",
   coordinate with the maintainer on the blocking issue first.
3. **Confirm dependencies** — frontend issues often depend on backend or
   contract surfaces; verify those interfaces exist before starting.
4. **Comment to claim** — a short "I'd like to work on this" comment so two
   contributors don't duplicate effort.

If the scope feels unclear or the change is large, **ask in the issue thread
before writing code**. A 5-minute clarification beats a 2-day rewrite.

## 2. Project layout

```
vaultquest/
├── backend/                    # Fastify action-ledger + reconciliation service
├── contracts/                  # Soroban smart contracts (Rust)
├── stellar-wallet-connect/     # Drop-in wallet module (React + Astro)
├── services/                   # Shared TypeScript service helpers
├── e2e/                        # Playwright end-to-end tests
├── tests/                      # Cross-cutting test utilities
└── docs/                       # Architecture, state model, testing notes
    └── ARCHITECTURE.md        # Cross-stack architecture diagram
```

Each top-level package has its own `README.md` with stack details and a setup
section — read it before running commands inside that folder.

## 3. Local setup

### Prerequisites

- **Node 20.x** (check with `node --version`)
- **pnpm 9.x** (`npm install -g pnpm` if missing)
- **Rust + Cargo** with the `wasm32-unknown-unknown` target (only needed for
  contract work — `rustup target add wasm32-unknown-unknown`)
- **Postgres 16** (only for backend work — `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16`)

### Bootstrap

```bash
git clone https://github.com/<your-username>/vaultquest.git
cd vaultquest
pnpm install
```

Then follow the per-package setup that matches your issue:

- **Backend**: `cd backend && cp .env.example .env && pnpm exec prisma migrate deploy && pnpm dev`
- **Contracts**: `cd contracts && cargo build && cargo test`
- **Wallet module**: see `stellar-wallet-connect/README.md` for env vars

## 4. Validate before opening a PR

Every PR must show that the change does what the issue asked **and** does not
break anything else. Run the relevant commands for your area:

| Area | Command | What it checks |
|---|---|---|
| Backend | `pnpm --filter backend test` | Vitest suite against real Postgres |
| Backend | `pnpm --filter backend run lint` | ESLint + TypeScript |
| Backend | `pnpm --filter backend exec prisma format` | Prisma schema formatting |
| Frontend | `pnpm test` (root) | Vitest unit tests |
| Frontend | `pnpm run test:smoke:routes` | Critical route smoke tests |
| Frontend | `pnpm run test:e2e` | Full Playwright E2E suite |
| CI / docs | `pnpm run check:terms` | Legacy product name and import guard |
| Contracts | `cargo test` (in `contracts/`) | Soroban contract tests |
| Contracts | `cargo fmt --check && cargo clippy -- -D warnings` | Format + lint |
| Security | `pnpm audit` | Dependency vulnerabilities |
| Security | `trufflehog filesystem .` | Secret scanning |
| Docs | manual preview | Markdown renders correctly on GitHub |

### Auto-fixing lint errors locally

Before pushing, you can auto-fix most lint errors:

```bash
# Fix ESLint errors in the frontend app
pnpm run lint --fix

# Fix ESLint errors in the backend
cd backend && npm run lint --fix

# Fix ESLint errors in the stellar-wallet-connect module
cd stellar-wallet-connect && npm run lint --fix

# Format Rust code in contracts
cd contracts && cargo fmt

# Format with Prettier (if configured)
npx prettier --write "app/**/*.{js,jsx}" "components/**/*.{js,jsx}" "hooks/**/*.{js,ts}" "lib/**/*.{js,ts}"
```

The CI pipeline runs these same checks and fails if any lint errors remain.

If you skip a check, **say so explicitly in the PR description and why** —
that's far more useful than silent gaps.

### Handling False Positives in Secret Scans

If the secret scanner (e.g., TruffleHog or Gitleaks) flags a safe placeholder or a mock value in a test file as a secret, you can handle the false positive by updating the scanner's ignore rules (e.g., using a `.gitleaksignore` file or appending the specific exception to the test suite configuration). Do not commit real secrets to bypass validation.

## 5. Pull request expectations

### Title

Use a conventional prefix: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
`chore:`. Example: `feat(frontend): add transaction timeline component (#63)`.

### Body — copy this checklist into every PR

```markdown
## Summary

Closes #<issue-number>

<1–3 bullet points describing what changed and why>

## Test plan

- [ ] Ran `<the relevant validation commands above>`
- [ ] Manually tested <the user flow this affects>
- [ ] Updated/added tests in <path>

## Screenshots / demo

<UI changes MUST include a before/after screenshot or a short screen recording.
Backend changes that affect a visible surface should include the curl
request + response or an API client screenshot.>

## Notes for the reviewer

<Anything non-obvious: trade-offs you weighed, follow-ups deferred to a
later PR, env vars added, migration order, etc.>
```

### What gets rejected fast

- PRs that close an issue without including `Closes #N` in the body.
- UI PRs with no screenshot or recording.
- "Drive-by" formatting commits unrelated to the issue.
- Changes to `pnpm-lock.yaml` or `Cargo.lock` that aren't motivated by a
  dependency change in the same PR.
- New top-level files added at the repo root without prior discussion.

### What gets merged fast

- A PR that closes exactly the linked issue and nothing more.
- Tests added or updated to cover the new behaviour.
- A short, descriptive commit message body that future-you can read in
  `git log` 6 months from now.
- One round of review feedback addressed in a follow-up commit (don't
  force-push to the same branch — let reviewers see what changed).

## 6. When to ask before starting

Send a short comment in the issue thread *before* writing code if:

- The acceptance criteria are ambiguous or contradict each other.
- The fix appears to span multiple packages (frontend + backend + contract).
- You think the issue description is wrong or out of date.
- You'd need to add a new dependency.
- You'd need to refactor existing public APIs to ship the fix.

Asking saves everyone time — maintainers can redirect you to the right
approach, or split the issue into smaller pieces.

## 7. Accessibility expectations (frontend PRs)

VaultQuest aims for keyboard-navigable, screen-reader-friendly UI. For any
frontend change:

- New interactive elements need `aria-label` or visible text.
- Dialogs use `role="dialog"`, `aria-modal="true"`, trap focus, and restore
  focus on close.
- Icon-only buttons need an accessible name.
- Status messages use `role="status"` (polite) or `role="alert"` (assertive).
- Form controls have associated `<label>` elements.

See `stellar-wallet-connect/src/components/Modal.tsx` for a worked example
of a focus-trapped, ARIA-compliant dialog.

## 8. Code style

- **TypeScript**: prefer `interface` for public component props, `type` for
  unions and aliases. Avoid `any`; use `unknown` when the type is genuinely
  unknown.
- **Imports**: group external → internal → relative; one blank line between
  groups. Don't reorder existing import blocks unless your change touches
  them.
- **Comments**: explain *why*, not *what*. Code already says what.
- **Rust**: run `cargo fmt` before committing; treat clippy warnings as
  errors.

## 9. Getting help

- **Stuck on an issue?** Comment in the issue thread — tag the assignor.
- **Found a security problem?** Email the maintainer privately rather than
  opening a public issue.
- **Want to propose a larger change?** Open a discussion or draft RFC issue
  before writing code.

Thanks for contributing to VaultQuest! 🚀
