import { defineConfig } from "vitest/config";

// Vitest inherits Vite config from the root postcss.config.js.
// For backend tests we don't need CSS processing, so disable it.
export default defineConfig({
  root: process.cwd(),
  test: {
    globals: false,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    include: ["tests/**/*.spec.ts"]
  },
  // @ts-expect-error: Vite's css config accepts `false` to disable CSS
  css: false
});