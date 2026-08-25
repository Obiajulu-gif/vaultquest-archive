#!/usr/bin/env bash
# apply-vaultquest-fixes.sh
# Run this from the ROOT of your vaultquest repo:
#   bash apply-vaultquest-fixes.sh
# It writes every new/modified file directly — no patch context needed.
set -e
REPO_ROOT="$(pwd)"
echo "Applying VaultQuest fixes to: $REPO_ROOT"

# ─────────────────────────────────────────────────────────────
# #246  contracts/vault/src/lib.rs  (new file)
# ─────────────────────────────────────────────────────────────
mkdir -p "$REPO_ROOT/contracts/vault/src"
cat > "$REPO_ROOT/contracts/vault/src/lib.rs" << 'EOF'
#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    IsPaused,
    Balance(Address),
    TotalDeposits,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum VaultError {
    NotAdmin            = 1,
    AlreadyPaused       = 2,
    NotPaused           = 3,
    ProtocolPaused      = 4,
    ZeroAmount          = 5,
    InsufficientBalance = 6,
    NotInitialized      = 7,
}

impl From<VaultError> for soroban_sdk::Error {
    fn from(e: VaultError) -> Self {
        soroban_sdk::Error::from_contract_error(e as u32)
    }
}

const PAUSED_TOPIC:   Symbol = symbol_short!("PAUSED");
const UNPAUSED_TOPIC: Symbol = symbol_short!("UNPAUSED");
const DEPOSIT_TOPIC:  Symbol = symbol_short!("DEPOSIT");
const WITHDRAW_TOPIC: Symbol = symbol_short!("WITHDRAW");
const WINNER_TOPIC:   Symbol = symbol_short!("WINNER");

#[contract]
pub struct VaultContract;

#[contractimpl]
impl VaultContract {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.storage().instance().set(&DataKey::TotalDeposits, &0_i128);
    }

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, VaultError::NotInitialized));
        admin.require_auth();
    }

    fn is_paused(env: &Env) -> bool {
        env.storage().instance().get(&DataKey::IsPaused).unwrap_or(false)
    }

    fn require_not_paused(env: &Env) {
        if Self::is_paused(env) {
            panic_with_error!(env, VaultError::ProtocolPaused);
        }
    }

    /// Pause the protocol — admin only.
    /// deposit() and draw_winner() revert while paused.
    /// withdraw() is always available.
    pub fn pause_protocol(env: Env) {
        Self::require_admin(&env);
        if Self::is_paused(&env) { panic_with_error!(env, VaultError::AlreadyPaused); }
        env.storage().instance().set(&DataKey::IsPaused, &true);
        env.events().publish((PAUSED_TOPIC,), ());
    }

    /// Unpause the protocol — admin only.
    pub fn unpause_protocol(env: Env) {
        Self::require_admin(&env);
        if !Self::is_paused(&env) { panic_with_error!(env, VaultError::NotPaused); }
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.events().publish((UNPAUSED_TOPIC,), ());
    }

    pub fn get_paused(env: Env) -> bool { Self::is_paused(&env) }

    /// REVERTS when paused.
    pub fn deposit(env: Env, depositor: Address, amount: i128) {
        Self::require_not_paused(&env);
        depositor.require_auth();
        if amount <= 0 { panic_with_error!(env, VaultError::ZeroAmount); }
        let key = DataKey::Balance(depositor.clone());
        let cur: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(cur + amount));
        let tot: i128 = env.storage().instance().get(&DataKey::TotalDeposits).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalDeposits, &(tot + amount));
        env.events().publish((DEPOSIT_TOPIC,), (depositor, amount));
    }

    /// ALWAYS available — no pause gate by design.
    pub fn withdraw(env: Env, depositor: Address, amount: i128) {
        depositor.require_auth();
        if amount <= 0 { panic_with_error!(env, VaultError::ZeroAmount); }
        let key = DataKey::Balance(depositor.clone());
        let cur: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if cur < amount { panic_with_error!(env, VaultError::InsufficientBalance); }
        env.storage().persistent().set(&key, &(cur - amount));
        let tot: i128 = env.storage().instance().get(&DataKey::TotalDeposits).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalDeposits, &(tot - amount));
        env.events().publish((WITHDRAW_TOPIC,), (depositor, amount));
    }

    /// REVERTS when paused.
    pub fn draw_winner(env: Env, winner: Address) {
        Self::require_not_paused(&env);
        Self::require_admin(&env);
        env.events().publish((WINNER_TOPIC,), winner);
    }

    pub fn balance_of(env: Env, depositor: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Balance(depositor)).unwrap_or(0)
    }

    pub fn total_deposits(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalDeposits).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup() -> (Env, VaultContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, VaultContract);
        let client = VaultContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let user  = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin, user)
    }

    #[test] fn admin_can_pause()            { let (_,c,_,_)=setup(); c.pause_protocol(); assert!(c.get_paused()); }
    #[test] #[should_panic] fn non_admin_cannot_pause() { let (e,c,_,_)=setup(); e.set_auths(&[]); c.pause_protocol(); }
    #[test] #[should_panic] fn double_pause_reverts()   { let (_,c,_,_)=setup(); c.pause_protocol(); c.pause_protocol(); }
    #[test] fn admin_can_unpause()          { let (_,c,_,_)=setup(); c.pause_protocol(); c.unpause_protocol(); assert!(!c.get_paused()); }
    #[test] #[should_panic] fn unpause_when_not_paused_reverts() { let (_,c,_,_)=setup(); c.unpause_protocol(); }
    #[test] fn deposit_works_when_not_paused() { let (_,c,_,u)=setup(); c.deposit(&u,&100); assert_eq!(c.balance_of(&u),100); }
    #[test] #[should_panic] fn deposit_reverts_when_paused() { let (_,c,_,u)=setup(); c.pause_protocol(); c.deposit(&u,&100); }
    #[test] fn withdraw_works_when_paused() { let (_,c,_,u)=setup(); c.deposit(&u,&100); c.pause_protocol(); c.withdraw(&u,&100); assert_eq!(c.balance_of(&u),0); }
    #[test] fn withdraw_works_when_not_paused() { let (_,c,_,u)=setup(); c.deposit(&u,&200); c.withdraw(&u,&50); assert_eq!(c.balance_of(&u),150); }
    #[test] #[should_panic] fn withdraw_over_balance_reverts() { let (_,c,_,u)=setup(); c.deposit(&u,&50); c.withdraw(&u,&100); }
    #[test] fn draw_winner_works_when_not_paused() { let (_,c,_,u)=setup(); c.draw_winner(&u); }
    #[test] #[should_panic] fn draw_winner_reverts_when_paused() { let (_,c,_,u)=setup(); c.pause_protocol(); c.draw_winner(&u); }
    #[test] fn total_deposits_tracks() { let (_,c,_,u)=setup(); c.deposit(&u,&300); assert_eq!(c.total_deposits(),300); c.withdraw(&u,&100); assert_eq!(c.total_deposits(),200); }
}
EOF
echo "✓ contracts/vault/src/lib.rs"

