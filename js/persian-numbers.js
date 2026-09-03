/*
 * Persian/Arabic digit + number-to-words helpers.
 *
 * All money/quantity/percent math below is BigInt-based (arbitrary-precision
 * integers), never `Number`. Rial amounts routinely exceed
 * Number.MAX_SAFE_INTEGER (9,007,199,254,740,991) in real invoices, and once
 * a value crosses that line, ordinary float math silently rounds it — the
 * BigInt path keeps parsing, formatting, arithmetic and word-conversion
 * exact regardless of magnitude. Loaded as a classic <script> tag (no ES
 * module resolution), which keeps the app working when opened directly via
 * file:// with no local server.
 */

// Both Persian (U+06F0) and Arabic-Indic (U+0660) digit blocks run 0-9 in
// order, so the digit's value is a fixed offset from its code point.
function toAsciiDigits(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[۰-۹٠-٩]/g, function (digit) {
    var code = digit.charCodeAt(0);
    return String(code >= 0x0660 && code <= 0x0669 ? code - 0x0660 : code - 0x06f0);
  });
}

function toPersianDigits(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/[0-9]/g, function (digit) {
      return String.fromCharCode(digit.charCodeAt(0) + 1728);
    })
    .replace(/[٠-٩]/g, function (digit) {
      return String.fromCharCode(digit.charCodeAt(0) + 144);
    });
}

var GROUP_SEP = "٬"; // ٬ Arabic thousands separator (matches fa-IR grouping)
var DECIMAL_SEP = "٫"; // ٫ Arabic decimal separator (matches fa-IR decimal point)

var STRICT_UNGROUPED_INT = /^\d+$/;
var STRICT_GROUPED_INT = /^\d{1,3}(?:([,٬\s])\d{3})(?:\1\d{3})*$/;

// Normalizes a user-typed numeric string to ASCII digits with a plain "."
// decimal point, rejecting malformed grouping separators (such as "1,5" or "12,34").
function normalizeStrictNumber(raw) {
  if (raw === null || raw === undefined) return null;
  var text = toAsciiDigits(String(raw).trim());
  if (!text) return "";
  var sign = text.indexOf("-") === 0 ? "-" : "";
  var unsigned = sign ? text.slice(1) : text;
  if (!unsigned) return null;

  var intPart = unsigned;
  var fracPart = "";
  var decimalMatch = unsigned.match(/^([^.٫]*)[.٫](.*)$/);
  if (decimalMatch) {
    intPart = decimalMatch[1];
    fracPart = decimalMatch[2];
    if (intPart.indexOf(".") !== -1 || intPart.indexOf("٫") !== -1 || fracPart.indexOf(".") !== -1 || fracPart.indexOf("٫") !== -1) {
      return null;
    }
  }

  if (fracPart && !/^\d+$/.test(fracPart)) return null;

  var plainInt = intPart;
  if (!intPart && fracPart) {
    plainInt = "0";
  } else if (/[, ٬\s]/.test(intPart)) {
    if (!STRICT_GROUPED_INT.test(intPart)) return null;
    plainInt = intPart.replace(/[, ٬\s]/g, "");
  } else if (!STRICT_UNGROUPED_INT.test(intPart)) {
    return null;
  }

  return fracPart ? sign + plainInt + "." + fracPart : sign + plainInt;
}

// Parses a numeric string into a BigInt scaled by 10^decimals (e.g.
// decimals=3 turns "2.755" into 2755n), rounding half-up on any digits
// beyond that precision. Every digit of the integer part is carried through
// as text into `BigInt(...)`, which parses arbitrarily long decimal strings
// exactly — unlike parseFloat/Number, there is no point at which precision
// is silently lost for a very large value.
function parseDecimalToBigIntScaled(value, decimals) {
  var normalized = normalizeStrictNumber(value);
  if (normalized === null || normalized === "") return 0n;
  var match = normalized.match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if (!match) return 0n;

  var sign = match[1] === "-" ? -1n : 1n;
  var intDigits = match[2] || "0";
  var fracDigits = match[3] || "";

  // Pad/truncate the fractional part to decimals+1 digits so the extra
  // digit can drive half-up rounding into the kept precision.
  var extended = (fracDigits + "0".repeat(decimals + 1)).slice(0, decimals + 1);
  var keep = extended.slice(0, decimals);
  var roundDigit = extended.charAt(decimals);

  var scaled;
  try {
    scaled = BigInt(intDigits + keep);
  } catch (err) {
    return 0n;
  }
  if (roundDigit >= "5") scaled += 1n;
  return sign * scaled;
}

// Rounds numerator/denominator to the nearest integer (half-up), entirely
// in BigInt arithmetic so no intermediate float ever touches the value.
function bigRoundDiv(numerator, denominator) {
  if (denominator === 0n) return 0n;
  var negResult = (numerator < 0n) !== (denominator < 0n);
  var n = numerator < 0n ? -numerator : numerator;
  var d = denominator < 0n ? -denominator : denominator;
  var result = (2n * n + d) / (2n * d);
  return negResult ? -result : result;
}

