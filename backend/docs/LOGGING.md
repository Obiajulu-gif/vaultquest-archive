# Backend logging privacy

Use structured, low-cardinality event fields. The createLogger factory redacts
identity, transaction, wallet, user-controlled payload, URL, and network
address fields at serialization time, including one-level nested objects.
Keep the correlation_id field for request tracing; the request middleware
accepts only bounded opaque characters and generates a UUID when the incoming
value is invalid or oversized.

Do not copy identifiers or request values into the log message string: field
redaction cannot sanitize free-form prose. Prefer a stable event name, an
allowlisted enum, a bounded count, status code, duration, and the correlation
ID. If a specific identifier is essential for an investigation, use a
separately reviewed keyed/pseudonymous correlation mechanism rather than
logging it raw. Never log credentials, request bodies, database URLs, wallet
addresses, transaction hashes, email addresses, or arbitrary error details.

Tests in backend/tests/logger.spec.ts assert that sensitive fields are
redacted while the correlation ID remains available.