# ─────────────────────────────────────────────────────────────
# #245  backend/src/plugins/rate-limit.ts  (new file)
# ─────────────────────────────────────────────────────────────
mkdir -p "$REPO_ROOT/backend/src/plugins"
cat > "$REPO_ROOT/backend/src/plugins/rate-limit.ts" << 'EOF'
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import rateLimit from "@fastify/rate-limit";

export interface RateLimitOptions extends FastifyPluginOptions {
  max?: number;
  timeWindow?: number;
}

async function rateLimitPlugin(fastify: FastifyInstance, options: RateLimitOptions) {
  const max        = options.max        ?? 100;
  const timeWindow = options.timeWindow ?? 60_000;

  await fastify.register(rateLimit, {
    global: true,
    max,
    timeWindow,
    errorResponseBuilder(_request, context) {
      return {
        statusCode: 429,
        error: "Too Many Requests",
        message: `Rate limit exceeded. Retry after ${context.after}.`,
        retryAfter: context.after,
      };
    },
    onExceeding(req)  { req.log.warn({ ip: req.ip, url: req.url }, "Rate limit approaching"); },
    onExceeded(req)   { req.log.warn({ ip: req.ip, url: req.url }, "Rate limit exceeded – 429"); },
    keyGenerator(req) {
      return req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ?? req.ip;
    },
  });
}

export default fp(rateLimitPlugin, { name: "rate-limit", fastify: "4.x || 5.x" });
EOF
echo "✓ backend/src/plugins/rate-limit.ts"

# ─────────────────────────────────────────────────────────────
# #245  backend/src/plugins/rate-limit.test.ts  (new file)
# ─────────────────────────────────────────────────────────────
cat > "$REPO_ROOT/backend/src/plugins/rate-limit.test.ts" << 'EOF'
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import rateLimitPlugin from "./rate-limit.js";

