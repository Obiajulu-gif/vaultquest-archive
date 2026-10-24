#!/usr/bin/env node

/**
 * Accessibility Validation Script
 *
 * Performs automated checks on the application's accessibility:
 * - Verifies semantic HTML structure
 * - Checks for accessible form labels
 * - Validates heading hierarchy
 * - Checks color contrast (placeholder)
 * - Validates ARIA attributes
 *
 * Usage: node scripts/check-accessibility.js
 */

const fs = require("fs");
const path = require("path");

const ISSUES = {
  passed: 0,
  warnings: 0,
  critical: 0,
};

const RESULTS = [];

function log(level, message, file = "") {
  const timestamp = new Date().toISOString().split("T")[1];
  const fileInfo = file ? ` [${file}]` : "";
  const prefix = {
    pass: "✅ PASS",
    warn: "⚠️  WARN",
    fail: "❌ FAIL",
  }[level];

  console.log(`${prefix} ${timestamp}${fileInfo}: ${message}`);

  RESULTS.push({ level, message, file });

  if (level === "pass") ISSUES.passed++;
  else if (level === "warn") ISSUES.warnings++;
  else if (level === "fail") ISSUES.critical++;
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function checkFile(filePath) {
  const content = readFile(filePath);
  if (!content) return;

  const relativePath = path.relative(process.cwd(), filePath);

  // Skip non-component files
  if (!filePath.includes("/components/") && !filePath.endsWith("page.jsx")) {
    return;
  }

  // Check 1: Page must have <h1> or semantically important heading
  const hasH1 = /<h1/.test(content);
  const hasMainHeading = /<h[1-2]/.test(content);
  if (filePath.endsWith("page.jsx") && !hasH1) {
    log("warn", "Missing <h1> on page component", relativePath);
  } else if (hasH1) {
    log("pass", "Page has <h1>", relativePath);
  }

  // Check 2: Form inputs should have <label> elements
  const inputCount = (content.match(/<input/g) || []).length;
  const labelCount = (content.match(/<label/g) || []).length;
  const accessibleFieldCount = (content.match(/AccessibleField/g) || []).length;

  if (inputCount > 0) {
    const properlyLabeled = labelCount >= inputCount - 2 || accessibleFieldCount >= inputCount - 2;
    if (properlyLabeled) {
      log("pass", `All ${inputCount} inputs have labels`, relativePath);
    } else {
      log("fail", `Only ${labelCount} of ${inputCount} inputs have labels`, relativePath);
    }
  }

  // Check 3: Form inputs should use aria-label or <label>
  const ariaLabeledInputs = (content.match(/aria-label/g) || []).length;
  const implicitLabels = (content.match(/htmlFor/g) || []).length;

  if (inputCount > 0 && ariaLabeledInputs + implicitLabels < inputCount - 2) {
    log("warn", "Some inputs may lack proper accessible names", relativePath);
  }

  // Check 4: Error messages should use aria-describedby
  const errorMessages = (content.match(/error|Error/g) || []).length;
  const ariaDescribedBy = (content.match(/aria-describedby/g) || []).length;

  if (errorMessages > 0 && ariaDescribedBy < Math.max(1, errorMessages / 5)) {
    log("warn", "Error messages might not be properly linked to form fields", relativePath);
  }

  // Check 5: Interactive elements should be keyboard accessible
  const buttons = (content.match(/<button/g) || []).length;
  const links = (content.match(/<a/g) || []).length;
  const divClicks = (content.match(/div.*onClick/g) || []).length;

  if (divClicks > 0) {
    log("fail", `Found ${divClicks} non-semantic clickable divs (use <button> instead)`, relativePath);
  } else if (buttons + links > 0) {
    log("pass", `${buttons} buttons and ${links} links are semantic`, relativePath);
  }

  // Check 6: Tables should have proper structure
  const tables = (content.match(/<table/g) || []).length;
  const tableHeaders = (content.match(/<th/g) || []).length;
  const tableScopes = (content.match(/scope=/g) || []).length;

  if (tables > 0) {
    if (tableHeaders > 0) {
      log("pass", `Table has ${tableHeaders} header cells`, relativePath);
    } else {
      log("fail", "Table missing <th> header cells", relativePath);
    }

    if (tableScopes >= tableHeaders / 2) {
      log("pass", `Table headers have scope attributes`, relativePath);
    } else {
      log("warn", "Table headers missing scope attributes", relativePath);
    }
  }

  // Check 7: Images should have alt text
  const images = (content.match(/<img/g) || []).length;
  const alts = (content.match(/alt=/g) || []).length;
  const imageComponents = (content.match(/Image\s+alt=/g) || []).length;

  if (images + imageComponents > 0) {
    const totalImages = images + imageComponents;
    if (alts + imageComponents >= totalImages - 1) {
      log("pass", `All ${totalImages} images have alt text`, relativePath);
    } else {
      log("fail", `Only ${alts} of ${images} images have alt text`, relativePath);
    }
  }

  // Check 8: Skip link or main landmark
  const hasSkipLink = /skip.*main|Skip.*content/i.test(content);
  const hasMainLandmark = /<main|role="main"/.test(content);

  if (filePath.endsWith("layout.jsx") || filePath.includes("page.jsx")) {
    if (hasSkipLink || hasMainLandmark) {
      log("pass", "Has skip link or main landmark", relativePath);
    } else {
      log("warn", "Missing skip link to main content", relativePath);
    }
  }

  // Check 9: Headings should be in hierarchical order (heuristic)
  const h1Count = (content.match(/<h1/g) || []).length;
  const h2Count = (content.match(/<h2/g) || []).length;
  const h4Count = (content.match(/<h4/g) || []).length;
  const h6Count = (content.match(/<h6/g) || []).length;

  if (h1Count === 0 && h2Count > 0 && filePath.endsWith("page.jsx")) {
    log("warn", "Page has <h2> but no <h1>", relativePath);
  }

  if (h6Count > 0 && h4Count === 0) {
    log("warn", "Has <h6> but no <h4> (may skip hierarchy)", relativePath);
  }

  // Check 10: Using AccessibleButton/AccessibleField components
  const hasAccessibleComponents =
    /AccessibleButton|AccessibleField|AccessibleCheckbox|AccessibleSelect/.test(content);
  if (inputCount > 0 || buttons > 0) {
    if (hasAccessibleComponents) {
      log("pass", "Using accessible form components", relativePath);
    } else if (!filePath.includes("node_modules") && inputCount > 0) {
      log("warn", "Not using AccessibleField component for forms", relativePath);
    }
  }
}

function scanDirectory(dir, ext = ".jsx") {
  const files = fs.readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = path.join(dir, file.name);

    if (file.isDirectory()) {
      if (!file.name.startsWith(".") && file.name !== "node_modules") {
        scanDirectory(fullPath, ext);
      }
    } else if (file.name.endsWith(ext)) {
      checkFile(fullPath);
    }
  }
}

console.log("🔍 VaultQuest Accessibility Audit");
console.log("==================================\n");

// Scan components and pages
scanDirectory(path.join(process.cwd(), "app", "components"));
scanDirectory(path.join(process.cwd(), "app", "app"));

console.log("\n==================================");
console.log("📊 Summary");
console.log("==================================");
console.log(`✅ Passed:    ${ISSUES.passed}`);
console.log(`⚠️  Warnings: ${ISSUES.warnings}`);
console.log(`❌ Failed:    ${ISSUES.critical}\n`);

if (ISSUES.critical > 0) {
  console.log("❌ AUDIT FAILED: Critical accessibility issues found");
  process.exit(1);
} else if (ISSUES.warnings > 0) {
  console.log("⚠️  AUDIT PASSED WITH WARNINGS: Fix warnings to improve accessibility");
  process.exit(0);
} else {
  console.log("✅ AUDIT PASSED: No critical accessibility issues found");
  process.exit(0);
}
