/**
 * Role-based access control definitions (#767).
 *
 * Single source of truth for roles and permissions, shared by the backend
 * (enforcement) and the frontend (hiding/disabling UI). The UI is never the
 * security boundary: every privileged API route re-checks these on the server.
 */

export const ROLES = ["user", "maintainer", "service"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "own.data.read",
  "own.data.export",
  "own.data.import",
  "admin.audit.read",
  "admin.audit.write",
  "admin.audit.export",
  "admin.ledger.verify",
  "admin.export.any",
  "internal.reconcile",
  "internal.checkpoint",
  "internal.trace",
  "internal.reconciliation.propose",
  "internal.reconciliation.approve",
  "internal.reconciliation.execute",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const USER_PERMISSIONS: readonly Permission[] = ["own.data.read", "own.data.export", "own.data.import"];

/**
 * Role capability matrix. Maintainers are a strict superset of users; service
 * actors (indexer, reconciler) are machine identities and get only internal
 * permissions.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  user: USER_PERMISSIONS,
  maintainer: [
    ...USER_PERMISSIONS,
    "admin.audit.read",
    "admin.audit.write",
    "admin.audit.export",
    "admin.ledger.verify",
    "admin.export.any",
  ],
  service: [
    "internal.reconcile",
    "internal.checkpoint",
    "internal.trace",
    "internal.reconciliation.propose",
    "internal.reconciliation.approve",
    "internal.reconciliation.execute",
  ],
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** True when `role` grants `permission`. Unknown roles grant nothing. */
export function roleHasPermission(role: Role | string | null | undefined, permission: Permission): boolean {
  if (!isRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** True when any of `roles` grants `permission`. */
export function hasPermission(
  roles: readonly (Role | string)[] | null | undefined,
  permission: Permission,
): boolean {
  return (roles ?? []).some((role) => roleHasPermission(role, permission));
}

/**
 * UI-only hint: the roles a connected wallet is *expected* to hold, given the
 * configured admin allowlist. Mirrors the server's session resolver so the UI
 * can hide or disable actions, but the server remains the only authority.
 */
export function rolesForWallet(
  walletAddress: string | null | undefined,
  adminWalletAddresses: readonly string[] = [],
): Role[] {
  if (!walletAddress) return [];
  const wallet = walletAddress.trim().toLowerCase();
  const isAdmin = adminWalletAddresses.some((a) => a.trim().toLowerCase() === wallet);
  return [isAdmin ? "maintainer" : "user"];
}
