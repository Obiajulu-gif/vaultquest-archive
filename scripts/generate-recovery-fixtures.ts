#!/usr/bin/env node
/**
 * Generates the committed recovery-path fixture corpus from the generator in
 * `lib/recovery-fixture-generator.ts` (#998).
 *
 *   pnpm fixtures:recovery           # regenerate tests/fixtures/recovery-paths/corpus.json
 *   pnpm fixtures:recovery --check   # fail (non-zero) if the committed corpus is stale
 *
 * The generator is deterministic, so `--check` is a golden-fixture guard: it
 * regenerates in-memory and diffs against the committed file. Run it in CI to
 * ensure the corpus and the generator never drift. Intentional changes are
 * applied by re-running without `--check` and committing the result.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateRecoveryCorpus,
  validateRecoveryFixture,
  RECOVERY_PATHS,
} from "../lib/recovery-fixture-generator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_PATH = join(ROOT, "tests", "fixtures", "recovery-paths", "corpus.json");

// Seed and variant count are part of the committed artifact's identity.
const SEED = "vaultquest-recovery-v1";
const RETRY_VARIANTS = 8;

function buildDocument(): string {
  const fixtures = generateRecoveryCorpus({ seed: SEED, retryVariants: RETRY_VARIANTS });
  for (const f of fixtures) {
    if (!validateRecoveryFixture(f)) {
      throw new Error(`Generator produced an invalid fixture: ${f.id}`);
    }
  }
  const byPath = Object.fromEntries(
    RECOVERY_PATHS.map((p) => [p, fixtures.filter((f) => f.path === p).length] as const),
  );
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    description: "Generated fixtures for rare failure and recovery paths (#998). Do not edit by hand.",
    generator: "lib/recovery-fixture-generator.ts",
    seed: SEED,
    retryVariants: RETRY_VARIANTS,
    counts: { total: fixtures.length, byPath },
    fixtures,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

function main(): void {
  const check = process.argv.includes("--check");
  const next = buildDocument();

  if (check) {
    if (!existsSync(OUT_PATH)) {
      console.error(`✗ ${OUT_PATH} is missing. Run \`pnpm fixtures:recovery\` and commit it.`);
      process.exit(1);
    }
    const current = readFileSync(OUT_PATH, "utf8");
    if (current !== next) {
      console.error("✗ Recovery fixture corpus is stale. Run `pnpm fixtures:recovery` and commit the result.");
      process.exit(1);
    }
    console.log("✓ Recovery fixture corpus is up to date.");
    return;
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, next, "utf8");
  console.log(`✓ Wrote ${OUT_PATH}`);
}

main();
