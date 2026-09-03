import { test, expect } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, startRepoServer, stopRepoServer } from "./server-helper.mjs";

let server;
let baseURL;

test.beforeAll(async () => {
  ({ server, baseURL } = await startRepoServer());
});

test.afterAll(async () => {
  await stopRepoServer(server);
});

async function openApp(page) {
  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => { window.__printCalls += 1; };
    // Any promise the app fails to settle shows up here rather than vanishing
    // into the console, which is what the openFromFile rewrite has to avoid.
    window.__rejections = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.__rejections.push(String((event.reason && event.reason.message) || event.reason));
    });
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

function sheetOverflow(page) {
  return page.locator("#invoice-sheet").evaluate((sheet) => sheet.scrollHeight - sheet.clientHeight);
}

async function fillFirstRowAndBuyer(page) {
  await fillValidFirstRow(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار آزمایشی");
}

// Drives the hidden file input the same way the picker does, so the whole
// openFromFile path (read → parse → shape check → apply) runs for real.
async function importJsonFile(page, filename, contents) {
  await page.evaluate(({ name, body }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([body], name, { type: "application/json" }));
    const input = document.getElementById("file-open");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { name: filename, body: typeof contents === "string" ? contents : JSON.stringify(contents) });
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

// ---------------------------------------------------------------------------
// Optimistic conflict detection: two tabs editing the SAME saved entry.
// Without a version check, the second tab's Save silently clobbers whatever
// the first tab already saved, discarding it with no trace.
// ---------------------------------------------------------------------------

async function openFirstSavedEntry(page) {
  await page.locator("#btn-saved-list").click();
  await page.locator(".saved-item-actions button", { hasText: "باز کردن" }).first().click();
}

test("saving over an entry another tab already saved a newer version of warns before overwriting", async ({ browser }) => {
  const context = await browser.newContext({ locale: "fa-IR", timezoneId: "Asia/Tehran" });
  const pageA = await context.newPage();
  await openApp(pageA);
  await fillValidFirstRow(pageA);
  await pageA.getByLabel("نام خریدار", { exact: true }).fill("خریدار اصلی");
  await saveNamed(pageA, "سند مشترک");

  // Tab B opens the very same saved entry.
  const pageB = await context.newPage();
  await openApp(pageB);
  await openFirstSavedEntry(pageB);
  await expect(pageB.getByLabel("نام خریدار", { exact: true })).toHaveValue("خریدار اصلی");

  // Tab A edits and re-saves (same entry, no naming dialog this time).
  await pageA.getByLabel("نام خریدار", { exact: true }).fill("ویرایش الف");
  await pageA.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(pageA.locator("#toolbar-status")).toContainText("ذخیره شد");

  // Tab B, still holding the version from before A's save, edits something
  // else and tries to save. It must be warned, not silently overwrite.
  await pageB.locator('[data-field="notes"]').fill("یادداشت ب");
  await pageB.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(pageB.locator("#app-dialog")).toBeVisible();
  await expect(pageB.locator("#app-dialog-message")).toContainText(
    "این سند در برگهٔ دیگری تغییر کرده است. آیا می‌خواهید تغییرات فعلی جایگزین نسخهٔ جدید شوند؟"
  );

  // Confirming the overwrite persists tab B's own full document (its buyer
  // name is still whatever B loaded, since B never touched that field) -
  // it explicitly replaces A's saved version, exactly as the user agreed to.
  await pageB.locator("#app-dialog-actions button.danger").click();
  await expect(pageB.locator("#toolbar-status")).toContainText("ذخیره شد");

  const pageC = await context.newPage();
  await openApp(pageC);
  await openFirstSavedEntry(pageC);
  await expect(pageC.getByLabel("نام خریدار", { exact: true })).toHaveValue("خریدار اصلی");
  await expect(pageC.locator('[data-field="notes"]')).toHaveValue("یادداشت ب");
  await context.close();
});

test("cancelling the conflict dialog keeps the other tab's saved version AND this tab's unsaved edits", async ({ browser }) => {
  const context = await browser.newContext({ locale: "fa-IR", timezoneId: "Asia/Tehran" });
  const pageA = await context.newPage();
  await openApp(pageA);
  await fillValidFirstRow(pageA);
  await pageA.getByLabel("نام خریدار", { exact: true }).fill("خریدار اصلی");
  await saveNamed(pageA, "سند مشترک دوم");

  const pageB = await context.newPage();
  await openApp(pageB);
  await openFirstSavedEntry(pageB);

  await pageA.getByLabel("نام خریدار", { exact: true }).fill("نسخهٔ نهایی الف");
  await pageA.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(pageA.locator("#toolbar-status")).toContainText("ذخیره شد");

  await pageB.locator('[data-field="notes"]').fill("یادداشت ناتمام ب");
  await pageB.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(pageB.locator("#app-dialog")).toBeVisible();
  await pageB.locator("#app-dialog-actions button", { hasText: "انصراف" }).click();

  // B's own unsaved edit is still sitting right there in the editor.
  await expect(pageB.locator('[data-field="notes"]')).toHaveValue("یادداشت ناتمام ب");
  await expect(pageB.locator("#status-dot")).toHaveClass(/is-dirty/);
  await expect(pageB.locator("#toolbar-status")).toContainText("سند در برگهٔ دیگری تغییر کرده است");

  // And storage still holds exactly A's version - nothing was overwritten.
  const pageC = await context.newPage();
  await openApp(pageC);
  await openFirstSavedEntry(pageC);
  await expect(pageC.getByLabel("نام خریدار", { exact: true })).toHaveValue("نسخهٔ نهایی الف");
  await expect(pageC.locator('[data-field="notes"]')).toHaveValue("");
  await context.close();
});

test("repeated saves in the same tab never produce a false conflict", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار یک");
  await saveNamed(page, "سند تکراری");

  // Several normal same-tab re-saves in a row: each one's own successful
  // save must become the new baseline, so the next one never conflicts
  // with itself.
  for (const buyer of ["خریدار دو", "خریدار سه", "خریدار چهار"]) {
    await page.getByLabel("نام خریدار", { exact: true }).fill(buyer);
    await page.getByRole("button", { name: "ذخیره", exact: true }).click();
    await expect(page.locator("#app-dialog")).toBeHidden();
    await expect(page.locator("#toolbar-status")).toContainText("ذخیره شد");
  }
});

test("an entry deleted in another tab still falls through to save-as-new, not a conflict prompt", async ({ browser }) => {
  const context = await browser.newContext({ locale: "fa-IR", timezoneId: "Asia/Tehran" });
  const pageA = await context.newPage();
  await openApp(pageA);
  await fillValidFirstRow(pageA);
  await pageA.getByLabel("نام خریدار", { exact: true }).fill("خریدار در معرض حذف");
  await saveNamed(pageA, "سند فانی");

  const pageB = await context.newPage();
  await openApp(pageB);
  await openFirstSavedEntry(pageB);

  // Tab A deletes the entry pageB has open.
  await pageA.locator("#btn-saved-list").click();
  await pageA.locator(".saved-item-actions button.danger").click();
  await pageA.locator("#app-dialog-actions button.danger").click();
  await expect(pageA.locator("#toolbar-status")).toContainText("حذف شد");

  // Tab B edits and saves: no such entry exists any more, so this must be
  // the ordinary "save as a new entry" flow (naming dialog), never the
  // "changed in another tab" conflict prompt.
  await pageB.locator('[data-field="notes"]').fill("یادداشت پس از حذف");
  await pageB.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(pageB.locator("#app-dialog")).toBeVisible();
  await expect(pageB.locator("#app-dialog-title")).toHaveText("نام سند");
  await expect(pageB.locator("#app-dialog-input-wrap")).toBeVisible();
  await pageB.locator("#app-dialog-actions button").first().click();
  await expect(pageB.locator("#toolbar-status")).toContainText("ذخیره شد");

  const entries = await pageB.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.indexOf("preinvoice.saved.entry.") === 0));
  expect(entries).toHaveLength(1);
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

test("an unusually large row total shrinks its own font to stay fully visible, never truncated or wrapped", async ({ page }) => {
  await openApp(page);

  // A 21-digit unit price renders a total far wider than the fixed-width
  // total column at the document's normal font-size (see FIT_MIN_SCALE /
  // fitNumericEl in app.js) — this must shrink just that cell's font until
  // the whole number fits, never truncate/ellipsize it, wrap it, or resize
  // the column, and it must land above the emergency floor that the
  // "عمودی" overflow test above deliberately blows past.
  //
  // It took 15 digits to overflow this column while the table also carried a
  // تخفیف and a "پس از تخفیف" column. Retiring those two gave every surviving
  // money column about 4% more of the table's width, so the figure that
  // exercises the shrinker had to grow with it.
  const hugePrice = "999999999999999999999";
  await fillValidFirstRow(page, hugePrice);

  const rows = page.locator("#inv-rows tr");
  const totalCell = rows.first().locator('[data-row-computed="total"]');
  await expect(totalCell).toHaveText("۹۹۹٬۹۹۹٬۹۹۹٬۹۹۹٬۹۹۹٬۹۹۹٬۹۹۹");

  // An untouched row's total cell carries no inline font-size, so its
  // computed size is the true, un-shrunk baseline to compare against —
  // avoids pinning the assertion to a hardcoded pixel value.
  const baseFontSize = await rows.nth(1)
    .locator('[data-row-computed="total"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  const metrics = await totalCell.evaluate((el) => ({
    fontSize: parseFloat(getComputedStyle(el).fontSize),
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    isOverflowing: el.classList.contains("numeric-overflow"),
  }));

  expect(metrics.isOverflowing, "must not fall back to the overflow state").toBe(false);
  expect(metrics.scrollWidth, "the full number must stay inside the cell, not get clipped")
    .toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.fontSize, "font-size must shrink to make room for the large number")
    .toBeLessThan(baseFontSize);
  expect(metrics.fontSize, "shrink must stop at a readable floor, not collapse toward zero")
    .toBeGreaterThan(baseFontSize * 0.5);

  // table-layout: fixed keeps every row's total column the same width
  // regardless of content — confirm the huge value never grew it.
  const totalCellWidths = await rows.locator('[data-row-computed="total"]').evaluateAll(
    (els) => els.map((el) => el.clientWidth)
  );
  expect(new Set(totalCellWidths).size, "column width must stay uniform across rows").toBe(1);
});

