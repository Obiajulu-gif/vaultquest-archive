#!/usr/bin/env node

/**
 * Regenerates golden fixtures from the canonical contract spec.
 *
 * Run: node scripts/regenerate-fixtures.js
 *
 * This script:
 * 1. Reads the canonical contract spec (contracts/drip-pool/canonical-spec.json)
 * 2. Updates golden fixtures with the latest contract types
 * 3. Outputs a summary of changes
 *
 * Intentional breaking changes should be documented in the commit message.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SPEC_PATH = path.join(ROOT, "contracts/drip-pool/canonical-spec.json");
const FIXTURES_DIR = path.join(ROOT, "contracts/drip-pool/golden-fixtures");

function readSpec() {
  if (!fs.existsSync(SPEC_PATH)) {
    console.error(`Canonical spec not found at ${SPEC_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
}

function writeFixture(name, data) {
  const filePath = path.join(FIXTURES_DIR, `${name}.json`);
  const content = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(filePath, content, "utf8");
  console.log(`  ✓ Updated ${name}.json`);
}

function main() {
  console.log("Regenerating golden fixtures from canonical spec...\n");

  const spec = readSpec();

  // Ensure fixtures directory exists
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  // Update events fixture
  writeFixture("events", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    version: spec.version,
    description: "Golden fixtures for contract events.",
    fixtures: spec.events,
  });

  // Update errors fixture
  writeFixture("errors", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    version: spec.version,
    description: "Golden fixtures for contract error codes.",
    contract_errors: Object.fromEntries(
      Object.entries(spec.errors).map(([name, code]) => [
        name,
        {
          code,
          backend_error: spec.error_code_mapping.contract_to_backend[name],
          wallet_error_kind: spec.error_code_mapping.contract_to_wallet[name],
        },
      ])
    ),
  });

  // Update structs fixture
  writeFixture("structs", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    version: spec.version,
    description: "Golden fixtures for contract struct shapes.",
    structs: spec.structs,
  });

  console.log("\n✅ Golden fixtures regenerated successfully.");
  console.log("\nIf you made intentional breaking changes, please document them in your commit message.");
}

main();
