# Deployment Provenance & Cache-Busting Strategy (#660)

This document describes how VaultQuest handles build asset versioning, stale
client detection, and safe refresh prompts to protect users during active
wallet sessions.

---

## 1. Deployment Manifest

The `deployment-manifest.json` file is published at the root of every
deployment. It is served as a static asset and contains:

| Field | Description |
|---|---|
| `version` | SemVer string matching the release tag |
| `environment` | `staging` or `production` |
| `network` | Stellar network passphrase, Soroban RPC, and Horizon URLs |
| `contracts.dripPool.contractId` | Canonical on-chain contract address |
| `build.commitSha` | Git commit SHA of the deployed build |
| `build.buildTimestamp` | ISO 8601 UTC timestamp of the build |

The manifest is validated on startup via `lib/deployment-manifest.ts` using
Zod schemas. Any mismatch between manifest values and runtime env vars surfaces
through `AttestationProvider` → `AttestationError`.

---

## 2. Stale Client Detection

`AttestationProvider` fetches the manifest on every page load and compares the
embedded `version` and contract addresses against the compiled env vars. A
mismatch indicates the user is running a stale JavaScript bundle.

### Detection Flow

```
Page Load
  │
  ▼
loadManifestAsync() — fetches /deployment-manifest.json (always fresh, no SW cache)
  │
  ▼
validateManifestAgainstEnv(manifest, process.env)
  │
  ├─ No mismatches → render app normally
  │
  └─ Mismatches detected → render <AttestationError />
       (shows version mismatch banner + safe refresh prompt)
```

---

## 3. Cache-Busting Strategy

### Next.js Build Hashing

All JavaScript chunks emitted by Next.js include a content hash in their
filename (e.g. `_next/static/chunks/abc123.js`). This means:
- **New deployments** always load fresh JS — browser cache misses on hash change.
- **CDN/edge** can safely cache assets with long TTLs (e.g. `Cache-Control: public, max-age=31536000, immutable`).
- **`/deployment-manifest.json`** must be served with `Cache-Control: no-cache` so the version check is always fresh.

### Service Worker Guidance

VaultQuest does **not** register a service worker by default to avoid
complexities with Stellar transaction builders and contract addresses becoming
stale. If a service worker is added in future:
- Precache only static assets; exclude `/deployment-manifest.json`.
- On SW activation, post a message to all clients to recheck the manifest.
- Never cache Soroban RPC responses.

---

## 4. Safe Refresh Prompt

When a version mismatch is detected **outside** a pending wallet signing
session, the user is shown a non-blocking banner prompting a page refresh.

### Rules

| Condition | Behaviour |
|---|---|
| Mismatch detected, no pending transaction | Show refresh banner immediately |
| Mismatch detected, wallet signing in progress | Defer banner until signing resolves |
| Mismatch detected, deposit/withdrawal pending | Defer banner until `confirmed` or `failed` |

The `AttestationError` component reads transaction state from the global store
to determine whether to show immediately or defer. This prevents unsafe
interruption of wallet signing flows.

---

## 5. Environment Variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE` | Validated against `manifest.network.passphrase` |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | Validated against `manifest.network.sorobanRpcUrl` |
| `NEXT_PUBLIC_HORIZON_URL` | Validated against `manifest.network.horizonUrl` |
| `NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID` | Validated against `manifest.contracts.dripPool.contractId` |
| `DEPLOYMENT_MANIFEST_PATH` | Override for SSR manifest path (optional) |

---

## 6. Deployment Checklist

Before every release:

1. Update `deployment-manifest.json` with the correct `version`, `commitSha`,
   and `buildTimestamp`.
2. Verify all contract IDs match on-chain deployments.
3. Ensure `/deployment-manifest.json` CDN TTL is set to `no-cache`.
4. Deploy Next.js build — hashed assets are safe to cache indefinitely.
5. Smoke-test `AttestationProvider` on staging before promoting to production.
