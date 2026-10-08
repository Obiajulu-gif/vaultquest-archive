import { defineConfig } from "vitest/config";

// These maintainer utilities are DOM-free and do not need wallet UI mocks.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/record-provenance.test.ts",
      "tests/archive-export.test.ts",
      "tests/permission-diff.test.ts",
      "tests/sensitive-field-access.test.ts",
    ],
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
});
