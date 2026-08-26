#!/usr/bin/env node
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
const PRODUCTION_DIRS = ["app", "components", "lib", "services", "hooks", "backend/src"];
const SCANNED_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);
const FORBIDDEN_PATTERNS = [
  {
    name: "query-parameter mock wallet toggle",
    pattern: /\bmockConnected\b/
  },
  {
    name: "fixed mock admin bearer credential",
    pattern: /mock-admin-token|Bearer\s+mock/i
  }
];

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isScannedFile(filePath) {
  return SCANNED_EXTENSIONS.has(path.extname(filePath).toLowerCase().replace(".", ""));
}

function isUnderProductionDir(relativePath) {
  return PRODUCTION_DIRS.some(
    (dir) => relativePath === dir || relativePath.startsWith(`${dir}/`)
  );
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
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
    } else if (isScannedFile(fullPath)) {
      callback(fullPath);
    }
  }
}

async function main() {
  const matches = [];

  await traverse(process.cwd(), (filePath) => {
    const relativePath = normalizePath(path.relative(process.cwd(), filePath));
    if (!isUnderProductionDir(relativePath)) return;

    const content = fs.readFileSync(filePath, "utf8");
    for (const forbidden of FORBIDDEN_PATTERNS) {
      forbidden.pattern.lastIndex = 0;
      const match = forbidden.pattern.exec(content);
      if (match) {
        matches.push({
          path: relativePath,
          lineNumber: lineNumberAt(content, match.index),
          name: forbidden.name
        });
      }
    }
  });

  if (matches.length > 0) {
    console.error("Mock auth production check failed.");
    for (const match of matches) {
      console.error(`- ${match.path}:${match.lineNumber}: ${match.name}`);
    }
    process.exit(1);
  }

  console.log("Mock auth production check passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
