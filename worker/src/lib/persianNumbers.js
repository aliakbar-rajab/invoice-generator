/*
 * Persian/Arabic digit + number-to-words helpers.
 *
 * Ported from the desktop invoice app's js/persian-numbers.js (same
 * BigInt-based approach — Rial amounts routinely exceed
 * Number.MAX_SAFE_INTEGER, so every money/quantity value here is exact
 * BigInt arithmetic, never `Number`).
 */

// Both Persian (U+06F0) and Arabic-Indic (U+0660) digit blocks run 0-9 in
// order, so the digit's value is a fixed offset from its code point.
export function toAsciiDigits(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[۰-۹٠-٩]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x0660 && code <= 0x0669 ? code - 0x0660 : code - 0x06f0);
  });
}

export function toPersianDigits(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/[0-9]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 1728))
    .replace(/[٠-٩]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 144));
}

const GROUP_SEP = "٬"; // Arabic thousands separator (matches fa-IR grouping)
const DECIMAL_SEP = "٫"; // Arabic decimal separator (matches fa-IR decimal point)

// An integer part is either bare digits, or 1-3 digits followed by complete
// 3-digit groups joined by ONE consistent separator — "1000", "1,000",
// "1٬000٬000", "1 000 000". Anything else that merely contains a separator
// is not a grouped number.
const STRICT_UNGROUPED_INT = /^\d+$/;
const STRICT_GROUPED_INT = /^\d{1,3}(?:([,٬\s])\d{3})(?:\1\d{3})*$/;

// Normalizes a user-typed numeric string to plain ASCII digits with a "."
// decimal point, or returns null when the text is not a well-formed number.
//
// Grouping separators are stripped only after the grouping they claim to
// express has been verified. Stripping "," / "٬" / spaces unconditionally
// (as this did) turned "2,5" into 25 — and a comma is exactly what many
// keyboards and locales produce for a DECIMAL point, so a quantity typed the
// European way was silently multiplied by ten with no warning at all. What
// the bot itself prints ("۱٬۵۰۰٬۰۰۰", "۲٫۵") still round-trips unchanged.
//
// This mirrors normalizeStrictNumber in the desktop app (js/app.js), where
// the same bug was found and fixed first; the bot never got that fix, so the
// two halves of the same product disagreed about what "2,5" meant.
//
// "" means genuinely empty; null means malformed. Callers must keep those
// apart wherever an empty value has a legitimate meaning of its own.
export function normalizeStrictNumber(value) {
  let raw = toAsciiDigits(String(value == null ? "" : value)).trim().replace(/٫/g, ".");
  if (!raw) return "";
  let sign = "";
  if (raw.charAt(0) === "-") {
    sign = "-";
    raw = raw.slice(1);
  }
  const pieces = raw.split(".");
  if (pieces.length > 2) return null;
  const intPart = pieces[0];
  const fracPart = pieces.length > 1 ? pieces[1] : null;
  const effectiveInt = (!intPart && fracPart !== null) ? "0" : intPart;
  if (!STRICT_UNGROUPED_INT.test(effectiveInt) && !STRICT_GROUPED_INT.test(effectiveInt)) return null;
  // Grouping inside the fractional part is never meaningful ("1.0,5").
  if (fracPart !== null && !/^\d*$/.test(fracPart)) return null;
  return sign + effectiveInt.replace(/[,٬\s]/g, "") + (fracPart === null ? "" : "." + fracPart);
}

// Parses a numeric string into a BigInt scaled by 10^decimals (e.g.
// decimals=3 turns "2.755" into 2755n), rounding half-up on any digits
// beyond that precision. Returns null when the input isn't a valid number
// (as opposed to 0n for a genuinely empty/zero input).
export function parseDecimalToBigIntScaled(value, decimals) {
  const normalized = normalizeStrictNumber(value);
  if (normalized === null) return null;
  const match = normalized.match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if (!match || (!match[2] && !match[3])) return null;

  const sign = match[1] === "-" ? -1n : 1n;
  const intDigits = match[2] || "0";
  const fracDigits = match[3] || "";

  const extended = (fracDigits + "0".repeat(decimals + 1)).slice(0, decimals + 1);
  const keep = extended.slice(0, decimals);
  const roundDigit = extended.charAt(decimals);

  let scaled;
  try {
    scaled = BigInt(intDigits + keep);
  } catch (err) {
    return null;
  }
  if (roundDigit >= "5") scaled += 1n;
  return sign * scaled;
}

