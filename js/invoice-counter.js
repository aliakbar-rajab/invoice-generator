/*
 * The per-company daily invoice-number counter (`شماره پیش‌فاکتور`).
 *
 * One document number must never reach two invoices, so exactly one rule
 * governs this file: a day's sequence is a high-water mark that only ever
 * rises. `next` reads it, `commit` raises it, `isIssued` compares against it.
 * Those three questions used to be three functions in js/app.js, each
 * re-deriving the storage key, re-parsing the number format and re-normalizing
 * the legacy record shape before getting to its own one line.
 *
 * The number format `YYYYMMDD-NNN` is parsed and generated here and nowhere
 * else; a format read in one place and written in another is how the two drift.
 *
 * Loaded as a classic <script> tag, so the app keeps working when index.html is
 * opened directly over file://.
 */

var INVOICE_COUNTER_KEY_PREFIX = "pishFaktor.dailySeq.";

/*
 * The storage seam. Defaults to the browser's localStorage; `useCounterStorage`
 * swaps in an in-memory implementation for tests, which is what lets the
 * high-water rule be checked without driving a browser.
 */
var counterStorage = typeof localStorage !== "undefined" ? localStorage : null;

function useCounterStorage(implementation) {
  counterStorage = implementation;
}

/*
 * Every read of a counter record goes through here, so the legacy shape is
 * understood in one place. Records written before per-day tracking held a
 * single `{ day, n }` pair; the current shape carries a `days` map alongside
 * it. Both are read; only the current one is written.
 *
 * Storage can be disabled outright (private mode), and an unreadable record
 * proves nothing about any number — so failure reads as "no history", never as
 * "already used".
 */
function readCounterRecord(profileKey) {
  var empty = { day: "", n: 0, days: {} };
  if (!counterStorage) return empty;
  try {
    var saved = JSON.parse(counterStorage.getItem(INVOICE_COUNTER_KEY_PREFIX + profileKey) || "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return empty;
    var days = {};
    if (saved.days && typeof saved.days === "object" && !Array.isArray(saved.days)) {
      days = Object.assign({}, saved.days);
    } else if (saved.day && typeof saved.n === "number") {
      days[saved.day] = saved.n;
    }
    return { day: saved.day || "", n: typeof saved.n === "number" ? saved.n : 0, days: days };
  } catch (err) {
    return empty;
  }
}

// The highest sequence this profile has ever issued on `day`. Zero means the
// day is untouched, so the next number on it is 1.
function counterHighWater(record, day) {
  if (record.days[day] != null) return record.days[day] || 0;
  if (record.day === day) return record.n || 0;
  return 0;
}

// `YYYYMMDD-N`, in ASCII, or null. The one parser for the number format.
function parseInvoiceNumber(number) {
  var match = toAsciiDigits(number || "").match(/^(\d{8})-(\d+)$/);
  if (!match) return null;
  var sequence = parseInt(match[2], 10);
  if (!sequence) return null;
  return { day: match[1], sequence: sequence };
}

// ...and the one generator, so the two cannot disagree about the padding.
function formatInvoiceNumber(day, sequence) {
  var suffix = String(sequence);
  while (suffix.length < 3) suffix = "0" + suffix;
  return toPersianDigits(day + "-" + suffix);
}

// The next free number for this profile on this day. Reads, never writes: a
// suggestion the user may still discard costs nothing.
function nextInvoiceNumber(profileKey, dayDigits) {
  if (!dayDigits) return "";
  return formatInvoiceNumber(dayDigits, counterHighWater(readCounterRecord(profileKey), dayDigits) + 1);
}

/*
 * Retires a number: after this, `isIssued` reports it as taken. Called when a
 * document is saved or printed — the two moments a number stops being a
 * suggestion. Numbers below the day's mark are already retired, so re-committing
 * one is a no-op rather than a rewind.
 */
function commitInvoiceNumber(profileKey, number) {
  var parsed = parseInvoiceNumber(number);
  if (!parsed) return;
  var record = readCounterRecord(profileKey);
  if (counterHighWater(record, parsed.day) >= parsed.sequence) return;

  var days = Object.assign({}, record.days);
  days[parsed.day] = parsed.sequence;
  // `day`/`n` are kept in step for the benefit of an older build reading this
  // same storage; the `days` map above is what this file actually consults.
  var day = record.day || parsed.day;
  var n = record.day === parsed.day ? Math.max(record.n || 0, parsed.sequence)
    : record.day ? record.n || 0
    : parsed.sequence;

  if (!counterStorage) return;
  try {
    counterStorage.setItem(
      INVOICE_COUNTER_KEY_PREFIX + profileKey,
      JSON.stringify({ day: day, n: n, days: days })
    );
  } catch (err) {
    // Storage can be disabled in private mode. Saving the invoice itself will
    // surface that failure; numbering must not block the editor.
  }
}

// Has this exact number already been retired — i.e. is some document carrying
// it already saved or printed? Used by «ذخیره با نام جدید», which would
// otherwise put an issued number on a second document.
function invoiceNumberIsIssued(profileKey, number) {
  var parsed = parseInvoiceNumber(number);
  if (!parsed) return false;
  return parsed.sequence <= counterHighWater(readCounterRecord(profileKey), parsed.day);
}

// Drops a profile's numbering history, for when the company itself is deleted.
// Leftovers here are harmless, so a refusing storage is simply ignored.
function forgetInvoiceCounter(profileKey) {
  if (!counterStorage) return;
  try {
    counterStorage.removeItem(INVOICE_COUNTER_KEY_PREFIX + profileKey);
  } catch (err) {
    /* numbering leftovers are harmless */
  }
}

var InvoiceCounter = {
  nextInvoiceNumber: nextInvoiceNumber,
  commitInvoiceNumber: commitInvoiceNumber,
  invoiceNumberIsIssued: invoiceNumberIsIssued,
  forgetInvoiceCounter: forgetInvoiceCounter,
  parseInvoiceNumber: parseInvoiceNumber,
  useCounterStorage: useCounterStorage,
};

if (typeof window !== "undefined") window.InvoiceCounter = InvoiceCounter;
if (typeof module !== "undefined" && module.exports) module.exports = InvoiceCounter;
