import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT ?? "4317");

export default defineConfig({
  testDir: "test/browser",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }]],
  use: { baseURL: `http://127.0.0.1:${String(port)}` },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node test/browser/server.ts",
    url: `http://127.0.0.1:${String(port)}/pins.json`,
    reuseExistingServer: false,
    stdout: "pipe",
    timeout: 60_000,
  },
});