test("a very long amount-in-words wraps instead of overflowing the box, sheet, or printed page", async ({ page }) => {
  await openApp(page);
  // A 15-digit unit price makes rialToWordsBig() emit a sentence far longer
  // than the narrow totals-width box it lives in (see .inv-amount-words in
  // css/invoice.css) — this used to force the box past the sheet's edge,
  // since it had no min-width: 0 on its grid item and white-space: nowrap.
  await fillValidFirstRow(page, "999999999999999");
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار آزمایشی");
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill("10");

  const wordsValue = page.locator('[data-total="netTotalWords"]');
  await expect(wordsValue).not.toHaveText("صفر ریال");
  // Proof the sentence is actually long enough to force wrapping, not just
  // short text that happens to fit.
  expect((await wordsValue.textContent()).length).toBeGreaterThan(80);

  for (const orientationName of ["افقی", "عمودی"]) {
    await page.getByRole("radio", { name: orientationName, exact: true }).check();

    const wordsBox = page.locator("#invoice-sheet .inv-amount-words");
    const boxMetrics = await wordsBox.evaluate((el) => {
      const sheet = document.getElementById("invoice-sheet");
      const rect = el.getBoundingClientRect();
      const sheetRect = sheet.getBoundingClientRect();
      return {
        horizontalOverflow: el.scrollWidth - el.clientWidth,
        height: rect.height,
        lineHeight: parseFloat(getComputedStyle(el).lineHeight),
        withinSheet: rect.left >= sheetRect.left - 1 && rect.right <= sheetRect.right + 1,
      };
    });
    expect(boxMetrics.horizontalOverflow, orientationName + ": box must not overflow itself").toBeLessThanOrEqual(0);
    expect(boxMetrics.withinSheet, orientationName + ": box must stay inside the sheet").toBe(true);
    // Confirms the fix is actually wrapping (multiple line boxes), not merely
    // failing to overflow because the box grew unbounded in some other way.
    expect(boxMetrics.height, orientationName + ": box must wrap onto more than one line")
      .toBeGreaterThan(boxMetrics.lineHeight * 1.5);
    expect(await sheetOverflow(page), orientationName + ": wrapping must not push the sheet past one A4 page")
      .toBeLessThanOrEqual(0);

    const printsBefore = await page.evaluate(() => window.__printCalls);
    await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
    await expect.poll(
      () => page.evaluate(() => window.__printCalls),
      { message: orientationName + ": print must not be blocked by the wrapped box" }
    ).toBeGreaterThan(printsBefore);

    const printedPages = page.locator("#print-document .print-page");
    expect(await printedPages.count()).toBeGreaterThan(0);
    const pageMetrics = await printedPages.evaluateAll((elements) => elements.map((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    })));
    expect(pageMetrics.every((metric) => metric.scrollHeight <= metric.clientHeight + 2),
      orientationName + ": no printed page may overflow vertically").toBe(true);

    const printedWordsBox = page.locator("#print-document .inv-amount-words");
    await expect(printedWordsBox).toHaveCount(1);
    const printedOverflow = await printedWordsBox.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(printedOverflow, orientationName + ": printed box must not overflow horizontally").toBeLessThanOrEqual(0);
  }
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
  await expect(page.locator("#inv-rows tr")).toHaveCount(14);
  // The row counts are not arbitrary: each orientation's default is the most
  // rows that still leave the fresh sheet inside one A4 page. Asserting the
  // fit as well as the number means raising either default without checking
  // the geometry fails here instead of only showing up as a clipped print.
  expect(await sheetOverflow(page)).toBeLessThanOrEqual(0);
  await page.getByRole("radio", { name: "افقی", exact: true }).check();
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
  expect(await sheetOverflow(page)).toBeLessThanOrEqual(0);

  await page.getByLabel("ردیف ۱ — شرح کالا یا خدمت", { exact: true }).fill("قلم کاربر");
  await page.getByRole("radio", { name: "عمودی", exact: true }).check();
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
});

