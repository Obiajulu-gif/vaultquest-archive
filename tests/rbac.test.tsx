import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RequirePermission from "@/components/app/RequirePermission";
import { rolesForWallet } from "@/lib/rbac";

describe("rolesForWallet", () => {
  it("returns no roles when disconnected", () => {
    expect(rolesForWallet(null, ["GADMIN"])).toEqual([]);
    expect(rolesForWallet(undefined)).toEqual([]);
  });
  it("maps allowlisted wallets to maintainer, case-insensitively", () => {
    expect(rolesForWallet("gadmin", [" GADMIN "])).toEqual(["maintainer"]);
  });
  it("maps everyone else to user", () => {
    expect(rolesForWallet("GUSER", ["GADMIN"])).toEqual(["user"]);
    expect(rolesForWallet("GUSER")).toEqual(["user"]);
  });
});

describe("<RequirePermission />", () => {
  const action = <button>Approve</button>;

  it("renders children when the role grants the permission", () => {
    render(<RequirePermission permission="admin.audit.read" roles={["maintainer"]}>{action}</RequirePermission>);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("hides children (renders fallback) when denied", () => {
    render(
      <RequirePermission permission="admin.audit.read" roles={["user"]} fallback={<p>Admins only</p>}>
        {action}
      </RequirePermission>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Admins only")).toBeTruthy();
  });

  it("renders nothing by default when denied", () => {
    const { container } = render(
      <RequirePermission permission="internal.reconcile" roles={[]}>{action}</RequirePermission>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("disables children in disable mode", () => {
    const { container } = render(
      <RequirePermission permission="admin.audit.write" roles={["user"]} mode="disable">{action}</RequirePermission>,
    );
    expect(container.querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
    expect((screen.getByRole("button") as HTMLButtonElement).matches(":disabled")).toBe(true);
  });

  it("does not treat a service role as a maintainer", () => {
    render(<RequirePermission permission="admin.audit.read" roles={["service"]}>{action}</RequirePermission>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
