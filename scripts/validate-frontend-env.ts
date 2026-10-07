import { parseFrontendEnv } from "../stellar-wallet-connect/src/core/env.js";
try {
  parseFrontendEnv();
  console.log("Frontend environment configuration is valid.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid frontend environment configuration");
  process.exitCode = 1;
}
