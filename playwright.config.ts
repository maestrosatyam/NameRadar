import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against:
 *  - the MOCK Qloo server (synthetic data) by default, so CI needs no key, or
 *  - a deployed URL when E2E_BASE_URL is set (live Qloo; used for the public smoke test).
 */
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 60_000 },
  retries: external ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: external ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: external
    ? undefined
    : [
        { command: "npx tsx scripts/mock_qloo_server.ts", port: 4010, reuseExistingServer: true },
        {
          command: "npx next dev -p 3000",
          port: 3000,
          reuseExistingServer: true,
          timeout: 300_000,
          env: { QLOO_API_URL: "http://localhost:4010", QLOO_API_KEY: "mock-key", NEBIUS_API_KEY: "" },
        },
      ],
});