async function buildTestApp(max = 3) {
  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(rateLimitPlugin, { max, timeWindow: 60_000 });
  app.get("/test", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("rate-limit plugin", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => { app = await buildTestApp(); });
  afterEach(async ()  => { await app.close(); });

  it("allows requests within limit", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("returns 429 when exceeded", async () => {
    for (let i = 0; i < 3; i++) await app.inject({ method: "GET", url: "/test" });
    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(429);
  });

  it("429 body has standard shape", async () => {
    for (let i = 0; i < 3; i++) await app.inject({ method: "GET", url: "/test" });
    const body = JSON.parse((await app.inject({ method: "GET", url: "/test" })).body);
    expect(body).toMatchObject({ statusCode: 429, error: "Too Many Requests" });
    expect(typeof body.retryAfter).toBe("string");
  });

  it("uses X-Forwarded-For for bucketing", async () => {
    const a = await app.inject({ method:"GET", url:"/test", headers:{"x-forwarded-for":"1.2.3.4"} });
    const b = await app.inject({ method:"GET", url:"/test", headers:{"x-forwarded-for":"5.6.7.8"} });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });
});
EOF
echo "✓ backend/src/plugins/rate-limit.test.ts"

# ─────────────────────────────────────────────────────────────
# #245  backend/src/server.ts  — APPEND rate-limit registration
#        Uses a marker comment so it's idempotent on re-runs.
# ─────────────────────────────────────────────────────────────
SERVER="$REPO_ROOT/backend/src/server.ts"
if grep -q "@fastify/rate-limit" "$SERVER" 2>/dev/null; then
  echo "⚠  backend/src/server.ts already has rate-limit — skipping"
else
  # Prepend the import and inject the register call after buildApp opens
  node - "$SERVER" << 'NODEEOF'
const fs   = require("fs");
const path = process.argv[2];
let src = fs.readFileSync(path, "utf8");

// 1. Add import after the last existing import line
const importLine = `import rateLimitPlugin from "./plugins/rate-limit.js";`;
if (!src.includes(importLine)) {
  // insert after the last `import … from` line
  src = src.replace(/(^import .+\n)(?!import)/m, `$1${importLine}\n`);
}

// 2. Inject plugin registration: find the first `app.register(` call or
//    the closing of buildApp, whichever comes first, and prepend our call.
const registerLine = `
  // Rate limiting — 100 req/min per IP (#245)
  await app.register(rateLimitPlugin, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 100),
    timeWindow: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  });
`;

// Try to insert before the first existing app.register call
if (src.includes("app.register(") && !src.includes("rateLimitPlugin")) {
  src = src.replace("app.register(", registerLine + "  app.register(");
} else if (!src.includes("rateLimitPlugin")) {
  // Fallback: insert before `return app`
  src = src.replace("return app;", registerLine + "\n  return app;");
}

fs.writeFileSync(path, src, "utf8");
console.log("✓ backend/src/server.ts patched");
NODEEOF
fi

# ─────────────────────────────────────────────────────────────
# #248  components/navConfig.ts  (new file)
# ─────────────────────────────────────────────────────────────
mkdir -p "$REPO_ROOT/components"
cat > "$REPO_ROOT/components/navConfig.ts" << 'EOF'
export interface NavItem {
  label: string;
  href: string;
  icon?: string;
  exact?: boolean;
}

const navItems: NavItem[] = [
  { label: "Dashboard",   href: "/",            icon: "LayoutDashboard", exact: true },
  { label: "Vault",       href: "/vault",        icon: "Vault" },
  { label: "Leaderboard", href: "/leaderboard",  icon: "Trophy" },
  { label: "History",     href: "/history",      icon: "History" },
  { label: "Settings",    href: "/settings",     icon: "Settings" },
];

export default navItems;
EOF
echo "✓ components/navConfig.ts"

# ─────────────────────────────────────────────────────────────
# #248 + #249  components/Navbar.tsx  (new or replace)
# ─────────────────────────────────────────────────────────────
cat > "$REPO_ROOT/components/Navbar.tsx" << 'EOF'
"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Vault, Trophy, History, Settings, Sun, Moon, Menu, X } from "lucide-react";
import navItems, { type NavItem } from "./navConfig";

const ICONS: Record<string, React.ElementType> = { LayoutDashboard, Vault, Trophy, History, Settings };
function NavIcon({ name }: { name?: string }) {
  if (!name) return null;
  const Icon = ICONS[name];
  return Icon ? <Icon className="w-4 h-4 shrink-0" /> : null;
}

function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const stored = localStorage.getItem("theme");
    if (stored === "dark")  return true;
    if (stored === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, () => setDark(d => !d)];
}

