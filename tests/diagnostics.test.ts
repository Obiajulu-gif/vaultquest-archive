import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const FIXTURES_ROOT = path.join(__dirname, 'diagnostics-fixtures');

describe('Diagnostics command', () => {
  beforeAll(() => {
    // Setup failing fixture
    const failRoot = path.join(FIXTURES_ROOT, 'fail');
    fs.mkdirSync(failRoot, { recursive: true });
    // Empty root means no .env, no node_modules, no fixtures

    // Setup passing fixture
    const passRoot = path.join(FIXTURES_ROOT, 'pass');
    fs.mkdirSync(passRoot, { recursive: true });
    fs.writeFileSync(path.join(passRoot, '.env.example'), 'VAR=1\nTEST=2\n');
    fs.writeFileSync(path.join(passRoot, '.env'), 'VAR=1\nTEST=2\n');
    fs.mkdirSync(path.join(passRoot, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(passRoot, 'contracts/drip-pool/golden-fixtures'), { recursive: true });
    fs.writeFileSync(path.join(passRoot, 'contracts/drip-pool/golden-fixtures/events.json'), '{}');
    fs.writeFileSync(path.join(passRoot, 'contracts/drip-pool/golden-fixtures/errors.json'), '{}');
    fs.writeFileSync(path.join(passRoot, 'contracts/drip-pool/golden-fixtures/structs.json'), '{}');
  });

  afterAll(() => {
    fs.rmSync(FIXTURES_ROOT, { recursive: true, force: true });
  });

  it('fails when environment is missing files', () => {
    const failRoot = path.join(FIXTURES_ROOT, 'fail');
    let output = '';
    try {
      execSync('node scripts/diagnostics.js', { 
        env: { ...process.env, DIAGNOSTICS_ROOT: failRoot },
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      output = err.stdout;
    }

    expect(output).toContain('FAILED');
    expect(output).toContain('[FAIL] Dependencies installed (node_modules)');
    expect(output).toContain('[FAIL] Environment variables');
    expect(output).toContain('[FAIL] Local fixtures');
  });

  it('passes when environment has required files', () => {
    const passRoot = path.join(FIXTURES_ROOT, 'pass');
    const output = execSync('node scripts/diagnostics.js', { 
      env: { ...process.env, DIAGNOSTICS_ROOT: passRoot },
      encoding: 'utf8',
      stdio: 'pipe'
    });

    expect(output).toContain('PASSED');
    expect(output).toContain('[PASS] Dependencies installed (node_modules)');
    expect(output).toContain('[PASS] Environment variables (.env has all keys)');
    expect(output).toContain('[PASS] Local fixtures');
  });
});
