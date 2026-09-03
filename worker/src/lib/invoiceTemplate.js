import { invoiceStyles } from "./invoiceStyles.js";
import {
  bigRoundDiv,
  formatBigRial,
  formatQtyMilli,
  parseDecimalToBigIntScaled,
  rialToWordsBig,
  toAsciiDigits,
  toPersianDigits,
} from "./persianNumbers.js";

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

// The printed form's per-sheet capacity, and the app's own
// MAX_PRINT_ITEM_ROWS_PER_PAGE. Items are chunked at this here rather than
// wherever a browser happens to run out of paper, so 17 items are 16 + 1 —
// the split the app makes deliberately. layoutInvoicePages() in the render
// browser only ever moves rows FORWARD from here, when a page's descriptions
// wrap onto enough extra lines that even the tightest rhythm overflows.
export const MAX_ROWS_PER_PAGE = 16;

// Fills complete sheets before the remainder, so the last page carries
// ((n - 1) % MAX) + 1 items rather than an arbitrary balance.
function chunkItems(lines, perPage) {
  if (lines.length <= perPage) return [lines];
  const finalCount = ((lines.length - 1) % perPage) + 1;
  const chunks = [];
  let rest = lines.slice(0, lines.length - finalCount);
  while (rest.length) {
    chunks.push(rest.slice(0, perPage));
    rest = rest.slice(perPage);
  }
  chunks.push(lines.slice(lines.length - finalCount));
  return chunks;
}

