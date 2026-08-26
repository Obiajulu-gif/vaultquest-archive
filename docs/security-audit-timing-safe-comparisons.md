# Timing-safe comparison audit (issue #584)

Scope: `backend/src/middleware/auth.ts`, `backend/src/middleware/api-key-auth.ts`,
`backend/src/middleware/service-auth.ts`, plus any secret comparison they
delegate to.

## Method

Searched each file (and the routes that construct their guards) for any
place a secret, API key, token, or signature is compared against an
attacker-influenced value, and classified each site as:

- **safe via library** — comparison is performed by a vetted crypto library
  with its own constant-time verification (no fix needed).
- **needed fixing** — a raw `===`/`!==`/`String.prototype` comparison that
  short-circuits on the first mismatched byte (fixed in this PR).
- **N/A** — no secret comparison present at this site.

## Findings

| Site | Comparison | Verdict | Action |
|---|---|---|---|
| `backend/src/middleware/auth.ts` (`requireAuth`) | `token === "invalid"` | **N/A** | This checks a token against the literal string `"invalid"`, not a secret — it is a placeholder/stub (the comment notes real JWT verification via a library like `jsonwebtoken` is not yet wired in). There is no secret-bearing comparison here to make timing-safe. Flagging the missing real JWT verification is out of scope for this timing-safety issue and should be tracked separately. |
| `backend/src/routes/auth.ts` (`jwt.sign`) | N/A — only signs tokens, never verifies one in this codebase | **N/A** | Signing isn't a comparison. No `jwt.verify()` call exists anywhere in the backend today, so there is no library-based verification path to audit yet either. |
| `backend/src/middleware/api-key-auth.ts` (`requireApiKey`) | Previously a hand-rolled loop (`a.charCodeAt(i) ^ b.charCodeAt(i)`, issue #273) that avoided short-circuiting but was custom crypto | **needed fixing** | Replaced with `timingSafeStringEqual` (SHA-256 digest of both sides, then `crypto.timingSafeEqual`) in `backend/src/utils/timingSafeCompare.ts`, per this issue's ask to standardize on Node's `crypto.timingSafeEqual`. |
| `backend/src/middleware/service-auth.ts` (`requireServiceAuth`) | `provided !== expectedSecret` | **needed fixing** | Raw strict-inequality comparison of the `X-Internal-Secret` header against `INTERNAL_SERVICE_SECRET` — short-circuits on the first differing character. Replaced with `timingSafeStringEqual`. |

## Implementation notes

`crypto.timingSafeEqual` throws if given two buffers of different length,
and comparing raw UTF-8 buffers of attacker-controlled length would leak
the secret's length through a thrown/caught branch (or would require an
early length check that itself is not constant-time). To sidestep both
problems, `backend/src/utils/timingSafeCompare.ts` hashes both operands to
a fixed-length SHA-256 digest first, then compares the two 32-byte digests
with `crypto.timingSafeEqual`. Both `requireApiKey` and `requireServiceAuth`
now use this helper.

## Secret entropy check

- `API_KEY` (`backend/src/env.ts`): validated `min(32)` characters and
  rejected if it matches a placeholder pattern (`PLACEHOLDER`, `YOUR_`,
  `CHANGE-ME`, `EXAMPLE`, `<...>`). Documented in `backend/.env.example`.
- `INTERNAL_SERVICE_SECRET` (`backend/src/env.ts`): validated `min(20)`
  characters and the same placeholder rejection. Documented in
  `backend/.env.example` and `docs/env-inventory.md`.

Both floors are long enough (20+ and 32+ characters of operator-chosen
random text) that, combined with the constant-time comparison fixed here,
brute-forcing the secret byte-by-byte via a timing side channel is not a
practical attack.
