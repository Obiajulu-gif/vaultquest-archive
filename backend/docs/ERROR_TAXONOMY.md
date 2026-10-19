# Error Taxonomy and Remediation Hints

## Overview
Every stable `ErrorCode` (see `backend/src/constants.ts`) maps to one entry in `ERROR_CATALOG` (`backend/src/errorTaxonomy.ts`). The entry decides how the failure is categorised, whether a client may retry it, and what text is safe to show a user. The catalog is the only source of user-facing copy for `internal`, `dependency` and `settlement` failures, so stack traces, SQL and RPC payloads cannot reach the client.

## Descriptor Fields
| Field | Meaning |
|---|---|
| `category` | One of `ERROR_CATEGORIES`: `validation`, `authorization`, `not_found`, `conflict`, `rate_limit`, `wallet`, `settlement`, `dependency`, `internal`. |
| `retryable` | `true` when repeating the same request may succeed without changes. |
| `userMessage` | Safe to show end users verbatim. |
| `recovery` | Optional actionable next step. Required when `retryable` is `true`. |
| `exposeMessage` | When `true`, the caller-supplied message is authored by us for that failure (for example validation) and may be shown instead of `userMessage`. |

## Remediation Hints
The `recovery` text is the remediation hint. It is returned to clients as the `remediation` member of the Problem Details response (`backend/src/problemDetails.ts`) whenever it is set. Write hints as a single imperative step the user or operator can take, for example "Approve the request in your wallet, or start again if you meant to cancel."

## Guarantees
- **Completeness:** `ERROR_CATALOG` is typed as `Record<ErrorCode, ErrorDescriptor>`, so TypeScript rejects a new `ErrorCode` that has no descriptor.
- **Recovery for retries:** every retryable descriptor must have a non-empty `recovery`. This is enforced by `backend/tests/errorTaxonomy.spec.ts`.
- **Unknown codes:** `describeError` returns the internal descriptor for any string that is not a known code, and `isKnownErrorCode` reports `false` for it.
- **Stable codes:** existing `ErrorCode` values are part of the API contract. Add new codes rather than renaming or repurposing existing ones. Clients may branch on the code string.

## Adding or Changing a Code
1. Add the constant to `ERROR_CODES` in `backend/src/constants.ts`. Never reuse a retired value.
2. Add the matching `ERROR_CATALOG` entry with a category, `retryable`, `userMessage` and, when retryable, `recovery`.
3. Run `backend/tests/errorTaxonomy.spec.ts`, which checks the catalog is complete and that retryable codes carry guidance.
4. If the failure is not user-facing, keep `exposeMessage: false` so the catalog message is used.

## Operational Edge Cases
- **Changing `recovery` text** is safe for clients. Changing `retryable` or `category` changes client retry and alerting behaviour, so treat it as a contract change and note it in the PR.
- **Rate-limit errors** point users at the `Retry-After` header. Do not hard-code a wait time into `recovery`.
- **Rollback:** the catalog is code only and has no database state. Reverting a commit restores the previous copy and codes. Clients that already received a removed code's string will see it disappear from future responses, so prefer deprecating a code over deleting it.

## Files
- `backend/src/constants.ts` - `ERROR_CODES`
- `backend/src/errorTaxonomy.ts` - `ERROR_CATALOG`, `describeError`, `toUserSafeError`
- `backend/src/problemDetails.ts` - maps `recovery` to `remediation`
- `backend/tests/errorTaxonomy.spec.ts` - catalog completeness and retry-guidance tests
