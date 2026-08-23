import { test, expect } from "@playwright/test";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server;
let baseURL;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
};

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const target = path.resolve(repoRoot, relative);
      if (!target.startsWith(repoRoot + path.sep)) throw new Error("outside root");
      const body = await readFile(target);
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(target)] || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openApp(page) {
  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => { window.__printCalls += 1; };
  });
  await page.goto(baseURL);
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
}

async function fillValidFirstRow(page, price = "1000") {
  await page.getByLabel("ردیف ۱ — شرح کالا یا خدمت", { exact: true }).fill("کالای آزمایشی");
  await page.getByLabel("ردیف ۱ — تعداد یا مقدار", { exact: true }).fill("1");
  await page.getByLabel("ردیف ۱ — مبلغ واحد", { exact: true }).fill(price);
}

async function saveNamed(page, name, saveAs = false) {
  const buttonName = saveAs ? "ذخیره با نام جدید" : "ذخیره";
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-input").fill(name);
  await page.locator("#app-dialog-actions button").first().click();
  await expect(page.locator("#toolbar-status")).toContainText("ذخیره شد");
}

function asciiDigits(value) {
  return value
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

test("invalid financial values are neutralized and block authoritative Save/Print", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill("200");

  await expect(page.locator('[data-total="grossTotal"]')).toHaveText("۱٬۰۰۰ ریال");
  await expect(page.locator('[data-total="taxTotal"]')).toHaveText("۰ ریال");
  await expect(page.locator('[data-total="netTotal"]')).toHaveText("۱٬۰۰۰ ریال");

  await page.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(page.locator("#app-dialog")).toBeHidden();
  await expect(page.locator("#toolbar-status")).toContainText("خطاهای مالی");

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(0);

  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill("10");
  await page.getByLabel("ردیف ۱ — تعداد یا مقدار", { exact: true }).fill("-1");
  await expect(page.locator('[data-total="grossTotal"]')).toHaveText("۰ ریال");
  await expect(page.locator('[data-total="netTotal"]')).toHaveText("۰ ریال");
});

test("an over-height row blocks printing instead of creating a clipped page", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill("0");
  await page.getByLabel("ردیف ۱ — شرح کالا یا خدمت", { exact: true }).fill("شرح بسیار بلند ".repeat(1500));

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect(page.locator("#toolbar-status")).toContainText("در صفحهٔ A4 جا نمی‌شود");
  await expect(page.locator("#invoice-validation-list")).toContainText("برای جلوگیری از حذف محتوا، چاپ متوقف شد");
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(0);
  await expect(page.locator("#print-document .print-page")).toHaveCount(0);
});

test("deleting in one tab preserves invoices saved concurrently in another", async ({ browser }) => {
  const context = await browser.newContext({ locale: "fa-IR", timezoneId: "Asia/Tehran" });
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await openApp(pageA);
  await openApp(pageB);

  await pageA.getByLabel("نام خریدار", { exact: true }).fill("خریدار اول");
  await saveNamed(pageA, "سند اول");

  await pageB.locator("#btn-saved-list").click();
  await expect(pageB.locator(".saved-item-name")).toHaveText(["سند اول"]);
  await pageB.locator(".saved-item-actions button.danger").click();
  await expect(pageB.locator("#app-dialog")).toBeVisible();

  await saveNamed(pageA, "سند دوم", true);
  await pageB.locator("#app-dialog-actions button.danger").click();

  await pageA.locator("#btn-saved-list").click();
  await expect(pageA.locator(".saved-item-name")).toHaveText(["سند دوم"]);
  await context.close();
});

test("malformed legacy storage stays recoverable and cannot break or be overwritten by new saves", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("preinvoice.saved.v1", "null");
  });
  await openApp(page);

  await expect(page.locator("#invoice-validation-list")).toContainText("فهرست قدیمی ذخیره‌ها خراب است");
  await page.getByLabel("نام خریدار", { exact: true }).fill("ذخیرهٔ سالم");
  await saveNamed(page, "سند سالم");

  const storageState = await page.evaluate(() => ({
    legacy: localStorage.getItem("preinvoice.saved.v1"),
    independentEntries: Object.keys(localStorage).filter((key) => key.startsWith("preinvoice.saved.entry.v2.")).length
  }));
  expect(storageState).toEqual({ legacy: "null", independentEntries: 1 });
});

test("valid monolithic saves migrate to independent entries before the old key is removed", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("preinvoice.saved.v1", JSON.stringify({
      "inv-legacy-test": {
        id: "inv-legacy-test",
        name: "سند قدیمی سالم",
        savedAt: 1_700_000_000_000,
        data: { version: 7, meta: { number: "۱۴۰۲۰۸۲۳-۰۰۱" }, company: { profile: "fouladBonyan" }, items: [] }
      }
    }));
  });
  await openApp(page);
  await page.locator("#btn-saved-list").click();
  await expect(page.locator(".saved-item-name")).toHaveText(["سند قدیمی سالم"]);

  const migrated = await page.evaluate(() => ({
    legacyRemoved: localStorage.getItem("preinvoice.saved.v1") === null,
    entryPresent: localStorage.getItem("preinvoice.saved.entry.v2.inv-legacy-test") !== null
  }));
  expect(migrated).toEqual({ legacyRemoved: true, entryPresent: true });
});

