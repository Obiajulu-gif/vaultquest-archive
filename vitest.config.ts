import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.kilo/**",
      "**/.agents/**",
      "**/.gemini/**",
      "backend/**",
      "contracts/**",
      "stellar-wallet-connect/**"
    ]
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      // Not a declared dependency yet (see tests/mocks/react-hot-toast.js).
      "react-hot-toast": path.resolve(__dirname, "./tests/mocks/react-hot-toast.js")
    }
  }
});
