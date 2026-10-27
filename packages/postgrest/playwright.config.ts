import { defineConfig, devices } from "@playwright/test";

// The static origin is chosen by scripts/real-postgrest-browser.mjs so the
// PostgREST fixture can allow exactly that origin. A direct `playwright test`
// therefore needs PORT to point at the same origin the fixture allows.
const port = Number(process.env.PORT ?? "4327");

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
