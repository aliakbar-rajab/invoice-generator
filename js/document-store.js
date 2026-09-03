/*
 * Document Store Module.
 *
 * Encapsulates client-side document persistence, multi-tab optimistic
 * concurrency checks, per-invoice independent storage keys, legacy
 * storage migration, and JSON export/import validation.
 */

var PN = (typeof window !== "undefined" && window.PersianNumbers)
  ? window.PersianNumbers
  : (typeof require === "function" ? require("./persian-numbers.js") : null);

if (!PN) {
  PN = {
    toPersianDigits: function (v) { return String(v || ""); }
  };
}

  var SAVED_LIST_KEY = "preinvoice.saved.v1";
  var SAVED_ENTRY_PREFIX = "preinvoice.saved.entry.v2.";
  var LEGACY_STORAGE_KEY = "preinvoice.autosave.v1";

  var storageWarnings = [];

  function addStorageWarning(message) {
    if (storageWarnings.indexOf(message) === -1) {
      storageWarnings.push(message);
    }
  }

  function getStorageWarnings() {
    return storageWarnings.slice();
  }

  function clearStorageWarnings() {
    storageWarnings = [];
  }

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

  function readLegacySavedList() {
    if (typeof localStorage === "undefined") return {};
    var raw = localStorage.getItem(SAVED_LIST_KEY);
    if (!raw) return {};
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid saved list");
      return parsed;
    } catch (err) {
      addStorageWarning("فهرست قدیمی ذخیره‌ها خراب است؛ برای جلوگیری از حذف اطلاعات دست‌نخورده نگه داشته شد.");
      return {};
    }
  }

  function loadSavedList() {
    var list = {};
    if (typeof localStorage === "undefined") return list;
    try {
      for (var index = 0; index < localStorage.length; index += 1) {
        var key = localStorage.key(index);
        if (!key || key.indexOf(SAVED_ENTRY_PREFIX) !== 0) continue;
        var fallbackId = key.slice(SAVED_ENTRY_PREFIX.length);
        try {
          var entry = normalizeSavedEntry(JSON.parse(localStorage.getItem(key) || "null"), fallbackId);
          if (!entry) throw new Error("Invalid saved entry");
          list[entry.id] = entry;
        } catch (err) {
          addStorageWarning("حداقل یک سند ذخیره‌شده خراب است؛ نسخهٔ خام آن برای بازیابی حذف نشد.");
        }
      }

      // Until migration completes, keep valid legacy entries visible. New v2
      // entries win on id collisions and are stored independently.
      var legacy = readLegacySavedList();
      Object.keys(legacy).forEach(function (id) {
        if (list[id]) return;
        var entry = normalizeSavedEntry(legacy[id], id);
        if (entry) list[entry.id] = entry;
        else addStorageWarning("حداقل یک سند در فهرست قدیمی خراب است و برای بازیابی حذف نشد.");
      });
    } catch (err) {
      addStorageWarning("دسترسی به ذخیره‌های مرورگر ممکن نشد؛ از پشتیبان فایل استفاده کنید.");
    }
    return list;
  }

  function persistSavedEntry(entry) {
    if (typeof localStorage === "undefined") return;
    var normalized = normalizeSavedEntry(entry, entry && entry.id);
    if (!normalized) throw new Error("Invalid saved entry");
    localStorage.setItem(SAVED_ENTRY_PREFIX + normalized.id, JSON.stringify(normalized));
  }

  function removeSavedEntry(id) {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(SAVED_ENTRY_PREFIX + id);
    try {
      var raw = localStorage.getItem(SAVED_LIST_KEY);
      if (raw) {
        var legacy = readLegacySavedList();
        if (legacy && Object.prototype.hasOwnProperty.call(legacy, id)) {
          delete legacy[id];
          if (Object.keys(legacy).length === 0) {
            localStorage.removeItem(SAVED_LIST_KEY);
          } else {
            localStorage.setItem(SAVED_LIST_KEY, JSON.stringify(legacy));
          }
        }
      }
    } catch (err) {
      /* ignore storage cleanup errors */
    }
  }

  function migrateSavedListStorage() {
    if (typeof localStorage === "undefined") return;
    try {
      var raw = localStorage.getItem(SAVED_LIST_KEY);
      if (!raw) return;
      var legacy = readLegacySavedList();
      if (!Object.keys(legacy).length) return;
      Object.keys(legacy).forEach(function (id) {
        var entry = normalizeSavedEntry(legacy[id], id);
        if (!entry) throw new Error("Invalid legacy entry");
        var targetKey = SAVED_ENTRY_PREFIX + entry.id;
        if (!localStorage.getItem(targetKey)) persistSavedEntry(entry);
      });
      // Remove the monolithic source only after every independent entry write succeeds.
      localStorage.removeItem(SAVED_LIST_KEY);
    } catch (err) {
      addStorageWarning("انتقال ذخیره‌های قدیمی کامل نشد؛ نسخهٔ اصلی برای بازیابی حفظ شد.");
    }
  }

  function migrateLegacyAutosave() {
    if (typeof localStorage === "undefined") return;
    try {
      var legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!legacyRaw) return;
      var data = JSON.parse(legacyRaw);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid legacy autosave");
      var id = "inv-legacy-autosave";
      if (!localStorage.getItem(SAVED_ENTRY_PREFIX + id)) {
        persistSavedEntry({ id: id, name: "بازیابی‌شده از نسخهٔ قبلی برنامه", savedAt: Date.now(), data: data });
      }
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (err) {
      addStorageWarning("ذخیرهٔ خودکار نسخهٔ قدیمی خراب است یا منتقل نشد؛ نسخهٔ خام آن حذف نشد.");
    }
  }

  function checkConflict(id, expectedVersion) {
    var list = loadSavedList();
    if (!id || !list[id]) return { conflict: false, exists: false };
    var currentEntry = list[id];
    var conflict = expectedVersion != null && currentEntry.savedAt !== expectedVersion;
    return { conflict: conflict, exists: true, storedEntry: currentEntry };
  }

  function suggestEntryName(data, fallbackLabel) {
    if (data && data.buyer && data.buyer.name) return data.buyer.name;
    if (data && data.meta && data.meta.date) return "پیش‌فاکتور " + data.meta.date;
    return "پیش‌فاکتور " + (fallbackLabel || "");
  }

  function formatSavedTime(ts) {
    try {
      var d = new Date(ts);
      return d.toLocaleDateString("fa-IR") + " — " + d.toLocaleTimeString("fa-IR");
    } catch (err) {
      return "";
    }
  }

  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function invoiceDocumentProblem(data) {
    if (!isPlainObject(data)) return "فایل انتخاب‌شده دادهٔ پیش‌فاکتور معتبر ندارد.";
    if (typeof data.meta !== "undefined" && !isPlainObject(data.meta)) return "بخش مشخصات سربرگ پیش‌فاکتور آسیب دیده است.";
    if (typeof data.company !== "undefined" && !isPlainObject(data.company)) return "بخش مشخصات شرکت پیش‌فاکتور معتبر نیست.";
    if (typeof data.seller !== "undefined" && !isPlainObject(data.seller)) return "بخش اطلاعات فروشنده معتبر نیست.";
    if (typeof data.buyer !== "undefined" && !isPlainObject(data.buyer)) return "بخش اطلاعات خریدار معتبر نیست.";
    if (typeof data.directives !== "undefined" && !isPlainObject(data.directives)) return "تنظیمات پیش‌فاکتور معتبر نیست.";
    if (typeof data.assets !== "undefined" && !isPlainObject(data.assets)) return "بخش نشان‌های پیش‌فاکتور معتبر نیست.";
    if (typeof data.items !== "undefined" && !Array.isArray(data.items)) return "فهرست اقلام پیش‌فاکتور معتبر نیست.";
    if (Array.isArray(data.items)) {
      for (var i = 0; i < data.items.length; i += 1) {
        if (!isPlainObject(data.items[i])) return "حداقل یکی از ردیف‌های پیش‌فاکتور آسیب دیده است.";
      }
    }
    return null;
  }

