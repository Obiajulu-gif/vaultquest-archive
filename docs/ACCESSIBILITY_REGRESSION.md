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

**Reduced motion:** `lib/usePrefersReducedMotion.ts` follows `(prefers-reduced-motion: reduce)` live.
The components drop spinners, step transitions and framer-motion entrance/layout animations when it is set.

## Edge cases and failure modes
- **jsdom has no layout.** Visual focus rings and contrast are covered by the Playwright/axe suite (`e2e/a11y-components.spec.ts`), not here.
- **Fake timers.** The retry-queue tests set a minimal global `jest` shim; without it Testing Library hangs on a faked `setTimeout(0)`.
- **`react-hot-toast`** is imported by app code but is not a declared dependency. `vitest.config.ts` aliases it to `tests/mocks/react-hot-toast.js`. Remove the alias once the package is added.
- **Labels changed:** Compare buttons are now named `Compare <pool>`/`Selected <pool>` with `aria-pressed`, and watchlist buttons are named `Add <pool> to watchlist`. Their `title`s are unchanged, so title-based selectors keep working.

## Rollback
Every change is additive markup and ARIA, with no API or schema changes. Reverting the commit restores the previous behaviour. If one assertion blocks an urgent fix, mark that single test `it.skip` with an issue link rather than deleting the file.