test("editor and print clone keep the same gap below a grown landscape table", async ({ page }) => {
  await openApp(page);
  for (let index = 0; index < 5; index += 1) {
    await page.getByRole("button", { name: "افزودن ردیف/قلم جدید", exact: true }).click();
  }
  // The rhythm solver runs behind a short debounce (scheduleSheetRhythm), so
  // the editor has to be given its settled geometry before it is measured.
  await page.waitForTimeout(300);
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
  // Editor and print clone are solved by the same routine against the same A4
  // box, so the gap below the table is the same gap — but the clone drops the
  // screen-only delete column, which widens its شرح column by ~8mm and can
  // land its density a hair apart from the editor's. Sub-millimetre, i.e.
  // still a faithful preview; anything larger is a real divergence.
  expect(Math.abs(screenGap - printGap)).toBeLessThanOrEqual(4);
});

test("eleven detailed landscape items stay on one A4 page", async ({ page }, testInfo) => {
  await openApp(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار آزمایشی");

  const descriptions = [
    "میلگرد آجدار A3 ذوب‌آهن اصفهان سایز ۱۶ شاخه ۱۲ متری",
    "میلگرد آجدار A3 ذوب‌آهن اصفهان سایز ۱۸ شاخه ۱۲ متری",
    "میلگرد آجدار A3 ذوب‌آهن اصفهان سایز ۲۰ شاخه ۱۲ متری",
    "تیرآهن IPE ذوب‌آهن اصفهان سایز ۱۴ شاخه ۱۲ متری",
    "تیرآهن IPE ذوب‌آهن اصفهان سایز ۱۶ شاخه ۱۲ متری",
    "قوطی صنعتی ۴۰ در ۴۰ ضخامت ۲ میلی‌متر شاخه ۶ متری",
    "نبشی بال مساوی ۴۰ در ۴۰ ضخامت ۴ میلی‌متر شاخه ۶ متری",
    "ناودانی سبک سایز ۸ شاخه ۶ متری تولید کارخانه تهران",
    "ورق سیاه فولاد مبارکه ضخامت ۲ میلی‌متر ابعاد ۱ در ۲ متر",
    "ورق گالوانیزه ضخامت ۱ میلی‌متر ابعاد ۱ در ۲ متر",
    "لوله صنعتی سایز ۲ اینچ ضخامت ۲ میلی‌متر شاخه ۶ متری",
  ];

  for (let index = 0; index < descriptions.length; index += 1) {
    if (index >= 7) {
      await page.getByRole("button", { name: "افزودن ردیف/قلم جدید", exact: true }).click();
    }
    const rowNumber = String(index + 1).replace(/[0-9]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) + 1728)
    );
    await page.getByLabel(`ردیف ${rowNumber} — شرح کالا یا خدمت`, { exact: true }).fill(
      descriptions[index] + " تحویل بنگاه تهران طبق مشخصات فنی مورد تأیید خریدار"
    );
    await page.getByLabel(`ردیف ${rowNumber} — تعداد یا مقدار`, { exact: true }).fill("1");
    await page.getByLabel(`ردیف ${rowNumber} — مبلغ واحد`, { exact: true }).fill(String((index + 1) * 1_000_000));
  }

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);

  const pages = page.locator("#print-document .print-page");
  await expect(pages).toHaveCount(1);
  // Eleven items whose شرح wraps to two lines no longer need a named
  // "condensed" tier. They are solved to a density below the generous end,
  // and — because two-line rows are the case that genuinely runs out of
  // paper — a few per cent off the type. The bound is what matters: the type
  // axis may never take the document below TYPE_SCALE_MIN, which is where a
  // page break becomes the better answer.
  const rhythm = await pages.first().evaluate((element) => ({
    density: Number(element.style.getPropertyValue("--print-density")),
    typeScale: Number(element.style.getPropertyValue("--doc-font-scale")),
  }));
  expect(rhythm.density).toBeGreaterThan(0);
  expect(rhythm.density).toBeLessThanOrEqual(1);
  expect(rhythm.typeScale).toBeGreaterThanOrEqual(0.9);
  expect(rhythm.typeScale).toBeLessThanOrEqual(1);
  await page.locator("#print-document").evaluate((documentRoot) => documentRoot.classList.add("is-measuring"));
  const metrics = await pages.first().evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(metrics.clientHeight).toBeGreaterThan(0);
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 2);
  const numericOverflow = await pages.first()
    .locator("[data-row-computed], .inv-totals strong")
    .evaluateAll((elements) => elements.map((element) => element.scrollWidth - element.clientWidth));
  expect(numericOverflow.every((overflow) => overflow <= 1)).toBe(true);
  await page.pdf({
    path: testInfo.outputPath("eleven-items-one-page.pdf"),
    preferCSSPageSize: true,
    printBackground: true,
  });
});