test("automatic date, number, and validity advance together after midnight", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-23T20:29:00.000Z") });
  await openApp(page);

  const before = await page.evaluate(() => ({
    date: document.querySelector('[data-field="meta.date"]').value,
    number: document.querySelector('[data-field="meta.number"]').value,
    validity: document.querySelector('[data-field="meta.validity"]').value
  }));

  await page.clock.fastForward(120_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  const after = await page.evaluate(() => ({
    date: document.querySelector('[data-field="meta.date"]').value,
    number: document.querySelector('[data-field="meta.number"]').value,
    validity: document.querySelector('[data-field="meta.validity"]').value
  }));
  expect(after.date).not.toBe(before.date);
  expect(after.validity).not.toBe(before.validity);
  expect(asciiDigits(after.number).split("-")[0]).toBe(asciiDigits(after.date).replace(/\D/g, ""));
  await expect(page.locator("#toolbar-status")).toContainText("تغییرات ذخیره‌نشده");
  await expect(page.locator("#status-dot")).toHaveClass(/is-dirty/);
});

test("automatic print orientation changes update dirty and save-status UI", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page, "9".repeat(42));
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill("0");
  await page.getByRole("radio", { name: "عمودی", exact: true }).check();
  await expect(page.locator(".numeric-overflow").first()).toBeVisible();
  await saveNamed(page, "سند جهت چاپ");
  await expect(page.locator("#status-dot")).not.toHaveClass(/is-dirty/);

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect(page.getByRole("radio", { name: "افقی", exact: true })).toBeChecked();
  await expect(page.locator("#status-dot")).toHaveClass(/is-dirty/);
  await expect(page.locator("#toolbar-status")).not.toContainText("ذخیره شد");
});

test("an empty invoice remains printable without a modal or warning inside the print clone", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
  await expect(page.locator("#app-dialog")).toBeHidden();
  await expect(page.locator("#print-document .print-page")).toHaveCount(1);
  await expect(page.locator("#print-document .invoice-validation")).toHaveCount(0);
});

test("postal code permanently follows the address for both parties", async ({ page }) => {
  await openApp(page);
  const fieldOrder = await page.locator(".inv-card").evaluateAll((cards) => cards.map((card) =>
    Array.from(card.querySelectorAll("[data-field]"), (field) => field.dataset.field)
  ));
  expect(fieldOrder[0].slice(0, 3)).toEqual(["seller.name", "seller.address", "seller.postalCode"]);
  expect(fieldOrder[1].slice(0, 3)).toEqual(["buyer.name", "buyer.address", "buyer.postalCode"]);
  await expect(page.locator(".inv-meta-icon")).toHaveCount(3);
  await expect(page.locator(".inv-card-head-icon")).toHaveCount(2);
  await expect(page.getByLabel("نشانی خریدار", { exact: true })).not.toHaveAttribute("placeholder");
});

test("fresh orientation defaults change only untouched item rows", async ({ page }) => {
  await openApp(page);
  await page.getByRole("radio", { name: "عمودی", exact: true }).check();
  await expect(page.locator("#inv-rows tr")).toHaveCount(8);
  await page.getByRole("radio", { name: "افقی", exact: true }).check();
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);

  await page.getByLabel("ردیف ۱ — شرح کالا یا خدمت", { exact: true }).fill("قلم کاربر");
  await page.getByRole("radio", { name: "عمودی", exact: true }).check();
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
});

test("editor and print clone keep the same gap below a grown landscape table", async ({ page }) => {
  await openApp(page);
  for (let index = 0; index < 5; index += 1) {
    await page.getByRole("button", { name: "افزودن ردیف/قلم جدید", exact: true }).click();
  }
  const screenGap = await page.locator("#invoice-sheet").evaluate((sheet) => {
    const table = sheet.querySelector(".inv-table-frame").getBoundingClientRect();
    const summary = sheet.querySelector(".inv-summary").getBoundingClientRect();
    return summary.top - table.bottom;
  });
  expect(screenGap).toBeGreaterThan(5);

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await page.locator("#print-document").evaluate((documentRoot) => documentRoot.classList.add("is-measuring"));
  const printGap = await page.locator("#print-document .print-page").last().evaluate((sheet) => {
    const table = sheet.querySelector(".inv-table-frame").getBoundingClientRect();
    const summary = sheet.querySelector(".inv-summary").getBoundingClientRect();
    return summary.top - table.bottom;
  });
  expect(Math.abs(screenGap - printGap)).toBeLessThanOrEqual(1);
});

test("a normal multi-page plan fits every generated A4 page and renders to PDF", async ({ page }, testInfo) => {
  await openApp(page);
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill("10");

  for (let index = 0; index < 24; index += 1) {
    if (index >= 7) await page.getByRole("button", { name: "افزودن ردیف/قلم جدید", exact: true }).click();
    const rowNumber = String(index + 1).replace(/[0-9]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 1728));
    await page.getByLabel(`ردیف ${rowNumber} — شرح کالا یا خدمت`, { exact: true }).fill(`قلم آزمایشی چندصفحه‌ای شماره ${index + 1}`);
    await page.getByLabel(`ردیف ${rowNumber} — تعداد یا مقدار`, { exact: true }).fill("1");
    await page.getByLabel(`ردیف ${rowNumber} — مبلغ واحد`, { exact: true }).fill(String((index + 1) * 1000));
  }

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
  const pages = page.locator("#print-document .print-page");
  expect(await pages.count()).toBeGreaterThan(1);
  const pageMetrics = await pages.evaluateAll((elements) => elements.map((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  })));
  expect(pageMetrics.every((metric) => metric.scrollHeight <= metric.clientHeight + 2)).toBe(true);

  await page.pdf({
    path: testInfo.outputPath("multi-page-invoice.pdf"),
    preferCSSPageSize: true,
    printBackground: true
  });
});

test("the app still boots in its supported direct file mode", async ({ page }) => {
  await page.goto(pathToFileURL(path.join(repoRoot, "index.html")).href);
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
  await expect(page.locator("#toolbar-status")).toContainText("آماده برای ثبت پیش‌فاکتور جدید");
});
