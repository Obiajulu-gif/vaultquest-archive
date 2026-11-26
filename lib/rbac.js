"use strict";
/**
 * Role-based access control definitions (#767).
 *
 * Single source of truth for roles and permissions, shared by the backend
 * (enforcement) and the frontend (hiding/disabling UI). The UI is never the
 * security boundary: every privileged API route re-checks these on the server.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLE_PERMISSIONS = exports.PERMISSIONS = exports.ROLES = void 0;
exports.isRole = isRole;
exports.roleHasPermission = roleHasPermission;
exports.hasPermission = hasPermission;
exports.rolesForWallet = rolesForWallet;
exports.ROLES = ["user", "maintainer", "service"];
exports.PERMISSIONS = [
    "own.data.read",
    "own.data.export",
    "own.data.import",
    // #983: a wallet edits its own records (multi-client saved-pool edits).
    "own.data.write",
    // #812: a wallet reads its own signed receipts; maintainers read any.
    "own.receipts.read",
    "admin.receipts.read",
    // #813: stuck pending-action diagnostics and recovery actions.
    "admin.recovery.read",
    "admin.recovery.write",
    // #814: immutable audit trail query/export.
    "admin.audit_trail.read",
    "admin.audit_trail.export",
    // #815: operation-limit policies, overrides and resets.
    "admin.limits.read",
    "admin.limits.write",
    // Guarded feature-flag rollouts and rollback verification.
    "admin.flags.read",
    "admin.flags.write",
    "admin.audit.read",
    "admin.audit.write",
    "admin.audit.export",
    "admin.ledger.verify",
    "admin.export.any",
    // #791: scoped maintainer impersonation.
    "admin.impersonation.read",
    "admin.impersonation.write",
    "internal.reconcile",
    "internal.checkpoint",
    "internal.trace",
    "internal.analytics.read",
    "internal.reconciliation.propose",
    "internal.reconciliation.approve",
    "internal.reconciliation.execute",
];
const USER_PERMISSIONS = [
    "own.data.read",
    "own.data.export",
    "own.data.import",
    "own.data.write",
    "own.receipts.read",
];
/**
 * Role capability matrix. Maintainers are a strict superset of users; service
 * actors (indexer, reconciler) are machine identities and get only internal
 * permissions.
 */
exports.ROLE_PERMISSIONS = {
    user: USER_PERMISSIONS,
    maintainer: [
        ...USER_PERMISSIONS,
        "admin.audit.read",
        "admin.audit.write",
        "admin.audit.export",
        "admin.ledger.verify",
        "admin.export.any",
        "admin.receipts.read",
        "admin.recovery.read",
        "admin.recovery.write",
        "admin.audit_trail.read",
        "admin.audit_trail.export",
        "admin.limits.read",
        "admin.limits.write",
        "admin.flags.read",
        "admin.flags.write",
        // #791: impersonation — maintainer-only.
        "admin.impersonation.read",
        "admin.impersonation.write",
    ],
    service: [
        "internal.reconcile",
        "internal.checkpoint",
        "internal.trace",
        "internal.analytics.read",
        "internal.reconciliation.propose",
        "internal.reconciliation.approve",
        "internal.reconciliation.execute",
    ],
};
function isRole(value) {
    return typeof value === "string" && exports.ROLES.includes(value);
}
/** True when `role` grants `permission`. Unknown roles grant nothing. */
function roleHasPermission(role, permission) {
    if (!isRole(role))
        return false;
    return exports.ROLE_PERMISSIONS[role].includes(permission);
}
/** True when any of `roles` grants `permission`. */
function hasPermission(roles, permission) {
    return (roles ?? []).some((role) => roleHasPermission(role, permission));
}
/**
 * UI-only hint: the roles a connected wallet is *expected* to hold, given the
 * configured admin allowlist. Mirrors the server's session resolver so the UI
 * can hide or disable actions, but the server remains the only authority.
 */
function rolesForWallet(walletAddress, adminWalletAddresses = []) {
    if (!walletAddress)
        return [];
    const wallet = walletAddress.trim().toLowerCase();
    const isAdmin = adminWalletAddresses.some((a) => a.trim().toLowerCase() === wallet);
    return [isAdmin ? "maintainer" : "user"];
}
//# sourceMappingURL=rbac.js.map