// Rounds numerator/denominator to the nearest integer (half-up), entirely
// in BigInt arithmetic so no intermediate float ever touches the value.
export function bigRoundDiv(numerator, denominator) {
  if (denominator === 0n) return 0n;
  const negResult = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const result = (2n * n + d) / (2n * d);
  return negResult ? -result : result;
}

function groupDigits(digitsAscii, sep) {
  let out = "";
  let count = 0;
  for (let i = digitsAscii.length - 1; i >= 0; i -= 1) {
    out = digitsAscii.charAt(i) + out;
    count += 1;
    if (count % 3 === 0 && i !== 0) out = sep + out;
  }
  return out;
}

// ---------- Money (integer Rial, no fractional subunit) ----------

// Rial has no fractional subunit, so an amount carrying a decimal point is
// not a Rial amount — rejected outright rather than quietly rounded, which
// is the rule strictMoney already applies in the desktop app.
export function parseMoneyBig(value) {
  const normalized = normalizeStrictNumber(value);
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  return parseDecimalToBigIntScaled(normalized, 0);
}

export function formatBigRial(value) {
  const v = value || 0n;
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString();
  return (neg ? "-" : "") + toPersianDigits(groupDigits(digits, GROUP_SEP));
}

// ---------- Quantity (up to 3 decimal places, e.g. weight in tons) ----------

// Three decimal places is the precision the printed invoice can actually
// show, so a fourth is rejected rather than rounded away behind the user's
// back — same rule as strictQuantity in the desktop app.
export function parseQtyMilli(value) {
  const normalized = normalizeStrictNumber(value);
  if (!normalized || !/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null;
  return parseDecimalToBigIntScaled(normalized, 3);
}

export function formatQtyMilli(value) {
  const v = value || 0n;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const intPart = abs / 1000n;
  const fracPart = abs % 1000n;
  let out = groupDigits(intPart.toString(), GROUP_SEP);
  if (fracPart !== 0n) {
    let fracStr = fracPart.toString();
    while (fracStr.length < 3) fracStr = "0" + fracStr;
    fracStr = fracStr.replace(/0+$/, "");
    out += DECIMAL_SEP + fracStr;
  }
  return (neg ? "-" : "") + toPersianDigits(out);
}

// ---------- Amount in words ----------

const ONES = ["", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه",
  "ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده",
  "هفده", "هجده", "نوزده"];
const TENS = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"];
const HUNDREDS = ["", "صد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد"];

function threeDigitsToWords(value) {
  const parts = [];
  if (value >= 100) parts.push(HUNDREDS[Math.floor(value / 100)]);
  const remainder = value % 100;
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
  const exponent = groupIndex * 3;
  const billionRepeats = Math.floor(exponent / 9);
  const remainder = exponent % 9;
  const prefix = remainder === 3 ? "هزار" : remainder === 6 ? "میلیون" : "";
  const words = [];
  if (prefix) words.push(prefix);
  for (let i = 0; i < billionRepeats; i += 1) words.push("میلیارد");
  return words.join(" ");
}

export function rialToWordsBig(value) {
  const v = value || 0n;
  if (v === 0n) return "صفر ریال";

  const neg = v < 0n;
  let remaining = neg ? -v : v;
  const groups = [];
  let groupIndex = 0;

  while (remaining > 0n) {
    const group = Number(remaining % 1000n); // always 0-999: exact as a plain Number
    if (group) {
      const scaleWord = scaleWordForGroup(groupIndex);
      groups.unshift(threeDigitsToWords(group) + (scaleWord ? " " + scaleWord : ""));
    }
    remaining = remaining / 1000n;
    groupIndex += 1;
  }

  return (neg ? "منفی " : "") + groups.join(" و ") + " ریال";
}
