#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT_DIR = process.cwd();

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  "playwright-report",
  "test-results"
]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isMarkdownFile(filePath) {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function collectMarkdownFiles(dir, results = []) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(fullPath, results);
      continue;
    }

    if (isMarkdownFile(fullPath)) {
      results.push(fullPath);
    }
  }

  return results;
}

function stripFragmentAndQuery(target) {
  return target.split("#")[0].split("?")[0];
}

function resolveLinkTarget(fromFile, rawTarget) {
  const target = rawTarget.trim();

  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("tel:") ||
    target.startsWith("data:") ||
    target.startsWith("#")
  ) {
    return null;
  }

  const pathTarget = stripFragmentAndQuery(target);
  if (!pathTarget) {
    return null;
  }

  if (pathTarget.startsWith("/")) {
    return path.resolve(ROOT_DIR, `.${pathTarget}`);
  }

  return path.resolve(path.dirname(fromFile), pathTarget);
}

async function main() {
  const files = await collectMarkdownFiles(ROOT_DIR);
  const problems = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    let inFence = false;
    let fenceCount = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
        inFence = !inFence;
        fenceCount += 1;
        continue;
      }

      if (inFence) {
        continue;
      }

      let match;
      linkPattern.lastIndex = 0;
      while ((match = linkPattern.exec(line)) !== null) {
        const target = match[1];
        const resolved = resolveLinkTarget(filePath, target);
        if (!resolved) {
          continue;
        }

        if (!fs.existsSync(resolved)) {
          problems.push(
            `${normalizePath(path.relative(ROOT_DIR, filePath))}:${index + 1} -> ${target}`
          );
        }
      }
    }

    if (inFence || fenceCount % 2 !== 0) {
      problems.push(
        `${normalizePath(path.relative(ROOT_DIR, filePath))}: unbalanced fenced code blocks`
      );
    }
  }

  if (problems.length > 0) {
    console.error("Documentation validation failed.");
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exit(1);
  }

  console.log(`Documentation validation passed for ${files.length} markdown files.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
