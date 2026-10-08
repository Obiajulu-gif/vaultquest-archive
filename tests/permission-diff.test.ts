import { describe, it, expect } from "vitest";
import {
  computePermissionDiff,
  PermissionDiffDeniedError,
  StalePolicyInputError,
  type RolePolicy,
  preparePolicyChange,
  PermissionConfirmationRequiredError,
} from "../lib/permission-diff";
import { ROLE_PERMISSIONS } from "../lib/rbac";

describe("Permission Diff Preview (#863)", () => {
  const basePolicy: RolePolicy = {
    version: 1,
    roles: {
      user: [...ROLE_PERMISSIONS.user],
      maintainer: [...ROLE_PERMISSIONS.maintainer],
      service: [...ROLE_PERMISSIONS.service],
    },
  };

  it("handles a no-op change (no permission added or removed)", () => {
    const proposedPolicy: RolePolicy = {
      version: 2,
      roles: {
        user: [...ROLE_PERMISSIONS.user],
        maintainer: [...ROLE_PERMISSIONS.maintainer],
        service: [...ROLE_PERMISSIONS.service],
      },
    };

    const preview = computePermissionDiff({
      actorRoles: ["maintainer"],
      currentPolicy: basePolicy,
      proposedPolicy,
    });

    expect(preview.isNoOp).toBe(true);
    expect(preview.requiresConfirmation).toBe(false);
    expect(preview.summary.totalAdded).toBe(0);
    expect(preview.summary.totalRemoved).toBe(0);
    expect(preview.summary.rolesModified).toEqual([]);
  });

  it("computes narrow changes without requiring broad confirmation", () => {
    const proposedPolicy: RolePolicy = {
      version: 2,
      roles: {
        ...basePolicy.roles,
        user: [...basePolicy.roles.user, "admin.receipts.read"],
      },
    };

    const preview = computePermissionDiff({
      actorRoles: ["maintainer"],
      currentPolicy: basePolicy,
      proposedPolicy,
    });

    expect(preview.isNoOp).toBe(false);
    expect(preview.requiresConfirmation).toBe(false);
    expect(preview.summary.totalAdded).toBe(1);
    expect(preview.summary.totalRemoved).toBe(0);
    expect(preview.summary.rolesModified).toEqual(["user"]);

    const userDiff = preview.diffs.find((d) => d.role === "user");
    expect(userDiff?.addedPermissions).toEqual(["admin.receipts.read"]);
  });

  it("flags broad changes and requires explicit confirmation when granting critical permissions to user role", () => {
    const proposedPolicy: RolePolicy = {
      version: 2,
      roles: {
        ...basePolicy.roles,
        user: [...basePolicy.roles.user, "admin.audit.write"],
      },
    };

    const preview = computePermissionDiff({
      actorRoles: ["maintainer"],
      currentPolicy: basePolicy,
      proposedPolicy,
    });

    expect(preview.isNoOp).toBe(false);
    expect(preview.isBroadChange).toBe(true);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.confirmationReason).toContain("Granting critical administrative permission");
  });

  it("throws PermissionDiffDeniedError when actor lacks maintainer role", () => {
    const proposedPolicy: RolePolicy = { version: 2, roles: basePolicy.roles };

    expect(() =>
      computePermissionDiff({
        actorRoles: ["user"],
        currentPolicy: basePolicy,
        proposedPolicy,
      })
    ).toThrow(PermissionDiffDeniedError);
  });

  it("throws StalePolicyInputError when proposed policy version is stale", () => {
    const staleProposedPolicy: RolePolicy = {
      version: 1, // Same as current version (1)
      roles: basePolicy.roles,
    };

    expect(() =>
      computePermissionDiff({
        actorRoles: ["maintainer"],
        currentPolicy: basePolicy,
        proposedPolicy: staleProposedPolicy,
      })
    ).toThrow(StalePolicyInputError);
  });
});

describe("Permission change preparation", () => {
  const currentPolicy: RolePolicy = { version: 4, roles: {
    user: ["own.data.read"], auditor: ["admin.audit.read"],
  }, actors: { alice: ["user", "auditor"], bob: ["user"] } };
  const options = (proposedPolicy: RolePolicy) => ({ actorRoles: ["maintainer"], currentPolicy, proposedPolicy, baseVersion: 4 });

  it("shows removed permissions, affected scopes and actors with effective role unions", () => {
    const proposedPolicy: RolePolicy = { ...currentPolicy, version: 5, roles: { ...currentPolicy.roles, auditor: [] } };
    const diff = computePermissionDiff(options(proposedPolicy));
    expect(diff.diffs.find((d) => d.role === "auditor")).toMatchObject({
      removedPermissions: ["admin.audit.read"], affectedScopes: ["admin.audit"], affectedActors: ["alice"],
    });
    expect(diff.actorDiffs).toHaveLength(1);
    expect(diff.actorDiffs[0].removedPermissions).toEqual(["admin.audit.read"]);
  });

  it("detects assignment-only changes and does not count redundant role grants", () => {
    const proposedPolicy = { ...currentPolicy, version: 5, actors: { ...currentPolicy.actors, alice: ["user"] } };
    expect(computePermissionDiff(options(proposedPolicy)).isNoOp).toBe(false);
    const redundant = { ...currentPolicy, version: 5, actors: { ...currentPolicy.actors, alice: ["user", "auditor", "auditor"] } };
    expect(computePermissionDiff(options(redundant)).isNoOp).toBe(true);
  });

  it("enforces content-bound confirmation for critical changes on custom roles", () => {
    const proposedPolicy: RolePolicy = { ...currentPolicy, version: 5, roles: { ...currentPolicy.roles, auditor: ["admin.audit.write"] } };
    const input = options(proposedPolicy);
    const preview = computePermissionDiff(input);
    expect(() => preparePolicyChange(input)).toThrow(PermissionConfirmationRequiredError);
    expect(preparePolicyChange({ ...input, confirmationToken: preview.confirmationToken })).toEqual(proposedPolicy);
    const edited = { ...input, proposedPolicy: { ...proposedPolicy, roles: { ...proposedPolicy.roles, auditor: ["admin.export.any" as const] } } };
    expect(() => preparePolicyChange({ ...edited, confirmationToken: preview.confirmationToken })).toThrow(PermissionConfirmationRequiredError);
  });

  it("rejects stale base revisions even when the proposed version is higher", () => {
    const proposedPolicy = { ...currentPolicy, version: 5 };
    expect(() => preparePolicyChange({ ...options(proposedPolicy), baseVersion: 3 })).toThrow(StalePolicyInputError);
    expect(() => preparePolicyChange({ ...options(proposedPolicy), actorRoles: ["user"] })).toThrow(PermissionDiffDeniedError);
  });

  it("requires confirmation when a role change affects ten actors", () => {
    const actors = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`wallet-${i}`, ["user"]]));
    const input = options({ ...currentPolicy, version: 5, actors, roles: { ...currentPolicy.roles, user: ["own.data.read", "own.data.export"] } });
    input.currentPolicy = { ...currentPolicy, actors };
    expect(computePermissionDiff(input).requiresConfirmation).toBe(true);
  });

  it("rejects unknown permissions and invalid actor assignments", () => {
    expect(() => computePermissionDiff(options(JSON.parse('{"version":5,"roles":{"user":["made.up"]}}')))).toThrow("Unknown permission");
    expect(() => computePermissionDiff(options({ ...currentPolicy, version: 5, actors: { alice: ["missing"] } }))).toThrow("unknown role");
  });
});