test("sixteen landscape items use one A4 page and item seventeen starts page two", async ({ page }, testInfo) => {
  await openApp(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار آزمایشی");
  await page.locator('[data-field="notes"]').fill(
    "شماره حساب: ۹۴۶۹۰۴۳۰۷۷\nشماره شبا: ۶۲۰۱۲۰۰۰۰۰۰۰۹۴۶۹۰۴۳۰۷۷\nبه نام فروشنده\nبانک ملت"
  );

  async function fillItem(index) {
    if (index >= 7) {
      await page.getByRole("button", { name: "افزودن ردیف/قلم جدید", exact: true }).click();
    }
    const rowNumber = String(index + 1).replace(/[0-9]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) + 1728)
    );
    await page.getByLabel(`ردیف ${rowNumber} — شرح کالا یا خدمت`, { exact: true })
      .fill(`تهیه مصالح و اجرای سقف کاذب فلت طبقه ${index + 1}`);
    await page.getByLabel(`ردیف ${rowNumber} — تعداد یا مقدار`, { exact: true }).fill(String(index + 20));
    await page.getByLabel(`ردیف ${rowNumber} — مبلغ واحد`, { exact: true }).fill(String((index + 10) * 1_000_000));
  }

  for (let index = 0; index < 11; index += 1) await fillItem(index);

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
  let pages = page.locator("#print-document .print-page");
  await expect(pages).toHaveCount(1);
  await expect(pages.first().locator("tbody tr")).toHaveCount(11);
  // #print-document is display:none outside an actual print, so every rect
  // below reads zero unless the page is put into measurement mode first.
  await page.locator("#print-document").evaluate((documentRoot) => documentRoot.classList.add("is-measuring"));
  const firstMetrics = await pages.first().evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    bottomGap: element.getBoundingClientRect().bottom -
      element.querySelector(".inv-footer").getBoundingClientRect().bottom,
    closingGap: element.querySelector(".inv-summary").getBoundingClientRect().top -
      element.querySelector(".inv-table-frame").getBoundingClientRect().bottom,
  }));
  expect(firstMetrics.clientHeight).toBeGreaterThan(0);
  expect(firstMetrics.scrollHeight).toBeLessThanOrEqual(firstMetrics.clientHeight + 2);
  // The closing block sits against the bottom edge and the table ends just
  // above it: no dead band anywhere on a sheet the solver has filled.
  expect(firstMetrics.bottomGap).toBeLessThanOrEqual(30);
  expect(firstMetrics.closingGap).toBeGreaterThanOrEqual(2);
  expect(firstMetrics.closingGap).toBeLessThanOrEqual(40);
  await page.locator("#print-document").evaluate((documentRoot) => documentRoot.classList.remove("is-measuring"));

  await page.pdf({
    path: testInfo.outputPath("eleven-items-adaptive-page.pdf"),
    preferCSSPageSize: true,
    printBackground: true,
  });

  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  for (let index = 11; index < 16; index += 1) await fillItem(index);

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(2);
  pages = page.locator("#print-document .print-page");
  await expect(pages).toHaveCount(1);
  await expect(pages.first().locator("tbody tr")).toHaveCount(16);

  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await fillItem(16);

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(3);
  pages = page.locator("#print-document .print-page");
  await expect(pages).toHaveCount(2);
  const rowCounts = await pages.locator("tbody").evaluateAll((bodies) =>
    bodies.map((body) => body.querySelectorAll("tr").length)
  );
  expect(rowCounts).toEqual([16, 1]);
  const pageMetrics = await pages.evaluateAll((elements) => elements.map((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  })));
  expect(pageMetrics.every((metric) => metric.scrollHeight <= metric.clientHeight + 2)).toBe(true);
});

/*
 * The whole point of the vertical-rhythm solver: one sheet, filled, at every
 * item count — not a document that jumps between three hand-tuned layouts and
 * parks a dead band above the totals in each of them.
 *
 * Every count below is measured on the page the print pipeline actually
 * produced, and the three claims are the ones a reader of the printed sheet
 * would make: it is one page, it is full, and nothing is clipped. The fourth —
 * that row height falls monotonically as items are added — is what makes the
 * transition between counts continuous rather than tiered.
 */
