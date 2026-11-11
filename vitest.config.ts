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
      // Unit-test regression floors, with a small margin for runtime coverage
      // differences. Generated-book tests exercise the author workflow too;
      // the separate EPUBCheck E2E suite does not count toward these numbers.
      thresholds: {
        statements: 82,
        branches: 72,
        functions: 90,
        lines: 83,
      },
    },
  },
});
