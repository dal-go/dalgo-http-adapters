import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test/browser runs in real Chromium with Playwright (pnpm test:browser).
    exclude: [...configDefaults.exclude, "test/browser/**"],
    // One worker keeps the shared real-server fixture within a single finite
    // process budget; test discovery and every assertion are unchanged.
    maxWorkers: 1,
  },
});
