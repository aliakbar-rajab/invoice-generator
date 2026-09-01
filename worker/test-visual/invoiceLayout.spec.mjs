import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildInvoiceHtml, MAX_ROWS_PER_PAGE } from "../src/lib/invoiceTemplate.js";
import { layoutInvoicePages } from "../src/lib/invoiceLayout.js";
import { COMPANIES } from "../src/lib/companies.js";

/*
 * Regression tests for the bot's Telegram/PDF render path — buildInvoiceHtml
 * for the markup, invoiceStyles for the rhythm knobs, and layoutInvoicePages
 * for the fitting that only a layout engine can do. They run the real output
 * in a real browser (not jsdom/workerd, neither of which run layout) and
 * drive layoutInvoicePages exactly the way pdf.js does: through
 * page.evaluate, so the function's self-containedness is under test too.
 */

const fontPath = fileURLToPath(new URL("../public/fonts/vazirmatn-arabic-variable.woff2", import.meta.url));
const fontDataUri = `data:font/woff2;base64,${readFileSync(fontPath).toString("base64")}`;

const DESCRIPTIONS = [
  "میلگرد آجدار A3 ذوب‌آهن اصفهان سایز ۱۶ شاخه ۱۲ متری",
  "تیرآهن IPE ذوب‌آهن اصفهان سایز ۱۴ شاخه ۱۲ متری",
  "قوطی صنعتی ۴۰ در ۴۰ ضخامت ۲ میلی‌متر شاخه ۶ متری",
  "نبشی بال مساوی ۴۰ در ۴۰ ضخامت ۴ میلی‌متر شاخه ۶ متری",
  "ناودانی سبک سایز ۸ شاخه ۶ متری تولید کارخانه تهران",
  "ورق سیاه فولاد مبارکه ضخامت ۲ میلی‌متر ابعاد ۱ در ۲ متر",
  "ورق گالوانیزه ضخامت ۱ میلی‌متر ابعاد ۱ در ۲ متر",
  "لوله صنعتی سایز ۲ اینچ ضخامت ۲ میلی‌متر شاخه ۶ متری",
];

function sampleInvoiceHtml(itemCount = 2, { longDescriptions = false } = {}) {
  return buildInvoiceHtml({
    company: COMPANIES.fouladBonyan,
    fontDataUri,
    docNumber: "۱۴۰۳-۰۰۱",
    docDate: "۱۴۰۳/۰۱/۰۱",
    validity: "پایان روز جاری",
    buyerName: "مشتری تست",
    buyerAddress: "تهران، خیابان آزادی",
    buyerPostalCode: "۱۲۳۴۵۶۷۸۹۰",
    buyerNationalId: "۱۰۹۸۷۶۵۴۳۲۱",
    buyerPhone: "۰۲۱-۱۲۳۴۵۶۷۸",
    items: Array.from({ length: itemCount }, (_, index) => ({
      description: longDescriptions
        ? DESCRIPTIONS[index % DESCRIPTIONS.length] +
          " تحویل بنگاه تهران طبق مشخصات فنی مورد تأیید خریدار و با گارانتی کارخانه"
        : DESCRIPTIONS[index % DESCRIPTIONS.length],
      unit: "شاخه",
      quantityMilli: BigInt((index + 3) * 1000),
      unitPriceRial: BigInt((index + 2) * 1_250_000),
    })),
    includeStamp: true,
  });
}

// Everything a printed sheet has to be true of, measured on the real thing.
async function measurePages(page) {
  return page.evaluate(() => {
    const MM = 96 / 25.4;
    return Array.prototype.slice.call(document.querySelectorAll(".invoice-sheet")).map((sheet) => {
      const box = sheet.getBoundingClientRect();
      const find = (selector) => sheet.querySelector(selector);
      const mm = (value) => Number((value / MM).toFixed(2));
      const table = find(".inv-table-frame");
      const summary = find(".inv-summary");
      const footer = find(".inv-footer");
      const firstRow = find("tbody tr");
      return {
        rows: sheet.querySelectorAll("tbody tr").length,
        overflow: sheet.scrollHeight - sheet.clientHeight,
        heightMm: mm(box.height),
        rowHeightMm: firstRow ? mm(firstRow.getBoundingClientRect().height) : null,
        closingGapMm: summary && table
          ? mm(summary.getBoundingClientRect().top - table.getBoundingClientRect().bottom)
          : null,
        bottomGapMm: footer ? mm(box.bottom - footer.getBoundingClientRect().bottom) : null,
      };
    });
  });
}

async function layout(page, html) {
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(layoutInvoicePages, { maxRowsPerPage: MAX_ROWS_PER_PAGE });
  return { result, metrics: await measurePages(page) };
}