test("one sheet fills itself at every item count, tightening as items are added", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار آزمایشی");

  const descriptions = [
    "میلگرد آجدار A3 سایز ۱۶ شاخه ۱۲ متری",
    "تیرآهن IPE سایز ۱۴ شاخه ۱۲ متری",
    "قوطی صنعتی ۴۰ در ۴۰ ضخامت ۲ میلی‌متر",
    "نبشی بال مساوی ۴۰ در ۴۰ شاخه ۶ متری",
    "ناودانی سبک سایز ۸ شاخه ۶ متری",
    "ورق سیاه ضخامت ۲ میلی‌متر ابعاد ۱ در ۲",
    "ورق گالوانیزه ضخامت ۱ میلی‌متر",
    "لوله صنعتی سایز ۲ اینچ شاخه ۶ متری",
  ];

  async function fillItem(index) {
    if (index >= 7) await page.getByRole("button", { name: "افزودن ردیف/قلم جدید", exact: true }).click();
    const rowNumber = String(index + 1).replace(/[0-9]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) + 1728)
    );
    await page.getByLabel(`ردیف ${rowNumber} — شرح کالا یا خدمت`, { exact: true })
      .fill(descriptions[index % descriptions.length]);
    await page.getByLabel(`ردیف ${rowNumber} — تعداد یا مقدار`, { exact: true }).fill(String(index + 4));
    await page.getByLabel(`ردیف ${rowNumber} — مبلغ واحد`, { exact: true }).fill(String((index + 2) * 1_500_000));
  }

  // Every count the office actually prints, including the sixteen-item sheet
  // that must not spill onto a second page.
  const counts = [7, 8, 9, 11, 16];
  const measured = [];
  let filled = 0;
  let printCalls = 0;

  for (const count of counts) {
    for (; filled < count; filled += 1) await fillItem(filled);

    await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
    printCalls += 1;
    await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(printCalls);

    const pages = page.locator("#print-document .print-page");
    await expect(pages, `${count} items must print as one sheet`).toHaveCount(1);
    await expect(pages.first().locator("tbody tr")).toHaveCount(count);

    // #print-document is display:none outside a real print, so the rects below
    // read zero unless the page is put into measurement mode first.
    await page.locator("#print-document").evaluate((root) => root.classList.add("is-measuring"));
    measured.push(await pages.first().evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        rowHeight: element.querySelector("tbody tr").getBoundingClientRect().height,
        density: Number(element.style.getPropertyValue("--print-density")),
        typeScale: Number(element.style.getPropertyValue("--doc-font-scale")),
        closingGap: element.querySelector(".inv-summary").getBoundingClientRect().top -
          element.querySelector(".inv-table-frame").getBoundingClientRect().bottom,
        bottomGap: box.bottom - element.querySelector(".inv-footer").getBoundingClientRect().bottom,
      };
    }));
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  }

  measured.forEach((metrics, index) => {
    const count = counts[index];
    expect(metrics.clientHeight, `${count} items: the page must be laid out`).toBeGreaterThan(0);
    expect(metrics.scrollHeight, `${count} items: nothing may be clipped`)
      .toBeLessThanOrEqual(metrics.clientHeight + 2);
    // A filled sheet, not a sheet with a hole in it. The old three-tier layout
    // left 8-16mm (30-60px) of dead paper here whatever the item count was.
    expect(metrics.closingGap, `${count} items: the table must clear the closing block`)
      .toBeGreaterThanOrEqual(2);
    expect(metrics.closingGap, `${count} items: no dead band above the closing block`)
      .toBeLessThanOrEqual(30);
    expect(metrics.bottomGap, `${count} items: the footer must sit on the bottom edge`)
      .toBeLessThanOrEqual(30);
    // Ordinary single-line descriptions do not need the type-shrink axis —
    // with one measured exception at the very top of the range.
    //
    // The sheet is 190mm tall, not 210mm: it is inset 10mm from the paper on
    // every edge so that it survives whatever page box the print dialog hands
    // back, including Chrome's Margins:Default (see the safe-band note in
    // invoice.css). At the printed form's full sixteen-item capacity that
    // costs about 2% of type size — 8.7pt becoming ~8.5pt — because density
    // bottoms out first and the type axis is what is left. Below capacity the
    // rhythm absorbs it all and the type is untouched.
    //
    // The bound is what matters, not the exact figure: the axis exists for
    // exactly this, and 0.97 is still far above the 0.9 emergency floor that
    // signals a document the design genuinely cannot carry.
    if (count >= 16) {
      expect(metrics.typeScale, `${count} items: type shrink must stay marginal`)
        .toBeGreaterThanOrEqual(0.97);
      expect(metrics.typeScale, `${count} items: type must never grow`).toBeLessThanOrEqual(1);
    } else {
      expect(metrics.typeScale, `${count} items: type size must not be touched`).toBe(1);
    }
  });

  for (let index = 1; index < measured.length; index += 1) {
    expect(
      measured[index].rowHeight,
      `${counts[index]} items must set tighter rows than ${counts[index - 1]}`
    ).toBeLessThan(measured[index - 1].rowHeight);
    expect(measured[index].density).toBeLessThanOrEqual(measured[index - 1].density);
  }
});

test("the items table and the totals carry no discount at all", async ({ page }) => {
  await openApp(page);

  // Neither the editor nor a print clone may still offer the retired column,
  // its computed "پس از تخفیف" partner, or their two totals rows.
  const headers = await page.locator(".inv-table thead th:not(.no-print)").allTextContents();
  expect(headers).toEqual([
    "ردیف",
    "شرح کالا یا خدمات",
    "تعداد / مقدار",
    "واحد",
    "مبلغ واحد (ریال)",
    "مبلغ کل (ریال)",
  ]);
  await expect(page.locator('[data-row-field="discount"]')).toHaveCount(0);
  await expect(page.locator('[data-row-computed="afterDiscount"]')).toHaveCount(0);
  await expect(page.locator('[data-total="discountTotal"]')).toHaveCount(0);
  await expect(page.locator('[data-total="afterDiscountTotal"]')).toHaveCount(0);

  // And the tax is now taken on the gross, because there is nothing between
  // the two any more.
  await fillValidFirstRow(page, "1000000");
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill("10");
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).blur();
  await expect(page.locator('[data-total="grossTotal"]')).toHaveText("۱٬۰۰۰٬۰۰۰ ریال");
  await expect(page.locator('[data-total="taxTotal"]')).toHaveText("۱۰۰٬۰۰۰ ریال");
  await expect(page.locator('[data-total="netTotal"]')).toHaveText("۱٬۱۰۰٬۰۰۰ ریال");

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
  await expect(page.locator('#print-document [data-row-field="discount"]')).toHaveCount(0);
  await expect(page.locator("#print-document .print-page")).toHaveCount(1);
});

