import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test/browser runs in real browsers with Playwright (pnpm test:browser).
    exclude: [...configDefaults.exclude, "test/browser/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
