#!/usr/bin/env tsx
/**
 * Deployment preflight validation script
 * Checks schema version compatibility before deployment
 * 
 * Usage:
 *   npm run validate:deployment
 *   
 * Exit codes:
 *   0 - Validation passed
 *   1 - Validation failed (incompatible schemas)
 */

import { PrismaClient } from "@prisma/client";
import { SchemaVersionService } from "../src/services/schemaVersionService.js";
import { SCHEMA_VERSIONS } from "../src/constants.js";

async function main() {
  const prisma = new PrismaClient();
  const schemaVersionService = new SchemaVersionService(prisma);

  console.log("🔍 VaultQuest Deployment Validation");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  try {
    console.log("Checking schema versions...\n");

    const validation = await schemaVersionService.validateSchemaVersions();
    const versionInfo = await schemaVersionService.getVersionInfo();

    console.log("📊 Version Information:");
    console.log(`  Database Schema:`);
    console.log(`    Current:   ${versionInfo.database.current}`);
    console.log(`    Expected:  ${versionInfo.database.expected}`);
    console.log(`    Supported: ${versionInfo.database.supported.join(", ")}`);
    console.log();
    console.log(`  Indexer Schema:`);
    console.log(`    Current:   ${versionInfo.indexer.current}`);
    console.log(`    Expected:  ${versionInfo.indexer.expected}`);
    console.log(`    Supported: ${versionInfo.indexer.supported.join(", ")}`);
    console.log();

    if (!validation.valid) {
      console.error("❌ VALIDATION FAILED\n");
      console.error("Schema version incompatibility detected:");
      validation.issues.forEach((issue, idx) => {
        console.error(`  ${idx + 1}. ${issue}`);
      });
      console.error();
      console.error("🚫 Deployment blocked. Please upgrade schemas to compatible versions.\n");
      console.error("📖 See backend/docs/SCHEMA_VERSIONS.md for upgrade instructions.");
      
      process.exit(1);
    }

    console.log("✅ VALIDATION PASSED");
    console.log("   All schema versions are compatible.");
    console.log("   Safe to deploy.\n");
    
    process.exit(0);
  } catch (error) {
    console.error("❌ VALIDATION ERROR\n");
    console.error("Failed to validate schema versions:");
    console.error(error);
    console.error();
    console.error("🚫 Deployment blocked due to validation error.\n");
    
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
