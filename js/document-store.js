/*
 * The Document Store (`مخزن اسناد`) — client-side persistence for saved
 * invoices.
 *
 * Everything about how an invoice is stored lives here: the key layout, the
 * two storage migrations, what to do with an entry that will not parse, and
 * the version check that keeps two tabs from silently overwriting each other.
 * Callers deal in entries and ids; nothing above this file names a storage key
 * or a `savedAt` comparison.
 *
 * KEY LAYOUT
 *   preinvoice.saved.entry.v2.<id>   one independent record per invoice
 *   preinvoice.saved.v1              legacy monolithic list, migrated then dropped
 *   preinvoice.autosave.v1           legacy single-slot autosave, migrated then dropped
 *
 * One record per invoice is the whole point of v2: a whole-list snapshot means
 * any save by one tab rewrites every other tab's documents from a stale copy.
 *
 * Loaded as a classic <script> tag, so the app keeps working when index.html is
 * opened directly over file://.
 */

var SAVED_ENTRY_PREFIX = "preinvoice.saved.entry.v2.";
var SAVED_LIST_KEY = "preinvoice.saved.v1";
var LEGACY_AUTOSAVE_KEY = "preinvoice.autosave.v1";

/*
 * The storage seam. Defaults to the browser's localStorage; `useDocumentStorage`
 * swaps in an in-memory implementation, which is what lets the migrations and
 * the conflict rule be tested without driving a browser.
 */
var documentStorage = typeof localStorage !== "undefined" ? localStorage : null;

var storeWarnings = [];
var migrationsRun = false;

function useDocumentStorage(implementation) {
  documentStorage = implementation;
  storeWarnings = [];
  migrationsRun = false;
}

// Append-only and deduped: a storage problem stays on the banner for the rest
// of the session, because nothing that happens later makes it untrue.
function addStoreWarning(message) {
  if (storeWarnings.indexOf(message) === -1) storeWarnings.push(message);
}

function documentStoreWarnings() {
  return storeWarnings.slice();
}

/*
 * The shape of a stored entry, enforced on the way in AND on the way out — a
 * record can be edited by hand, or written by an older build. Returns null for
 * anything that is not a saved document, which is what makes a corrupt entry
 * detectable rather than a source of downstream exceptions.
 *
 * Note this only proves `data` is an object, not that the invoice inside it is
 * sane; applying it is still guarded by the caller.
 */
function normalizeSavedEntry(entry, fallbackId) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return null;
  var id = String(entry.id || fallbackId || "").trim();
  if (!id) return null;
  var savedAt = Number(entry.savedAt);
  return {
    id: id,
    name: String(entry.name || "پیش‌فاکتور بدون نام"),
    savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0,
    data: entry.data,
  };
}

function readLegacyList() {
  if (!documentStorage) return {};
  var raw = null;
  try {
    raw = documentStorage.getItem(SAVED_LIST_KEY);
  } catch (err) {
    return {};
  }
  if (!raw) return {};
  try {
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid saved list");
    return parsed;
  } catch (err) {
    addStoreWarning("فهرست قدیمی ذخیره‌ها خراب است؛ برای جلوگیری از حذف اطلاعات دست‌نخورده نگه داشته شد.");
    return {};
  }
}

function writeEntry(entry) {
  var normalized = normalizeSavedEntry(entry, entry && entry.id);
  if (!normalized) throw new Error("Invalid saved entry");
  documentStorage.setItem(SAVED_ENTRY_PREFIX + normalized.id, JSON.stringify(normalized));
}

/*
 * MIGRATIONS. Both run once, on first access, so no caller can forget them and
 * no caller has to remember their order. Both write the replacement before
 * removing the source: a quota or security failure has to leave the old copy
 * recoverable, never destroy an invoice on the way to a better key layout.
 */
function migrateLegacyList() {
  try {
    if (!documentStorage.getItem(SAVED_LIST_KEY)) return;
    var legacy = readLegacyList();
    if (!Object.keys(legacy).length) return;
    Object.keys(legacy).forEach(function (id) {
      var entry = normalizeSavedEntry(legacy[id], id);
      if (!entry) throw new Error("Invalid legacy entry");
      if (!documentStorage.getItem(SAVED_ENTRY_PREFIX + entry.id)) writeEntry(entry);
    });
    documentStorage.removeItem(SAVED_LIST_KEY);
  } catch (err) {
    addStoreWarning("انتقال ذخیره‌های قدیمی کامل نشد؛ نسخهٔ اصلی برای بازیابی حفظ شد.");
  }
}

