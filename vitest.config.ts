import { defineConfig } from "vitest/config";

// TODO: We need to find a better way to handle tests that involve process.exit

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "src/types.ts", "src/types.d.ts"],
      // Regression floor only: measured unit coverage is well above these
      // values, so they catch large drops rather than small ones. The CLI
      // and scripts/fix have unit tests; most author-workflow modules in
      // scripts/ops are exercised mainly by the EPUBCheck E2E suite, which
      // does not count toward these numbers.
      thresholds: {
        statements: 58,
        branches: 48,
        functions: 68,
        lines: 58,
      },
    },
  },
});
