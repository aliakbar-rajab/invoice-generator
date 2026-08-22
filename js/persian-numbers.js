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

// Normalizes a user-typed numeric string to ASCII digits with a plain "."
// decimal point and no grouping separators, so it can be matched with a
// simple regex. Handles both punctuation conventions the app itself ever
// produces (ASCII "," / Persian "٬" for grouping, ASCII "." / Persian "٫"
// for the decimal point) as well as raw keyboard input.
function normalizeNumericInput(value) {
  if (value === null || value === undefined) return "";
  return toAsciiDigits(String(value))
    .replace(/[,\s٬]/g, "")
    .replace(/٫/g, ".");
}

// Parses a numeric string into a BigInt scaled by 10^decimals (e.g.
// decimals=3 turns "2.755" into 2755n), rounding half-up on any digits
// beyond that precision. Every digit of the integer part is carried through
// as text into `BigInt(...)`, which parses arbitrarily long decimal strings
// exactly — unlike parseFloat/Number, there is no point at which precision
// is silently lost for a very large value.
function parseDecimalToBigIntScaled(value, decimals) {
  var normalized = normalizeNumericInput(value).replace(/[^0-9.\-]/g, "");
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

function clampBig(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Groups an ASCII digit string into 3s from the right with `sep`, e.g.
// "1234567" -> "1٬234٬567". Pure string manipulation on the BigInt's own
// exact decimal representation — no length limit.
function groupDigits(digitsAscii, sep) {
  var out = "";
  var count = 0;
  for (var i = digitsAscii.length - 1; i >= 0; i -= 1) {
    out = digitsAscii.charAt(i) + out;
    count += 1;
    if (count % 3 === 0 && i !== 0) out = sep + out;
  }
  return out;
}

// ---------- Money (integer Rial, no fractional subunit) ----------

function parseMoneyBig(value) {
  return parseDecimalToBigIntScaled(value, 0);
}

function formatBigRial(value) {
  var v = value || 0n;
  var neg = v < 0n;
  var digits = (neg ? -v : v).toString();
  return (neg ? "-" : "") + toPersianDigits(groupDigits(digits, GROUP_SEP));
}

// ---------- Quantity (up to 3 decimal places, e.g. weight in tons) ----------

function parseQtyMilli(value) {
  return parseDecimalToBigIntScaled(value, 3);
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
  return parseDecimalToBigIntScaled(value, 2);
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

// Formal Persian financial wording only ever combines these three
// native scale words — never an imported term like «تریلیون»/«کوادریلیون».
// Beyond «میلیارد» (10^9), larger magnitudes are expressed compositionally
// the way Iranian financial documents already do (e.g. «هزار میلیارد» for
// 10^12, «میلیون میلیارد» for 10^15), which this function derives instead
// of hardcoding a longer scale-name table.
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

// `groupIndex` counts 3-digit groups from the ones group (0 = ones,
// 1 = thousands, 2 = millions, 3 = billions, ...). Each step of 3 in the
// exponent (E = groupIndex * 3) is covered by combining «هزار» (+3),
// «میلیون» (+6) and repeats of «میلیارد» (+9): k = floor(E / 9) gives the
// number of «میلیارد» repeats and the remainder (0, 3 or 6) picks the
// «هزار»/«میلیون» prefix — e.g. groupIndex 4 (10^12) -> E=12 -> k=1, r=3
// -> "هزار میلیارد", matching how Iranian financial documents already
// name figures beyond a billion instead of borrowing "trillion".
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
    var group = Number(remaining % 1000n); // always 0-999: exact as a plain Number
    if (group) {
      var scaleWord = scaleWordForGroup(groupIndex);
      groups.unshift(threeDigitsToWords(group) + (scaleWord ? " " + scaleWord : ""));
    }
    remaining = remaining / 1000n;
    groupIndex += 1;
  }

  return (neg ? "منفی " : "") + groups.join(" و ") + " ریال";
}
