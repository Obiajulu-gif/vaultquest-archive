#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const REQUIRED_CHECKS = Object.freeze([
  "migration",
  "security",
  "smoke",
  "rollback",
]);

function validateEvidence(evidence) {
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { ok: false, errors: ["Evidence must be a JSON object."] };
  }
  if (evidence.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1.");
  }
  if (typeof evidence.commit !== "string" || !/^[a-f0-9]{40}$/i.test(evidence.commit)) {
    errors.push("commit must be a 40-character Git commit SHA.");
  }
  if (typeof evidence.runUrl !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+$/.test(evidence.runUrl)) {
    errors.push("runUrl must identify the GitHub Actions run that produced this evidence.");
  }
  if (!evidence.checks || typeof evidence.checks !== "object" || Array.isArray(evidence.checks)) {
    errors.push("checks must contain results for all required release gates.");
  } else {
    for (const check of REQUIRED_CHECKS) {
      const result = evidence.checks[check];
      if (!result || result.status !== "passed") {
        errors.push(`${check} check is missing or did not pass.`);
      } else if (typeof result.evidence !== "string" || result.evidence.trim().length === 0) {
        errors.push(`${check} check is missing its verification evidence.`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function formatReport(report) {
  if (report.ok) return "Release readiness gate passed: migration, security, smoke, and rollback checks are evidenced.";
  return [
    "Release readiness gate failed:",
    ...report.errors.map((error) => `- ${error}`),
  ].join("\n");
}

function writeEvidence(outputPath, env = process.env) {
  const evidence = {
    schemaVersion: 1,
    commit: env.GITHUB_SHA,
    runUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    checks: {
      migration: { status: env.MIGRATION_CHECK_RESULT, evidence: env.MIGRATION_CHECK_EVIDENCE },
      security: { status: env.SECURITY_CHECK_RESULT, evidence: env.SECURITY_CHECK_EVIDENCE },
      smoke: { status: env.SMOKE_CHECK_RESULT, evidence: env.SMOKE_CHECK_EVIDENCE },
      rollback: { status: env.ROLLBACK_CHECK_RESULT, evidence: env.ROLLBACK_CHECK_EVIDENCE },
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  return evidence;
}

function main(args = process.argv.slice(2)) {
  const writeIndex = args.indexOf("--write-evidence");
  if (writeIndex !== -1) {
    const outputPath = args[writeIndex + 1];
    if (!outputPath) {
      console.error("Usage: node scripts/release-readiness.cjs --write-evidence <path>");
      return 1;
    }
    try {
      writeEvidence(outputPath);
    } catch (error) {
      console.error(`Unable to write release evidence: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    return 0;
  }

  const evidenceIndex = args.indexOf("--evidence");
  const evidencePath = evidenceIndex === -1 ? undefined : args[evidenceIndex + 1];
  if (!evidencePath) {
    console.error("Usage: node scripts/release-readiness.cjs --evidence <path>");
    return 1;
  }
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  } catch (error) {
    console.error(`Unable to read release evidence: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const report = validateEvidence(evidence);
  console.log(formatReport(report));
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { REQUIRED_CHECKS, validateEvidence, formatReport, writeEvidence, main };