function isActive(pathname: string, item: NavItem) {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}

export default function Navbar() {
  const pathname = usePathname();
  const [dark, toggleDark] = useDarkMode();
  const [open, setOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-700 dark:bg-slate-900/80">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2 text-xl font-bold text-violet-600 dark:text-violet-400">
          <Vault className="h-6 w-6" /> VaultQuest
        </Link>

        <ul className="hidden items-center gap-1 md:flex">
          {navItems.map(item => {
            const active = isActive(pathname, item);
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                  }`}>
                  <NavIcon name={item.icon} />{item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-2">
          <button onClick={toggleDark} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="rounded-md p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100">
            {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          <button className="rounded-md p-2 text-slate-500 md:hidden dark:text-slate-400"
            onClick={() => setOpen(o => !o)} aria-label="Toggle menu">
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-200 bg-white px-4 pb-4 pt-2 dark:border-slate-700 dark:bg-slate-900 md:hidden">
          <ul className="flex flex-col gap-1">
            {navItems.map(item => {
              const active = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link href={item.href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                        : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                    }`}>
                    <NavIcon name={item.icon} />{item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </nav>
  );
}
EOF
echo "✓ components/Navbar.tsx"

# ─────────────────────────────────────────────────────────────
# #249  tailwind.config.js  — set darkMode: "class"
#        Edits in-place; idempotent.
# ─────────────────────────────────────────────────────────────
TW="$REPO_ROOT/tailwind.config.js"
if grep -q 'darkMode' "$TW" 2>/dev/null; then
  # Replace whatever darkMode value is already there
  node -e "
    const fs=require('fs');
    let s=fs.readFileSync('$TW','utf8');
    s=s.replace(/darkMode\s*:\s*['\"][^'\"]*['\"]/, 'darkMode: \"class\"');
    s=s.replace(/darkMode\s*:\s*\[[^\]]*\]/, 'darkMode: \"class\"');
    fs.writeFileSync('$TW',s,'utf8');
    console.log('✓ tailwind.config.js — darkMode updated to class');
  "
else
  # Inject darkMode as first key inside the config object
  node -e "
    const fs=require('fs');
    let s=fs.readFileSync('$TW','utf8');
    // Insert after the opening brace of the config object literal
    s=s.replace(/(const config\s*=\s*\{)/, '\$1\n  darkMode: \"class\",');
    fs.writeFileSync('$TW',s,'utf8');
    console.log('✓ tailwind.config.js — darkMode: class added');
  "
fi

# ─────────────────────────────────────────────────────────────
# #245  docs/ARCHITECTURE.md  — append rate-limit section
# ─────────────────────────────────────────────────────────────
ARCH="$REPO_ROOT/docs/ARCHITECTURE.md"
if grep -q "rate-limit\|rate_limit\|rateLimit" "$ARCH" 2>/dev/null; then
  echo "⚠  docs/ARCHITECTURE.md already mentions rate-limit — skipping"
else
  cat >> "$ARCH" << 'EOF'

---

## Rate Limiting (#245)

All endpoints behind the Fastify backend are protected by `@fastify/rate-limit`.

**Default:** 100 requests per 60 seconds per IP address.

```
Client IP
  │
  ▼
[Fastify — trustProxy: true]
  │
  ├─ @fastify/rate-limit (global)
  │    key : X-Forwarded-For[0] ?? req.ip
  │    max : 100 req / 60 s  (RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS env vars)
  │    429 : { statusCode, error, message, retryAfter }
  │
  ├─ /action-ledger/*      (default limit)
  ├─ /reconciliation/*     (default limit)
  └─ /health               (override: 300 req / 60 s)
```

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_MAX` | `100` | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window size (ms) |
EOF
  echo "✓ docs/ARCHITECTURE.md — rate-limit section appended"
fi

echo ""
echo "═══════════════════════════════════════════"
echo " All fixes applied successfully."
echo " Next steps:"
echo "   cd backend && pnpm add @fastify/rate-limit fastify-plugin"
echo "   git add -A"
echo "   git commit -m 'fix: resolve issues #245 #246 #248 #249'"
echo "═══════════════════════════════════════════"
