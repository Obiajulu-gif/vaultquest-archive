/** Pure contributor environment checks used by the local diagnostics command. */

export interface DependencyCheckInput {
  name: string;
  status: 'installed' | 'missing' | 'failed' | 'timeout';
  critical?: boolean;
  requiredRole?: string;
  retryAttempts?: number;
  maxRetries?: number;
}

export interface ContributorDiagnosticsInput {
  nodeVersion: string;
  packageManager: string;
  expectedPackageManager?: string;
  requiredEnv?: Record<string, string | undefined>;
  lockfiles?: string[];
  workspacePackages?: string[];
  actorRoles?: string[];
  dependencies?: DependencyCheckInput[];
  allowDegradedDependencies?: boolean;
}

export interface DiagnosticResult {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
  retryable?: boolean;
  authorized?: boolean;
}

export function runContributorDiagnostics(input: ContributorDiagnosticsInput): DiagnosticResult[] {
  const results: DiagnosticResult[] = [];
  const nodeMajor = Number.parseInt(input.nodeVersion.replace(/^v/, '').split('.')[0] ?? '', 10);
  results.push(Number.isInteger(nodeMajor) && nodeMajor >= 20
    ? { name: 'node', ok: true, detail: input.nodeVersion }
    : { name: 'node', ok: false, detail: input.nodeVersion, remediation: 'Install Node.js 20 or newer.' });

  const expectedManager = input.expectedPackageManager ?? 'pnpm';
  results.push(input.packageManager === expectedManager
    ? { name: 'package-manager', ok: true, detail: input.packageManager }
    : { name: 'package-manager', ok: false, detail: input.packageManager, remediation: `Use ${expectedManager} for this repository.` });

  for (const [name, value] of Object.entries(input.requiredEnv ?? {})) {
    results.push(value?.trim()
      ? { name: `env:${name}`, ok: true, detail: 'configured' }
      : { name: `env:${name}`, ok: false, detail: 'missing', remediation: `Set ${name} in a local, uncommitted environment file.` });
  }

  for (const lockfile of input.lockfiles ?? []) {
    results.push(lockfile.trim()
      ? { name: `lockfile:${lockfile}`, ok: true, detail: 'present' }
      : { name: 'lockfile', ok: false, detail: 'missing', remediation: 'Install dependencies with the repository package manager.' });
  }

  for (const workspace of input.workspacePackages ?? []) {
    results.push(workspace.trim()
      ? { name: `workspace:${workspace}`, ok: true, detail: 'declared' }
      : { name: 'workspace', ok: false, detail: 'invalid', remediation: 'Check pnpm-workspace.yaml package globs.' });
  }

  const actorRoles = new Set(input.actorRoles ?? ['contributor']);

  for (const dep of input.dependencies ?? []) {
    const isAuthorized = !dep.requiredRole || actorRoles.has(dep.requiredRole) || actorRoles.has('admin') || actorRoles.has('maintainer');
    if (!isAuthorized) {
      results.push({
        name: `dependency:${dep.name}`,
        ok: false,
        detail: 'unauthorized',
        authorized: false,
        remediation: `Requires '${dep.requiredRole}' role to diagnose or inspect this dependency.`,
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

    const retries = dep.retryAttempts ?? 0;
    const maxRetries = dep.maxRetries ?? 3;
    const canRetry = retries < maxRetries;
    const isDegradedAllowed = Boolean(input.allowDegradedDependencies && !dep.critical);

    results.push({
      name: `dependency:${dep.name}`,
      ok: isDegradedAllowed,
      detail: dep.status === 'timeout' ? `timeout (attempt ${retries}/${maxRetries})` : `${dep.status} (attempt ${retries}/${maxRetries})`,
      authorized: true,
      retryable: canRetry,
      remediation: canRetry
        ? `Retry dependency resolution or setup (attempt ${retries + 1} of ${maxRetries}).`
        : `Dependency failed after ${retries} attempts. Roll back to lockfile or execute clean rebuild.`,
    });
  }

  return results;
}
