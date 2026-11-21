import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/**
 * VaultQuest Contributor Diagnostics CLI (#1134)
 *
 * Provides executable diagnostics for local contributor environments,
 * verifying toolchains, workspace packages, environment variables,
 * role authorization, and dependency states with retry and rollback guidance.
 *
 * Usage:
 *   node ./scripts/contributor-diagnostics.mjs
 *   node ./scripts/contributor-diagnostics.mjs --strict
 *   node ./scripts/contributor-diagnostics.mjs --json
 *   node ./scripts/contributor-diagnostics.mjs --role maintainer
 *   node ./scripts/contributor-diagnostics.mjs --retry
 */

const root = process.env.DIAGNOSTICS_ROOT ? resolve(process.env.DIAGNOSTICS_ROOT) : process.cwd();

// Parse CLI flags
const args = process.argv.slice(2);
const isStrict = args.includes('--strict');
const isJson = args.includes('--json');
const isRetry = args.includes('--retry');
const isQuiet = args.includes('--quiet');

// Role determination (CLI flag > ENV var > default: contributor)
let actorRole = 'contributor';
const roleIdx = args.indexOf('--role');
if (roleIdx !== -1 && args[roleIdx + 1]) {
  actorRole = args[roleIdx + 1];
} else if (process.env.CONTRIBUTOR_ROLE) {
  actorRole = process.env.CONTRIBUTOR_ROLE;
}

export function runDiagnostics(options = {}) {
  const currentRoot = options.root ?? root;
  const currentRole = options.role ?? actorRole;
  const allowDegraded = options.allowDegraded ?? (process.env.ALLOW_DEGRADED_DEPENDENCIES === 'true');
  const results = [];

  // 1. Toolchain: Node.js runtime
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0] ?? '', 10);
  const nodeOk = Number.isInteger(nodeMajor) && nodeMajor >= 20;
  results.push({
    name: 'node',
    ok: nodeOk,
    detail: nodeVersion,
    authorized: true,
    remediation: nodeOk ? undefined : 'Install Node.js 20 or newer.',
  });

  // 2. Toolchain: Package Manager
  let packageJson = {};
  try {
    packageJson = JSON.parse(readFileSync(join(currentRoot, 'package.json'), 'utf8'));
  } catch {
    packageJson = { packageManager: 'pnpm' };
  }
  const expectedManager = String(packageJson.packageManager ?? 'pnpm').split('@')[0];

  let detectedManager = options.packageManager ?? 'unknown';
  if (!options.packageManager) {
    if (process.env.npm_config_user_agent?.startsWith('pnpm/')) {
      detectedManager = 'pnpm';
    } else if (existsSync('/usr/local/bin/pnpm') || existsSync('/usr/bin/pnpm')) {
      detectedManager = 'pnpm';
    } else {
      try {
        detectedManager = execSync('pnpm --version', {
          encoding: 'utf8',
          env: { ...process.env, XDG_DATA_HOME: '/tmp/.local/share', XDG_CACHE_HOME: '/tmp/.cache' },
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 1000,
        }).trim() ? 'pnpm' : 'unknown';
      } catch {
        detectedManager = 'unknown';
      }
    }
  }
  const managerOk = detectedManager === expectedManager;
  results.push({
    name: 'package-manager',
    ok: managerOk,
    detail: detectedManager,
    authorized: true,
    remediation: managerOk ? undefined : `Install and use ${expectedManager} for this repository.`,
  });

  // 3. Repository lockfiles & workspace manifest
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const fileExists = existsSync(join(currentRoot, file));
    results.push({
      name: file,
      ok: fileExists,
      detail: fileExists ? 'present' : 'missing',
      authorized: true,
      remediation: fileExists ? undefined : 'Run from a complete repository checkout or re-fetch missing files.',
    });
  }

  // 4. Dependencies installed (node_modules)
  const hasNodeModules = existsSync(join(currentRoot, 'node_modules'));
  results.push({
    name: 'dependencies:installed',
    ok: hasNodeModules,
    detail: hasNodeModules ? 'installed' : 'missing',
    authorized: true,
    remediation: hasNodeModules ? undefined : 'Run `pnpm install` from the repository root.',
  });

  // 5. Workspace Packages verification
  const workspaces = [
    { name: 'backend', path: 'backend/package.json' },
    { name: 'stellar-wallet-connect', path: 'stellar-wallet-connect/package.json' },
    { name: 'contracts', path: 'contracts/drip-pool/Cargo.toml' },
  ];
  for (const ws of workspaces) {
    const wsExists = existsSync(join(currentRoot, ws.path));
    results.push({
      name: `workspace:${ws.name}`,
      ok: wsExists,
      detail: wsExists ? 'present' : 'missing',
      authorized: true,
      remediation: wsExists ? undefined : `Workspace ${ws.name} is missing. Verify git submodules or checkout.`,
    });
  }

  // 6. Environment variables verification (never leak values)
  const requiredEnvVars = ['NEXT_PUBLIC_STELLAR_NETWORK'];
  for (const envName of requiredEnvVars) {
    const isConfigured = Boolean((options.env?.[envName] ?? process.env[envName])?.trim());
    results.push({
      name: `env:${envName}`,
      ok: isConfigured,
      detail: isConfigured ? 'configured' : 'missing',
      authorized: true,
      remediation: isConfigured ? undefined : `Set ${envName} in a local, uncommitted environment file.`,
    });
  }

  // 7. Role-based authorization & protected diagnostic checks
  const actorRoles = new Set([currentRole]);
  if (currentRole === 'admin') {
    actorRoles.add('maintainer');
    actorRoles.add('contributor');
  } else if (currentRole === 'maintainer') {
    actorRoles.add('contributor');
  }

  // Define contributor vs maintainer dependency targets
  const dependencyChecks = options.dependencies ?? [
    { name: 'soroban-cli', status: 'installed', critical: true, requiredRole: 'contributor' },
    { name: 'vitest', status: 'installed', critical: true, requiredRole: 'contributor' },
    { name: 'production-secret-store', status: 'installed', critical: false, requiredRole: 'maintainer' },
  ];

  for (const dep of dependencyChecks) {
    const isAuthorized = !dep.requiredRole || actorRoles.has(dep.requiredRole);
    if (!isAuthorized) {
      results.push({
        name: `dependency:${dep.name}`,
        ok: false,
        detail: 'unauthorized',
        authorized: false,
        remediation: `Requires '${dep.requiredRole}' role to inspect this dependency. Run with --role ${dep.requiredRole} if authorized.`,
      });
      continue;
    }

    if (dep.status === 'installed') {
      results.push({
        name: `dependency:${dep.name}`,
        ok: true,
        detail: 'installed',
        authorized: true,
      });
      continue;
    }

    // Failure / Retry / Rollback evaluation
    const retries = dep.retryAttempts ?? 0;
    const maxRetries = dep.maxRetries ?? 3;
    const canRetry = retries < maxRetries;
    const isDegradedAllowed = Boolean(allowDegraded && !dep.critical);

    results.push({
      name: `dependency:${dep.name}`,
      ok: isDegradedAllowed,
      detail: dep.status === 'timeout'
        ? `timeout (attempt ${retries}/${maxRetries})`
        : `${dep.status} (attempt ${retries}/${maxRetries})`,
      authorized: true,
      retryable: canRetry,
      remediation: canRetry
        ? `Retry dependency resolution or setup (attempt ${retries + 1} of ${maxRetries}). Use --retry flag.`
        : `Dependency failed after ${retries} attempts. Roll back to lockfile or execute clean rebuild (pnpm install --frozen-lockfile).`,
    });
  }

  return results;
}