// A document opened from an older backup still carries a `discount` on every
// item. It has to load as an ordinary invoice — the retired field ignored, not
// applied, and not left to throw on the way in.
test("a backup saved with discounts still opens, with the discounts dropped", async ({ page }) => {
  await openApp(page);
  const legacy = {
    version: 7,
    orientation: "landscape",
    meta: { number: "۱۴۰۴۰۱۰۱-۰۰۱", date: "۱۴۰۴/۰۱/۰۱" },
    buyer: { name: "خریدار قدیمی" },
    seller: {},
    company: { profile: "fouladBonyan" },
    taxPercent: "۱۰",
    notes: "",
    items: [
      { description: "کالای قدیمی", quantity: "1", unit: "عدد", unitPrice: "1000000", discount: "200000" },
    ],
  };
  await importJsonFile(page, "قدیمی.json", JSON.stringify(legacy));

  await expect(page.getByLabel("نام خریدار", { exact: true })).toHaveValue("خریدار قدیمی");
  await expect(page.getByLabel("ردیف ۱ — شرح کالا یا خدمت", { exact: true })).toHaveValue("کالای قدیمی");
  // 1,000,000 gross + 10% — the 200,000 discount is gone, not silently applied.
  await expect(page.locator('[data-total="netTotal"]')).toHaveText("۱٬۱۰۰٬۰۰۰ ریال");
  expect(await page.evaluate(() => window.__rejections)).toEqual([]);
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

test("a too-tall item row is blamed on that row, by number", async ({ page }) => {
  await openApp(page);
  await fillFirstRowAndBuyer(page);
  await page.getByLabel("ردیف ۱ — شرح کالا یا خدمت", { exact: true })
    .fill("شرح بسیار طولانی ".repeat(400));

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect(page.locator("#invoice-validation-list li").first())
    .toContainText("ردیف ۱ بلندتر از ظرفیت یک صفحهٔ A4 است");
  await expect(page.locator("#toolbar-status")).toContainText("یک ردیف در صفحهٔ A4 جا نمی‌شود");
  expect(await page.evaluate(() => window.__printCalls)).toBe(0);
  await expect(page.locator("#print-document .print-page")).toHaveCount(0);
});

test("closing-block overflow blames the notes text, never an innocent row", async ({ page }) => {
  await openApp(page);
  await fillFirstRowAndBuyer(page);
  // Only row 1 carries anything; rows 2-7 are blank. The old code reported
  // this as "ردیف ۷ ... شرح را کوتاه‌تر کنید", sending the user hunting for a
  // long description on an empty row.
  await page.locator('[data-field="notes"]').fill("یادداشت طولانی ".repeat(200));

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  const warnings = page.locator("#invoice-validation-list li");
  await expect(warnings.first()).toContainText("متن «توضیحات» بلندتر از فضای باقی‌ماندهٔ صفحهٔ پایانی است");
  await expect(page.locator("#toolbar-status")).toContainText("متن توضیحات در صفحهٔ A4 جا نمی‌شود");
  // The decisive assertion: no item row is accused at all.
  const texts = await warnings.allTextContents();
  expect(texts.some((text) => text.includes("بلندتر از ظرفیت یک صفحهٔ A4"))).toBe(false);
  expect(await page.evaluate(() => window.__printCalls)).toBe(0);
  await expect(page.locator("#print-document .print-page")).toHaveCount(0);
});

test("shortening the notes makes the same document printable again", async ({ page }) => {
  await openApp(page);
  await fillFirstRowAndBuyer(page);
  await page.locator('[data-field="notes"]').fill("یادداشت طولانی ".repeat(200));
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect(page.locator("#toolbar-status")).toContainText("چاپ انجام نشد");

  await page.locator('[data-field="notes"]').fill("یادداشت کوتاه");
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
  const pages = page.locator("#print-document .print-page");
  expect(await pages.count()).toBeGreaterThan(0);
  const metrics = await pages.evaluateAll((elements) => elements.map((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  })));
  expect(metrics.every((metric) => metric.scrollHeight <= metric.clientHeight + 2)).toBe(true);
});

test("unrelated JSON is rejected without touching the open document", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page, "250000");
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار اصلی");
  await expect(page.locator("#toolbar-status")).toContainText("ذخیره‌نشده");

  const snapshot = () => page.evaluate(() => ({
    buyer: document.querySelector('[data-field="buyer.name"]').value,
    description: document.querySelector('[data-row-field="description"]').value,
    number: document.querySelector('[data-field="meta.number"]').value,
    net: document.querySelector('[data-total="netTotal"]').textContent,
    rows: document.querySelectorAll("#inv-rows tr").length
  }));
  const before = await snapshot();

  await importJsonFile(page, "random.json", { hello: "world" });
  await expect(page.locator("#app-dialog")).toBeVisible();
  await expect(page.locator("#app-dialog-title")).toContainText("این فایل پیش‌فاکتور نیست");
  await page.locator("#app-dialog-actions button").first().click();
  await expect(page.locator("#app-dialog")).toBeHidden();

  expect(await snapshot()).toEqual(before);
  // A rejected import is a no-op, not an implicit save: unsaved work must
  // still be reported as unsaved.
  await expect(page.locator("#toolbar-status")).toContainText("ذخیره‌نشده");
});

test("malformed and near-miss JSON shapes are all rejected", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page, "250000");
  const baseline = await page.evaluate(() => document.querySelector('[data-row-field="description"]').value);

  const rejected = [
    ["broken.json", "{ not json at all"],
    ["array.json", JSON.stringify([1, 2, 3])],
    ["scalar.json", JSON.stringify(42)],
    ["null.json", JSON.stringify(null)],
    ["package.json", JSON.stringify({ name: "x", version: "1.0.0", scripts: {} })],
    ["no-items.json", JSON.stringify({ version: 7, meta: {}, buyer: {}, seller: {}, company: {} })],
    ["no-meta.json", JSON.stringify({ version: 7, buyer: {}, seller: {}, company: {}, items: [] })],
    ["no-parties.json", JSON.stringify({ version: 7, meta: {}, items: [] })],
    ["bad-items.json", JSON.stringify({ version: 7, meta: {}, buyer: {}, seller: {}, company: {}, items: ["x"] })],
    ["no-version.json", JSON.stringify({ meta: {}, buyer: {}, seller: {}, company: {}, items: [] })]
  ];

  for (const [name, body] of rejected) {
    await importJsonFile(page, name, body);
    await expect(page.locator("#app-dialog")).toBeVisible();
    await expect(page.locator("#app-dialog-message")).toContainText("سند فعلی بدون تغییر باقی ماند");
    await page.locator("#app-dialog-actions button").first().click();
    await expect(page.locator("#app-dialog")).toBeHidden();
    expect(await page.evaluate(() => document.querySelector('[data-row-field="description"]').value)).toBe(baseline);
  }
});

