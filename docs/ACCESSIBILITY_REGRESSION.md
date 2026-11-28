# Accessibility Regression Coverage

`app/tests/a11y-regression.spec.tsx` and `app/tests/a11y-async-states.spec.tsx` (run with `pnpm test`) lock in keyboard, focus,
screen-reader, error-announcement, async status, and reduced-motion behaviour for core flows.

| Flow | Component | Protected behaviour |
|---|---|---|
| Dense form | `PoolCreationForm` | Labelled controls, `aria-required`; visual tab order; on invalid submit focus moves to the first invalid field, each field gets `aria-invalid` + `aria-describedby` to its error, one summary `role="alert"`; focus moves to the step heading on step change; failed submit shows an in-page alert and keeps values; submitting is a busy `role="status"` |
| Data table | `VaultComparisonTable` | Caption, column and row headers; sort headers are buttons (Tab + Enter/Space); `aria-sort` follows the sort; sort changes announced politely (never on first render); per-row controls have unique names |
| Error recovery | `VaultRetryQueue` | Retry/Dismiss names say which action (visible text first, WCAG 2.5.3); error text is the Retry button's description; outcomes announced (polite for resolved/submitted/backoff, assertive for exhausted), countdown ticks are not; focus stays in the queue when a row or its Retry button disappears; "cleared" is announced even after the queue unmounts |
| Modal & Async | `DepositModal` | Dialog semantics (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`); focus trap (Tab/Shift+Tab cycle); focus restored to trigger on close; step headings receive focus on transition; loading state has `role="status"`, `aria-live="polite"`, `aria-busy="true"`; validation and execution failures expose `role="alert"`, `aria-live="assertive"`, `aria-invalid`, `aria-describedby`; accessible keyboard retry; disconnected wallet authorization warning |
| Conflict resolution | `ConflictResolutionUI` | State modification alerts (`role="alert"`), `aria-busy` indicator during resolution, keyboard-operable refresh and dismiss actions |
| Wallet transaction progress (#1133) | `TransactionTimeline` (wallet module, used by `PoolDetail` and `RewardHistory` for join/drip/claim/withdraw) | Each step reads its state ("completed", "in progress", "not started", "failed") instead of relying on colour and hidden icons; the current step has `aria-current="step"`; one polite `role="status"` line announces the current step or "Transaction confirmed"; failures go to a `role="alert"` line naming the failed step and reason (a declined signature reads "failed at Awaiting signature"); explorer link, Close and Retry are reachable in that order and work with Enter/Space; after Retry the alert clears and the new step is announced. Tested in `stellar-wallet-connect/src/components/TransactionTimeline.test.tsx` (run with `npx vitest run` in `stellar-wallet-connect`) |

**Reduced motion:** `lib/usePrefersReducedMotion.ts` follows `(prefers-reduced-motion: reduce)` live.
The components drop spinners, step transitions and framer-motion entrance/layout animations when it is set.

## Edge cases and failure modes
- **jsdom has no layout.** Visual focus rings and contrast are covered by the Playwright/axe suite (`e2e/a11y-components.spec.ts`), not here.
- **Fake timers.** The retry-queue tests set a minimal global `jest` shim; without it Testing Library hangs on a faked `setTimeout(0)`.
- **`react-hot-toast`** is imported by app code but is not a declared dependency. `vitest.config.ts` aliases it to `tests/mocks/react-hot-toast.js`. Remove the alias once the package is added.
- **Labels changed:** Compare buttons are now named `Compare <pool>`/`Selected <pool>` with `aria-pressed`, and watchlist buttons are named `Add <pool> to watchlist`. Their `title`s are unchanged, so title-based selectors keep working.
- **`TransactionTimeline` roles changed (#1133):** the card used to be one `role="status"` live region holding the buttons and all six steps, so every change re-read the whole card and failures were only polite. The card is now a named region with the same names ("Transaction in progress" / "completed" / "failed"); select it with `getByRole("region", { name })`. The status and alert lines are always in the DOM and empty when unused, so assistive tech is already tracking them when text appears. On success every step now shows as completed, and on failure the steps before the failed one show as completed (previously the final step kept a spinner on success and earlier steps went grey on failure).

## Rollback
Every change is additive markup and ARIA, with no API or schema changes. Reverting the commit restores the previous behaviour. If one assertion blocks an urgent fix, mark that single test `it.skip` with an issue link rather than deleting the file.
