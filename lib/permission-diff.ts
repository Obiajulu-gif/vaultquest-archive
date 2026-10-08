/**
 * Permission Diff Preview for Role and Policy Changes (#863).
 *
 * Provides before/after permission diff computation, impact analysis on affected
 * actors and actions, and explicit confirmation requirements for broad changes.
 */

import { type Permission, PERMISSIONS } from "./rbac";

export interface RolePolicy {
  version: number;
  roles: Record<string, Permission[]>;
  /** Trusted actor inventory. Effective grants are unions of assigned roles. */
  actors?: Record<string, string[]>;
}

export interface PermissionDiffItem {
  role: string;
  addedPermissions: Permission[];
  removedPermissions: Permission[];
  unchangedPermissions: Permission[];
  affectedActions: string[];
  affectedScopes: string[];
  affectedActors: string[];
}

export interface PermissionDiffPreview {
  currentVersion: number;
  proposedVersion: number;
  diffs: PermissionDiffItem[];
  isNoOp: boolean;
  isBroadChange: boolean;
  requiresConfirmation: boolean;
  confirmationReason?: string;
  /** Content-bound confirmation, not an authorization credential. */
  confirmationToken: string;
  actorDiffs: Array<{ actor: string; addedPermissions: Permission[]; removedPermissions: Permission[]; affectedActions: string[]; affectedScopes: string[] }>;
  summary: {
    totalAdded: number;
    totalRemoved: number;
    rolesModified: string[];
  };
}

export class PermissionDiffDeniedError extends Error {
  constructor(message: string = "Actor is not authorized to preview or apply policy diffs.") {
    super(message);
    this.name = "PermissionDiffDeniedError";
  }
}

export class StalePolicyInputError extends Error {
  constructor(currentVersion: number, providedVersion: number) {
    super(
      `Stale policy input: current active policy version is ${currentVersion}, but provided base version is ${providedVersion}.`
    );
    this.name = "StalePolicyInputError";
  }
}

/** Critical permissions that trigger broad change confirmation when added to non-service/user roles. */
export const CRITICAL_PERMISSIONS: Permission[] = [
  "admin.audit.write",
  "admin.audit.export",
  "admin.export.any",
  "admin.recovery.write",
  "admin.impersonation.write",
  "admin.limits.write",
  "internal.reconciliation.execute",
  "internal.reconcile",
  "internal.checkpoint",
  "admin.audit_trail.export",
];

/**
 * Maps permissions to user-visible actions for impact assessment.
 */
export function getAffectedActions(permission: string): string[] {
  switch (permission) {
    case "own.data.read":
      return ["Read user profile and private data"];
    case "own.data.export":
      return ["Export personal records payload"];
    case "own.data.import":
      return ["Import saved pool watchlists"];
    case "own.receipts.read":
      return ["View personal transaction receipts"];
    case "admin.audit.read":
      return ["View protocol parameters audit trail"];
    case "admin.audit.write":
      return ["Modify protocol parameters and records"];
    case "admin.audit.export":
      return ["Export protocol audit logs"];
    case "admin.export.any":
      return ["Export any user's private data payload"];
    case "admin.recovery.read":
      return ["View pending-action recovery state"];
    case "admin.recovery.write":
      return ["Execute manual action recovery & overrides"];
    case "admin.impersonation.read":
      return ["View active impersonation sessions"];
    case "admin.impersonation.write":
      return ["Initiate maintainer impersonation session"];
    default:
      return [`Perform action guarded by '${permission}'`];
  }
}

export interface ComputePermissionDiffOptions {
  actorRoles: string[];
  currentPolicy: RolePolicy;
  proposedPolicy: RolePolicy;
  baseVersion?: number;
}

function canonicalPolicy(policy: RolePolicy): string {
  return JSON.stringify({ version: policy.version,
    roles: Object.keys(policy.roles).sort().map((role) => [role, [...new Set(policy.roles[role])].sort()]),
    actors: Object.keys(policy.actors ?? {}).sort().map((actor) => [actor, [...new Set(policy.actors![actor])].sort()]),
  });
}

export class InvalidPolicyError extends Error {}

function validatePolicy(policy: RolePolicy): void {
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) throw new InvalidPolicyError("Invalid policy version.");
  for (const permissions of Object.values(policy.roles)) {
    if (!Array.isArray(permissions) || permissions.some((p) => !(PERMISSIONS as readonly string[]).includes(p))) {
      throw new InvalidPolicyError("Unknown permission in policy.");
    }
  }
  for (const roles of Object.values(policy.actors ?? {})) {
    if (!Array.isArray(roles) || roles.some((r) => !Object.hasOwn(policy.roles, r))) {
      throw new InvalidPolicyError("Actor assignment references an unknown role.");
    }
  }
}

function actorPermissions(policy: RolePolicy, actor: string): Permission[] {
  return [...new Set((policy.actors?.[actor] ?? []).flatMap((r) => policy.roles[r] ?? []))].sort();
}

/**
 * Compute the permission diff preview between current and proposed role policies.
 *
 * @throws {PermissionDiffDeniedError} if actor lacks maintainer role
 * @throws {StalePolicyInputError} if proposed policy is based on an outdated version
 */