test("the app's own export still passes the importer's shape check", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page, "777000");
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار واقعی");

  // Capture exactly what "پشتیبان فایل" writes, by intercepting the Blob the
  // exporter hands to URL.createObjectURL. This is the compatibility half of
  // the shape check: the validator must never reject the app's own output.
  const exported = await page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    const realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = function (blob) { captured = blob; return "blob:stub"; };
    HTMLAnchorElement.prototype.click = function () {};
    document.getElementById("btn-export").click();
    URL.createObjectURL = realCreate;
    HTMLAnchorElement.prototype.click = realClick;
    return captured ? await captured.text() : null;
  });
  expect(exported).toBeTruthy();
  expect(JSON.parse(exported).version).toBe(7);

  // The document has unsaved changes, so "جدید" asks before discarding them.
  await page.locator("#btn-new").click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-actions button.primary").click();
  await expect(page.getByLabel("ردیف ۱ — شرح کالا یا خدمت", { exact: true })).toHaveValue("");

  await importJsonFile(page, "export.json", exported);
  await expect(page.locator("#app-dialog")).toBeHidden();
  await expect(page.locator("#toolbar-status")).toContainText("بازشد");
  await expect(page.getByLabel("ردیف ۱ — شرح کالا یا خدمت", { exact: true })).toHaveValue("کالای آزمایشی");
  await expect(page.getByLabel("نام خریدار", { exact: true })).toHaveValue("خریدار واقعی");
});

test("a second dialog cancels the first instead of orphaning it", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);

  await page.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  // Ctrl+S again while the naming prompt is still up: the first saveCurrent
  // must settle (as a cancel) rather than await a resolve nobody holds.
  await page.keyboard.press("Control+s");
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-input").fill("سند یکتا");
  await page.locator("#app-dialog-actions button").first().click();
  await expect(page.locator("#toolbar-status")).toContainText("ذخیره شد");

  const entries = await page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.indexOf("preinvoice.saved.entry.") === 0)
    .map((key) => JSON.parse(localStorage.getItem(key)).name));
  expect(entries).toEqual(["سند یکتا"]);
  await expect(page.locator("#saved-count")).toHaveText("۱");
});

test("a built-in company profile can be restored to its shipped defaults", async ({ page }) => {
  await openApp(page);
  const shippedName = (await page.locator("#inv-company-name").textContent()).trim();

  await page.getByRole("button", { name: "تنظیمات", exact: true }).click();
  await page.locator("#btn-company-profile-edit").click();
  await expect(page.locator("#company-editor-dialog")).toBeVisible();
  // Nothing overridden yet, so the reset action is present but inert.
  await expect(page.locator("#btn-company-editor-reset")).toBeVisible();
  await expect(page.locator("#btn-company-editor-reset")).toBeDisabled();

  await page.locator("#company-editor-name").fill("نام دستکاری‌شده");
  await page.locator("#btn-company-editor-submit").click();
  await expect(page.locator("#inv-company-name")).toHaveText("نام دستکاری‌شده");
  expect(await page.evaluate(() => localStorage.getItem("preinvoice.profileOverrides.v1")))
    .toContain("نام دستکاری‌شده");

  await page.reload();
  await expect(page.locator("#inv-company-name")).toHaveText("نام دستکاری‌شده");

  await page.getByRole("button", { name: "تنظیمات", exact: true }).click();
  await page.locator("#btn-company-profile-edit").click();
  await expect(page.locator("#btn-company-editor-reset")).toBeEnabled();
  await page.locator("#btn-company-editor-reset").click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-actions button").first().click();

  await expect(page.locator("#inv-company-name")).toHaveText(shippedName);
  await expect(page.locator('[data-field="seller.name"]')).toHaveValue(shippedName);
  // The reset has to outlive a reload, or the override is still on disk.
  await page.reload();
  await expect(page.locator("#inv-company-name")).toHaveText(shippedName);
});

test("the header logo is fetched once, from the active profile only", async ({ page }) => {
  const assetRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/assets/")) assetRequests.push(url.slice(url.lastIndexOf("/") + 1));
  });
  await openApp(page);
  await page.waitForTimeout(500);

  const logos = assetRequests.filter((name) => name.includes("logo"));
  expect(logos).toEqual(["logo-foulad-bonyan-mark.png"]);
  const rendered = await page.evaluate(() => ({
    logo: document.getElementById("inv-logo").getAttribute("src")
  }));
  expect(rendered.logo).toBe("assets/logo-foulad-bonyan-mark.png");
});

// Seeds an overridden built-in profile, then opens its editor ready to reset.
async function openResetDialogWithOverride(page, seedExtra) {
  await page.addInitScript((extra) => {
    localStorage.setItem("preinvoice.profileOverrides.v1", JSON.stringify({
      fouladBonyan: { label: "دستکاری", name: "دستکاری", nationalId: "۱", address: "ا", postalCode: "۱", phones: "۱", website: "w" }
    }));
    localStorage.setItem("preinvoice.profileAssets.v1", extra);
  }, seedExtra);
  await page.goto(baseURL);
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
  await expect(page.locator("#inv-company-name")).toHaveText("دستکاری");
  await page.getByRole("button", { name: "تنظیمات", exact: true }).click();
  await page.locator("#btn-company-profile-edit").click();
  await expect(page.locator("#company-editor-dialog")).toBeVisible();
}

