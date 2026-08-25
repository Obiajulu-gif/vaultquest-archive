const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const THRESHOLD = 90;

async function run() {
  console.log("Starting Lighthouse audits...");

  const reportDir = path.join(process.cwd(), "lighthouse-reports");
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir);
  }

  const pages = [
    { name: "Home Page", path: "/", file: "home.json" },
    { name: "Account Dashboard", path: "/app/account?mockConnected=true", file: "account.json" },
  ];

  const results = [];
  let failed = false;

  for (const page of pages) {
    const url = `http://localhost:3000${page.path}`;
    const reportPath = path.join(reportDir, page.file);

    console.log(`Auditing ${page.name} (${url})...`);
    try {
      // Run Lighthouse via npx
      execSync(
        `npx lighthouse ${url} --output=json --output-path=${reportPath} --chrome-flags="--headless --no-sandbox --disable-gpu --disable-dev-shm-usage" --quiet`,
        { stdio: "inherit" }
      );

      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      
      const scores = {
        performance: Math.round((report.categories.performance?.score || 0) * 100),
        accessibility: Math.round((report.categories.accessibility?.score || 0) * 100),
        bestPractices: Math.round((report.categories["best-practices"]?.score || 0) * 100),
        seo: Math.round((report.categories.seo?.score || 0) * 100),
      };

      console.log(`Scores for ${page.name}:`, scores);
      results.push({ name: page.name, path: page.path, scores });

      // Fail if performance, accessibility, or best practices drop below 90
      if (scores.performance < THRESHOLD) {
        console.error(`❌ ${page.name} Performance score is below 90: ${scores.performance}`);
        failed = true;
      }
      if (scores.accessibility < THRESHOLD) {
        console.error(`❌ ${page.name} Accessibility score is below 90: ${scores.accessibility}`);
        failed = true;
      }
      if (scores.bestPractices < THRESHOLD) {
        console.error(`❌ ${page.name} Best Practices score is below 90: ${scores.bestPractices}`);
        failed = true;
      }
    } catch (error) {
      console.error(`❌ Failed to audit ${page.name}:`, error.message);
      failed = true;
    }
  }

  // Compile summarized report markdown
  let markdown = `### ⚡ Lighthouse & Axe Audit Results

Here is a summary of the automated performance and accessibility audits run against the preview deployment:

| Audited Page | Performance | Accessibility | Best Practices | SEO |
| :--- | :---: | :---: | :---: | :---: |
`;

  results.forEach((res) => {
    const s = res.scores;
    const perfStatus = s.performance >= THRESHOLD ? "✅" : "❌";
    const accStatus = s.accessibility >= THRESHOLD ? "✅" : "❌";
    const bpStatus = s.bestPractices >= THRESHOLD ? "✅" : "❌";
    const seoStatus = s.seo >= THRESHOLD ? "✅" : "❌";

    markdown += `| **${res.name}** (\`${res.path}\`) | ${perfStatus} ${s.performance} | ${accStatus} ${s.accessibility} | ${bpStatus} ${s.bestPractices} | ${seoStatus} ${s.seo} |\n`;
  });

  markdown += `\n*Threshold for build approval is **${THRESHOLD}** for Performance, Accessibility, and Best Practices (powered by axe-core).*`;

  if (failed) {
    markdown += `\n\n⚠️ **Warning**: One or more scores dropped below the required threshold of ${THRESHOLD}. The build has failed.`;
  } else {
    markdown += `\n\n🎉 **Success**: All audited pages meet or exceed our design and accessibility requirements!`;
  }

  fs.writeFileSync("lighthouse-report.md", markdown);
  console.log("Written audit summary to lighthouse-report.md");

  if (failed) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("Audit runner crashed:", err);
  process.exit(1);
});
