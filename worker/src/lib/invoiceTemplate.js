import { invoiceStyles } from "./invoiceStyles.js";
import { bigRoundDiv, formatBigRial, formatQtyMilli, rialToWordsBig, toPersianDigits } from "./persianNumbers.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const METER_ICON = `<svg class="inv-meta-icon" viewBox="0 0 24 24"><path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/></svg>`;
const NUMBER_ICON = `<svg class="inv-meta-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></svg>`;
const CLOCK_ICON = `<svg class="inv-meta-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
const SELLER_ICON = `<svg class="inv-card-head-icon" viewBox="0 0 24 24"><path d="M4 21V7l8-4 8 4v14"/><path d="M9 21v-6h6v6M8 10h.01M12 10h.01M16 10h.01"/></svg>`;
const BUYER_ICON = `<svg class="inv-card-head-icon" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`;

// Matches the desktop app's DEFAULT_INVOICE_ROWS_BY_ORIENTATION.landscape
// (js/app.js) — every new landscape invoice there starts as 7 blank rows,
// and printableSourceRows() prints them as-is (still numbered, just empty)
// so the sheet stays visually filled instead of the summary block riding up
// under a single real row. This is a floor, not a cap: an invoice with more
// real items than this gets no padding at all.
const LANDSCAPE_MIN_ROWS = 7;

// Computes per-item and invoice-level totals as exact BigInt Rial amounts.
// quantityMilli/unitPriceRial are already-parsed BigInts (see persianNumbers).
export function computeTotals(items) {
  const lines = items.map((item) => {
    const lineTotal = bigRoundDiv(item.quantityMilli * item.unitPriceRial, 1000n);
    return { ...item, lineTotal };
  });
  const grossTotal = lines.reduce((sum, l) => sum + l.lineTotal, 0n);
  return { lines, grossTotal, discountTotal: 0n, afterDiscountTotal: grossTotal, taxTotal: 0n, netTotal: grossTotal };
}

function partyField(label, value, ltr) {
  const text = value ? escapeHtml(value) : "";
  return `<div class="inv-field inv-field-wide"><span class="inv-field-label">${label}</span><span class="inv-field-value"${ltr ? ' dir="ltr" data-align="ltr"' : ""}>${text}</span></div>`;
}

function itemRow(index, line) {
  return `<tr>
    <td class="col-row"><span class="row-index-badge">${toPersianDigits(index)}</span></td>
    <td class="col-desc">${escapeHtml(line.description)}</td>
    <td class="col-qty">${formatQtyMilli(line.quantityMilli)}</td>
    <td class="col-unit">${escapeHtml(line.unit || "")}</td>
    <td class="col-price cell-computed">${formatBigRial(line.unitPriceRial)}</td>
    <td class="col-total cell-computed">${formatBigRial(line.lineTotal)}</td>
    <td class="col-discount cell-computed">${formatBigRial(0n)}</td>
    <td class="col-net cell-computed">${formatBigRial(line.lineTotal)}</td>
  </tr>`;
}

// A row with no data at all, but still numbered — mirrors how the desktop
// app's own blank starter rows print (rowIsBlank(): every field empty; the
// row-template's own computed cells default to "۰", not blank). Purely
// visual: never fed into computeTotals, so it can't affect any amount.
function blankItemRow(index) {
  return `<tr>
    <td class="col-row"><span class="row-index-badge">${toPersianDigits(index)}</span></td>
    <td class="col-desc"></td>
    <td class="col-qty"></td>
    <td class="col-unit"></td>
    <td class="col-price cell-computed"></td>
    <td class="col-total cell-computed">${formatBigRial(0n)}</td>
    <td class="col-discount cell-computed"></td>
    <td class="col-net cell-computed">${formatBigRial(0n)}</td>
  </tr>`;
}

/**
 * Builds the full standalone HTML document for the invoice PDF.
 *
 * @param {object} data
 * @param {object} data.company - entry from companies.js, plus logoDataUri/stampDataUri
 * @param {string} data.fontDataUri
 * @param {string} data.docNumber - Persian-digit invoice number
 * @param {string} data.docDate - Persian-digit Jalali date
 * @param {string} data.validity - Persian-digit Jalali date or label
 * @param {string} data.buyerName
 * @param {Array<{description:string, unit?:string, quantityMilli:bigint, unitPriceRial:bigint}>} data.items
 * @param {boolean} data.includeStamp
 */
export function buildInvoiceHtml(data) {
  const { company, fontDataUri, docNumber, docDate, validity, buyerName, items, includeStamp } = data;
  const { lines, grossTotal, discountTotal, afterDiscountTotal, taxTotal, netTotal } = computeTotals(items);

  const realRowsHtml = lines.map((line, i) => itemRow(i + 1, line));
  const blankRowCount = Math.max(0, LANDSCAPE_MIN_ROWS - lines.length);
  const blankRowsHtml = Array.from({ length: blankRowCount }, (_, i) => blankItemRow(lines.length + i + 1));
  const rowsHtml = [...realRowsHtml, ...blankRowsHtml].join("\n");

  const logoImg = company.logoDataUri
    ? `<img class="inv-logo" alt="آرم شرکت" src="${company.logoDataUri}" />`
    : "";
  const stampImg = includeStamp && company.stampDataUri
    ? `<img class="inv-signature-stamp" alt="مهر شرکت" src="${company.stampDataUri}" />`
    : "";

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8" />
<title>پیش‌فاکتور</title>
<style>${invoiceStyles(fontDataUri)}</style>
</head>
<body>
<article class="invoice-sheet orientation-landscape" dir="rtl">
  <header class="inv-head">
    <p class="inv-doc-title">پیش‌فاکتور</p>
    <div class="inv-brand">
      <span class="inv-logo-chip">${logoImg}</span>
      <div class="inv-brand-text"><h1>${escapeHtml(company.name)}</h1></div>
    </div>
    <dl class="inv-meta">
      <div><dt>${METER_ICON}<span>تاریخ</span></dt><dd>${escapeHtml(docDate)}</dd></div>
      <div><dt>${NUMBER_ICON}<span>شماره پیش‌فاکتور</span></dt><dd>${escapeHtml(docNumber)}</dd></div>
      <div class="inv-meta-validity"><dt>${CLOCK_ICON}<span>اعتبار پیش‌فاکتور</span></dt><dd>${escapeHtml(validity)}</dd></div>
    </dl>
  </header>

  <section class="inv-parties">
    <div class="inv-card" aria-label="مشخصات فروشنده">
      <header class="inv-card-head">${SELLER_ICON}مشخصات فروشنده</header>
      <div class="inv-card-grid">
        ${partyField("نام شخص حقیقی / حقوقی", company.name)}
        ${partyField("نشانی", company.address)}
        ${partyField("کد پستی", company.postalCode, true)}
        ${partyField("شناسه ملی", company.nationalId, true)}
        ${partyField("تلفن", company.phones, true)}
      </div>
    </div>
    <div class="inv-card" aria-label="مشخصات خریدار">
      <header class="inv-card-head">${BUYER_ICON}مشخصات خریدار</header>
      <div class="inv-card-grid">
        ${partyField("نام شخص حقیقی / حقوقی", buyerName)}
        ${partyField("نشانی", "")}
        ${partyField("کد پستی", "", true)}
        ${partyField("شناسه ملی", "", true)}
        ${partyField("تلفن", "", true)}
      </div>
    </div>
  </section>

  <div class="inv-table-frame">
    <table class="inv-table">
      <colgroup>
        <col class="col-row" /><col class="col-desc" /><col class="col-qty" /><col class="col-unit" />
        <col class="col-price" /><col class="col-total" /><col class="col-discount" /><col class="col-net" />
      </colgroup>
      <thead>
        <tr>
          <th>ردیف</th><th>شرح کالا یا خدمات</th><th>تعداد / مقدار</th><th>واحد</th>
          <th>مبلغ واحد (ریال)</th><th>مبلغ کل (ریال)</th><th>تخفیف (ریال)</th><th>مبلغ پس از تخفیف (ریال)</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>

  <section class="inv-summary">
    <div class="inv-totals">
      <div><span>جمع کل</span><strong>${formatBigRial(grossTotal)} ریال</strong></div>
      <div><span>جمع تخفیف</span><strong>${formatBigRial(discountTotal)} ریال</strong></div>
      <div><span>جمع کل پس از تخفیف</span><strong>${formatBigRial(afterDiscountTotal)} ریال</strong></div>
      <div><span>مالیات و عوارض (٪۰)</span><strong>${formatBigRial(taxTotal)} ریال</strong></div>
      <div class="inv-total-final"><span>مبلغ قابل پرداخت</span><strong>${formatBigRial(netTotal)} ریال</strong></div>
    </div>
    <section class="inv-amount-words">
      <span class="inv-amount-words-label">مبلغ به حروف</span>
      <span class="inv-amount-words-value">${escapeHtml(rialToWordsBig(netTotal))}</span>
    </section>
    <div class="inv-notes">
      <span class="inv-notes-label">توضیحات</span>
      <span class="inv-notes-value"></span>
    </div>
    <div class="inv-signature-block inv-signature-buyer">
      <p class="inv-signature-label">مهر و امضای خریدار</p>
      <div class="inv-signature-area"></div>
    </div>
    <div class="inv-signature-block inv-signature-seller">
      <p class="inv-signature-label">مهر و امضای فروشنده</p>
      <div class="inv-signature-area">${stampImg}</div>
    </div>
  </section>

  <footer class="inv-footer"><p class="inv-footer-site">${escapeHtml(company.website)}</p></footer>
</article>
</body>
</html>`;
}
