#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT_DIR = process.cwd();

function checkFileExists(filePath, description) {
  const fullPath = path.resolve(ROOT_DIR, filePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Missing required release file: ${filePath} (${description})`);
    return false;
  }
  return true;
}

function main() {
  console.log("Checking release readiness checklist...");

  const requiredFiles = [
    ["package.json", "Root package configuration"],
    ["pnpm-lock.yaml", "Lockfile"],
    ["docs/API.md", "API documentation"],
    ["docs/ARCHITECTURE.md", "Architecture guide"],
    ["docs/WEBHOOKS.md", "Webhooks documentation"],
    ["docs/env-inventory.md", "Environment inventory"],
    ["backend/package.json", "Backend package configuration"],
    ["backend/prisma/schema.prisma", "Prisma schema definition"],
    ["scripts/release-readiness.cjs", "Release evidence validator"],
    ["scripts/rehearse-release-rollback.cjs", "Rollback rehearsal"],
    ["docs/release-readiness-checklist.md", "Release readiness operations checklist"]
  ];

  let passed = true;

  for (const [file, desc] of requiredFiles) {
    if (!checkFileExists(file, desc)) {
      passed = false;
    }
  }

  const releaseWorkflowPath = path.resolve(ROOT_DIR, ".github/workflows/release-tagging.yml");
  const securityWorkflowPath = path.resolve(ROOT_DIR, ".github/workflows/security.yml");
  if (fs.existsSync(releaseWorkflowPath) && fs.existsSync(securityWorkflowPath)) {
    const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, "utf8");
    const securityWorkflow = fs.readFileSync(securityWorkflowPath, "utf8");
    const releaseGateChecks = [
      /draft_release:\s*\n\s+needs:\s*release_readiness/,
      /prisma migrate deploy/,
      /migrationSafetyCli\.ts/,
      /pnpm audit --audit-level=critical/,
      /tests\/security\.spec\.ts/,
      /--testNamePattern=/,
      /tests\/smoke\.spec\.ts/,
      /rehearse-release-rollback\.cjs/,
      /release-readiness\.cjs --evidence/,
    ];
    for (const check of releaseGateChecks) {
      if (!check.test(releaseWorkflow)) {
        console.error(`Release workflow is missing a required gate: ${check}`);
        passed = false;
      }
    }
    if (!/pnpm audit --audit-level=critical/.test(securityWorkflow) ||
        /pnpm audit --audit-level=critical\s*\|\|\s*true/.test(securityWorkflow)) {
      console.error("Security workflow must fail when the critical dependency audit fails.");
      passed = false;
    }
  } else {
    console.error("Release or security workflow is missing; release gate cannot be verified.");
    passed = false;
  }

  if (!passed) {
    console.error("Release readiness checklist failed.");
    process.exit(1);
  }

  console.log("Release readiness checklist passed.");
}

main();
