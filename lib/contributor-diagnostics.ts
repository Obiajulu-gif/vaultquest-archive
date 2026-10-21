/** Pure contributor environment checks used by the local diagnostics command. */

export interface ContributorDiagnosticsInput {
  nodeVersion: string;
  packageManager: string;
  expectedPackageManager?: string;
  requiredEnv?: Record<string, string | undefined>;
  lockfiles?: string[];
  workspacePackages?: string[];
}

export interface DiagnosticResult {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
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
  return results;
}

