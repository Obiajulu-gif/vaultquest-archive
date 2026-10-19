import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expected = String(packageJson.packageManager ?? 'pnpm').split('@')[0];
const results = [];
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
results.push({ name: 'node', ok: nodeMajor >= 20, detail: process.version, remediation: 'Install Node.js 20 or newer.' });
let manager = 'unknown';
try {
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm --version'] : ['--version'];
  manager = execFileSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() ? 'pnpm' : 'unknown';
} catch {}
results.push({ name: 'package-manager', ok: manager === expected, detail: manager, remediation: `Install and use ${expected}.` });
for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  results.push({ name: file, ok: existsSync(join(root, file)), detail: existsSync(join(root, file)) ? 'present' : 'missing', remediation: 'Run from a complete repository checkout.' });
}
for (const name of ['NEXT_PUBLIC_STELLAR_NETWORK']) {
  const configured = Boolean(process.env[name]?.trim());
  results.push({ name: `env:${name}`, ok: configured, detail: configured ? 'configured' : 'missing', remediation: `Set ${name} in a local, uncommitted environment file.` });
}
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}${result.ok ? '' : ` (${result.remediation})`}`);
if (results.some((result) => !result.ok) && process.argv.includes('--strict')) process.exitCode = 1;

