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

// Normalizes a user-typed numeric string to ASCII digits with a plain "."
// decimal point and no grouping separators.
export function normalizeNumericInput(value) {
  if (value === null || value === undefined) return "";
  return toAsciiDigits(String(value))
    .replace(/[,\s٬]/g, "")
    .replace(/٫/g, ".");
}

// Parses a numeric string into a BigInt scaled by 10^decimals (e.g.
// decimals=3 turns "2.755" into 2755n), rounding half-up on any digits
// beyond that precision. Returns null when the input isn't a valid number
// (as opposed to 0n for a genuinely empty/zero input).
export function parseDecimalToBigIntScaled(value, decimals) {
  const normalized = normalizeNumericInput(value).replace(/[^0-9.\-]/g, "");
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

export function parseMoneyBig(value) {
  return parseDecimalToBigIntScaled(value, 0);
}

export function formatBigRial(value) {
  const v = value || 0n;
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString();
  return (neg ? "-" : "") + toPersianDigits(groupDigits(digits, GROUP_SEP));
}

// ---------- Quantity (up to 3 decimal places, e.g. weight in tons) ----------

export function parseQtyMilli(value) {
  return parseDecimalToBigIntScaled(value, 3);
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