test("a reset whose second storage write fails changes nothing at all", async ({ page }) => {
  await openResetDialogWithOverride(page, JSON.stringify({
    fouladBonyan: { logo: "data:image/webp;base64,AAAA" },
    karaBorjParseh: { logo: "data:image/webp;base64,BBBB" }
  }));

  // Fail only the assets write, i.e. the second of the reset's two setItems.
  await page.evaluate(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "preinvoice.profileAssets.v1") throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, key, value);
    };
  });

  await page.locator("#btn-company-editor-reset").click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-actions button.danger").click();
  await expect(page.locator("#toolbar-status")).toContainText("چیزی تغییر نکرد");

  // The details override must have been rolled back, not left deleted.
  const stored = await page.evaluate(() => ({
    details: JSON.parse(localStorage.getItem("preinvoice.profileOverrides.v1") || "{}"),
    assets: JSON.parse(localStorage.getItem("preinvoice.profileAssets.v1") || "{}")
  }));
  expect(stored.details.fouladBonyan).toBeTruthy();
  expect(stored.assets.fouladBonyan).toBeTruthy();
  expect(stored.assets.karaBorjParseh).toBeTruthy();

  // And the failure must survive a reload as "nothing happened", not as a
  // half-reset profile.
  await page.reload();
  await expect(page.locator("#inv-company-name")).toHaveText("دستکاری");
});

test("a reset refuses to overwrite an unreadable profile-assets record", async ({ page }) => {
  await openResetDialogWithOverride(page, "{{{ corrupt");

  await page.locator("#btn-company-editor-reset").click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-actions button.danger").click();
  await expect(page.locator("#toolbar-status")).toContainText("خوانا نیست");

  // The corrupt bytes stay exactly as they were, so another profile's logo
  // override remains recoverable by hand.
  expect(await page.evaluate(() => localStorage.getItem("preinvoice.profileAssets.v1"))).toBe("{{{ corrupt");
  await expect(page.locator("#inv-company-name")).toHaveText("دستکاری");
  await page.reload();
  await expect(page.locator("#inv-company-name")).toHaveText("دستکاری");
});

test("a document that throws while applying reports it instead of rejecting silently", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page, "4321");

  // Force applyInvoiceData to throw on the next call only, standing in for a
  // structurally valid file whose contents the editor cannot render.
  await page.evaluate(() => {
    const body = document.getElementById("inv-rows");
    Object.defineProperty(body, "innerHTML", {
      configurable: true,
      set() { throw new Error("apply exploded"); },
      get() { return ""; }
    });
  });

  await importJsonFile(page, "valid-shape.json", {
    version: 7, meta: {}, buyer: {}, seller: {}, company: {}, taxPercent: "۱۰", notes: "", items: []
  });
  // The shape passes, so the unsaved-changes prompt comes first; only after
  // confirming does applyInvoiceData run and blow up.
  await expect(page.locator("#app-dialog-title")).toContainText("باز کردن فایل");
  await page.locator("#app-dialog-actions button.primary").click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await expect(page.locator("#app-dialog-title")).toContainText("فایل نامعتبر");
  await page.locator("#app-dialog-actions button").first().click();
  expect(await page.evaluate(() => window.__rejections || [])).toEqual([]);
});

test("printing commits the daily invoice number sequence and names the print title with number and buyer", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("شرکت آزمون");

  let printedTitle = "";
  await page.exposeFunction("recordPrintTitle", (t) => { printedTitle = t; });
  await page.evaluate(() => {
    const origPrint = window.print;
    window.print = () => {
      window.recordPrintTitle(document.title);
      if (origPrint) origPrint();
    };
  });

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);

  expect(printedTitle).toMatch(/^پیش‌فاکتور_\d{8}-\d{3}_شرکت-آزمون$/);

  const seqRaw = await page.evaluate(() => localStorage.getItem("pishFaktor.dailySeq.fouladBonyan"));
  expect(seqRaw).toBeTruthy();
  const seq = JSON.parse(seqRaw);
  expect(seq.n).toBe(1);
  expect(seq.day).toMatch(/^\d{8}$/);
});

test("deleteSavedEntry cleanly removes from legacy SAVED_LIST_KEY storage", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const entry = {
      id: "inv-legacy-test",
      name: "فاکتور قدیمی",
      savedAt: 1700000000000,
      data: {
        version: 7,
        meta: { number: "۱۴۰۰۰۱۰۱-۰۰۱" },
        buyer: { name: "مشتری قدیمی" },
        seller: {},
        company: { profile: "fouladBonyan" },
        items: []
      }
    };
    localStorage.setItem("preinvoice.saved.entry.v2.inv-legacy-test", JSON.stringify(entry));
    localStorage.setItem("preinvoice.saved.v1", JSON.stringify({ "inv-legacy-test": entry }));
  });

  await page.locator("#btn-saved-list").click();
  await expect(page.locator("#saved-panel")).toBeVisible();
  await expect(page.locator(".saved-item-name")).toHaveText(["فاکتور قدیمی"]);
  await page.locator(".saved-item-actions button.danger").first().click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-actions button.danger").click();
  await expect(page.locator("#toolbar-status")).toContainText("حذف شد");

  const storageAfter = await page.evaluate(() => ({
    v2: localStorage.getItem("preinvoice.saved.entry.v2.inv-legacy-test"),
    legacy: localStorage.getItem("preinvoice.saved.v1")
  }));
  expect(storageAfter.v2).toBeNull();
  expect(storageAfter.legacy === null || Object.keys(JSON.parse(storageAfter.legacy)).length === 0).toBe(true);
});

test("company editor allows setting and persisting a permanent company stamp on user-created companies", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    document.getElementById("btn-settings").click();
    document.getElementById("btn-company-editor").click();
  });
  await expect(page.locator("#company-editor-dialog")).toBeVisible();
  await page.locator("#company-editor-name").fill("شرکت مهرساز");

  // Select a 1x1 valid PNG for stamp
  const validPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const pngBytes = Buffer.from(validPngBase64, "base64");
  await page.evaluate(({ bytes }) => {
    const file = new File([new Uint8Array(bytes)], "stamp.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById("company-stamp-file");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { bytes: Array.from(pngBytes) });

  await expect(page.locator("#company-stamp-preview")).toBeVisible();
  await page.locator("#btn-company-editor-submit").click();
  await expect(page.locator("#company-editor-dialog")).toBeHidden();

  const profiles = await page.evaluate(() => JSON.parse(localStorage.getItem("preinvoice.companyProfiles.v1") || "{}"));
  const created = Object.values(profiles).find((p) => p.name === "شرکت مهرساز");
  expect(created).toBeTruthy();
  expect(created.stamp).toMatch(/^data:image\//);
});

