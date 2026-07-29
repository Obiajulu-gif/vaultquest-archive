# VaultQuest Testing Guide

This document outlines the testing infrastructure and how to contribute tests.

## Testing Stack

- **Vitest**: Unit and Integration tests for components and hooks.
- **React Testing Library**: UI testing utilities.
- **Playwright**: E2E, Responsive, and Accessibility testing.
- **Axe Core**: Automated accessibility audits.

For a status map of important covered, partial, and missing areas, see
[`docs/TEST_COVERAGE_MAP.md`](./TEST_COVERAGE_MAP.md).

## Running Tests

### Unit & Integration (Vitest)

```bash
npm test
```

To run in watch mode:
```bash
npm run test:watch
```

### Route Smoke Tests (Playwright)

Route smoke tests live in `e2e/route-smoke.spec.ts`. They cover the initial critical public and app routes:

- `/` — marketing landing page
- `/app` — app dashboard in a disconnected-wallet state
- `/app/prizes` — prizes index in a disconnected-wallet state
- `/app/vaults` — vaults index in a disconnected-wallet state

The app-route tests clear browser storage, mock common wallet globals as disconnected, and fulfill `/api/*` requests with empty fixture data so route-level provider, import, and render failures surface consistently. Test names include the route path so CI failures identify the regressed route.

Run only the route smoke tests:

```bash
pnpm run test:smoke:routes
```

### E2E & Quality Gates (Playwright)

Make sure the dev server is running (or let Playwright start it via `playwright.config.ts`):

```bash
pnpm run test:e2e
```

To see the test results UI:
```bash
pnpm exec playwright test --ui
```

## Mocking Wallet States

We use `wagmi` mocks in `tests/mocks/wagmi.ts`. You can override these in individual tests to simulate different states:

```typescript
import { mockWagmiHooks } from '@/tests/mocks/wagmi';

it('shows error state', () => {
  mockWagmiHooks.useAccount.mockReturnValue({ status: 'error', message: 'Failed to connect' });
  render(<MyComponent />);
  // ...
});
```

## Accessibility (A11y)

E2E tests include automated `axe-core` checks. Ensure all new pages or major UI changes are covered by a Playwright test with `checkA11y`.

## Responsive Design

Playwright is configured to run tests across multiple viewports (Chromium, Webkit, Mobile Chrome, Mobile Safari). Use `isMobile` flag in Playwright tests to handle breakpoint-specific logic.
