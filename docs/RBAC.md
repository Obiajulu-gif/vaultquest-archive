# Role-based access control

Permissions are defined once in [`lib/rbac.ts`](../lib/rbac.ts) and enforced on
the server by `requirePermission` ([`backend/src/middleware/rbac.ts`](../backend/src/middleware/rbac.ts)).
The UI (`components/app/RequirePermission.tsx`) uses the same definitions only to
hide or disable controls. **The UI is not a security boundary**: every privileged
route re-checks the caller's role, so a bypassed UI still gets `401`/`403`.

## Roles

| Role         | Who                                   | How it is established                                                        |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------- |
| `user`       | Any wallet with a valid session       | Server-validated wallet session (`Authorization: Bearer <token>`)            |
| `maintainer` | Wallets on the admin allowlist        | Same session, wallet listed in `ADMIN_WALLET_ADDRESSES` (case-insensitive)   |
| `service`    | Indexer / reconciler (machine actors) | `X-Internal-Secret` header, compared in constant time                        |

A forged or expired token yields no principal (`401`). A valid principal without
the required permission gets `403`. Roles are not interchangeable: a maintainer
session cannot call `/internal/*` and the service secret cannot call `/admin/*`.

## Capability matrix

| Permission                          | user | maintainer | service | Guarded routes                                              |
| ----------------------------------- | :--: | :--------: | :-----: | ----------------------------------------------------------- |
| `own.data.read`                     |  ✅  |     ✅     |         | (reserved for wallet-scoped reads)                          |
| `own.data.export`                   |  ✅  |     ✅     |         | `GET /exports` (own wallet)                                 |
| `own.data.import`                   |  ✅  |     ✅     |         | `POST /imports/saved-pools` (own wallet)                    |
| `admin.export.any`                  |      |     ✅     |         | `GET /exports?wallet=<other>`                               |
| `admin.audit.read`                  |      |     ✅     |         | `GET /admin/audit`                                          |
| `admin.audit.write`                 |      |     ✅     |         | `POST /admin/audit`                                         |
| `admin.audit.export`                |      |     ✅     |         | `GET /admin/audit/export`                                   |
| `admin.ledger.verify`               |      |     ✅     |         | `/admin/ledger/*` (route factory takes a guard)             |
| `internal.reconcile`                |      |            |   ✅    | `POST /internal/reconcile`                                  |
| `internal.checkpoint`               |      |            |   ✅    | `POST /internal/checkpoint`                                 |
| `internal.trace`                    |      |            |   ✅    | `GET /internal/trace/:txHash`                               |
| `internal.reconciliation.propose`   |      |            |   ✅    | `POST /internal/reconciliation/proposals`                   |
| `internal.reconciliation.approve`   |      |            |   ✅    | `POST /internal/reconciliation/proposals/:id/approve`       |
| `internal.reconciliation.execute`   |      |            |   ✅    | `POST /internal/reconciliation/proposals/:id/execute`       |

Maintainers are a strict superset of users.

## Adding a privileged action

1. Add the permission to `PERMISSIONS` and grant it in `ROLE_PERMISSIONS` (`lib/rbac.ts`).
2. Guard the route with `requirePermission("<permission>", [resolvers])`.
3. Add the route to the matrix in `backend/tests/rbac.spec.ts` (missing credentials → 401,
   wrong role → 403, correct role → allowed).
4. Update the table above.

## Known gaps

Routes that are scoped by a `wallet` query parameter without a session
(`/actions`, `/saved-pools`, `/dashboard/*`, `DELETE /actions`) predate this
change and are still unauthenticated; moving them onto `own.data.*` guards is a
follow-up because it changes the client contract.

## Configuration

`ADMIN_WALLET_ADDRESSES` (comma-separated) is the maintainer allowlist. No
migration is required.
