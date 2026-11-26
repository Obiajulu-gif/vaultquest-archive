import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { runDiagnostics } from '../scripts/contributor-diagnostics.mjs';

const TEST_ROOT = resolve(__dirname, 'contributor-diagnostics-fixtures');

describe('Contributor Diagnostics Command (#1134)', () => {
  beforeAll(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    // Passing fixture workspace
    const passDir = join(TEST_ROOT, 'pass');
    mkdirSync(passDir, { recursive: true });
    writeFileSync(join(passDir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.28.2' }));
    writeFileSync(join(passDir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(passDir, 'pnpm-workspace.yaml'), 'packages:\n  - "backend"\n');
    mkdirSync(join(passDir, 'node_modules'), { recursive: true });
    mkdirSync(join(passDir, 'backend'), { recursive: true });
    writeFileSync(join(passDir, 'backend/package.json'), '{}');
    mkdirSync(join(passDir, 'stellar-wallet-connect'), { recursive: true });
    writeFileSync(join(passDir, 'stellar-wallet-connect/package.json'), '{}');
    mkdirSync(join(passDir, 'contracts/drip-pool'), { recursive: true });
    writeFileSync(join(passDir, 'contracts/drip-pool/Cargo.toml'), '');

    // Failing fixture workspace (missing files)
    const failDir = join(TEST_ROOT, 'fail');
    mkdirSync(failDir, { recursive: true });
    writeFileSync(join(failDir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.28.2' }));
  });

  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('normal path: succeeds when toolchain, workspace packages, and environment are valid', () => {
    const results = runDiagnostics({
      root: join(TEST_ROOT, 'pass'),
      nodeVersion: '22.2.0',
      packageManager: 'pnpm',
      role: 'maintainer',
      env: { NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' },
      dependencies: [
        { name: 'soroban-cli', status: 'installed', requiredRole: 'contributor' },
        { name: 'production-secret-store', status: 'installed', requiredRole: 'maintainer' },
      ],
    });

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.find((r) => r.name === 'node')?.detail).toBe('22.2.0');
    expect(results.find((r) => r.name === 'package-manager')?.detail).toBe('pnpm');
    expect(results.find((r) => r.name === 'pnpm-lock.yaml')?.detail).toBe('present');
    expect(results.find((r) => r.name === 'env:NEXT_PUBLIC_STELLAR_NETWORK')?.detail).toBe('configured');
  });

  it('failure path: detects missing dependencies, lockfiles, and invalid node runtime', () => {
    const results = runDiagnostics({
      root: join(TEST_ROOT, 'fail'),
      nodeVersion: '18.16.0',
      packageManager: 'npm',
      role: 'contributor',
      env: {},
    });

    const nodeCheck = results.find((r) => r.name === 'node');
    expect(nodeCheck?.ok).toBe(false);
    expect(nodeCheck?.remediation).toContain('Install Node.js 20 or newer');

    const pmCheck = results.find((r) => r.name === 'package-manager');
    expect(pmCheck?.ok).toBe(false);
    expect(pmCheck?.remediation).toContain('Install and use pnpm');

    const lockCheck = results.find((r) => r.name === 'pnpm-lock.yaml');
    expect(lockCheck?.ok).toBe(false);
    expect(lockCheck?.detail).toBe('missing');

    const modulesCheck = results.find((r) => r.name === 'dependencies:installed');
    expect(modulesCheck?.ok).toBe(false);
    expect(modulesCheck?.remediation).toContain('pnpm install');

    const envCheck = results.find((r) => r.name === 'env:NEXT_PUBLIC_STELLAR_NETWORK');
    expect(envCheck?.ok).toBe(false);
    expect(envCheck?.remediation).toContain('Set NEXT_PUBLIC_STELLAR_NETWORK');
  });

  it('retry path: flags retryable dependencies with remaining attempts', () => {
    const results = runDiagnostics({
      root: join(TEST_ROOT, 'pass'),
      role: 'contributor',
      dependencies: [
        { name: 'horizon-rpc', status: 'failed', retryAttempts: 1, maxRetries: 3, critical: true },
        { name: 'indexer-sync', status: 'timeout', retryAttempts: 2, maxRetries: 3, critical: false },
      ],
    });

    const horizon = results.find((r) => r.name === 'dependency:horizon-rpc');
    expect(horizon?.ok).toBe(false);
    expect(horizon?.retryable).toBe(true);
    expect(horizon?.remediation).toContain('attempt 2 of 3');

    const indexer = results.find((r) => r.name === 'dependency:indexer-sync');
    expect(indexer?.retryable).toBe(true);
    expect(indexer?.remediation).toContain('attempt 3 of 3');
  });

  it('rollback path: prescribes lockfile rollback when dependency retries are exhausted', () => {
    const results = runDiagnostics({
      root: join(TEST_ROOT, 'pass'),
      role: 'contributor',
      dependencies: [
        { name: 'prisma-client', status: 'failed', retryAttempts: 3, maxRetries: 3, critical: true },
      ],
    });

    const prisma = results.find((r) => r.name === 'dependency:prisma-client');
    expect(prisma?.ok).toBe(false);
    expect(prisma?.retryable).toBe(false);
    expect(prisma?.remediation).toContain('Roll back to lockfile or execute clean rebuild');
    expect(prisma?.remediation).toContain('pnpm install --frozen-lockfile');
  });

  it('authorization path: denies unauthorized actor access to maintainer-scoped diagnostics', () => {
    const contributorResults = runDiagnostics({
      root: join(TEST_ROOT, 'pass'),
      role: 'contributor',
      dependencies: [
        { name: 'public-contracts', status: 'installed', requiredRole: 'contributor' },
        { name: 'private-vault-secrets', status: 'installed', requiredRole: 'maintainer' },
      ],
    });

    const publicDep = contributorResults.find((r) => r.name === 'dependency:public-contracts');
    expect(publicDep?.ok).toBe(true);
    expect(publicDep?.authorized).toBe(true);

    const privateDep = contributorResults.find((r) => r.name === 'dependency:private-vault-secrets');
    expect(privateDep?.ok).toBe(false);
    expect(privateDep?.authorized).toBe(false);
    expect(privateDep?.detail).toBe('unauthorized');
    expect(privateDep?.remediation).toContain("Requires 'maintainer' role");

    // Maintainer role succeeds
    const maintainerResults = runDiagnostics({
      root: join(TEST_ROOT, 'pass'),
      role: 'maintainer',
      dependencies: [
        { name: 'private-vault-secrets', status: 'installed', requiredRole: 'maintainer' },
      ],
    });

    const privMaintainer = maintainerResults.find((r) => r.name === 'dependency:private-vault-secrets');
    expect(privMaintainer?.ok).toBe(true);
    expect(privMaintainer?.authorized).toBe(true);
  });

  it('executable CLI invocation: supports --json and --strict flags correctly', () => {
    // 1. JSON output test
    const jsonOutput = execSync(
      'node ./scripts/contributor-diagnostics.mjs --json',
      { encoding: 'utf8', env: { ...process.env, DIAGNOSTICS_ROOT: join(TEST_ROOT, 'pass'), NEXT_PUBLIC_STELLAR_NETWORK: 'testnet' } }
    );
    const parsed = JSON.parse(jsonOutput);
    expect(parsed).toHaveProperty('generatedAt');
    expect(parsed).toHaveProperty('summary');
    expect(parsed.summary).toHaveProperty('passed');
    expect(Array.isArray(parsed.checks)).toBe(true);

    // 2. Strict mode failure exit code
    let strictExitCode = 0;
    try {
      execSync('node ./scripts/contributor-diagnostics.mjs --strict', {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, DIAGNOSTICS_ROOT: join(TEST_ROOT, 'fail') },
      });
    } catch (err: any) {
      strictExitCode = err.status;
    }
    expect(strictExitCode).toBe(1);
  });
});
