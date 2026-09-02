/*
 * Print stylesheet for the generated invoice PDF — adapted from the desktop
 * invoice app's css/invoice.css (landscape sheet only; the two companies'
 * built-in profiles are the only ones this bot ever renders). Note that the
 * file's trailing "print-first refinement layer" overrides several earlier
 * base rules — notably .inv-summary's/.inv-footer's spacing below the items
 * table — so it is the LATER of the two definitions that must be mirrored
 * here. (Those refinements lived in a separate css/refinements.css until it
 * was folded into invoice.css.) This build has no editable/interactive
 * state, so the desktop file's `@media print`/`.print-page` overrides
 * (which turn editable fields back into plain print output) are folded into
 * the base rules here instead of being conditional.
 *
 * Visual design — including the monochrome palette and toner-banding
 * rationale — is unchanged from the original; see that file's own
 * comments for the reasoning. Only inputs/textareas are swapped for plain
 * elements and the delete-row column is dropped outright (there's nothing
 * to delete in a finished PDF).
 *
 * The sheet is sized by the same solved vertical rhythm as the app: one
 * --print-density scalar that every vertical dimension below is a straight
 * line in, bisected at render time until the content fills A4 exactly for
 * whatever number of items the document carries. The knob table below mirrors
 * css/invoice.css; the bisection itself is invoiceLayout.js, run inside the
 * rendering page by pdf.js before the PDF is taken.
 *
 * The values here are the app's EFFECTIVE ones — i.e. what its trailing
 * "print-first refinement layer" resolves to, not the base rules that layer
 * overrides. When the two files drift, that is the comparison to make.
 */

