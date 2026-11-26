# Stable problem details

The central error handler retains the existing problem-details fields and legacy
`error` envelope. Registered codes keep their type URI at
`https://api.vaultquest.io/errors/CODE`, category titles, remediation and timestamp.
Success payloads and HTTP status codes are unchanged.

An explicit `Accept: application/problem+json` selects the problem media type.
Missing Accept, wildcards, q=0, invalid quality values or a higher preference for
application/json retain the JSON media type. Responses include `Vary: Accept`
and preserve existing Retry-After headers.

Unknown framework codes map to stable authorization, missing-resource, conflict,
rate-limit or generic HTTP/internal problem codes. The legacy envelope retains
its existing code mapping. Clients should branch on type or code, never message
text. New codes require catalog entries; existing type URIs must not be renamed.

Internal messages and unsafe detail/issue extensions are suppressed in both
representations. Safe validation errors retain invalid_params and issues.
Occurrence URLs omit query strings to avoid exposing request secrets; use the
error_id for correlation. These redactions intentionally remove unsafe payloads
without changing registered codes or the response envelope.

Authorization failures require signing in or obtaining access. Follow remediation
and Retry-After for retryable failures. Retryability alone does not guarantee a
write can safely be repeated: preserve endpoint idempotency keys and check the
transaction state before retrying writes. Tests cover failures followed by a
successful retry and verify successful responses keep their normal format.

There are no database migrations. Clients can request application/json if the
problem media type causes incompatibilities. Server rollback restores the prior
formatter and handler; stored records and authorization are unaffected. Routes
that directly send error bodies retain their existing contracts and must adopt
the central handler before receiving these formatting guarantees.