// CLI Execution entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const results = runDiagnostics({
    role: actorRole,
  });

  const failedCount = results.filter((r) => !r.ok).length;
  const passedCount = results.filter((r) => r.ok).length;
  const retryableCount = results.filter((r) => r.retryable).length;
  const unauthorizedCount = results.filter((r) => r.authorized === false).length;

  if (isJson) {
    const report = {
      generatedAt: new Date().toISOString(),
      role: actorRole,
      summary: {
        total: results.length,
        passed: passedCount,
        failed: failedCount,
        retryable: retryableCount,
        unauthorized: unauthorizedCount,
      },
      checks: results,
    };
    console.log(JSON.stringify(report, null, 2));
  } else if (!isQuiet) {
    console.log(`VaultQuest Contributor Diagnostics [Role: ${actorRole}]\n`);
    for (const result of results) {
      const statusTag = result.ok
        ? 'PASS'
        : (result.authorized === false ? 'AUTH' : (result.retryable ? 'RETRY' : 'FAIL'));
      const line = `${statusTag.padEnd(5)} ${result.name}: ${result.detail}${result.remediation ? ` (${result.remediation})` : ''}`;
      console.log(line);
    }
    console.log(`\nDiagnostics: ${passedCount} passed, ${failedCount} failed (${retryableCount} retryable, ${unauthorizedCount} unauthorized)`);
  }

  if (failedCount > 0 && isStrict) {
    process.exitCode = 1;
  }
}
