import puppeteer from "@cloudflare/puppeteer";

/**
 * Renders an HTML string to A4-landscape PDF bytes using Cloudflare Browser
 * Rendering. The invoice sheet's own CSS is already sized to 297mm x 210mm
 * (see invoiceStyles.js), so the PDF page size is set to match exactly
 * instead of relying on the 'A4' + landscape preset.
 */
export async function renderInvoicePdf(env, html) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
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
