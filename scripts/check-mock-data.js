#!/usr/bin/env node
/**
 * #510 — fails the build when mock data or a placeholder service is reachable
 * from a production code path (app/, components/, lib/, services/,
 * backend/src/), rather than being confined to tests/fixtures/dev-only code.
 *
 * Two independent signals are checked per production file:
 *  1. An import/require whose source path looks like a mock/fixture/stub
 *     module (e.g. "@/lib/vault-mock-data", "./fixtures/foo").
 *  2. A same-file declaration of an identifier that itself looks like mock
 *     data (MOCK_*, FAKE_*, STUB_*, DUMMY_*), so a mock module can't dodge
 *     signal (1) by inlining its data into a "real" file.
 *
 * Known limitation: both signals are single-hop. A file that re-exports a
 * mock module (signal 1 catches the re-exporter) and a file that only
 * imports the *re-exported identifier* from that re-exporter (not from the
 * mock module directly) will not itself be flagged — transitive import-graph
 * analysis is out of scope for this check. In practice the re-exporting file
 * is still caught, which is enough to surface the dependency for review.
 *
 * Mirrors scripts/check-product-terms.js's traverse/allowlist shape.
 */
const fs = require("fs");
const path = require("path");

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  "scripts"
]);

// Only these directories are treated as production code paths. Anything
// outside them (tests, e2e, docs, config) is not scanned — mock data belongs
// there and is expected.
const PRODUCTION_DIRS = ["app", "components", "lib", "services", "hooks", "backend/src"];

const SCANNED_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);

// A file is exempt from signal (1)/(2) if its own path looks like a
// mock/fixture module — the module that legitimately *defines* mock data,
// as opposed to the production code that pulls it in.
const MOCK_MODULE_PATTERN = /(^|[/\\_.-])(mock|mocks|fixture|fixtures|stub|stubs)([/\\_.-]|$)/i;

// Matches import/require sources that point at a mock/fixture/stub module.
// Boundary chars mirror MOCK_MODULE_PATTERN so "vault-mock-data" (hyphenated,
// not its own path segment) is caught the same way "lib/mock-data" would be.
const MOCK_IMPORT_SOURCE_PATTERN =
  /(^|[/\\_.-])(mock|mocks|fixture|fixtures|stub|stubs)([/\\_.-]|(?=['"`])|$)/i;

const IMPORT_SOURCE_REGEX = /(?:from\s+|require\()\s*["']([^"']+)["']/g;

// A declared identifier that itself signals placeholder/mock data, e.g.
// `export const MOCK_VAULTS = [...]` or `const FAKE_USER = {...}`.
const MOCK_IDENTIFIER_DECL_REGEX =
  /\b(?:export\s+)?(?:const|let|var|function|class)\s+(MOCK_[A-Z0-9_]*|FAKE_[A-Z0-9_]*|STUB_[A-Z0-9_]*|DUMMY_[A-Z0-9_]*)\b/g;

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isScannedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  return SCANNED_EXTENSIONS.has(ext);
}

function isUnderProductionDir(relativePath) {
  return PRODUCTION_DIRS.some(
    (dir) => relativePath === dir || relativePath.startsWith(`${dir}/`)
  );
}

async function traverse(dir, callback) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await traverse(fullPath, callback);
      continue;
    }
    if (!isScannedFile(fullPath)) continue;
    callback(fullPath);
  }
}

function loadAllowlist() {
  const allowlistFile = path.resolve(process.cwd(), "scripts/mock-data-allowlist.json");
  try {
    const raw = fs.readFileSync(allowlistFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Allowlist file must contain an array");
    }
    return parsed.map((entry) => ({
      path: String(entry.path),
      reason: entry.reason ? String(entry.reason) : ""
    }));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Unable to load mock-data allowlist: ${error.message}`);
  }
}

function isAllowlisted(allowlist, relativePath) {
  return allowlist.some((entry) => entry.path === relativePath);
}

function findMockImports(content) {
  const findings = [];
  let match;
  IMPORT_SOURCE_REGEX.lastIndex = 0;
  while ((match = IMPORT_SOURCE_REGEX.exec(content)) !== null) {
    const source = match[1];
    if (MOCK_IMPORT_SOURCE_PATTERN.test(source)) {
      findings.push({ kind: "mock-import", detail: source, index: match.index });
    }
  }
  return findings;
}

function findMockIdentifiers(content) {
  const findings = [];
  let match;
  MOCK_IDENTIFIER_DECL_REGEX.lastIndex = 0;
  while ((match = MOCK_IDENTIFIER_DECL_REGEX.exec(content)) !== null) {
    findings.push({ kind: "mock-identifier", detail: match[1], index: match.index });
  }
  return findings;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

async function main() {
  const allowlist = loadAllowlist();
  const matches = [];

  await traverse(process.cwd(), (filePath) => {
    const relativePath = normalizePath(path.relative(process.cwd(), filePath));
    if (!isUnderProductionDir(relativePath)) return;
    if (MOCK_MODULE_PATTERN.test(relativePath)) return; // the mock module itself is allowed to exist
    if (isAllowlisted(allowlist, relativePath)) return;

    const content = fs.readFileSync(filePath, "utf8");
    const findings = [...findMockImports(content), ...findMockIdentifiers(content)];

    for (const finding of findings) {
      matches.push({
        path: relativePath,
        lineNumber: lineNumberAt(content, finding.index),
        kind: finding.kind,
        detail: finding.detail
      });
    }
  });

  if (matches.length > 0) {
    console.error("Mock data / placeholder service check failed.");
    console.error(
      "Found production code paths that reach mock data or a mock/fixture/stub module:"
    );
    for (const match of matches) {
      const description =
        match.kind === "mock-import"
          ? `imports from mock-like module "${match.detail}"`
          : `declares mock-like identifier "${match.detail}"`;
      console.error(`- ${match.path}:${match.lineNumber}: ${description}`);
    }
    console.error(
      "\nProduction paths (app/, components/, lib/, services/, hooks/, backend/src/) must not " +
        "depend on mock data or placeholder services. If this is a genuine dev-only affordance " +
        "or a tracked exception, add it to scripts/mock-data-allowlist.json with a reason."
    );
    process.exit(1);
  }

  console.log("Mock data / placeholder service check passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