test("bot-rendered invoice leaves a visible gap between the items table and the summary block", async ({ page }) => {
  const { metrics } = await layout(page, sampleInvoiceHtml());
  // Gluing the two sections together is the failure this test was written for.
  // The upper bound is the newer half: the fixed layout that preceded the
  // rhythm solver parked 8-16mm of dead paper in this seam on every sheet.
  expect(metrics).toHaveLength(1);
  expect(metrics[0].closingGapMm).toBeGreaterThan(0.8);
  expect(metrics[0].closingGapMm).toBeLessThan(8);
});

test("one sheet fills itself at every item count, tightening as items are added", async ({ page }) => {
  const counts = [7, 8, 9, 11, 16];
  const measured = [];

  for (const count of counts) {
    const { result, metrics } = await layout(page, sampleInvoiceHtml(count));
    expect(result.pages, `${count} items must render as one sheet`).toBe(1);
    expect(metrics[0].rows, `${count} items must all be on that sheet`).toBe(count);
    expect(metrics[0].overflow, `${count} items: nothing may be clipped`).toBeLessThanOrEqual(2);
    // A filled sheet: the closing block sits against the bottom edge and the
    // table ends just above it, whatever the item count.
    expect(metrics[0].closingGapMm, `${count} items: no dead band above the totals`).toBeLessThan(8);
    expect(metrics[0].bottomGapMm, `${count} items: the footer sits on the bottom edge`).toBeLessThan(8);
    // Ordinary single-line descriptions never need the type-shrink axis.
    expect(result.typeScales[0], `${count} items: type size must not be touched`).toBe(1);
    measured.push(metrics[0]);
  }

  for (let index = 1; index < measured.length; index += 1) {
    expect(
      measured[index].rowHeightMm,
      `${counts[index]} items must set tighter rows than ${counts[index - 1]}`
    ).toBeLessThan(measured[index - 1].rowHeightMm);
  }
});

test("the seventeenth item starts a second sheet, numbered and carrying the closing block", async ({ page }) => {
  const { result, metrics } = await layout(page, sampleInvoiceHtml(17));
  expect(result.pages).toBe(2);
  // 16 + 1, the printed form's capacity — not a balanced 9 + 8.
  expect(metrics.map((m) => m.rows)).toEqual([MAX_ROWS_PER_PAGE, 1]);
  expect(metrics.every((m) => m.overflow <= 2)).toBe(true);

  const structure = await page.evaluate(() => {
    const sheets = Array.prototype.slice.call(document.querySelectorAll(".invoice-sheet"));
    return sheets.map((sheet) => ({
      hasFullHead: !!sheet.querySelector(".inv-head"),
      hasParties: !!sheet.querySelector(".inv-parties"),
      hasContinuationHead: !!sheet.querySelector(".print-continuation-head"),
      hasClosingBlock: !!sheet.querySelector(".inv-summary"),
      pageNumber: sheet.querySelector(".print-page-number")?.textContent ?? null,
      lastRowNumber: sheet.querySelector("tbody tr:last-child .row-index-badge")?.textContent ?? null,
    }));
  });
  expect(structure[0]).toMatchObject({ hasFullHead: true, hasParties: true, hasClosingBlock: false });
  expect(structure[1]).toMatchObject({ hasContinuationHead: true, hasClosingBlock: true });
  expect(structure[0].pageNumber).toBe("صفحه ۱ از ۲");
  expect(structure[1].pageNumber).toBe("صفحه ۲ از ۲");
  // Numbering runs continuously across the break rather than restarting.
  expect(structure[0].lastRowNumber).toBe("۱۶");
  expect(structure[1].lastRowNumber).toBe("۱۷");
});

test("rows that wrap onto extra lines move to the next sheet instead of being clipped", async ({ page }) => {
  // Descriptions long enough to take two lines each. Sixteen of them do not
  // fit one sheet at any rhythm, so the relief pass has to hand the overflow
  // forward — and, since there is no next sheet yet, spin one off.
  const { result, metrics } = await layout(page, sampleInvoiceHtml(16, { longDescriptions: true }));
  expect(result.pages).toBeGreaterThan(1);
  expect(metrics.every((m) => m.overflow <= 2)).toBe(true);
  expect(metrics.reduce((sum, m) => sum + m.rows, 0)).toBe(16);
  // The closing block ends up on the last sheet, exactly once.
  const closingBlocks = await page.evaluate(() => document.querySelectorAll(".inv-summary").length);
  expect(closingBlocks).toBe(1);
  const lastHasClosing = await page.evaluate(() =>
    !!document.querySelectorAll(".invoice-sheet")[document.querySelectorAll(".invoice-sheet").length - 1]
      .querySelector(".inv-summary")
  );
  expect(lastHasClosing).toBe(true);
});
