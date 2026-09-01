import puppeteer from "@cloudflare/puppeteer";
import { layoutInvoicePages } from "./invoiceLayout.js";
import { MAX_ROWS_PER_PAGE } from "./invoiceTemplate.js";

/**
 * Renders an HTML string to A4-landscape PDF bytes using Cloudflare Browser
 * Rendering. The invoice sheet's own CSS is already sized to 297mm x 210mm
 * (see invoiceStyles.js), so the PDF page size is set to match exactly
 * instead of relying on the 'A4' + landscape preset.
 *
 * Between loading the document and taking the PDF, the page fitter runs
 * inside the browser: the template knows how many items there are, but only a
 * layout engine knows how tall they render, which is what the sheet's
 * vertical rhythm has to be solved against. Fonts are awaited first — every
 * measurement it takes is of rendered text, and a fallback face would settle
 * the whole document at the wrong density.
 */
export async function renderInvoicePdf(env, html) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.evaluate(layoutInvoicePages, { maxRowsPerPage: MAX_ROWS_PER_PAGE });
    const pdf = await page.pdf({
      printBackground: true,
      width: "297mm",
      height: "210mm",
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    });
    return pdf;
  } finally {
    await browser.close();
  }
}
