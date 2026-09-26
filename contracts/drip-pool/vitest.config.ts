import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      "@drip-pool": path.resolve(__dirname, "./"),
      "@trustquest/backend": path.resolve(__dirname, "../../backend"),
      "@vaultquest/stellar-wallet-connect": path.resolve(__dirname, "../../stellar-wallet-connect"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
    environment: "node",
  },
});