export function invoiceStyles(fontDataUri) {
  return `
@font-face {
  font-family: "Vazirmatn";
  src: url("${fontDataUri}") format("woff2");
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: #fff;
  font-family: "Vazirmatn", Tahoma, Arial, sans-serif;
  font-feature-settings: "ss01" 1, "tnum" 1;
  font-variant-numeric: tabular-nums;
  color: #1c1c1e;
}

.invoice-sheet {
  --paper: #ffffff;
  --ink: #000000;
  --muted: #5c5f61;
  --muted-strong: #303335;
  --line: #9aa0a3;
  --line-soft: #b9bec1;
  --surface: #d8d8d8;
  --band-ink: var(--ink);
  --band-muted: var(--muted);
  --band-line: var(--line);
  --band-grad: var(--paper);
  --edge: 0.42mm;
  /* The app's header/footer band under its default "هدر و فوتر خاکستری"
     setting, which is on for every document the bot renders. */
  --band-fill: #e4e4e4;
  --accent-ink: #000000;
  --accent-2: var(--muted);
  --pay-fill: #ededed;
  --sig-w: 44mm;

  /*
   * VERTICAL RHYTHM. --print-density runs 0 (tightest still-comfortable) to 1
   * (most generous) and every vertical dimension on the sheet is a straight
   * line between those ends, so the sheet's natural height is monotonic in it
   * and layoutInvoicePages() can bisect for the setting that fills the page.
   * The two --print-*-extra values take the residual on a document too short
   * to fill A4 even at 1. Mirrors css/invoice.css — same names, same numbers.
   */
  --print-density: 1;
  --print-row-extra: 0mm;
  --print-block-extra: 0mm;
  --doc-font-scale: 1;

  --rhythm-pad-block:    calc(2mm    + 5mm    * var(--print-density));
  --rhythm-head-pad:     calc(1.1mm  + 1.5mm  * var(--print-density));
  --rhythm-brand-gap:    calc(0.7mm  + 1.7mm  * var(--print-density));
  --rhythm-logo:         calc(11mm   + 6mm    * var(--print-density));
  --rhythm-parties-gap:  calc(0.9mm  + 1.6mm  * var(--print-density));
  --rhythm-card-head:    calc(0.55mm + 0.75mm * var(--print-density));
  --rhythm-card-pad:     calc(0.5mm  + 0.9mm  * var(--print-density));
  --rhythm-card-rowgap:  calc(0.15mm + 0.75mm * var(--print-density));
  --rhythm-th-pad:       calc(0.65mm + 0.75mm * var(--print-density));
  --rhythm-td-pad:       calc(0.28mm + 0.5mm  * var(--print-density));
  --rhythm-cell-line:    calc(1.35em  + 0.2em   * var(--print-density));
  /* Leading for the metadata blocks — the header's date/number/validity strip
     and the two party cards. Unitless so it cascades as a factor to fields set
     at different sizes. Together those blocks are ~64mm of the sheet, all of
     it single lines of text that used to sit on the font's own 1.45 default,
     i.e. height the solver could not reach: it could tighten the space BETWEEN
     the rows but not the rows themselves. Mirrors css/invoice.css. */
  --rhythm-field-line:   calc(1.24   + 0.21   * var(--print-density));
  --rhythm-meta-gap:     calc(0.5mm  + 0.5mm  * var(--print-density));
  --rhythm-meta-pad:     calc(0.45mm + 0.35mm * var(--print-density));
  --rhythm-row-h:        calc(4.6mm  + 2.4mm  * var(--print-density) + var(--print-row-extra));
  --rhythm-summary-gap:  calc(1.2mm  + 1.6mm  * var(--print-density));
  --rhythm-totals-row:   calc(3.4mm  + 2.6mm  * var(--print-density));
  --rhythm-payable:      calc(8.4mm  + 3.4mm  * var(--print-density));
  --rhythm-words:        calc(5.6mm  + 2.4mm  * var(--print-density));
  --rhythm-footer-gap:   calc(1mm    + 1.4mm  * var(--print-density));
  --rhythm-footer-pad:   calc(0.85mm + 1.05mm * var(--print-density));
  --sig-h:               calc(33mm   + 15mm   * var(--print-density) + var(--print-block-extra));

  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--paper);
  color: var(--ink);
  /* The metadata leading, matching the app. Item cells take the looser
     --rhythm-cell-line below; everything else inherits this. */
  line-height: var(--rhythm-field-line);
  margin: 0;
}

.invoice-sheet, .invoice-sheet * {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.invoice-sheet h1, .invoice-sheet h2, .invoice-sheet p,
.invoice-sheet span, .invoice-sheet dt, .invoice-sheet dd { margin: 0; }

/*
 * The bot renders through Browser Rendering, not a print dialog, so there is
 * no Margins control to fight and the sheet is the full A4 page — none of the
 * safe band the desktop app needs (see the geometry note in css/invoice.css).
 *
 * What DOES have to match is the content box inside it, or the same invoice
 * comes out as two different documents depending on which half of the product
 * issued it. The app draws a 277x190mm sheet with 2mm side padding, centred on
 * A4 by a 10mm @page margin: a 273mm-wide content column inset 12mm from the
 * paper's edge. These paddings reproduce exactly that box on a full-bleed
 * page — 12mm horizontally, and 10mm plus the shared --rhythm-pad-block
 * vertically, so the solver here is fitting the same height budget the app's
 * solver is.
 */
.invoice-sheet.orientation-landscape {
  width: 297mm;
  height: 210mm;
  padding: calc(10mm + var(--rhythm-pad-block)) 12mm;
  overflow: hidden;
  font-size: calc(8.7pt * var(--doc-font-scale));

  /* The app's own --col-* percentages (css/invoice.css), renormalized over
     the 97% they share there once its screen-only delete column is dropped:
     4 / 47 / 7 / 6 / 16 / 17, each divided by 0.97. */
  --col-row: 4.124%;
  --col-desc: 48.454%;
  --col-qty: 7.216%;
  --col-unit: 6.186%;
  --col-price: 16.495%;
  --col-total: 17.526%;
  --totals-span: calc(var(--col-price) + var(--col-total));
}

.inv-head {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 4mm;
  padding: var(--rhythm-head-pad) 4.2mm;
  background: var(--band-fill);
  color: var(--band-ink);
  border: var(--edge) solid var(--ink);
  border-radius: 1mm;
  break-inside: avoid;
}

.inv-doc-title {
  justify-self: start;
  min-width: 34mm;
  max-width: 100%;
  padding: 0.5mm 1mm;
  font-size: calc(16.5pt * var(--doc-font-scale));
  font-weight: 800;
  letter-spacing: 0.05em;
  color: var(--band-ink);
}

.inv-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--rhythm-brand-gap);
  min-width: 0;
}

.inv-logo-chip {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1mm;
}

.inv-logo, .inv-signature-stamp { filter: grayscale(1); }
.inv-logo { display: block; object-fit: contain; width: var(--rhythm-logo); height: var(--rhythm-logo); }

.inv-brand-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6mm;
  text-align: center;
}

.inv-brand-text h1 {
  font-size: calc(12.5pt * var(--doc-font-scale));
  line-height: 1.25;
  font-weight: 800;
  color: var(--band-ink);
  letter-spacing: 0.01em;
}

.inv-meta {
  justify-self: end;
  display: flex;
  flex-direction: column;
  gap: var(--rhythm-meta-gap);
  width: 68mm;
}

.inv-meta > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2mm;
  background: var(--pay-fill);
  border-radius: 1.6mm;
  padding: var(--rhythm-meta-pad) 2.5mm;
}

.inv-meta dt {
  display: inline-flex;
  align-items: center;
  gap: 1.2mm;
  white-space: nowrap;
  color: var(--muted-strong);
  font-size: calc(7.4pt * var(--doc-font-scale));
}

.inv-meta-icon, .inv-card-head-icon {
  flex: none;
  width: 3.4mm;
  height: 3.4mm;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.inv-meta dd {
  width: 34mm;
  text-align: left;
  font-size: calc(9.2pt * var(--doc-font-scale));
  font-weight: 400;
  color: var(--ink);
}

.inv-meta-validity dd {
  display: flex;
  align-items: center;
  gap: 1.5mm;
  justify-content: flex-start;
}

.inv-parties {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4mm;
  margin-block: var(--rhythm-parties-gap);
  break-inside: avoid;
}

.inv-card {
  border: 1px solid var(--line);
  border-radius: 0.75mm;
  overflow: hidden;
  background: var(--paper);
}

.inv-card-head {
  display: flex;
  align-items: center;
  gap: 2mm;
  padding: var(--rhythm-card-head) 3mm;
  background: #fff;
  color: var(--band-ink);
  border-bottom: 0.3mm solid var(--ink);
  font-size: calc(8.8pt * var(--doc-font-scale));
  font-weight: 800;
  letter-spacing: 0.01em;
}

.inv-card-head-icon { color: var(--accent-2); }

.inv-card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--rhythm-card-rowgap) 5mm;
  padding: var(--rhythm-card-pad) 3mm;
}

.inv-field { display: flex; align-items: flex-start; gap: 1.6mm; min-width: 0; }
.inv-field-wide { grid-column: 1 / -1; }

.inv-field-label {
  flex: none;
  padding-top: 0.4mm;
  color: var(--muted);
  font-size: calc(7.9pt * var(--doc-font-scale));
  font-weight: 500;
}
.inv-field-label::after { content: ":"; }

.inv-field-value {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 0 0.4mm;
  font-size: calc(9pt * var(--doc-font-scale));
  line-height: var(--rhythm-field-line);
  font-weight: 700;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.inv-card [data-align="ltr"] { text-align: right; }

.inv-table-frame {
  border: 1px solid #8e9396;
  border-radius: 0.75mm;
  overflow: hidden;
  break-inside: avoid;
  /* The guaranteed minimum air below the table; any height the sheet has left
     over lands here too, via .inv-summary's auto top margin. */
  margin-bottom: var(--rhythm-summary-gap);
}

.inv-table { width: 100%; border-collapse: collapse; table-layout: fixed; }

.inv-table th, .inv-table td {
  padding: var(--rhythm-td-pad) 1.6mm;
  border: none;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: middle;
  text-align: center;
  overflow-wrap: anywhere;
  line-height: 1.35;
}

.inv-table td + td { border-inline-start: 1px solid var(--line-soft); }
.inv-table th + th { border-inline-start: 1px solid var(--band-line); }

.inv-table th {
  padding-block: var(--rhythm-th-pad);
  background: #fff;
  border-bottom: 0.42mm solid var(--ink);
  font-weight: 800;
  font-size: 0.88em;
  line-height: 1.3;
  color: var(--band-ink);
}

.inv-table th:nth-child(1) { padding-inline: 0.8mm; white-space: nowrap; }
.inv-table tbody tr:last-child td { border-bottom: none; }

.inv-table td.col-desc { text-align: center; overflow-wrap: break-word; }
.inv-table td.col-qty, .inv-table td.col-unit,
.inv-table td.col-price, .inv-table td.col-total { text-align: center; }

.col-row { width: var(--col-row); }
.col-desc { width: var(--col-desc); }
.col-qty { width: var(--col-qty); }
.col-unit { width: var(--col-unit); }
.col-price { width: var(--col-price); }
.col-total { width: var(--col-total); }

.inv-table thead { display: table-header-group; }
.inv-table tbody tr:nth-child(even) td { background: var(--surface); }
.inv-table tr { break-inside: avoid; }

/* A minimum, not a cap: a row whose شرح wraps to two lines is taller than
   this and stays taller — which is exactly what the fit solver measures. */
.inv-table tbody tr { height: var(--rhythm-row-h); }
.inv-table td.col-desc { min-height: var(--rhythm-cell-line); }
/* Item cells keep their own, looser leading: a شرح that wraps needs it.
   Mirrors .invoice-sheet .inv-table .cell-input in css/invoice.css. */
.inv-table td { line-height: var(--rhythm-cell-line); }

.row-index-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 3.7mm;
  color: var(--ink);
  font-size: 0.86em;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.cell-computed { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }

.inv-amount-words {
  display: block;
  min-width: 0;
  min-height: var(--rhythm-words);
  margin: 0;
  padding: 0.55mm 2.5mm;
  border: 1px solid var(--ink);
  border-radius: 0.75mm;
  font-size: 0.9em;
  line-height: 1.3;
  white-space: normal;
  direction: rtl;
  break-inside: avoid;
}

.inv-amount-words-label { font-weight: 800; font-size: 0.97em; }
.inv-amount-words-label::after { content: "\\00a0\\2013\\00a0"; color: var(--muted); font-weight: 400; }
.inv-amount-words-value { color: var(--muted-strong); }

.inv-summary {
  display: grid;
  direction: ltr;
  column-gap: 4mm;
  row-gap: 1.4mm;
  align-items: stretch;
  grid-template-columns: var(--totals-span) 1fr var(--sig-w) var(--sig-w);
  grid-template-areas:
    "totals notes buyer seller"
    "words  notes buyer seller";
  grid-template-rows: minmax(0, 1fr) auto;
  break-inside: avoid;
  /* The sheet is a flex column, so this collects whatever height the solver
     could not spend on the blocks themselves and puts it in ONE place — the
     seam between the items table and the commercial closing block. Everything
     below then sits flush against the bottom edge. */
  margin-top: auto;
}

.inv-totals { grid-area: totals; }
.inv-amount-words { grid-area: words; }
.inv-notes { grid-area: notes; }
.inv-signature-buyer { grid-area: buyer; }
.inv-signature-seller { grid-area: seller; }

.inv-totals {
  direction: rtl;
  display: flex;
  flex-direction: column;
  background: var(--band-grad);
  color: var(--band-ink);
  border: var(--edge) solid var(--ink);
  border-radius: 0.75mm;
  overflow: hidden;
  padding-top: 0;
}

.inv-totals > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 3mm;
  min-height: var(--rhythm-totals-row);
  padding: 0.6mm 3mm;
  font-size: 0.97em;
  flex: 1 1 auto;
}

.inv-totals > div + div { border-top: 1px solid var(--band-line); }
.inv-totals > div > span { flex: 0 0 auto; color: var(--band-muted); font-weight: 500; }

.inv-totals strong {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--band-ink);
}

.inv-totals .inv-total-final {
  margin-top: auto;
  flex: 0 0 auto;
  background: #f1f1f1;
  color: var(--accent-ink);
  min-height: var(--rhythm-payable);
  padding-block: 1.8mm;
  border-top: var(--edge) solid var(--ink) !important;
}

.inv-totals .inv-total-final > span { color: var(--accent-ink); opacity: 0.82; font-weight: 800; }
.inv-total-final strong { color: var(--accent-ink); font-size: 1.62em; font-weight: 800; }

.inv-notes {
  direction: rtl;
  display: flex;
  flex-direction: column;
  gap: 0.5mm;
  border: 1px solid var(--line);
  border-radius: 0.75mm;
  padding: 1.1mm 3mm 1.4mm;
  min-width: 0;
  break-inside: avoid;
}

.inv-notes-label { flex: none; font-size: 0.86em; font-weight: 700; color: var(--muted-strong); }
.inv-notes-value { flex: 1 1 auto; font-size: 0.92em; line-height: 1.55; white-space: pre-wrap; }

.inv-signature-block {
  direction: rtl;
  border: 1px solid var(--line);
  border-radius: 0.75mm;
  padding: 1.1mm 2.6mm 1.4mm;
  display: flex;
  flex-direction: column;
  gap: 0.8mm;
  min-height: var(--sig-h);
  break-inside: avoid;
}

.inv-signature-label {
  font-size: 0.86em;
  font-weight: 700;
  color: var(--muted-strong);
  display: flex;
  align-items: center;
  gap: 1.6mm;
}

.inv-signature-label::before {
  content: "";
  flex: none;
  width: 1.8mm;
  height: 1.8mm;
  border-radius: 0.5mm;
  background: var(--ink);
}

.inv-signature-area {
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.inv-signature-stamp {
  position: absolute;
  inset: 0;
  margin: auto;
  max-width: min(88%, 31mm);
  max-height: min(88%, 31mm);
  object-fit: contain;
}

.inv-footer {
  /* A fixed gap rather than an auto one: the sheet's leftover height belongs
     above the closing block (see .inv-summary), not split in two around it.
     No backticks in this file's CSS — it is a JS template literal. */
  margin-top: var(--rhythm-footer-gap);
  padding: var(--rhythm-footer-pad) 4.5mm;
  background: var(--band-fill);
  color: var(--band-ink);
  border: var(--edge) solid var(--ink);
  border-radius: 0.75mm;
  font-size: 0.94em;
  position: relative;
  break-inside: avoid;
}

.inv-footer-site {
  display: block;
  width: 100%;
  text-align: center;
  font-family: "Vazirmatn", Tahoma, Arial, sans-serif;
  font-size: calc(9.5pt * var(--doc-font-scale));
  font-weight: 500;
  letter-spacing: 0.035em;
}

/* ---------- Multi-page ---------- */

/*
 * One .invoice-sheet article per A4 sheet (no angle brackets in here: this
 * stylesheet is served inside a style element, and a literal tag in a comment
 * is one more thing for a test that greps the HTML to trip over). Items are
 * chunked into
 * pages of at most sixteen server-side (see invoiceTemplate.js), the same
 * capacity the app's printed form has; page two onwards replaces the full
 * header and the party cards with a continuation strip, and only the last
 * page carries the closing block.
 */
.invoice-sheet + .invoice-sheet {
  break-before: page;
  page-break-before: always;
}

.print-continuation-head {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 4mm;
  padding: 2mm 3mm;
  margin-bottom: 2mm;
  border-block: 0.4mm solid #000;
}

.print-continuation-brand { display: flex; align-items: center; gap: 2.5mm; }
.print-continuation-brand img { width: 11mm; height: 11mm; object-fit: contain; filter: grayscale(1); }
.print-continuation-brand strong { font-size: calc(11pt * var(--doc-font-scale)); }
.print-continuation-title { text-align: center; font-size: calc(12pt * var(--doc-font-scale)); font-weight: 850; }
.print-continuation-meta { text-align: end; color: #35373a; font-size: calc(8.3pt * var(--doc-font-scale)); line-height: 1.7; }

.print-page-marker {
  margin-top: auto;
  padding-top: 1.5mm;
  border-top: 1px solid #777;
  color: #4b4d50;
  font-size: calc(8pt * var(--doc-font-scale));
  text-align: center;
}

.print-page-number {
  position: absolute;
  inset-inline-end: 10mm;
  bottom: 2.5mm;
  color: #555;
  font-size: calc(7.5pt * var(--doc-font-scale));
}

/*
 * Natural-height measurement (layoutInvoicePages). A sheet normally reports
 * the fixed A4 box it will be printed into, which says nothing about whether
 * the content inside it is 30mm short or 5mm too tall. Under this class it
 * reports the height its content actually wants — and because a flex line
 * with no free space has none to distribute, .inv-summary's auto top margin
 * collapses to zero, so what is measured is content, not content plus slack.
 */
.is-measuring-natural {
  height: auto !important;
  min-height: 0 !important;
  overflow: visible !important;
}
`;
}
