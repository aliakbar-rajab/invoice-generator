import { defineConfig } from "@playwright/test";

const PORT = 4173;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  timeout: 45_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  // One static server for the whole run (tests/server-helper.mjs), instead of
  // each spec file standing one up in its own beforeAll.
  webServer: {
    command: "node tests/server-helper.mjs",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
  },
  use: {
    baseURL,
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    viewport: { width: 1440, height: 1000 }
  },
  projects: [
    { name: "app", testDir: "./tests" },
  ],
});
