import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  // Global ignores (a config object with only `ignores` applies everywhere).
  // Declaration files have no runtime code, so type-aware linting skips them.
  { ignores: ["**/*.d.ts"] },
  {
    ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", "temp_epub/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
  // For all TypeScript files
  {
    files: ["**/*.ts", "**/*.d.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Catch unawaited promises in the async-heavy pipeline.
      "@typescript-eslint/no-floating-promises": "error",
    },
  }
);
