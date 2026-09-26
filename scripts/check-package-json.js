#!/usr/bin/env node
/**
 * Strict JSON.parse guard for every package.json in the workspace.
 *
 * Some tools (npm/pnpm) tolerate malformed JSON via lenient parsing, so a
 * missing comma or a broken `scripts` block can slip through. This script
 * runs a strict RFC 8259 JSON.parse over every workspace package.json and
 * fails the build (non-zero exit) if any of them are malformed.
 *
 * Usage: node ./scripts/check-package-json.js
 */
const fs = require("fs");
const path = require("path");

const ROOT_DIR = process.cwd();

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vercel",
  "dist",
  "build",
  "out",
  "coverage",
  "playwright-report",
  "test-results",
  "target"
]);

function collectPackageJsonFiles(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      collectPackageJsonFiles(fullPath, results);
    } else if (entry.name === "package.json") {
      results.push(fullPath);
    }
  }

  return results;
}

const files = collectPackageJsonFiles(ROOT_DIR);
let failed = false;

if (files.length === 0) {
  console.error("No package.json files found to validate.");
  process.exit(1);
}

for (const file of files) {
  const relative = path.relative(ROOT_DIR, file);
  const raw = fs.readFileSync(file, "utf8");

  try {
    JSON.parse(raw);
    console.log(`ok: ${relative}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL: ${relative} is not valid JSON: ${err.message}`);
  }
}

if (failed) {
  console.error("\nOne or more package.json files failed strict JSON parsing.");
  process.exit(1);
}

console.log(`\nAll ${files.length} package.json file(s) parsed cleanly.`);
