#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.DIAGNOSTICS_ROOT || path.resolve(__dirname, '..');

let allPassed = true;

function logCheck(name, passed, remediation) {
  if (passed) {
    console.log(`[PASS] ${name}`);
  } else {
    console.log(`[FAIL] ${name}`);
    console.log(`       Remediation: ${remediation}`);
    allPassed = false;
  }
}

function checkCommand(command, name, remediation) {
  try {
    execSync(`${command} --version`, { stdio: 'ignore' });
    logCheck(name, true);
  } catch (err) {
    logCheck(name, false, remediation);
  }
}

function runDiagnostics() {
  console.log('Running VaultQuest Contributor Diagnostics...\n');

  // 1. Runtime tools
  checkCommand('node', 'Node.js installed', 'Please install Node.js (https://nodejs.org/).');
  checkCommand('pnpm', 'pnpm installed', 'Please install pnpm (https://pnpm.io/installation).');
  checkCommand('cargo', 'Cargo (Rust) installed', 'Please install Rust/Cargo (https://rustup.rs/).');

  // 2. Package installation
  const nodeModulesPath = path.join(ROOT, 'node_modules');
  const hasNodeModules = fs.existsSync(nodeModulesPath);
  logCheck('Dependencies installed (node_modules)', hasNodeModules, "Run 'pnpm install' in the project root.");

  // 3. Environment variables
  const envExamplePath = path.join(ROOT, '.env.example');
  const envPath = path.join(ROOT, '.env');

  if (!fs.existsSync(envExamplePath)) {
    logCheck('Environment variables', false, 'Missing .env.example file. This is required for reference.');
  } else {
    let envPassed = false;
    let missingKeys = [];
    if (!fs.existsSync(envPath)) {
      logCheck('Environment variables (.env)', false, "Missing .env file. Copy .env.example to .env and fill in required values.");
    } else {
      const exampleContent = fs.readFileSync(envExamplePath, 'utf8');
      const envContent = fs.readFileSync(envPath, 'utf8');
      
      const getKeys = (content) => content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => line.split('=')[0]);

      const exampleKeys = getKeys(exampleContent);
      const envKeys = new Set(getKeys(envContent));

      missingKeys = exampleKeys.filter(k => !envKeys.has(k));
      envPassed = missingKeys.length === 0;
      
      logCheck('Environment variables (.env has all keys)', envPassed, `Missing keys in .env: ${missingKeys.join(', ')}. Please add them based on .env.example.`);
    }
  }

  // 4. Local fixtures
  const fixturesDir = path.join(ROOT, 'contracts/drip-pool/golden-fixtures');
  const expectedFixtures = ['events.json', 'errors.json', 'structs.json'];
  let fixturesPassed = true;

  for (const fixture of expectedFixtures) {
    if (!fs.existsSync(path.join(fixturesDir, fixture))) {
      fixturesPassed = false;
      break;
    }
  }
  logCheck('Local fixtures', fixturesPassed, "Run 'pnpm run fixtures:regenerate' to generate missing fixtures.");

  console.log('\nDiagnostics ' + (allPassed ? 'PASSED' : 'FAILED'));
  return allPassed;
}

if (require.main === module) {
  const passed = runDiagnostics();
  process.exit(passed ? 0 : 1);
}

module.exports = { runDiagnostics, logCheck, checkCommand };