export function computePermissionDiff(
  options: ComputePermissionDiffOptions
): PermissionDiffPreview {
  const { actorRoles, currentPolicy, proposedPolicy } = options;

  // Authorization check: Actor must have maintainer role
  if (!actorRoles.includes("maintainer")) {
    throw new PermissionDiffDeniedError();
  }
  validatePolicy(currentPolicy);
  validatePolicy(proposedPolicy);

  // Stale policy input check
  if ((options.baseVersion !== undefined && options.baseVersion !== currentPolicy.version) ||
      proposedPolicy.version !== currentPolicy.version + 1) {
    throw new StalePolicyInputError(currentPolicy.version, proposedPolicy.version);
  }

  const allRoles = Array.from(
    new Set([...Object.keys(currentPolicy.roles), ...Object.keys(proposedPolicy.roles)])
  ).sort();
  const actors = [...new Set([...Object.keys(currentPolicy.actors ?? {}), ...Object.keys(proposedPolicy.actors ?? {})])].sort();
  const actorDiffs = actors.flatMap((actor) => {
    const before = actorPermissions(currentPolicy, actor);
    const after = actorPermissions(proposedPolicy, actor);
    const addedPermissions = after.filter((p) => !before.includes(p));
    const removedPermissions = before.filter((p) => !after.includes(p));
    const changed = [...addedPermissions, ...removedPermissions];
    return changed.length ? [{ actor, addedPermissions, removedPermissions,
      affectedActions: [...new Set(changed.flatMap(getAffectedActions))],
      affectedScopes: [...new Set(changed.map((p) => p.split(".").slice(0, -1).join(".")))].sort(),
    }] : [];
  });

  const diffs: PermissionDiffItem[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  const rolesModified: string[] = [];
  let hasBroadChange = false;
  const confirmationReasons: string[] = [];

  for (const role of allRoles) {
    const currentPerms = new Set(Object.hasOwn(currentPolicy.roles, role) ? currentPolicy.roles[role] ?? [] : []);
    const proposedPerms = new Set(Object.hasOwn(proposedPolicy.roles, role) ? proposedPolicy.roles[role] ?? [] : []);

    const added = Array.from(proposedPerms).filter((p) => !currentPerms.has(p as Permission)) as Permission[];
    const removed = Array.from(currentPerms).filter((p) => !proposedPerms.has(p as Permission)) as Permission[];
    const unchanged = Array.from(currentPerms).filter((p) => proposedPerms.has(p as Permission)) as Permission[];

    if (added.length > 0 || removed.length > 0) {
      rolesModified.push(role);
      totalAdded += added.length;
      totalRemoved += removed.length;

      const affectedActions = Array.from(
        new Set([...added.flatMap(getAffectedActions), ...removed.flatMap(getAffectedActions)])
      );

      diffs.push({
        role,
        addedPermissions: added,
        removedPermissions: removed,
        unchangedPermissions: unchanged,
        affectedActions,
        affectedScopes: [...new Set([...added, ...removed].map((p) => p.split(".").slice(0, -1).join(".")))].sort(),
        affectedActors: actorDiffs.filter((a) =>
          (currentPolicy.actors?.[a.actor] ?? []).includes(role) || (proposedPolicy.actors?.[a.actor] ?? []).includes(role),
        ).map((a) => a.actor),
      });

      // Broad change check 1: Adding critical permissions to 'user' or non-admin roles
      const addedCritical = added.filter((p) => CRITICAL_PERMISSIONS.includes(p));
      if (addedCritical.length > 0) {
        hasBroadChange = true;
        confirmationReasons.push(
          `Granting critical administrative permission(s) [${addedCritical.join(", ")}] to '${role}' role.`
        );
      }

      // Broad change check 2: Removing core permissions from user
      if (role === "user" && removed.includes("own.data.read")) {
        hasBroadChange = true;
        confirmationReasons.push("Revoking core data access permission 'own.data.read' from user role.");
      }

      // Broad change check 3: High volume change (> 3 changes on a single role)
      if (added.length + removed.length > 3) {
        hasBroadChange = true;
        confirmationReasons.push(`High volume policy modification (${added.length + removed.length} changes) on role '${role}'.`);
      }
    } else {
      diffs.push({
        role,
        addedPermissions: [],
        removedPermissions: [],
        unchangedPermissions: unchanged,
        affectedActions: [],
        affectedScopes: [],
        affectedActors: [],
      });
    }
  }

  if (totalAdded + totalRemoved > 3 || actorDiffs.length >= 10 ||
      actorDiffs.some((a) => a.addedPermissions.some((p) => CRITICAL_PERMISSIONS.includes(p)) || a.removedPermissions.includes("own.data.read"))) {
    hasBroadChange = true;
    confirmationReasons.push("Broad aggregate or actor permission impact.");
  }
  const isNoOp = totalAdded === 0 && totalRemoved === 0 && actorDiffs.length === 0;

  return {
    currentVersion: currentPolicy.version,
    proposedVersion: proposedPolicy.version,
    diffs,
    isNoOp,
    actorDiffs,
    confirmationToken: JSON.stringify([canonicalPolicy(currentPolicy), canonicalPolicy(proposedPolicy)]),
    isBroadChange: hasBroadChange,
    requiresConfirmation: hasBroadChange,
    confirmationReason: confirmationReasons.length > 0 ? confirmationReasons.join(" ") : undefined,
    summary: {
      totalAdded,
      totalRemoved,
      rolesModified,
    },
  };
}

export class PermissionConfirmationRequiredError extends Error {
  constructor() {
    super("Explicit confirmation of the current permission preview is required.");
    this.name = "PermissionConfirmationRequiredError";
  }
}

/** Recompute against the authoritative current policy immediately before persistence. */
export function preparePolicyChange(options: ComputePermissionDiffOptions & {
  baseVersion: number;
  confirmationToken?: string;
}): RolePolicy {
  const preview = computePermissionDiff(options);
  if (preview.requiresConfirmation && options.confirmationToken !== preview.confirmationToken) {
    throw new PermissionConfirmationRequiredError();
  }
  return structuredClone(options.proposedPolicy);
}
