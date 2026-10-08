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

## Permission Diff Preview (#863)

Before applying role, policy, or access updates, maintainers must preview the computed permission diff (`computePermissionDiff` in [`lib/permission-diff.ts`](../lib/permission-diff.ts)).

The preview:
- Identifies added, removed, and unchanged permissions per role.
- Lists affected actions and user-facing capabilities.
- Requires explicit confirmation (`requiresConfirmation: true`) for broad changes (e.g. granting critical admin permissions to user roles, high-volume role modifications, or revoking core user permissions).
- Protects against unauthorized actors (`PermissionDiffDeniedError`) and stale policy inputs (`StalePolicyInputError`).

Maintainers can POST to `/admin/permissions/preview` using their wallet session:

```json
{
  "baseVersion": 1,
  "proposedPolicy": {
    "version": 2,
    "roles": { "user": ["own.data.read"] }
  }
}
```

Supply the complete role matrix: omitted roles revoke their grants. Responses
include added/removed permissions, affected scopes/actions, and effective actor
diffs when an actor inventory is supplied by the policy provider. Actor grants
are the union of their assigned roles, so redundant grants are not counted.
The default provider previews the existing static `ROLE_PERMISSIONS` matrix at
version 1. It has no actor inventory; it does not guess session identities.

POST the same body to `/admin/permissions/prepare` to obtain a validated
deployment candidate. Broad changes require the `confirmationToken` from the
exact preview in the body. The token binds both complete policies and is an
explicit acknowledgement, not an authorization credential. Changed proposals
invalidate it. A stale base revision or missing confirmation returns 409;
unauthenticated/non-maintainer callers receive 401/403.

Broad changes include critical grants on any role, revoking core user reads,
more than three aggregate permission changes, or changes affecting ten actors.
`preparePolicyChange` rechecks authorization, revision and confirmation before
returning an isolated candidate. Custom persistence adapters must reload their
authoritative policy and use an atomic compare-and-swap on `baseVersion` when
writing it. The configured RBAC matrix remains code-managed; preparation
returns `activated: false` and requires the normal reviewed deployment to take
effect. No runtime permission switching, migration or configuration is added.

Validation: `pnpm exec vitest run --config vitest.config.ts tests/permission-diff.test.ts`
and `pnpm --dir backend exec vitest run tests/permission-preview.spec.ts`.

