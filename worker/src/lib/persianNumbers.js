/*
 * Persian/Arabic digit + number-to-words helpers.
 *
 * Single source of truth mirrored from js/persian-numbers.js.
 * All money/quantity/percent math below is BigInt-based (arbitrary-precision
 * integers), never `Number`.
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

const STRICT_UNGROUPED_INT = /^\d+$/;
const STRICT_GROUPED_INT = /^\d{1,3}(?:([,٬\s])\d{3})(?:\1\d{3})*$/;

export function normalizeStrictNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = toAsciiDigits(String(raw).trim());
  if (!text) return "";
  const sign = text.indexOf("-") === 0 ? "-" : "";
  const unsigned = sign ? text.slice(1) : text;
  if (!unsigned) return null;

  let intPart = unsigned;
  let fracPart = "";
  const decimalMatch = unsigned.match(/^([^.٫]*)[.٫](.*)$/);
  if (decimalMatch) {
    intPart = decimalMatch[1];
    fracPart = decimalMatch[2];
    if (intPart.indexOf(".") !== -1 || intPart.indexOf("٫") !== -1 || fracPart.indexOf(".") !== -1 || fracPart.indexOf("٫") !== -1) {
      return null;
    }
  }

  if (fracPart && !/^\d+$/.test(fracPart)) return null;

  let plainInt = intPart;
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

export function parseDecimalToBigIntScaled(value, decimals) {
  const normalized = normalizeStrictNumber(value);
  if (normalized === null || normalized === "") return 0n;
  const match = normalized.match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if (!match) return 0n;

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
    return 0n;
  }
  if (roundDigit >= "5") scaled += 1n;
  return sign * scaled;
}

export function bigRoundDiv(numerator, denominator) {
  if (denominator === 0n) return 0n;
  const negResult = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const result = (2n * n + d) / (2n * d);
  return negResult ? -result : result;
}

export function groupDigits(digitsAscii, sep) {
  return digitsAscii.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

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

export function parsePercentBps(value) {
  const normalized = normalizeStrictNumber(value);
  if (!normalized || !/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  return parseDecimalToBigIntScaled(normalized, 2);
}

export function formatPercentBps(value) {
  const v = value || 0n;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const intPart = abs / 100n;
  const fracPart = abs % 100n;
  let out = intPart.toString();
  if (fracPart !== 0n) {
    let fracStr = fracPart.toString();
    while (fracStr.length < 2) fracStr = "0" + fracStr;
    fracStr = fracStr.replace(/0+$/, "");
    out += DECIMAL_SEP + fracStr;
  }
  return (neg ? "-" : "") + toPersianDigits(out);
}

const ONES = ["", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه",
  "ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده",
  "هفده", "هجده", "نوزده"];
const TENS = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"];
const HUNDREDS = ["", "صد", "دویست", "سیصد", "چهارصد", "پانصد", "ششصد", "هفتصد", "هشتصد", "نهصد"];

export function threeDigitsToWords(value) {
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

export function scaleWordForGroup(groupIndex) {
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
    const group = Number(remaining % 1000n);
    if (group) {
      const scaleWord = scaleWordForGroup(groupIndex);
      groups.unshift(threeDigitsToWords(group) + (scaleWord ? " " + scaleWord : ""));
    }
    remaining = remaining / 1000n;
    groupIndex += 1;
  }

  return (neg ? "منفی " : "") + groups.join(" و ") + " ریال";
}