if (typeof window !== "undefined") {
  window.DocumentStore = {
    SAVED_LIST_KEY: SAVED_LIST_KEY,
    SAVED_ENTRY_PREFIX: SAVED_ENTRY_PREFIX,
    LEGACY_STORAGE_KEY: LEGACY_STORAGE_KEY,
    addStorageWarning: addStorageWarning,
    getStorageWarnings: getStorageWarnings,
    clearStorageWarnings: clearStorageWarnings,
    normalizeSavedEntry: normalizeSavedEntry,
    readLegacySavedList: readLegacySavedList,
    loadSavedList: loadSavedList,
    persistSavedEntry: persistSavedEntry,
    removeSavedEntry: removeSavedEntry,
    migrateSavedListStorage: migrateSavedListStorage,
    migrateLegacyAutosave: migrateLegacyAutosave,
    checkConflict: checkConflict,
    suggestEntryName: suggestEntryName,
    formatSavedTime: formatSavedTime,
    isPlainObject: isPlainObject,
    invoiceDocumentProblem: invoiceDocumentProblem,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SAVED_LIST_KEY: SAVED_LIST_KEY,
    SAVED_ENTRY_PREFIX: SAVED_ENTRY_PREFIX,
    LEGACY_STORAGE_KEY: LEGACY_STORAGE_KEY,
    addStorageWarning: addStorageWarning,
    getStorageWarnings: getStorageWarnings,
    clearStorageWarnings: clearStorageWarnings,
    normalizeSavedEntry: normalizeSavedEntry,
    readLegacySavedList: readLegacySavedList,
    loadSavedList: loadSavedList,
    persistSavedEntry: persistSavedEntry,
    removeSavedEntry: removeSavedEntry,
    migrateSavedListStorage: migrateSavedListStorage,
    migrateLegacyAutosave: migrateLegacyAutosave,
    checkConflict: checkConflict,
    suggestEntryName: suggestEntryName,
    formatSavedTime: formatSavedTime,
    isPlainObject: isPlainObject,
    invoiceDocumentProblem: invoiceDocumentProblem,
  };
}
