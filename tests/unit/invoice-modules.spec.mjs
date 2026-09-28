/*
 * Unit tests for the three modules extracted out of js/app.js.
 *
 * These exist because the rules they check are rules about invoices, not about
 * a user interface, and each one used to be reachable only by driving a real
 * browser through the DOM. Everything here runs in milliseconds; the Playwright
 * suite stays for what genuinely needs a layout engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp, memoryStorage, refusingStorage } from "./load.mjs";

const app = loadApp();

// ---------------------------------------------------------------------------
// Financial Computations (js/invoice-totals.js)
// ---------------------------------------------------------------------------

test("a line total is quantity times price, rounded half-up off milli-units", () => {
  // 2.5 × 1,500,000 = 3,750,000 exactly
  assert.equal(app.lineTotalRial(2500n, 1500000n), 3750000n);
  // 0.001 × 1,500 = 1.5 Rial, which rounds up rather than truncating to 1
  assert.equal(app.lineTotalRial(1n, 1500n), 2n);
});

test("totals stay exact past Number.MAX_SAFE_INTEGER", () => {
  const huge = 9007199254740993n; // MAX_SAFE_INTEGER + 2
  const { grossTotal, netTotal } = app.computeTotals(
    [{ quantityMilli: 1000n, unitPriceRial: huge }],
    1000n
  );
  assert.equal(grossTotal.toString(), "9007199254740993");
  assert.equal(netTotal.toString(), "9907919180215092", "tax on it stays exact too");
  // The float this would have been: the last digit is simply gone.
  assert.equal(String(Number(grossTotal)), "9007199254740992");
});

test("tax is applied in basis points, so a 10.5% rate is not rounded to 10", () => {
  const items = [{ quantityMilli: 1000n, unitPriceRial: 1000000n }];
  assert.equal(app.computeTotals(items, 1050n).taxTotal, 105000n);
  assert.equal(app.computeTotals(items, 1000n).taxTotal, 100000n);
});

test("a tax rate reaches basis points from either adapter's notation", () => {
  assert.equal(app.taxBasisPointsFrom(10), 1000n);        // bot: a Number
  assert.equal(app.taxBasisPointsFrom("۱۰"), 1000n);       // editor: Persian digits
  assert.equal(app.taxBasisPointsFrom("۹٫۵"), 950n);       // Persian decimal separator
  assert.equal(app.taxBasisPointsFrom(undefined), 0n);
  assert.equal(app.taxBasisPointsFrom(-5), 0n);            // never negative tax
});

test("an unreadable quantity or price excludes its row from the totals", () => {
  const summary = app.summarizeRows([
    { description: "میلگرد", quantity: "2", unit: "تن", unitPrice: "1000000" },
    { description: "تیرآهن", quantity: "abc", unit: "شاخه", unitPrice: "500000" },
  ], "0");
  assert.equal(summary.rows[1].quantityValid, false);
  assert.equal(summary.rows[1].lineTotal, null);
  assert.equal(summary.grossTotal, 2000000n, "the healthy row still calculates");
  assert.equal(summary.pricedCount, 1);
  assert.equal(summary.filledCount, 2, "but both rows count as started");
});

test("malformed grouping is rejected rather than read as ten times itself", () => {
  // "1,50" is not valid grouping; reading it as 150 would multiply by ten.
  assert.equal(app.strictMoney("1,50").valid, false);
  assert.equal(app.strictMoney("1,500").valid, true);
  assert.equal(app.strictMoney("1,500").value, 1500n);
});

test("a malformed tax rate is reported and contributes nothing", () => {
  const summary = app.summarizeRows(
    [{ description: "میلگرد", quantity: "1", unit: "تن", unitPrice: "1000" }],
    "1,0"
  );
  assert.equal(summary.taxValid, false);
  assert.equal(summary.taxTotal, 0n, "never applied as ten times itself");
  assert.equal(summary.netTotal, 1000n);
});

test("an empty tax rate is valid and means zero", () => {
  const tax = app.strictPercent("");
  assert.equal(tax.valid, true);
  assert.equal(tax.value, 0n);
});

test("a blank row is neither an error nor a total", () => {
  const summary = app.summarizeRows([{ description: "", quantity: "", unit: "", unitPrice: "" }], "10");
  assert.equal(summary.rows[0].blank, true);
  assert.equal(summary.rows[0].descriptionMissing, false);
  assert.equal(summary.filledCount, 0);
});

test("quantities are capped at three decimals and must be positive", () => {
  assert.equal(app.strictQuantity("2.5").valid, true);
  assert.equal(app.strictQuantity("2.5").value, 2500n);
  assert.equal(app.strictQuantity("2.5555").valid, false, "four decimals");
  assert.equal(app.strictQuantity("0").valid, false, "a zero quantity is unfinished, not free");
  assert.equal(app.strictQuantity("-1").valid, false);
});

test("an over-precise quantity or rate carries 0n like every other invalid value, never null", () => {
  assert.equal(app.strictQuantity("2.5555").valid, false);
  assert.equal(app.strictQuantity("2.5555").value, 0n);
  assert.equal(app.strictPercent("10.555").valid, false);
  assert.equal(app.strictPercent("10.555").value, 0n);
  // summarizeRows passes the rate's value straight through.
  assert.equal(app.summarizeRows([], "10.555").taxBasisPoints, 0n);
});

// ---------------------------------------------------------------------------
// Invoice number counter (js/invoice-counter.js)
// ---------------------------------------------------------------------------

function freshCounter(seed) {
  const storage = memoryStorage(seed);
  app.useCounterStorage(storage);
  return storage;
}

test("the first number of a day is 001, zero-padded and in Persian digits", () => {
  freshCounter();
  assert.equal(app.nextInvoiceNumber("fouladBonyan", "14040631"), "۱۴۰۴۰۶۳۱-۰۰۱");
});

test("suggesting a number never consumes it", () => {
  freshCounter();
  assert.equal(app.nextInvoiceNumber("fouladBonyan", "14040631"), "۱۴۰۴۰۶۳۱-۰۰۱");
  assert.equal(app.nextInvoiceNumber("fouladBonyan", "14040631"), "۱۴۰۴۰۶۳۱-۰۰۱");
});

test("committing a number retires it and advances the next suggestion", () => {
  freshCounter();
  app.commitInvoiceNumber("fouladBonyan", "۱۴۰۴۰۶۳۱-۰۰۱");
  assert.equal(app.invoiceNumberIsIssued("fouladBonyan", "۱۴۰۴۰۶۳۱-۰۰۱"), true);
  assert.equal(app.nextInvoiceNumber("fouladBonyan", "14040631"), "۱۴۰۴۰۶۳۱-۰۰۲");
});

test("the high-water mark only ever rises", () => {
  freshCounter();
  app.commitInvoiceNumber("fouladBonyan", "14040631-005");
  app.commitInvoiceNumber("fouladBonyan", "14040631-002");
  assert.equal(app.nextInvoiceNumber("fouladBonyan", "14040631"), "۱۴۰۴۰۶۳۱-۰۰۶");
});

test("each company counts separately", () => {
  freshCounter();
  app.commitInvoiceNumber("fouladBonyan", "14040631-009");
  assert.equal(app.nextInvoiceNumber("karaBorjParseh", "14040631"), "۱۴۰۴۰۶۳۱-۰۰۱");
});

test("saving for another date does not disturb today's sequence", () => {
  freshCounter();
  app.commitInvoiceNumber("fouladBonyan", "14040631-004");
  app.commitInvoiceNumber("fouladBonyan", "14040101-001");
  assert.equal(app.nextInvoiceNumber("fouladBonyan", "14040631"), "۱۴۰۴۰۶۳۱-۰۰۵");
});

test("a legacy {day,n} record is understood without being rewritten blindly", () => {
  freshCounter({ "pishFaktor.dailySeq.fouladBonyan": JSON.stringify({ day: "14040631", n: 7 }) });
  assert.equal(app.nextInvoiceNumber("fouladBonyan", "14040631"), "۱۴۰۴۰۶۳۱-۰۰۸");
  assert.equal(app.invoiceNumberIsIssued("fouladBonyan", "14040631-007"), true);
});

test("an unreadable counter proves no number is issued", () => {
  freshCounter({ "pishFaktor.dailySeq.fouladBonyan": "{{{ not json" });
  assert.equal(app.invoiceNumberIsIssued("fouladBonyan", "14040631-001"), false);
  assert.equal(app.nextInvoiceNumber("fouladBonyan", "14040631"), "۱۴۰۴۰۶۳۱-۰۰۱");
});

test("a refusing storage never blocks the editor", () => {
  app.useCounterStorage(refusingStorage());
  assert.doesNotThrow(() => app.commitInvoiceNumber("fouladBonyan", "14040631-001"));
  assert.doesNotThrow(() => app.forgetInvoiceCounter("fouladBonyan"));
});

test("only the YYYYMMDD-N format is a number this counter knows", () => {
  freshCounter();
  assert.equal(app.parseInvoiceNumber("14040631-001").sequence, 1);
  assert.equal(app.parseInvoiceNumber("hand written"), null);
  assert.equal(app.parseInvoiceNumber("14040631-000"), null);
  app.commitInvoiceNumber("fouladBonyan", "hand written");
  assert.equal(app.nextInvoiceNumber("fouladBonyan", "14040631"), "۱۴۰۴۰۶۳۱-۰۰۱");
});

// ---------------------------------------------------------------------------
// Document Store (js/document-store.js)
// ---------------------------------------------------------------------------

const ENTRY = "preinvoice.saved.entry.v2.";

function freshStore(seed) {
  const storage = memoryStorage(seed);
  app.useDocumentStorage(storage);
  return storage;
}

function invoice(name) {
  return { meta: { title: name }, items: [] };
}

test("a saved document comes back with the version it was stamped with", () => {
  freshStore();
  const written = app.saveDocument({ id: "inv-1", name: "آزمایشی", data: invoice("a") });
  assert.equal(written.ok, true);
  assert.ok(written.savedAt > 0);
  assert.equal(app.readDocument("inv-1").savedAt, written.savedAt);
});

test("each document occupies its own key, so one save cannot clobber another", () => {
  const storage = freshStore();
  app.saveDocument({ id: "inv-1", name: "یک", data: invoice("a") });
  app.saveDocument({ id: "inv-2", name: "دو", data: invoice("b") });
  assert.deepEqual(Object.keys(storage.snapshot()).sort(), [ENTRY + "inv-1", ENTRY + "inv-2"]);
  assert.equal(Object.keys(app.listDocuments().entries).length, 2);
});

test("a version that moved underneath the caller is reported as a conflict", () => {
  const storage = freshStore();
  const first = app.saveDocument({ id: "inv-1", name: "یک", data: invoice("a") });
  assert.equal(app.documentConflict("inv-1", first.savedAt).conflict, false);

  // Another tab saves the same entry. Written straight into storage with an
  // explicit stamp rather than through a second saveDocument call: Date.now()
  // has millisecond resolution, so two saves in the same tick genuinely do
  // produce the same version, and this test is about the comparison rule, not
  // about how fast the clock ticks.
  storage.setItem(ENTRY + "inv-1", JSON.stringify({
    id: "inv-1", name: "یک", savedAt: first.savedAt + 1000, data: invoice("b"),
  }));

  const check = app.documentConflict("inv-1", first.savedAt);
  assert.equal(check.conflict, true);
  assert.equal(check.current.savedAt, first.savedAt + 1000);
  assert.equal(check.current.data.meta.title, "b", "and hands back what is actually stored");
});

test("a caller with no expected version is not claiming a conflict", () => {
  freshStore();
  app.saveDocument({ id: "inv-1", name: "یک", data: invoice("a") });
  assert.equal(app.documentConflict("inv-1", null).conflict, false);
  assert.equal(app.documentConflict("inv-missing", 123).exists, false);
});

test("an unreadable entry is quarantined, not hidden and not overwritten", () => {
  const storage = freshStore({ [ENTRY + "inv-broken"]: "{{{ not json" });
  const listing = app.listDocuments();
  assert.equal(Object.keys(listing.entries).length, 0);
  assert.equal(listing.corrupt.length, 1);
  assert.equal(listing.corrupt[0].key, ENTRY + "inv-broken");
  assert.equal(listing.corrupt[0].id, "inv-broken");
  assert.equal(storage.getItem(ENTRY + "inv-broken"), "{{{ not json", "raw value untouched");

  assert.equal(app.purgeCorruptDocument(ENTRY + "inv-broken"), true);
  assert.equal(app.listDocuments().corrupt.length, 0);
});

test("an entry missing its data object is corrupt, not an empty invoice", () => {
  freshStore({ [ENTRY + "inv-1"]: JSON.stringify({ id: "inv-1", name: "x", savedAt: 5 }) });
  assert.equal(app.listDocuments().corrupt.length, 1);
});

test("the legacy monolithic list migrates to independent entries on first access", () => {
  const storage = freshStore({
    "preinvoice.saved.v1": JSON.stringify({
      "inv-old": { id: "inv-old", name: "قدیمی", savedAt: 111, data: invoice("old") },
    }),
  });
  const listing = app.listDocuments();
  assert.equal(listing.entries["inv-old"].name, "قدیمی");
  assert.equal(storage.getItem("preinvoice.saved.v1"), null, "source dropped only after the copy landed");
  assert.ok(storage.getItem(ENTRY + "inv-old"));
});

test("the legacy single-slot autosave becomes the first named entry", () => {
  const storage = freshStore({ "preinvoice.autosave.v1": JSON.stringify(invoice("autosaved")) });
  const listing = app.listDocuments();
  assert.equal(listing.entries["inv-legacy-autosave"].data.meta.title, "autosaved");
  assert.equal(storage.getItem("preinvoice.autosave.v1"), null);
});

test("a migration that cannot write leaves the original recoverable", () => {
  const storage = refusingStorage({
    "preinvoice.saved.v1": JSON.stringify({
      "inv-old": { id: "inv-old", name: "قدیمی", savedAt: 111, data: invoice("old") },
    }),
  });
  app.useDocumentStorage(storage);

  const listing = app.listDocuments();
  assert.equal(storage.getItem("preinvoice.saved.v1") !== null, true, "source kept");
  assert.equal(listing.entries["inv-old"].name, "قدیمی", "and still listed meanwhile");
  assert.ok(app.documentStoreWarnings().length > 0, "and the failure is said out loud");
});

test("deleting a document also prunes it from a still-present legacy list", () => {
  // Seeded so the entry exists in both places, as it does mid-migration.
  const storage = freshStore({
    [ENTRY + "inv-1"]: JSON.stringify({ id: "inv-1", name: "یک", savedAt: 5, data: invoice("a") }),
  });
  storage.setItem("preinvoice.saved.v1", JSON.stringify({
    "inv-1": { id: "inv-1", name: "یک", savedAt: 5, data: invoice("a") },
  }));

  assert.equal(app.removeDocument("inv-1"), true);
  assert.equal(app.readDocument("inv-1"), null, "and does not come back on the next listing");
});

test("a write that storage refuses is reported rather than thrown", () => {
  app.useDocumentStorage(refusingStorage());
  assert.equal(app.saveDocument({ id: "inv-1", name: "یک", data: invoice("a") }).ok, false);
});
