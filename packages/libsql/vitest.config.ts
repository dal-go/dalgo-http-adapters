import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test/browser runs in real Chromium with Playwright (pnpm test:browser).
    exclude: [...configDefaults.exclude, "test/browser/**"],
  },
});
