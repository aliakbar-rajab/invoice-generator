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
 * KNOWN DIVERGENCE. The app now sizes its sheet with a solved vertical
 * rhythm — one --print-density scalar that every vertical dimension is a
 * straight line in, bisected until the content fills A4 exactly for whatever
 * number of items the document carries (see the knob table in
 * css/invoice.css and fitSheetToPage in js/app.js). This stylesheet is still
 * the fixed layout that preceded it: correct, but always set at one density,
 * so a short invoice leaves a band of blank paper above the totals and a long
 * one has no room to give. Porting the solver here means running the same
 * bisection inside the rendering page before page.pdf() in pdf.js — the
 * browser is already there, it just has not been asked. The columns and the
 * retired تخفیف columns ARE in sync.
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
  --surface: #e0e0e0;
  --band-ink: var(--ink);
  --band-muted: var(--muted);
  --band-line: var(--line);
  --band-grad: var(--paper);
  --edge: 0.6mm;
  --band-fill: #e0e0e0;
  --accent-ink: #000000;
  --accent-2: var(--muted);
  --pay-fill: #ededed;
  --sig-w: 46mm;
  --sig-h: 46mm;

  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--paper);
  color: var(--ink);
  line-height: 1.5;
  margin: 0;
}

.invoice-sheet, .invoice-sheet * {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.invoice-sheet h1, .invoice-sheet h2, .invoice-sheet p,
.invoice-sheet span, .invoice-sheet dt, .invoice-sheet dd { margin: 0; }

.invoice-sheet.orientation-landscape {
  width: 297mm;
  min-height: 210mm;
  padding: 6mm 10mm 6mm;
  font-size: 8.7pt;

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
  padding: 2.2mm 4.5mm;
  background: var(--band-fill);
  color: var(--band-ink);
  border: var(--edge) solid var(--ink);
  border-radius: 2.5mm;
  break-inside: avoid;
}

.inv-doc-title {
  justify-self: start;
  min-width: 34mm;
  max-width: 100%;
  padding: 0.5mm 1mm;
  font-size: 16.5pt;
  font-weight: 800;
  letter-spacing: 0.05em;
  color: var(--band-ink);
}

.inv-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2.2mm;
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
.inv-logo { display: block; object-fit: contain; width: 17mm; height: 17mm; }

.inv-brand-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6mm;
  text-align: center;
}

.inv-brand-text h1 {
  font-size: 12.5pt;
  line-height: 1.25;
  font-weight: 800;
  color: var(--band-ink);
  letter-spacing: 0.01em;
}

.inv-meta {
  justify-self: end;
  display: flex;
  flex-direction: column;
  gap: 1mm;
  width: 68mm;
}

.inv-meta > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2mm;
  background: var(--pay-fill);
  border-radius: 1.6mm;
  padding: 0.8mm 2.5mm;
}

.inv-meta dt {
  display: inline-flex;
  align-items: center;
  gap: 1.2mm;
  white-space: nowrap;
  color: var(--muted-strong);
  font-size: 7.4pt;
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
  font-size: 9.2pt;
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
  margin-block: 2.2mm 1.8mm;
  break-inside: avoid;
}

.inv-card {
  border: 1px solid var(--line);
  border-radius: 2.5mm;
  overflow: hidden;
  background: var(--paper);
}

.inv-card-head {
  display: flex;
  align-items: center;
  gap: 2mm;
  padding: 1.1mm 3mm;
  background: var(--band-grad);
  color: var(--band-ink);
  border-bottom: 0.35mm solid var(--ink);
  font-size: 8.8pt;
  font-weight: 800;
  letter-spacing: 0.01em;
}

.inv-card-head-icon { color: var(--accent-2); }

.inv-card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.7mm 6mm;
  padding: 1.2mm 3mm 1.4mm;
}

.inv-field { display: flex; align-items: baseline; gap: 1.6mm; min-width: 0; }
.inv-field-wide { grid-column: 1 / -1; }

.inv-field-label {
  flex: none;
  color: var(--muted);
  font-size: 7.4pt;
  font-weight: 500;
}
.inv-field-label::after { content: ":"; }

.inv-field-value {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 0 0.4mm;
  font-size: 9.2pt;
  font-weight: 700;
}

.inv-card [data-align="ltr"] { text-align: right; }

.inv-table-frame {
  border: 1px solid var(--line);
  border-radius: 2mm;
  overflow: hidden;
  break-inside: avoid;
}

.inv-table { width: 100%; border-collapse: collapse; table-layout: fixed; }

.inv-table th, .inv-table td {
  padding: 0.65mm 1.6mm;
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
  padding-block: 1.3mm;
  background: var(--band-grad);
  border-bottom: 0.5mm solid var(--ink);
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
  min-height: 7mm;
  margin: 0;
  padding: 0.55mm 2.5mm;
  border: 1px solid var(--ink);
  border-radius: 1.5mm;
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
  /* A fixed gap below the items table. The app spends its leftover sheet
     height here instead (margin-top: auto, filled by the rhythm solver); see
     the KNOWN DIVERGENCE note at the top of this file. */
  margin-top: 2mm;
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
  border-radius: 2.5mm;
  overflow: hidden;
  padding-top: 0;
}

.inv-totals > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 3mm;
  min-height: 4.3mm;
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
  background: var(--pay-fill);
  color: var(--accent-ink);
  min-height: 11mm;
  padding-block: 1.8mm;
  border-top: var(--edge) solid var(--ink) !important;
}

.inv-totals .inv-total-final > span { color: var(--accent-ink); opacity: 0.82; font-weight: 800; }
.inv-total-final strong { color: var(--accent-ink); font-size: 1.75em; font-weight: 800; }

.inv-notes {
  direction: rtl;
  display: flex;
  flex-direction: column;
  gap: 0.5mm;
  border: 1px solid var(--line);
  border-radius: 2mm;
  padding: 1.1mm 3mm 1.4mm;
  min-width: 0;
  break-inside: avoid;
}

.inv-notes-label { flex: none; font-size: 0.86em; font-weight: 700; color: var(--muted-strong); }
.inv-notes-value { flex: 1 1 auto; font-size: 0.92em; line-height: 1.55; white-space: pre-wrap; }

.inv-signature-block {
  direction: rtl;
  border: 1px solid var(--line);
  border-radius: 2.5mm;
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
  max-width: min(95%, 36mm);
  max-height: min(95%, 36mm);
  object-fit: contain;
}

.inv-footer {
  margin-top: 2.1mm;
  padding: 1.6mm 4.5mm;
  background: var(--band-fill);
  color: var(--band-ink);
  border: var(--edge) solid var(--ink);
  border-radius: 2.5mm;
  font-size: 0.94em;
  position: relative;
  break-inside: avoid;
}

.inv-footer-site {
  display: block;
  width: 100%;
  text-align: center;
  font-family: Georgia, "Palatino Linotype", "Book Antiqua", serif;
  font-size: 12pt;
  font-weight: 400;
  letter-spacing: 0.12em;
}
`;
}
