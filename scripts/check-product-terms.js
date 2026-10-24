#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".kilo",
  ".agents",
  ".gemini",
  ".system_generated",
  "dist",
  "build",
  "out",
  "coverage",
  "scripts"
]);

const STILL_TEXT_FILE = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "mdx",
  "yml",
  "yaml",
  "html",
  "htm",
  "astro",
  "css",
  "scss",
  "less",
  "txt",
  "env",
  "cfg",
  "conf",
  "ini",
  "toml",
  "xml",
  "sh",
  "bash"
]);

const SPECIAL_TEXT_NAMES = new Set([
  "README",
  "LICENSE",
  "Dockerfile",
  "Makefile",
  ".gitignore",
  ".npmrc",
  ".env.example",
  ".prettierrc",
  "tsconfig.json",
  "jsconfig.json"
]);

const blockedTerms = [
  {
    term: "TrustQuest",
    label: "legacy product name"
  },
  {
    term: "Drip Wave",
    label: "legacy product name"
  },
  {
    term: "Trustless Work",
    label: "legacy integration name"
  }
];

const whitelistFile = path.resolve(process.cwd(), "scripts/legacy-term-whitelist.json");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeRegex(term) {
  const escaped = escapeRegExp(term);
  const startWord = /[A-Za-z0-9]/.test(term[0]);
  const endWord = /[A-Za-z0-9]/.test(term[term.length - 1]);
  const prefix = startWord ? "\\b" : "";
  const suffix = endWord ? "\\b" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "gi");
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const base = path.basename(filePath);
  return STILL_TEXT_FILE.has(ext) || SPECIAL_TEXT_NAMES.has(base);
}

async function traverse(dir, callback) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await traverse(fullPath, callback);
      continue;
    }

    if (!isTextFile(fullPath)) {
      continue;
    }

    callback(fullPath);
  }
}

function loadWhitelist() {
  try {
    const raw = fs.readFileSync(whitelistFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Whitelist file must contain an array");
    }
    return parsed.map((entry) => ({
      term: String(entry.term),
      paths: entry.paths ? entry.paths.map(String) : [],
      reason: entry.reason ? String(entry.reason) : ""
    }));
  } catch (error) {
    throw new Error(`Unable to load legacy term whitelist: ${error.message}`);
  }
}

function isWhitelisted(entry, relativePath) {
  return entry.paths.some((pattern) => relativePath.includes(pattern));
}

async function main() {
  const whitelist = loadWhitelist();
  const matches = [];
  const regexes = blockedTerms.map((item) => ({
    ...item,
    regex: makeRegex(item.term)
  }));

  await traverse(process.cwd(), (filePath) => {
    const relativePath = normalizePath(path.relative(process.cwd(), filePath));
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    for (const { term, label, regex } of regexes) {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const match = regex.exec(line);
        if (!match) continue;
        const whitelisted = whitelist.some(
          (entry) => entry.term === term && isWhitelisted(entry, relativePath)
        );
        if (whitelisted) continue;
        matches.push({
          path: relativePath,
          term,
          label,
          lineNumber: index + 1,
          line: line.trim()
        });
      }
    }
  });

  if (matches.length > 0) {
    console.error("Legacy product term check failed.");
    console.error("Found disallowed legacy terms in source files:");
    for (const match of matches) {
      console.error(
        `- ${match.path}:${match.lineNumber}: ${match.term} (${match.label})\n    ${match.line}`
      );
    }
    console.error(
      "\nIf this reference is intentional, add it to scripts/legacy-term-whitelist.json."
    );
    process.exit(1);
  }

  console.log("Legacy product term check passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
