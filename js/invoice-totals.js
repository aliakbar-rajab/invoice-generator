/*
 * Financial Computations for one Invoice Document.
 *
 * This is the only place the invoice's money is added up. Both View Adapters
 * call it: the browser DOM shell (js/app.js, recalcAll) and the Telegram bot
 * (worker/src/lib/invoiceTemplate.js, which gets a generated ESM copy of this
 * file — see worker/scripts/sync-assets.mjs). Before it existed the same two
 * formulas were written once on each side, with nothing keeping them equal.
 *
 * Everything is BigInt, for the reason js/persian-numbers.js gives at length:
 * real Rial totals run past Number.MAX_SAFE_INTEGER, and a float would round
 * them silently. Quantities are milli-units (10^3), tax is basis points
 * (10^4), unit prices are whole Rials.
 *
 * Loaded as a classic <script> tag, like persian-numbers.js, so the app keeps
 * working when index.html is opened directly over file://.
 */

/*
 * VALIDATION. normalizeStrictNumber returns "" for a genuinely empty field and
 * null for a malformed one, and the difference matters: an empty tax rate
 * legitimately means zero, while a malformed one must never be quietly read as
 * zero. Each validator below therefore reports `valid` separately from
 * `value`, and callers must not infer one from the other — an invalid row
 * still carries 0n, which is not the same as a row that is worth nothing.
 */

// Whole Rials. Grouping separators are allowed (the app formats with them),
// decimals are not.
function strictMoney(value) {
  var normalized = normalizeStrictNumber(value);
  if (normalized === null) return { valid: false, value: 0n };
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return { valid: false, value: 0n };
  return {
    valid: /^\d+$/.test(normalized),
    value: parseDecimalToBigIntScaled(normalized, 0),
  };
}

// Up to three decimals, and strictly positive: a zero quantity is a row the
// user has started but not finished, not a line worth nothing.
function strictQuantity(value) {
  var normalized = normalizeStrictNumber(value);
  if (normalized === null) return { valid: false, value: 0n };
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return { valid: false, value: 0n };
  var parsed = parseQtyMilli(normalized);
  return {
    valid: /^\d+(?:\.\d{1,3})?$/.test(normalized) && parsed > 0n,
    value: parsed,
  };
}

// 0–100 with at most two decimals, carried as basis points. Empty is valid and
// means zero, which is why this one cannot just defer to strictMoney.
function strictPercent(value) {
  var normalized = normalizeStrictNumber(value);
  if (normalized === null) return { valid: false, value: 0n };
  if (!normalized) return { valid: true, value: 0n };
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return { valid: false, value: 0n };
  var parsed = parsePercentBps(normalized);
  return {
    valid: /^\d+(?:\.\d{1,2})?$/.test(normalized) && parsed >= 0n && parsed <= 10000n,
    value: parsed,
  };
}

/*
 * ARITHMETIC.
 */

// Quantity is scaled by 10^3, so the product is too and has to come back down.
// bigRoundDiv is half-up, so a half-Rial line total rounds up rather than
// truncating toward zero the way BigInt division would.
function lineTotalRial(quantityMilli, unitPriceRial) {
  return bigRoundDiv(quantityMilli * unitPriceRial, 1000n);
}

/*
 * A tax rate as the two adapters actually carry it — a Number on the bot
 * (state.taxPercent, already range-checked when /tax set it) and a field
 * string in the editor ("۱۰", possibly with a Persian decimal separator).
 *
 * Deliberately lenient, and NOT the same rule as strictPercent: this one
 * accepts whatever reaches it and floors at zero, because by the time a
 * document is being rendered the rate has already been through whichever
 * validator that adapter uses. strictPercent is what the editor gates typing
 * with; this is what rendering falls back on.
 */
function taxBasisPointsFrom(taxPercent) {
  if (typeof taxPercent === "number") {
    if (Number.isNaN(taxPercent) || !Number.isFinite(taxPercent)) return 0n;
    return BigInt(Math.max(0, Math.round(taxPercent * 100)));
  }
  if (taxPercent == null) return 0n;
  // BigInt() choking on Persian digits is what used to throw RangeError here;
  // see the regression test of the same name in worker/test.
  var normalized = toAsciiDigits(String(taxPercent).trim()).replace(/٫/g, ".");
  // parseDecimalToBigIntScaled returns 0n for anything it cannot read, never
  // null, so the only check worth making is the sign one.
  var parsed = parseDecimalToBigIntScaled(normalized, 2);
  return parsed > 0n ? parsed : 0n;
}

