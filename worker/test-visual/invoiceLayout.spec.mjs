import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildInvoiceHtml } from "../src/lib/invoiceTemplate.js";
import { COMPANIES } from "../src/lib/companies.js";

// Regression test for the bot's Telegram/PDF render path (buildInvoiceHtml +
// invoiceStyles). The real desktop invoice app leaves a deliberate 2mm gap
// between the items table and the totals/notes/signature block below it
// (css/invoice.css: ".inv-summary { margin-top: 2mm; }") — a rule the
// bot's adapted stylesheet once dropped entirely, gluing the two sections
// together. This renders the bot's actual HTML output in a real browser
// (not jsdom/workerd, neither of which run layout) and measures the
// rendered gap directly, the same way the desktop app's own
// "editor and print clone keep the same gap below a grown landscape table"
// test does.

const fontPath = fileURLToPath(new URL("../public/fonts/vazirmatn-arabic-variable.woff2", import.meta.url));
const fontDataUri = `data:font/woff2;base64,${readFileSync(fontPath).toString("base64")}`;

function sampleInvoiceHtml() {
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
    items: [
      { description: "کالای تست یک", unit: "عدد", quantityMilli: 2000n, unitPriceRial: 150000n },
      { description: "کالای تست دو", unit: "متر", quantityMilli: 5000n, unitPriceRial: 320000n },
    ],
    includeStamp: true,
  });
}

test("bot-rendered invoice leaves a visible gap between the items table and the summary block", async ({ page }) => {
  await page.setContent(sampleInvoiceHtml(), { waitUntil: "load" });

  const gap = await page.evaluate(() => {
    const table = document.querySelector(".inv-table-frame").getBoundingClientRect();
    const summary = document.querySelector(".inv-summary").getBoundingClientRect();
    return summary.top - table.bottom;
  });

  // 2mm at the invoice sheet's 8.7pt/96dpi rendering is a few px; assert a
  // conservative non-zero floor rather than pinning to an exact px value.
  expect(gap).toBeGreaterThan(3);
});