// A one-time upgrade path so users who saved under the old single-slot
// autosave don't lose that invoice: it becomes the first named entry.
function migrateLegacyAutosave() {
  try {
    var legacyRaw = documentStorage.getItem(LEGACY_AUTOSAVE_KEY);
    if (!legacyRaw) return;
    var data = JSON.parse(legacyRaw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid legacy autosave");
    var id = "inv-legacy-autosave";
    if (!documentStorage.getItem(SAVED_ENTRY_PREFIX + id)) {
      writeEntry({ id: id, name: "بازیابی‌شده از نسخهٔ قبلی برنامه", savedAt: Date.now(), data: data });
    }
    documentStorage.removeItem(LEGACY_AUTOSAVE_KEY);
  } catch (err) {
    // Keep the source intact. A future session (or a user-created backup) may
    // still be able to recover it once storage becomes available.
    addStoreWarning("ذخیرهٔ خودکار نسخهٔ قدیمی خراب است یا منتقل نشد؛ نسخهٔ خام آن حذف نشد.");
  }
}

function ensureMigrated() {
  if (migrationsRun || !documentStorage) return;
  migrationsRun = true;
  migrateLegacyList();
  migrateLegacyAutosave();
}

/*
 * Every readable document, plus the keys that hold something unreadable.
 *
 * A damaged entry is reported rather than hidden, because the alternative was
 * a permanent banner about a document with no delete button anywhere: the
 * panel filtered it out while the warning list, which is append-only, kept
 * mentioning it. Its raw value is never overwritten — only shown, and only
 * deleted when the user says so.
 */
function listDocuments() {
  ensureMigrated();
  var entries = {};
  var corrupt = [];
  if (!documentStorage) {
    addStoreWarning("دسترسی به ذخیره‌های مرورگر ممکن نشد؛ از پشتیبان فایل استفاده کنید.");
    return { entries: entries, corrupt: corrupt };
  }
  try {
    for (var index = 0; index < documentStorage.length; index += 1) {
      var key = documentStorage.key(index);
      if (!key || key.indexOf(SAVED_ENTRY_PREFIX) !== 0) continue;
      var fallbackId = key.slice(SAVED_ENTRY_PREFIX.length);
      try {
        var entry = normalizeSavedEntry(JSON.parse(documentStorage.getItem(key) || "null"), fallbackId);
        if (!entry) throw new Error("Invalid saved entry");
        entries[entry.id] = entry;
      } catch (err) {
        corrupt.push({ key: key, id: fallbackId });
      }
    }

    // Until migration completes, keep valid legacy entries visible. Independent
    // v2 entries win on id collisions.
    var legacy = readLegacyList();
    Object.keys(legacy).forEach(function (id) {
      if (entries[id]) return;
      var entry = normalizeSavedEntry(legacy[id], id);
      if (entry) entries[entry.id] = entry;
      else addStoreWarning("حداقل یک سند در فهرست قدیمی خراب است و برای بازیابی حذف نشد.");
    });
  } catch (err) {
    addStoreWarning("دسترسی به ذخیره‌های مرورگر ممکن نشد؛ از پشتیبان فایل استفاده کنید.");
  }
  return { entries: entries, corrupt: corrupt };
}

function readDocument(id) {
  var found = listDocuments().entries[id];
  return found || null;
}

/*
 * Has this entry changed underneath us?
 *
 * `expectedVersion` is the `savedAt` the caller last saw — from opening the
 * entry, or from its own last successful save. A stored value that differs
 * means another tab wrote a newer version in between, and overwriting it would
 * discard that tab's work with no trace. Detection belongs here; the question
 * to the user belongs to the caller, which is the only thing that knows how to
 * ask one.
 */
function documentConflict(id, expectedVersion) {
  var stored = listDocuments().entries[id];
  if (!stored) return { exists: false, conflict: false, current: null };
  return {
    exists: true,
    conflict: expectedVersion != null && stored.savedAt !== expectedVersion,
    current: stored,
  };
}

/*
 * Writes one entry and stamps it with the moment it was written, which becomes
 * the version the next conflict check compares against. Only this entry's own
 * key is touched, so a save can never clobber a document another tab created
 * while this one was busy.
 */
function saveDocument(entry) {
  ensureMigrated();
  if (!documentStorage) return { ok: false, savedAt: 0 };
  var savedAt = Date.now();
  try {
    writeEntry({ id: entry.id, name: entry.name, savedAt: savedAt, data: entry.data });
    return { ok: true, savedAt: savedAt };
  } catch (err) {
    return { ok: false, savedAt: 0 };
  }
}

/*
 * Deletes one saved invoice. The legacy list is pruned too when it is still
 * present, so an entry that was only ever visible through the pre-migration
 * path does not come back on the next listing.
 */
function removeDocument(id) {
  ensureMigrated();
  if (!documentStorage) return false;
  try {
    documentStorage.removeItem(SAVED_ENTRY_PREFIX + id);
  } catch (err) {
    return false;
  }
  try {
    if (documentStorage.getItem(SAVED_LIST_KEY)) {
      var legacy = readLegacyList();
      if (Object.prototype.hasOwnProperty.call(legacy, id)) {
        delete legacy[id];
        if (Object.keys(legacy).length === 0) documentStorage.removeItem(SAVED_LIST_KEY);
        else documentStorage.setItem(SAVED_LIST_KEY, JSON.stringify(legacy));
      }
    }
  } catch (err) {
    /* legacy cleanup is best-effort; the entry itself is already gone */
  }
  return true;
}

// Drops an unreadable record by its raw key. Separate from removeDocument
// because there is no entry here to speak of — only a key the listing flagged.
function purgeCorruptDocument(key) {
  if (!documentStorage) return false;
  try {
    documentStorage.removeItem(key);
    return true;
  } catch (err) {
    return false;
  }
}

var DocumentStore = {
  listDocuments: listDocuments,
  readDocument: readDocument,
  documentConflict: documentConflict,
  saveDocument: saveDocument,
  removeDocument: removeDocument,
  purgeCorruptDocument: purgeCorruptDocument,
  documentStoreWarnings: documentStoreWarnings,
  useDocumentStorage: useDocumentStorage,
};

if (typeof window !== "undefined") window.DocumentStore = DocumentStore;
if (typeof module !== "undefined" && module.exports) module.exports = DocumentStore;
