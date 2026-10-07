import { getEnv } from "../env.js";
try {
  getEnv();
  console.log("Backend environment configuration is valid.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid backend environment configuration");
  process.exitCode = 1;
}