// Computes per-item and invoice-level totals as exact BigInt Rial amounts.
// quantityMilli/unitPriceRial are already-parsed BigInts (see persianNumbers).
export function computeTotals(items, taxPercent = 0) {
  const lines = items.map((item) => {
    const lineTotal = bigRoundDiv(item.quantityMilli * item.unitPriceRial, 1000n);
    return { ...item, lineTotal };
  });
  const grossTotal = lines.reduce((sum, l) => sum + l.lineTotal, 0n);

  let taxBasisPoints = 0n;
  if (typeof taxPercent === "number" && !Number.isNaN(taxPercent) && Number.isFinite(taxPercent)) {
    taxBasisPoints = BigInt(Math.max(0, Math.round(taxPercent * 100)));
  } else if (typeof taxPercent === "bigint") {
    taxBasisPoints = taxPercent > 0n ? taxPercent * 100n : 0n;
  } else if (taxPercent != null) {
    const normalized = toAsciiDigits(String(taxPercent).trim()).replace(/٫/g, ".");
    const parsed = parseDecimalToBigIntScaled(normalized, 2);
    if (parsed !== null && parsed > 0n) {
      taxBasisPoints = parsed;
    }
  }

  const taxTotal = bigRoundDiv(grossTotal * taxBasisPoints, 10000n);
  const netTotal = grossTotal + taxTotal;
  return { lines, grossTotal, taxTotal, netTotal };
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
    <td class="col-total cell-computed"></td>
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
 * @param {string} [data.buyerAddress]
 * @param {string} [data.buyerPostalCode]
 * @param {string} [data.buyerNationalId]
 * @param {string} [data.buyerPhone]
 * @param {Array<{description:string, unit?:string, quantityMilli:bigint, unitPriceRial:bigint}>} data.items
 * @param {boolean} data.includeStamp
 */
export function buildInvoiceHtml(data) {
  const {
    company,
    fontDataUri,
    docNumber,
    docDate,
    validity,
    buyerName,
    buyerAddress,
    buyerPostalCode,
    buyerNationalId,
    buyerPhone,
    items,
    includeStamp,
    taxPercent = 0,
  } = data;
  const { lines, grossTotal, taxTotal, netTotal } = computeTotals(items, taxPercent);

  const logoImg = company.logoDataUri
    ? `<img class="inv-logo" alt="آرم شرکت" src="${company.logoDataUri}" />`
    : "";
  const logoChip = logoImg ? `<span class="inv-logo-chip">${logoImg}</span>` : "";
  const stampImg = includeStamp && company.stampDataUri
    ? `<img class="inv-signature-stamp" alt="مهر شرکت" src="${company.stampDataUri}" />`
    : "";
  const continuationLogo = company.logoDataUri
    ? `<img alt="" src="${company.logoDataUri}" />`
    : "";

  const rowsHtml = lines.map((line, i) => itemRow(i + 1, line));
  // Blank filler rows belong to a single-sheet invoice only: on a document
  // that already runs to a second page there is nothing to fill out.
  if (rowsHtml.length <= LANDSCAPE_MIN_ROWS) {
    for (let i = rowsHtml.length; i < LANDSCAPE_MIN_ROWS; i += 1) rowsHtml.push(blankItemRow(i + 1));
  }
  const chunks = chunkItems(rowsHtml, MAX_ROWS_PER_PAGE);

  const fullHead = `<header class="inv-head">
    <p class="inv-doc-title">پیش‌فاکتور</p>
    <div class="inv-brand">
      ${logoChip}
      <div class="inv-brand-text"><h1>${escapeHtml(company.name)}</h1></div>
    </div>
    <dl class="inv-meta">
      <div><dt>${METER_ICON}<span>تاریخ</span></dt><dd>${escapeHtml(docDate)}</dd></div>
      <div><dt>${NUMBER_ICON}<span>شماره پیش‌فاکتور</span></dt><dd>${escapeHtml(docNumber)}</dd></div>
      <div class="inv-meta-validity"><dt>${CLOCK_ICON}<span>اعتبار پیش‌فاکتور</span></dt><dd>${escapeHtml(validity)}</dd></div>
    </dl>
  </header>`;

  // Page numbers are left to layoutInvoicePages(): it may add or drop a page
  // during relief, so it is the only place that knows the final count.
  const continuationHead = `<header class="print-continuation-head">
    <div class="print-continuation-brand">${continuationLogo}<strong>${escapeHtml(company.name)}</strong></div>
    <div class="print-continuation-title">ادامهٔ پیش‌فاکتور</div>
    <div class="print-continuation-meta">
      <div>شماره: ${escapeHtml(docNumber)}</div>
      <div>تاریخ: ${escapeHtml(docDate)} · صفحه ۱ از ۱</div>
    </div>
  </header>`;

  const parties = `<section class="inv-parties">
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
        ${partyField("نشانی", buyerAddress || "")}
        ${partyField("کد پستی", buyerPostalCode || "", true)}
        ${partyField("شناسه ملی", buyerNationalId || "", true)}
        ${partyField("تلفن", buyerPhone || "", true)}
      </div>
    </div>
  </section>`;

  const tableFrame = (pageRowsHtml) => `<div class="inv-table-frame">
    <table class="inv-table">
      <colgroup>
        <col class="col-row" /><col class="col-desc" /><col class="col-qty" /><col class="col-unit" />
        <col class="col-price" /><col class="col-total" />
      </colgroup>
      <thead>
        <tr>
          <th>ردیف</th><th>شرح کالا یا خدمات</th><th>تعداد / مقدار</th><th>واحد</th>
          <th>مبلغ واحد (ریال)</th><th>مبلغ کل (ریال)</th>
        </tr>
      </thead>
      <tbody>${pageRowsHtml.join("\n")}</tbody>
    </table>
  </div>`;

  const closingBlock = `<section class="inv-summary">
    <div class="inv-totals">
      <div><span>جمع کل</span><strong>${formatBigRial(grossTotal)} ریال</strong></div>
      <div><span>مالیات و عوارض (٪${toPersianDigits(taxPercent)})</span><strong>${formatBigRial(taxTotal)} ریال</strong></div>
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

  <footer class="inv-footer"><p class="inv-footer-site">${escapeHtml(company.website)}</p></footer>`;

  const continuationNote = `ادامه در صفحهٔ بعد · پیش‌فاکتور ${docNumber}`;
  const pagesHtml = chunks.map((chunk, index) => {
    const isFirst = index === 0;
    const isLast = index === chunks.length - 1;
    return `<article class="invoice-sheet orientation-landscape" dir="rtl">
  ${isFirst ? fullHead + "\n\n  " + parties : continuationHead}

  ${tableFrame(chunk)}

  ${isLast ? closingBlock : `<div class="print-page-marker">${escapeHtml(continuationNote)}</div>`}
</article>`;
  }).join("\n");

  return `<!doctype html>
<html dir="rtl" lang="fa">
<head>
<meta charset="utf-8" />
<title>پیش‌فاکتور</title>
<style>${invoiceStyles(fontDataUri)}</style>
</head>
<body data-continuation-note="${escapeHtml(continuationNote)}">
${pagesHtml}
<template id="continuation-head-template">${continuationHead}</template>
</body>
</html>`;
}

