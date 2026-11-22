import type { PrismaClient } from "@prisma/client";
import type {
  AdminSigner,
  EscrowServiceDeps,
  HorizonGateway,
  PayoutVerifier,
  TransactionAssembler
} from "../services/escrowService.js";
import { SANDBOX_FIXTURES, type SandboxScenario } from "./fixtures.js";

export interface SandboxAdapterTrace {
  sequenceLoads: number;
  assembledXdr: string[];
  signedXdr: string[];
  submissions: string[];
  verifications: string[];
}

const SANDBOX_SIGNER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export function createSandboxEscrowDependencies(
  prisma: PrismaClient,
  scenario: SandboxScenario,
  trace: SandboxAdapterTrace = {
    sequenceLoads: 0,
    assembledXdr: [],
    signedXdr: [],
    submissions: [],
    verifications: []
  }
): EscrowServiceDeps & { trace: SandboxAdapterTrace } {
  const fixture = SANDBOX_FIXTURES[scenario];
  const horizon: HorizonGateway = {
    async loadSequence() {
      trace.sequenceLoads += 1;
      return String(10_000 + trace.sequenceLoads);
    },
    async submit(signedXdr) {
      trace.submissions.push(signedXdr);
      const submission = trace.submissions.length;
      if (!signedXdr.startsWith("sandbox-signed:sandbox-xdr:")) {
        throw new Error("Sandbox Horizon accepts only sandbox-signed XDR");
      }
      if (scenario === "retry_once" && submission === 1) {
        return { hash: "", successful: false, resultCode: "tx_bad_seq" };
      }
      if (scenario === "timeout_once" && submission === 1) {
        throw new Error("timeout");
      }
      if (scenario === "submit_failure") {
        return { hash: "", successful: false, resultCode: "tx_bad_auth" };
      }
      return {
        hash: `sandbox-${scenario}-tx-${String(submission).padStart(4, "0")}`,
        successful: true,
        resultCode: "tx_success"
      };
    }
  };

  const signer: AdminSigner = {
    publicKey: SANDBOX_SIGNER,
    async sign(xdr) {
      if (!xdr.startsWith("sandbox-xdr:")) {
        throw new Error("Sandbox signer refuses non-sandbox transaction data");
      }
      const signed = `sandbox-signed:${xdr}`;
      trace.signedXdr.push(signed);
      return signed;
    }
  };

  const assembler: TransactionAssembler = {
    async assemble(input) {
      const encoded = Buffer.from(JSON.stringify(input)).toString("base64url");
      const xdr = `sandbox-xdr:${encoded}`;
      trace.assembledXdr.push(xdr);
      return { xdr, sourceAccount: SANDBOX_SIGNER, sequence: input.sequence };
    }
  };

  const verifier: PayoutVerifier = {
    async verify(txHash) {
      trace.verifications.push(txHash);
      if (scenario === "verification_pending") return null;
      if (scenario === "verification_mismatch") return fixture.mismatchPayoutFacts ?? null;
      return fixture.payoutFacts;
    }
  };

  return {
    prisma,
    horizon,
    signer,
    assembler,
    verifier,
    networkPassphrase: "VaultQuest Sandbox Network",
    sleep: async () => undefined,
    trace
  };
}