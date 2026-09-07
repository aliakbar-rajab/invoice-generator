/*
 * Shared Playwright setup for the app's specs.
 *
 * The static server is started once per run by playwright.config.mjs
 * (`webServer`), and `use.baseURL` points at it — so a spec opens the app with
 * page.goto("/") and needs no per-file beforeAll/afterAll of its own.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { test, expect };

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const ROW_LABEL = {
  description: "شرح کالا یا خدمت",
  quantity: "تعداد یا مقدار",
  unit: "واحد",
  unitPrice: "مبلغ واحد",
};

export const persian = (n) =>
  String(n).replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 1728));

export const cell = (page, n, field) =>
  page.getByLabel(`ردیف ${persian(n)} — ${ROW_LABEL[field]}`, { exact: true });

/*
 * Loads the app and waits for its default landscape row count.
 *
 * window.print is stubbed rather than left to open a real dialog, and any
 * promise the app fails to settle is collected into window.__rejections
 * rather than vanishing into the console — which is what the openFromFile
 * rewrite has to avoid.
 */
export async function openApp(page) {
  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => { window.__printCalls += 1; };
    window.__rejections = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.__rejections.push(String((event.reason && event.reason.message) || event.reason));
    });
  });
  await page.goto("/");
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
}

export async function fillRow(page, index, description, quantity, price) {
  await cell(page, index, "description").fill(description);
  await cell(page, index, "quantity").fill(quantity);
  await cell(page, index, "unitPrice").fill(price);
}

export function fillValidFirstRow(page, price = "1000") {
  return fillRow(page, 1, "کالای آزمایشی", "1", price);
}
