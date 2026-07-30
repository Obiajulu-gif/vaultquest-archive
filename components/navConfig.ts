// components/navConfig.ts
// Single source of truth for navbar links.
// Import this in the Navbar component and map over it to render links.

export interface NavItem {
  /** Display label */
  label: string;
  /** Next.js href */
  href: string;
  /** Optional icon name (maps to your icon component/library of choice) */
  icon?: string;
  /** When true, the active check uses an exact path match instead of startsWith */
  exact?: boolean;
}

const navItems: NavItem[] = [
  {
    label: "Dashboard",
    href: "/",
    icon: "LayoutDashboard",
    exact: true,
  },
  {
    label: "Vault",
    href: "/vault",
    icon: "Vault",
  },
  {
    label: "Leaderboard",
    href: "/leaderboard",
    icon: "Trophy",
  },
  {
    label: "History",
    href: "/history",
    icon: "History",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: "Settings",
  },
];

export default navItems;
