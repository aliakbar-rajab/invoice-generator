import test from "node:test";
import assert from "node:assert/strict";

import InvoiceDocument from "../js/invoice-document.js";
import PersianNumbers from "../js/persian-numbers.js";
import DocumentStore from "../js/document-store.js";
import CompanyRepository from "../js/company-repository.js";
import InvoiceLayout from "../js/invoice-layout.js";

const {
  createBlankInvoice,
  computeTotals,
  validateInvoice,
  normalizeInvoiceData,
  parseJalaliDate,
  formatJalaliYmd,
} = InvoiceDocument;

const {
  parseMoneyBig,
  parseQtyMilli,
  parsePercentBps,
  formatBigRial,
  formatQtyMilli,
  formatPercentBps,
  rialToWordsBig,
} = PersianNumbers;

const {
  isPlainObject,
  invoiceDocumentProblem,
} = DocumentStore;

const {
  BUILT_IN_PROFILE_DEFAULTS,
  isCustomProfile,
} = CompanyRepository;

const {
  MM_TO_PX,
  PAGE_BOX_MM,
} = InvoiceLayout;

test("InvoiceDocument creates valid blank default invoice", () => {
  const blank = createBlankInvoice({ orientation: "landscape" });
  assert.equal(blank.directives.orientation, "landscape");
  assert.equal(blank.items.length, 7);
  assert.equal(blank.taxPercent, "۱۰");
  assert.equal(blank.meta.title, "پیش‌فاکتور");
});

test("InvoiceDocument calculates exact BigInt financial totals and words", () => {
  const invoice = {
    taxPercent: "10",
    items: [
      { description: "آهن میلگرد", quantity: "2.5", unit: "تن", unitPrice: "1500000" },
      { description: "تیرآهن", quantity: "10", unit: "شاخه", unitPrice: "500000" },
    ],
  };

  const totals = computeTotals(invoice);
  // Row 1: 2.5 * 1,500,000 = 3,750,000
  assert.equal(totals.rows[0].totalBig, 3750000n);
  // Row 2: 10 * 500,000 = 5,000,000
  assert.equal(totals.rows[1].totalBig, 5000000n);
  // Gross: 8,750,000
  assert.equal(totals.grossTotal, 8750000n);
  // Tax (10%): 875,000
  assert.equal(totals.taxTotal, 875000n);
  // Net: 9,625,000
  assert.equal(totals.netTotal, 9625000n);
  assert.equal(totals.netTotalWords, "نه میلیون و ششصد و بیست و پنج هزار ریال");
});

test("InvoiceDocument supports decimal percentage like 10.5%", () => {
  const invoice = {
    taxPercent: "10.5",
    items: [
      { description: "ورق", quantity: "1", unit: "عدد", unitPrice: "1000000" },
    ],
  };

  const totals = computeTotals(invoice);
  assert.equal(totals.taxTotal, 105000n);
  assert.equal(totals.netTotal, 1105000n);
});

test("InvoiceDocument normalizes older backups and drops discounts", () => {
  const legacyBackup = {
    items: [
      { description: "کالا", quantity: "1", unit: "عدد", unitPrice: "100", discount: "50" },
    ],
  };

  const normalized = normalizeInvoiceData(legacyBackup);
  assert.equal(normalized.taxPercent, "۰"); // defaults to 0% if missing
  assert.equal(normalized.items[0].discount, undefined); // discount dropped
});

test("InvoiceDocument validates required fields and reports missing buyer", () => {
  const blank = createBlankInvoice();
  const warnings = validateInvoice(blank);
  assert.ok(warnings.some((w) => w.field === "buyer.name"));
  assert.ok(warnings.some((w) => w.field === "seller.name"));
});

test("DocumentStore validates import shape correctly", () => {
  assert.equal(invoiceDocumentProblem(null), "فایل انتخاب‌شده دادهٔ پیش‌فاکتور معتبر ندارد.");
  assert.equal(invoiceDocumentProblem({ meta: "not an object" }), "بخش مشخصات سربرگ پیش‌فاکتور آسیب دیده است.");
  assert.equal(invoiceDocumentProblem({}), null);
});

test("CompanyRepository exposes shipped built-in profiles", () => {
  assert.ok(BUILT_IN_PROFILE_DEFAULTS.fouladBonyan);
  assert.ok(BUILT_IN_PROFILE_DEFAULTS.karaBorjParseh);
  assert.equal(isCustomProfile("other"), true);
  assert.equal(isCustomProfile("fouladBonyan"), false);
});

test("InvoiceLayout exposes correct sheet geometry constants", () => {
  assert.equal(PAGE_BOX_MM.landscape.w, 277);
  assert.equal(PAGE_BOX_MM.landscape.h, 190);
  assert.ok(MM_TO_PX > 3.77 && MM_TO_PX < 3.78);
});