/*
 * Per-item and invoice-level totals as exact BigInt Rial amounts.
 * `items` carry quantityMilli/unitPriceRial as already-parsed BigInts; each
 * one comes back with its lineTotal attached, in order.
 */
function computeTotals(items, taxBasisPoints) {
  var bps = taxBasisPoints || 0n;
  var lines = items.map(function (item) {
    var lineTotal = lineTotalRial(item.quantityMilli, item.unitPriceRial);
    return Object.assign({}, item, { lineTotal: lineTotal });
  });
  var grossTotal = lines.reduce(function (sum, line) { return sum + line.lineTotal; }, 0n);
  var taxTotal = bigRoundDiv(grossTotal * bps, 10000n);
  return { lines: lines, grossTotal: grossTotal, taxTotal: taxTotal, netTotal: grossTotal + taxTotal };
}

/*
 * The editor's single call: raw Item Rows exactly as they were typed, in, and
 * everything the sheet needs to repaint itself, out.
 *
 * Rows are `{ description, quantity, unit, unitPrice }` of user strings. Each
 * comes back with its validity broken out per field, because the editor treats
 * the three failures differently: a missing description is a warning that does
 * not touch the arithmetic, while an unreadable quantity or price must block
 * Save/Print AND leave the row out of the totals — a document whose printed
 * total silently omitted a row would be worse than one that refuses to print.
 *
 * No message strings live here. The adapter owns the wording; this owns which
 * fields are wrong.
 */
function summarizeRows(rows, taxPercentRaw) {
  var results = [];
  var priced = [];

  rows.forEach(function (row) {
    var blank = ["description", "quantity", "unit", "unitPrice"].every(function (field) {
      return !String(row[field] == null ? "" : row[field]).trim();
    });
    if (blank) {
      results.push({ blank: true, descriptionMissing: false, quantityValid: true, unitPriceValid: true, lineTotal: null });
      return;
    }

    var qty = strictQuantity(row.quantity);
    var price = strictMoney(row.unitPrice);
    var counts = qty.valid && price.valid;
    // Only a row whose arithmetic is sound contributes. The rest are reported
    // and excluded, never guessed at.
    var lineTotal = counts ? lineTotalRial(qty.value, price.value) : null;
    if (counts) priced.push({ quantityMilli: qty.value, unitPriceRial: price.value });

    results.push({
      blank: false,
      descriptionMissing: !String(row.description == null ? "" : row.description).trim(),
      quantityValid: qty.valid,
      unitPriceValid: price.valid,
      lineTotal: lineTotal,
    });
  });

  var tax = strictPercent(taxPercentRaw);
  // An unreadable rate is reported by `taxValid` and contributes nothing, so
  // the gross total stays honest while the banner explains the missing tax.
  var totals = computeTotals(priced, tax.valid ? tax.value : 0n);

  return {
    rows: results,
    // Every row the user has started, whether or not it priced. The editor
    // shows totals as soon as one row exists, so a document of nothing but
    // unreadable rows still reads "۰ ریال" rather than going blank.
    filledCount: results.filter(function (r) { return !r.blank; }).length,
    pricedCount: priced.length,
    taxValid: tax.valid,
    taxBasisPoints: tax.value,
    grossTotal: totals.grossTotal,
    taxTotal: totals.taxTotal,
    netTotal: totals.netTotal,
  };
}

var InvoiceTotals = {
  strictMoney: strictMoney,
  strictQuantity: strictQuantity,
  strictPercent: strictPercent,
  lineTotalRial: lineTotalRial,
  taxBasisPointsFrom: taxBasisPointsFrom,
  computeTotals: computeTotals,
  summarizeRows: summarizeRows,
};

// Classic-script load (index.html) puts every function above in global scope
// already; this is the namespaced handle for anything that prefers one.
if (typeof window !== "undefined") window.InvoiceTotals = InvoiceTotals;

// CommonJS load (worker/scripts/sync-assets.mjs reads the export list off this).
if (typeof module !== "undefined" && module.exports) module.exports = InvoiceTotals;