function groupDigits(digitsAscii, sep) {
  return digitsAscii.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

// ---------- Money (integer Rial, no fractional subunit) ----------

function parseMoneyBig(value) {
  var normalized = normalizeStrictNumber(value);
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  return parseDecimalToBigIntScaled(normalized, 0);
}

function formatBigRial(value) {
  var v = value || 0n;
  var neg = v < 0n;
  var digits = (neg ? -v : v).toString();
  return (neg ? "-" : "") + toPersianDigits(groupDigits(digits, GROUP_SEP));
}

// ---------- Quantity (up to 3 decimal places, e.g. weight in tons) ----------

function parseQtyMilli(value) {
  var normalized = normalizeStrictNumber(value);
  if (!normalized || !/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null;
  return parseDecimalToBigIntScaled(normalized, 3);
}

function formatQtyMilli(value) {
  var v = value || 0n;
  var neg = v < 0n;
  var abs = neg ? -v : v;
  var intPart = abs / 1000n;
  var fracPart = abs % 1000n;
  var out = groupDigits(intPart.toString(), GROUP_SEP);
  if (fracPart !== 0n) {
    var fracStr = fracPart.toString();
    while (fracStr.length < 3) fracStr = "0" + fracStr;
    fracStr = fracStr.replace(/0+$/, "");
    out += DECIMAL_SEP + fracStr;
  }
  return (neg ? "-" : "") + toPersianDigits(out);
}

// ---------- Percent (up to 2 decimal places, stored as basis points) ----------

function parsePercentBps(value) {
  var normalized = normalizeStrictNumber(value);
  if (!normalized || !/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  return parseDecimalToBigIntScaled(normalized, 2);
}

function formatPercentBps(value) {
  var v = value || 0n;
  var neg = v < 0n;
  var abs = neg ? -v : v;
  var intPart = abs / 100n;
  var fracPart = abs % 100n;
  var out = intPart.toString();
  if (fracPart !== 0n) {
    var fracStr = fracPart.toString();
    while (fracStr.length < 2) fracStr = "0" + fracStr;
    fracStr = fracStr.replace(/0+$/, "");
    out += DECIMAL_SEP + fracStr;
  }
  return (neg ? "-" : "") + toPersianDigits(out);
}

// ---------- Amount in words ----------

var ONES = ["", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه",
  "ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده",
  "هفده", "هجده", "نوزده"];
var TENS = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"];
var HUNDREDS = ["", "صد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد"];

function threeDigitsToWords(value) {
  var parts = [];
  if (value >= 100) parts.push(HUNDREDS[Math.floor(value / 100)]);
  var remainder = value % 100;
  if (remainder < 20) {
    if (remainder) parts.push(ONES[remainder]);
  } else {
    parts.push(TENS[Math.floor(remainder / 10)]);
    if (remainder % 10) parts.push(ONES[remainder % 10]);
  }
  return parts.join(" و ");
}

function scaleWordForGroup(groupIndex) {
  if (groupIndex === 0) return "";
  var exponent = groupIndex * 3;
  var billionRepeats = Math.floor(exponent / 9);
  var remainder = exponent % 9;
  var prefix = remainder === 3 ? "هزار" : remainder === 6 ? "میلیون" : "";
  var words = [];
  if (prefix) words.push(prefix);
  for (var i = 0; i < billionRepeats; i += 1) words.push("میلیارد");
  return words.join(" ");
}

function rialToWordsBig(value) {
  var v = value || 0n;
  if (v === 0n) return "صفر ریال";

  var neg = v < 0n;
  var remaining = neg ? -v : v;
  var groups = [];
  var groupIndex = 0;

  while (remaining > 0n) {
    var group = Number(remaining % 1000n);
    if (group) {
      var scaleWord = scaleWordForGroup(groupIndex);
      groups.unshift(threeDigitsToWords(group) + (scaleWord ? " " + scaleWord : ""));
    }
    remaining = remaining / 1000n;
    groupIndex += 1;
  }

  return (neg ? "منفی " : "") + groups.join(" و ") + " ریال";
}

var PersianNumbers = {
  toPersianDigits: toPersianDigits,
  toAsciiDigits: toAsciiDigits,
  normalizeStrictNumber: normalizeStrictNumber,
  parseDecimalToBigIntScaled: parseDecimalToBigIntScaled,
  bigRoundDiv: bigRoundDiv,
  groupDigits: groupDigits,
  parseMoneyBig: parseMoneyBig,
  parseQtyMilli: parseQtyMilli,
  parsePercentBps: parsePercentBps,
  formatBigRial: formatBigRial,
  formatQtyMilli: formatQtyMilli,
  formatPercentBps: formatPercentBps,
  threeDigitsToWords: threeDigitsToWords,
  scaleWordForGroup: scaleWordForGroup,
  rialToWordsBig: rialToWordsBig,
};

if (typeof window !== "undefined") {
  window.PersianNumbers = PersianNumbers;
  window.normalizeStrictNumber = normalizeStrictNumber;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    toPersianDigits: toPersianDigits,
    toAsciiDigits: toAsciiDigits,
    normalizeStrictNumber: normalizeStrictNumber,
    parseDecimalToBigIntScaled: parseDecimalToBigIntScaled,
    bigRoundDiv: bigRoundDiv,
    groupDigits: groupDigits,
    parseMoneyBig: parseMoneyBig,
    parseQtyMilli: parseQtyMilli,
    parsePercentBps: parsePercentBps,
    formatBigRial: formatBigRial,
    formatQtyMilli: formatQtyMilli,
    formatPercentBps: formatPercentBps,
    threeDigitsToWords: threeDigitsToWords,
    scaleWordForGroup: scaleWordForGroup,
    rialToWordsBig: rialToWordsBig,
  };
}
