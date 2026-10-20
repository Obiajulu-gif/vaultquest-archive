import React from "react";
import { hasPermission, type Permission, type Role } from "@/lib/rbac";

type RequirePermissionProps = {
  permission: Permission;
  /** Roles of the current viewer (see `rolesForWallet`). */
  roles: readonly (Role | string)[];
  /**
   * `hide` (default) renders `fallback`; `disable` renders children inside a
   * disabled, inert fieldset so buttons/inputs can't be operated.
   */
  mode?: "hide" | "disable";
  fallback?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * Hides or disables UI the viewer isn't permitted to use (#767). This is a
 * usability layer only: every privileged API route re-checks permissions on
 * the server, so bypassing this component grants nothing.
 */
export default function RequirePermission({
  permission,
  roles,
  mode = "hide",
  fallback = null,
  children,
}: RequirePermissionProps) {
  if (hasPermission(roles, permission)) return <>{children}</>;
  if (mode === "disable") {
    return (
      <fieldset disabled aria-disabled="true" title="You don't have permission to do this" className="contents">
        {children}
      </fieldset>
    );
  }
  return <>{fallback}</>;
}
