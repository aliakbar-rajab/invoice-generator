import { defineConfig } from "@playwright/test";

// Layout regression checks only (renders buildInvoiceHtml() output in a
// real browser to measure computed geometry) — kept out of the vitest
// suite because that runs inside workerd (@cloudflare/vitest-pool-workers),
// which has no layout engine to measure against.
export default defineConfig({
  testDir: "./test-visual",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
  },
});
