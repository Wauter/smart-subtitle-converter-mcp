import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } },
      { test: { name: "mcp", include: ["tests/mcp/**/*.test.ts"], environment: "node", testTimeout: 20000 } },
      { test: { name: "e2e", include: ["tests/e2e/**/*.test.ts"], environment: "node", testTimeout: 30000 } },
      { test: { name: "contract", include: ["tests/contract/**/*.test.ts"], environment: "node", testTimeout: 120000, fileParallelism: false } },
    ],
  },
});
