import { PrismaClient } from "@prisma/client";
import { EscrowService } from "../services/escrowService.js";
import { createSandboxEscrowDependencies } from "../sandbox/escrowAdapters.js";
import { parseSandboxConfig } from "../sandbox/config.js";
import { SANDBOX_AMOUNT, SANDBOX_FIXTURES, SANDBOX_RECIPIENT } from "../sandbox/fixtures.js";

async function main() {
  const config = parseSandboxConfig();
  const fixture = SANDBOX_FIXTURES[config.scenario];
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

  try {
    const dependencies = createSandboxEscrowDependencies(prisma, config.scenario);
    const service = new EscrowService(dependencies);
    const result = await service.settleVault({
      vaultId: `sandbox-${config.scenario}`,
      settlementType: "release",
      recipient: SANDBOX_RECIPIENT,
      amount: SANDBOX_AMOUNT
    });
    const report = {
      mode: "sandbox",
      scenario: config.scenario,
      description: fixture.description,
      expected_state: fixture.expectedState,
      result,
      adapter_trace: dependencies.trace
    };
    console.log(JSON.stringify(report, null, 2));

    if (result.state !== fixture.expectedState) {
      throw new Error(`Expected ${fixture.expectedState}, received ${result.state}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});