# Permission policy preview

Maintainer wallet sessions may POST `/admin/permissions/matrix-preview` with
`{"roles":{"user":["own.data.read"]}}`. The response data contains the live
policy revision and sorted before/after, added and removed permissions for every
role. Supplied roles replace the complete permission list; omitted roles retain
their permissions. Empty lists revoke everything, duplicates are collapsed,
and unknown roles, permissions and fields fail validation. An empty roles object
is rejected. No-op proposals return `changed: false`.

Pass `expected_revision` from a previous preview to detect a changed baseline.
A 409 requires refreshing the preview against the deployed matrix. Requests are
read-only and safe to retry after a network failure. Missing credentials return
401, and users and service identities receive 403 before proposal validation.

The role matrix remains code-defined. This endpoint does not save, approve or
apply a policy, and a preview grants no permissions. Review the returned diff
before deploying a matrix edit; deployment review must recheck the revision.
There is no new policy-write API or database migration. To roll back an applied
matrix edit, restore the prior matrix through the normal deployment workflow.
Removing this endpoint and its dedicated permission rolls back the preview.

The existing `/admin/permissions/preview`, `/report` and `/prepare` APIs retain
their versioned-policy and confirmation-token contracts. The matrix endpoint
provides a separate read-only view of the deployed static RBAC matrix.
