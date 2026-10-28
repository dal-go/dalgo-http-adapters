import { defineConfig, devices } from "@playwright/test";

// scripts/real-typesense-browser.mjs chooses the static loopback origin. The
// owned Typesense server allows exactly that origin, so Chromium itself proves
// a genuine cross-origin fetch; no request is routed or faked.
const port = Number(process.env.PORT ?? "4331");

export default defineConfig({
  testDir: "test/browser",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }]],
  use: { baseURL: `http://127.0.0.1:${String(port)}` },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node test/browser/server.ts",
    url: `http://127.0.0.1:${String(port)}/health`,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  },
});
