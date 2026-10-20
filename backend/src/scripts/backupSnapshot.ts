import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { captureBackupSnapshot, validateBackupSnapshot } from "../services/backupSnapshot.js";

async function main() {
  const { values } = parseArgs({ options: { snapshot: { type: "string" }, output: { type: "string" } } });
  if (Boolean(values.snapshot) === Boolean(values.output)) throw new Error("choose --snapshot <file> to validate or --output <new-file> to capture");
  if (values.snapshot) {
    const report = validateBackupSnapshot(JSON.parse(await readFile(values.snapshot, "utf8")));
    console.log(JSON.stringify(report, null, 2));
    if (report.failureCount) process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  try {
    const snapshot = await captureBackupSnapshot(prisma);
    await writeFile(values.output!, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ status: "captured", readOnly: true, rowCounts: snapshot.rowCounts }));
  } finally { await prisma.$disconnect(); }
}
main().catch(() => {
  console.error(JSON.stringify({ status: "unavailable", readOnly: true,
    hint: "Use --snapshot <JSON file> or --output <new file>; check file access, JSON syntax and database connectivity. Existing files are never overwritten." }));
  process.exitCode = 2;
});
