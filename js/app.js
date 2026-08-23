/*
 * Standalone پیش‌فاکتور (pre-invoice) editor.
 *
 * Plain script, no modules/build step, no external dependencies — designed
 * to be opened directly via file:// on office computers (Windows 7 through
 * current), or served from any static host. The invoice sheet's own DOM is
 * treated as the source of truth for row data; a plain JS object is only
 * assembled on demand for Save / Export, and applied back to the DOM on
 * New / Open.
 */

(function () {
  "use strict";

  var ROW_FIELDS = ["description", "quantity", "unit", "unitPrice", "discount"];

  // CSS px per millimetre at the 96dpi CSS reference resolution. Used by the
  // screen-preview scaler and print-page measurements.
  var MM_TO_PX = 96 / 25.4;
  var LEGACY_STORAGE_KEY = "preinvoice.autosave.v1";
  // Legacy monolithic storage is read only for migration/recovery. New saves
  // use one key per invoice so concurrent tabs can never overwrite unrelated
  // entries with a stale whole-list snapshot.
  var SAVED_LIST_KEY = "preinvoice.saved.v1";
  var SAVED_ENTRY_PREFIX = "preinvoice.saved.entry.v2.";
  var CUSTOM_PROFILES_KEY = "preinvoice.companyProfiles.v1";
  var PROFILE_ASSETS_KEY = "preinvoice.profileAssets.v1";
  var PROFILE_OVERRIDES_KEY = "preinvoice.profileOverrides.v1";

  // In-memory id of the saved-list entry currently loaded (null = unsaved/
  // new document). Save updates this entry in place once set; it is reset
  // on New / Open-from-file so those always start a fresh entry on next Save.
  var currentSavedId = null;
  var currentSavedName = "";
  var isDirty = false;
  var validationRequested = false;
  var stampRequested = true;
  var stampAvailable = false;
  var lastProfileKey = null;
  var pendingCompanyLogoData = "";
  var companyEditorMode = "create";
  var companyEditorProfileKey = null;
  // The catch-all «سایر» profile is document-scoped rather than a reusable
  // company identity. Keep its branding outside COMPANY_PROFILES so opening
  // one ad-hoc invoice can never leak its logo or stamp into the next one.
  var adHocCompanyAssets = { logo: "", stamp: "" };
  // Per-invoice branding overrides. `null` means "use the selected company's
  // default"; a data URL means "use this image only on the current document".
  // These values may be saved with the invoice, but never mutate a profile.
  var invoiceAssetOverrides = { logo: null, stamp: null };
  var DEFAULT_INVOICE_ROWS_BY_ORIENTATION = { landscape: 7, portrait: 14 };
  // Only a fresh, untouched document follows the orientation defaults. Once
  // the user edits the item rows, their exact count becomes authoritative.
  var defaultRowCountManaged = false;

  // True while meta.number still holds a live suggestion (set by blankInvoice
  // on New/boot) rather than something the user typed or a value that came in
  // from a saved/opened file. Lets the company-profile switch below re-derive
  // the number under the newly-picked company's own sequence (see SEQ_KEY_
  // PREFIX) without ever clobbering a number the user actually typed.
  var numberIsAutoSuggested = false;
  var dateIsAutoSuggested = false;
  var validityIsAutoSuggested = false;
  var storageWarnings = [];

  var ROW_FIELD_LABELS = {
    description: "شرح کالا یا خدمت",
    quantity: "تعداد یا مقدار",
    unit: "واحد",
    unitPrice: "مبلغ واحد",
    discount: "تخفیف",
  };

  // ---------- Company profiles ----------
  // Add a new profile here and it becomes selectable from the toolbar
  // dropdown (see index.html #company-profile) — nothing else to wire up.
  // `stamp` points at a per-company seal/signature image shipped in assets/
  // (see راهنما.txt). If a profile's file is ever missing, #inv-stamp's
  // `error` handler (wired just below) hides the broken-image icon and the
  // dashed placeholder box is shown instead.
  var CUSTOM_PROFILE_KEY = "other";
  var COMPANY_PROFILES = {
    fouladBonyan: {
      label: "بنیان فولاد داریا",
      logo: "assets/logo-foulad-bonyan-mark.png",
      stamp: "assets/stamp-foulad-bonyan.png",
      name: "بنیان فولاد داریا",
      nationalId: "۱۴۰۱۵۴۸۳۱۸۶",
      address: "تهران، آجودانیه، پورابتهاج، نبش لشکری، ساختمان سرو، واحد ۳۰۳",
      postalCode: "۱۹۷۸۹۷۷۱۹۸",
      phones: "۰۲۱-۸۸۸۸۸۲۸۰ / ۰۲۱-۸۸۸۸۸۷۸۰ / ۰۲۱-۸۸۸۸۸۱۲۲",
      website: "www.fouladbonyan.com",
    },
    karaBorjParseh: {
      label: "کارا برج پارسه",
      logo: "assets/logo-kara-borj-parseh.svg",
      stamp: "assets/stamp-kara-borj-parseh.png",
      name: "کارا برج پارسه",
      nationalId: "۱۴۰۰۷۴۳۲۹۹۹",
      address: "تهران، آجودانیه، پورابتهاج، نبش لشکری، ساختمان سرو، واحد ۳۰۳",
      postalCode: "۱۹۷۸۹۷۷۱۹۸",
      phones: "۰۲۱-۸۸۸۸۸۲۸۰ / ۰۲۱-۸۸۸۸۸۷۸۰ / ۰۲۱-۸۸۸۸۸۱۲۲",
      website: "www.karaborj.com",
    },
    other: {
      label: "سایر",
      logo: "",
      stamp: "",
      name: "",
      nationalId: "",
      address: "",
      postalCode: "",
      phones: "",
      website: "",
    },
  };
  var BUILT_IN_PROFILE_ORDER = ["fouladBonyan", "karaBorjParseh"];
  var DEFAULT_PROFILE_KEY = "fouladBonyan";

  // ---------- Document fonts ----------
  // Keys match the toolbar dropdown's values (see index.html #font-select)
  // and the html[data-font="…"] selectors in invoice.css that actually set
  // --doc-font; this map only has to agree with those two, nothing else.
  var FONT_FAMILIES = {
    parastoo: "پرستو",
    vazirmatn: "وزیرمتن",
    nazanin: "B Nazanin",
    mitra: "B Mitra",
  };
  var DEFAULT_FONT_KEY = "vazirmatn";

  // ---------- Document font size ----------
  // A plain multiplier on --doc-font-scale (see invoice.css), set directly
  // as an inline custom property rather than a data-attribute since it's a
  // continuous percentage, not a fixed enum like the font family above.
  var DEFAULT_FONT_SCALE = 1;

  // ---------- Invoice validity ("اعتبار پیش‌فاکتور") ----------
  // Keys match the header select's values (see index.html #meta-validity-mode).
  // "today"/"tomorrow" resolve to a value the app fills in itself;
  // "manual" leaves the printed field blank for the user to type into.
  var VALID_VALIDITY_MODES = { today: true, tomorrow: true, manual: true };
  var DEFAULT_VALIDITY_MODE = "today";
  var VALIDITY_LABEL_TODAY = "پایان روز جاری";

  var rowTemplate = document.getElementById("row-template");
  var rowsBody = document.getElementById("inv-rows");
  var sheet = document.getElementById("invoice-sheet");
  var statusEl = document.getElementById("toolbar-status");
  var statusDotEl = document.getElementById("status-dot");
  var pageStyleEl = document.getElementById("page-size-style");
  var logoEl = document.getElementById("inv-logo");
  var logoChipEl = logoEl.parentElement;
  var watermarkEl = document.getElementById("inv-watermark");
  var scaleWrapperEl = document.getElementById("sheet-scale-wrapper");
  var stampEl = document.getElementById("inv-stamp");
  var stampAreaEl = stampEl.parentElement;
  var profileSelectEl = document.getElementById("company-profile");
  var validityModeEl = document.getElementById("meta-validity-mode");
  var fontSelectEl = document.getElementById("font-select");
  var fontSizeSelectEl = document.getElementById("font-size-select");
  var zoomValueEl = document.getElementById("zoom-value");
  var zoomOutBtnEl = document.getElementById("btn-zoom-out");
  var zoomInBtnEl = document.getElementById("btn-zoom-in");
  var savedPanelEl = document.getElementById("saved-panel");
  var savedListEl = document.getElementById("saved-list");
  var savedEmptyEl = document.getElementById("saved-empty");
  var savedCountEl = document.getElementById("saved-count");
  var currentDocumentTitleEl = document.getElementById("current-document-title");
  var toolbarPayableEl = document.getElementById("toolbar-payable-total");
  var includeStampEl = document.getElementById("include-stamp");
  var headerGrayToggleEl = document.getElementById("header-gray-toggle");
  var stampUploadFileEl = document.getElementById("stamp-upload-file");
  var temporaryLogoFileEl = document.getElementById("temporary-logo-file");
  var temporaryLogoBtnEl = document.getElementById("btn-temporary-logo");
  var temporaryStampBtnEl = document.getElementById("btn-temporary-stamp");
  var temporaryLogoSettingsBtnEl = document.getElementById("btn-temporary-logo-settings");
  var logoResetBtnEl = document.getElementById("btn-logo-reset");
  var stampResetBtnEl = document.getElementById("btn-stamp-reset");
  var stampUploadPreviewEl = document.getElementById("settings-stamp-preview");
  var stampUploadEmptyEl = document.getElementById("settings-stamp-empty");
  var stampUploadStatusEl = document.getElementById("stamp-upload-status");
  var settingsPanelEl = document.getElementById("settings-panel");
  var settingsBtnEl = document.getElementById("btn-settings");
  var validationEl = document.getElementById("invoice-validation");
  var validationListEl = document.getElementById("invoice-validation-list");
  var printDocumentEl = document.getElementById("print-document");
  var appDialogEl = document.getElementById("app-dialog");
  var dialogTitleEl = document.getElementById("app-dialog-title");
  var dialogMessageEl = document.getElementById("app-dialog-message");
  var dialogDetailsEl = document.getElementById("app-dialog-details");
  var dialogInputWrapEl = document.getElementById("app-dialog-input-wrap");
  var dialogInputEl = document.getElementById("app-dialog-input");
  var dialogActionsEl = document.getElementById("app-dialog-actions");
  var companyEditorDialogEl = document.getElementById("company-editor-dialog");
  var companyEditorFormEl = document.getElementById("company-editor-form");
  var companyEditorTitleEl = document.getElementById("company-editor-title");
  var companyEditorDescriptionEl = document.getElementById("company-editor-description");
  var companyEditorSubmitEl = document.getElementById("btn-company-editor-submit");
  var companyEditorNameEl = document.getElementById("company-editor-name");
  var companyEditorNationalIdEl = document.getElementById("company-editor-national-id");
  var companyEditorPostalCodeEl = document.getElementById("company-editor-postal-code");
  var companyEditorAddressEl = document.getElementById("company-editor-address");
  var companyEditorPhonesEl = document.getElementById("company-editor-phones");
  var companyEditorWebsiteEl = document.getElementById("company-editor-website");
  var companyLogoFileEl = document.getElementById("company-logo-file");
  var companyLogoPreviewEl = document.getElementById("company-logo-preview");
  var companyLogoEmptyEl = document.getElementById("company-logo-empty");
  var companyLogoStatusEl = document.getElementById("company-logo-status");
  var companyEditorErrorEl = document.getElementById("company-editor-error");

  // A failed image load (e.g. a profile added without its stamp file yet)
  // hides the <img> so the empty dashed placeholder box shows instead of a
  // broken-image icon.
  stampEl.addEventListener("error", function () {
    stampAvailable = false;
    stampEl.hidden = true;
    stampAreaEl.classList.remove("has-stamp");
    sheet.classList.remove("stamp-enabled");
    syncStampVisibility();
    refreshStampUploadPreview();
  });
  stampEl.addEventListener("load", function () {
    stampAvailable = true;
    syncStampVisibility();
    refreshStampUploadPreview();
  });

  // Same missing-file safety net as the stamp above: a profile added (or
  // repointed) before its logo asset actually exists should never show a
  // broken-image icon in the header — or on a printed page.
  logoEl.addEventListener("error", function () {
    logoEl.hidden = true;
    logoChipEl.hidden = true;
  });
  stampUploadPreviewEl.addEventListener("error", function () {
    this.hidden = true;
    stampUploadEmptyEl.hidden = false;
  });
  companyLogoPreviewEl.addEventListener("error", function () {
    this.hidden = true;
    companyLogoEmptyEl.hidden = false;
    companyLogoStatusEl.textContent = "نمایش این تصویر ممکن نشد.";
  });

  // ---------- Application dialog ----------

  var activeDialogResolve = null;

  function closeAppDialog(result) {
    if (appDialogEl.hidden) return;
    appDialogEl.hidden = true;
    var resolve = activeDialogResolve;
    activeDialogResolve = null;
    if (resolve) resolve(result || { action: "cancel", value: "" });
  }

  function showAppDialog(options) {
    options = options || {};
    dialogTitleEl.textContent = options.title || "";
    dialogMessageEl.textContent = options.message || "";

    var details = options.details || [];
    dialogDetailsEl.innerHTML = "";
    dialogDetailsEl.hidden = details.length === 0;
    details.forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      dialogDetailsEl.appendChild(li);
    });

    var hasInput = Object.prototype.hasOwnProperty.call(options, "inputValue");
    dialogInputWrapEl.hidden = !hasInput;
    dialogInputEl.value = hasInput ? options.inputValue : "";
    dialogActionsEl.innerHTML = "";

    var actions = options.actions || [
      { id: "ok", label: "تأیید", primary: true },
      { id: "cancel", label: "انصراف" },
    ];

    return new Promise(function (resolve) {
      activeDialogResolve = resolve;
      actions.forEach(function (action) {
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        if (action.primary) button.classList.add("primary");
        if (action.danger) button.classList.add("danger");
        button.addEventListener("click", function () {
          closeAppDialog({ action: action.id, value: dialogInputEl.value.trim() });
        });
        dialogActionsEl.appendChild(button);
      });
      appDialogEl.hidden = false;
      window.setTimeout(function () {
        if (hasInput) {
          dialogInputEl.focus();
          dialogInputEl.select();
        } else {
          var primary = dialogActionsEl.querySelector("button.primary") || dialogActionsEl.querySelector("button");
          if (primary) primary.focus();
        }
      }, 0);
    });
  }

  function confirmApp(title, message, confirmLabel, danger) {
    return showAppDialog({
      title: title,
      message: message,
      actions: [
        { id: "confirm", label: confirmLabel || "تأیید", primary: !danger, danger: !!danger },
        { id: "cancel", label: "انصراف" },
      ],
    }).then(function (result) {
      return result.action === "confirm";
    });
  }

  // ---------- Defaults ----------

  function readStoredObject(key) {
    try {
      var raw = localStorage.getItem(key);
      var parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function profileFromCompanyData(company, userCreated) {
    company = company || {};
    var name = String(company.name || company.label || "").trim();
    return {
      label: name,
      logo: String(company.logo || ""),
      stamp: String(company.stamp || ""),
      name: name,
      nationalId: String(company.nationalId || ""),
      address: String(company.address || ""),
      postalCode: String(company.postalCode || ""),
      phones: String(company.phones || company.phone || ""),
      website: String(company.website || ""),
      userCreated: !!userCreated,
    };
  }

  function persistUserProfiles() {
    var stored = {};
    Object.keys(COMPANY_PROFILES).forEach(function (key) {
      if (COMPANY_PROFILES[key] && COMPANY_PROFILES[key].userCreated) stored[key] = COMPANY_PROFILES[key];
    });
    localStorage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(stored));
  }

  function persistProfileAsset(profileKey, assetName, dataUrl) {
    var overrides = readStoredObject(PROFILE_ASSETS_KEY);
    if (!overrides[profileKey]) overrides[profileKey] = {};
    overrides[profileKey][assetName] = dataUrl;
    localStorage.setItem(PROFILE_ASSETS_KEY, JSON.stringify(overrides));
  }

  function persistProfileDetails(profileKey) {
    var profile = COMPANY_PROFILES[profileKey];
    if (!profile || isCustomProfile(profileKey)) return;
    if (profile.userCreated) {
      persistUserProfiles();
      return;
    }
    var overrides = readStoredObject(PROFILE_OVERRIDES_KEY);
    overrides[profileKey] = {
      label: profile.label,
      name: profile.name,
      nationalId: profile.nationalId,
      address: profile.address,
      postalCode: profile.postalCode,
      phones: profile.phones,
      website: profile.website,
    };
    localStorage.setItem(PROFILE_OVERRIDES_KEY, JSON.stringify(overrides));
  }

  function renderCompanyProfileOptions(selectedKey) {
    var userKeys = Object.keys(COMPANY_PROFILES)
      .filter(function (key) { return COMPANY_PROFILES[key] && COMPANY_PROFILES[key].userCreated; })
      .sort(function (a, b) {
        return COMPANY_PROFILES[a].label.localeCompare(COMPANY_PROFILES[b].label, "fa");
      });
    var keys = BUILT_IN_PROFILE_ORDER.concat(userKeys, [CUSTOM_PROFILE_KEY]);
    profileSelectEl.innerHTML = "";
    keys.forEach(function (key) {
      var profile = COMPANY_PROFILES[key];
      if (!profile) return;
      var option = document.createElement("option");
      option.value = key;
      option.textContent = profile.label || profile.name || "بدون نام";
      profileSelectEl.appendChild(option);
    });
    profileSelectEl.value = COMPANY_PROFILES[selectedKey] ? selectedKey : DEFAULT_PROFILE_KEY;
  }

  function hydrateCompanyProfiles() {
    var storedProfiles = readStoredObject(CUSTOM_PROFILES_KEY);
    Object.keys(storedProfiles).forEach(function (key) {
      if (!/^company-[a-z0-9-]+$/i.test(key)) return;
      var profile = profileFromCompanyData(storedProfiles[key], true);
      if (profile.name) COMPANY_PROFILES[key] = profile;
    });

    var profileOverrides = readStoredObject(PROFILE_OVERRIDES_KEY);
    Object.keys(profileOverrides).forEach(function (key) {
      if (!COMPANY_PROFILES[key] || COMPANY_PROFILES[key].userCreated) return;
      var override = profileOverrides[key] || {};
      ["label", "name", "nationalId", "address", "postalCode", "phones", "website"].forEach(function (field) {
        if (override[field] != null) COMPANY_PROFILES[key][field] = String(override[field]);
      });
    });

    var assetOverrides = readStoredObject(PROFILE_ASSETS_KEY);
    Object.keys(assetOverrides).forEach(function (key) {
      if (!COMPANY_PROFILES[key] || !assetOverrides[key]) return;
      if (assetOverrides[key].logo) COMPANY_PROFILES[key].logo = String(assetOverrides[key].logo);
      if (assetOverrides[key].stamp) COMPANY_PROFILES[key].stamp = String(assetOverrides[key].stamp);
    });
    renderCompanyProfileOptions(DEFAULT_PROFILE_KEY);
  }

  function registerEmbeddedProfile(profileKey, company) {
    if (!profileKey || COMPANY_PROFILES[profileKey] || profileKey === CUSTOM_PROFILE_KEY) return profileKey;
    if (!/^company-[a-z0-9-]+$/i.test(profileKey)) return DEFAULT_PROFILE_KEY;
    var profile = profileFromCompanyData(company, true);
    if (!profile.name) return DEFAULT_PROFILE_KEY;
    COMPANY_PROFILES[profileKey] = profile;
    try {
      persistUserProfiles();
    } catch (err) {
      // The opened invoice remains usable even when browser storage is full.
    }
    renderCompanyProfileOptions(profileKey);
    return profileKey;
  }

  function resolveProfile(key) {
    return COMPANY_PROFILES[key] || COMPANY_PROFILES[DEFAULT_PROFILE_KEY];
  }

  // Today's date on the Persian (Jalali) calendar, formatted to match the
  // date field's own placeholder ("۱۴۰۳/۰۱/۰۱"): Persian digits, zero-padded
  // month/day. Relies on the browser's ICU data (present in Chrome/Edge,
  // this app's target browsers per راهنما.txt); falls back to an empty
  // string — leaving the field blank for manual entry — if unsupported.
  function todayJalaliString() {
    try {
      return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    } catch (err) {
      return "";
    }
  }

  // Tomorrow's date on the Persian calendar. Advances a real Gregorian Date
  // by one day and re-formats it with the same Intl call as todayJalaliString
  // above — letting the browser's own Jalali calendar implementation handle
  // month-length rules (31-day months for the first six, 30 for the next
  // five, 29-or-30-day Esfand) and leap years, rather than reimplementing
  // that arithmetic here.
  function tomorrowJalaliString() {
    try {
      var d = new Date();
      d.setDate(d.getDate() + 1);
      return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
    } catch (err) {
      return "";
    }
  }

  // Reads whatever's actually in the تاریخ field — "1405/06/01", "1405-06-01"
  // and "14050601" (no separator at all) all land here, since this only cares
  // about the 8 digits underneath: 4-digit year + 2-digit month + 2-digit day.
  // Reuses invoiceDateDigits (below) rather than a second ad-hoc regex, so the
  // two places in this file that need "whatever format, just give me the
  // digits" can't quietly drift apart.
  function parseJalaliDateField(value) {
    var digits = invoiceDateDigits(value);
    if (!digits) return null;
    var y = parseInt(digits.slice(0, 4), 10);
    var m = parseInt(digits.slice(4, 6), 10);
    var d = parseInt(digits.slice(6, 8), 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y: y, m: m, d: d };
  }

  function formatJalaliYmd(y, m, d) {
    var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
    return toPersianDigits(y + "/" + pad2(m) + "/" + pad2(d));
  }

  // Converts a Jalali {y,m,d} to the equivalent Gregorian Date, needed only to
  // add a day for "tomorrow" mode (month/year rollover needs real calendar
  // rules). Rather than reimplementing the Jalali leap-year algorithm, this
  // seeds a rough Gregorian estimate (Farvardin 1 of a Jalali year falls on
  // ~March 21 of the Gregorian year 621 later) and then, exactly like
  // tomorrowJalaliString above, defers to the browser's own Intl Jalali
  // calendar to confirm/correct it — searching the ±10 days around the seed
  // for the one whose Persian-calendar formatting matches {y,m,d} exactly.
  // Ten days comfortably covers the seed's worst-case drift (the seed assumes
  // every month is 30 days; real months run 29-31).
  function jalaliPartsToGregorianDate(y, m, d) {
    var monthLenEstimate = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 30];
    var dayOfYear = d;
    for (var i = 0; i < m - 1; i += 1) dayOfYear += monthLenEstimate[i];
    var seed = new Date(y + 621, 2, 21);
    seed.setDate(seed.getDate() + dayOfYear - 1);
    try {
      var fmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "2-digit", day: "2-digit" });
      for (var offset = -10; offset <= 10; offset += 1) {
        var candidate = new Date(seed);
        candidate.setDate(candidate.getDate() + offset);
        var parts = fmt.formatToParts(candidate);
        var py = 0, pm = 0, pd = 0;
        parts.forEach(function (part) {
          var n = parseInt(toAsciiDigits(part.value), 10);
          if (part.type === "year") py = n;
          else if (part.type === "month") pm = n;
          else if (part.type === "day") pd = n;
        });
        if (py === y && pm === m && pd === d) return candidate;
      }
    } catch (err) {
      return null;
    }
    return null;
  }

  // Resolves a validity mode (see VALID_VALIDITY_MODES) to the text that
  // belongs in the printed "اعتبار پیش‌فاکتور" field. "manual" resolves to
  // an empty string — the field is left for the user to type into.
  //
  // "today"/"tomorrow" are relative to the تاریخ field's own value (whatever
  // format it was typed in), not the real-world date — an invoice dated for
  // next week must show a validity that's relative to ITS date, not today's.
  // dateFieldValue defaults to the live DOM value; callers building a
  // not-yet-applied document (blankInvoice) pass the intended date explicitly
  // so this doesn't read the field of whatever document is still on screen.
  function resolveValidityValue(mode, dateFieldValue) {
    if (mode === "manual") return "";
    var reference = parseJalaliDateField(dateFieldValue !== undefined ? dateFieldValue : currentInvoiceDateValue());
    if (mode === "tomorrow") {
      if (reference) {
        var greg = jalaliPartsToGregorianDate(reference.y, reference.m, reference.d);
        if (greg) {
          try {
            var next = new Date(greg);
            next.setDate(next.getDate() + 1);
            var formatted = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(next);
            if (formatted) return formatted;
          } catch (err) {
            // fall through to the real-world fallback below
          }
        }
      }
      return tomorrowJalaliString();
    }
    if (reference) return formatJalaliYmd(reference.y, reference.m, reference.d);
    return todayJalaliString() || VALIDITY_LABEL_TODAY;
  }

  // In "today"/"tomorrow" mode the value field just repeats what the mode
  // select's own option text already says, so it's hidden on screen (see
  // .no-screen in invoice.css) — only "manual" mode needs it visible, since
  // that's the one place left to actually type a date. Print is unaffected:
  // .no-screen only applies under @media screen.
  function syncValidityFieldVisibility(mode) {
    var input = document.querySelector('[data-field="meta.validity"]');
    if (input) input.classList.toggle("no-screen", mode !== "manual");
  }

  // The "مشخصات فروشنده" block mirrors "مشخصات خریدار" field-for-field, but
  // (unlike the buyer, always typed in per invoice) it's meant to come
  // straight from the selected company profile — this is the one place that
  // mapping is defined, shared by blankInvoice/applyCompanyProfile/
  // applyInvoiceData below so it can't drift between them.
  function sellerFromProfile(profile) {
    return {
      name: profile.name,
      nationalId: profile.nationalId,
      address: profile.address,
      postalCode: profile.postalCode,
      phone: profile.phones,
    };
  }

  // Same idea as sellerFromProfile above: the company block's field-for-field
  // mapping from a profile is defined once here so blankInvoice() and
  // applyInvoiceData() can't drift apart on which company fields exist.
  function companyFromProfile(profileKey, profile) {
    return {
      profile: profileKey,
      logo: profile.logo,
      stamp: profile.stamp,
      name: profile.name,
      nationalId: profile.nationalId,
      address: profile.address,
      postalCode: profile.postalCode,
      phones: profile.phones,
      website: profile.website,
    };
  }

  // Reusable profile assets already live in CUSTOM_PROFILES_KEY or
  // PROFILE_ASSETS_KEY. Browser-saved invoices only need the profile key;
  // embedding the same multi-megabyte data URL in every entry quickly fills
  // localStorage. File exports still use collectInvoiceData() directly and
  // therefore remain self-contained for transfer to another computer.
  function dataForBrowserStorage(data) {
    var stored = Object.assign({}, data, {
      company: Object.assign({}, data.company),
    });
    // Built-in defaults already live in the profile. Keep image data only
    // when this particular invoice has an explicit temporary replacement.
    if (!isCustomProfile(stored.company.profile) && !stored.company.logoOverride) delete stored.company.logo;
    if (!isCustomProfile(stored.company.profile) && !stored.company.stampOverride) delete stored.company.stamp;
    return stored;
  }

  function isCustomProfile(profileKey) {
    return profileKey === CUSTOM_PROFILE_KEY;
  }

  function resetAdHocCompanyAssets() {
    adHocCompanyAssets = { logo: "", stamp: "" };
  }

  function resetInvoiceAssetOverrides() {
    invoiceAssetOverrides = { logo: null, stamp: null };
    syncTemporaryAssetControls();
  }

  function baseCompanyAsset(profileKey, assetName) {
    if (isCustomProfile(profileKey)) return String(adHocCompanyAssets[assetName] || "");
    return String(resolveProfile(profileKey)[assetName] || "");
  }

  function effectiveCompanyAsset(profileKey, assetName) {
    var temporary = invoiceAssetOverrides[assetName];
    return temporary == null ? baseCompanyAsset(profileKey, assetName) : String(temporary);
  }

  function syncTemporaryAssetControls() {
    var hasLogoOverride = invoiceAssetOverrides.logo != null;
    var hasStampOverride = invoiceAssetOverrides.stamp != null;
    [temporaryLogoBtnEl, temporaryLogoSettingsBtnEl].forEach(function (button) {
      if (button) button.classList.toggle("is-active", hasLogoOverride);
    });
    if (temporaryStampBtnEl) temporaryStampBtnEl.classList.toggle("is-active", hasStampOverride);
    if (logoResetBtnEl) logoResetBtnEl.disabled = !hasLogoOverride;
    if (stampResetBtnEl) stampResetBtnEl.disabled = !hasStampOverride;
  }

  var SEQ_KEY_PREFIX = "pishFaktor.dailySeq.";

  // Number suggestions are deliberately side-effect free. Merely opening the
  // app, loading a file, or pressing New must never consume an accounting
  // number. The per-company counter advances only when the document is first
  // saved or intentionally printed/finalized (commitInvoiceNumber below).
  function invoiceDateDigits(value) {
    var digits = toAsciiDigits(value || "").replace(/[^0-9]/g, "");
    return /^\d{8}$/.test(digits) ? digits : "";
  }

  function currentInvoiceDateValue() {
    var input = document.querySelector('[data-field="meta.date"]');
    return input ? input.value : "";
  }

  function suggestInvoiceNumber(profileKey, invoiceDate) {
    var datePart = invoiceDateDigits(invoiceDate) || invoiceDateDigits(todayJalaliString());
    if (!datePart) return "";

    var key = SEQ_KEY_PREFIX + (COMPANY_PROFILES[profileKey] ? profileKey : DEFAULT_PROFILE_KEY);
    var next = 1;
    try {
      var saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved && saved.day === datePart) next = (saved.n || 0) + 1;
    } catch (err) {
      next = 1;
    }

    var suffix = String(next);
    while (suffix.length < 3) suffix = "0" + suffix;
    return toPersianDigits(datePart + "-" + suffix);
  }

  function commitInvoiceNumber(profileKey, number) {
    var ascii = toAsciiDigits(number || "");
    var match = ascii.match(/^(\d{8})-(\d+)$/);
    if (!match) return;
    var day = match[1];
    var n = parseInt(match[2], 10);
    if (!n) return;
    var key = SEQ_KEY_PREFIX + (COMPANY_PROFILES[profileKey] ? profileKey : DEFAULT_PROFILE_KEY);
    try {
      var saved = JSON.parse(localStorage.getItem(key) || "null");
      if (!saved || saved.day !== day || (saved.n || 0) < n) {
        localStorage.setItem(key, JSON.stringify({ day: day, n: n }));
      }
    } catch (err) {
      // Storage can be disabled in private mode. Saving the invoice itself
      // will surface that failure; numbering must not block the editor.
    }
  }

  function refreshLiveInvoiceNumber() {
    if (!numberIsAutoSuggested) return false;
    var numberInput = document.querySelector('[data-field="meta.number"]');
    if (!numberInput) return false;
    var latest = suggestInvoiceNumber(profileSelectEl.value, currentInvoiceDateValue());
    if (!latest || latest === numberInput.value) return false;
    numberInput.value = latest;
    fitNumericEl(numberInput);
    updateDocumentIdentity();
    return true;
  }

  // Keeps "اعتبار پیش‌فاکتور" glued to whatever's actually in the تاریخ field
  // whenever mode isn't "manual". In "today"/"tomorrow" mode the value
  // field is always auto (it's hidden from editing — see syncValidityFieldVisibility),
  // so unlike refreshLiveInvoiceNumber above this isn't gated on an
  // IsAutoSuggested flag: there's no hand-typed value in those modes to
  // protect from being overwritten, on a fresh document or one reopened after
  // being saved.
  function refreshValidityFromDate() {
    if (validityModeEl.value === "manual") return false;
    var validityInput = document.querySelector('[data-field="meta.validity"]');
    if (!validityInput) return false;
    var latest = resolveValidityValue(validityModeEl.value);
    if (latest === validityInput.value) return false;
    validityInput.value = latest;
    fitStaticFields();
    updateDocumentIdentity();
    return true;
  }

  // Refresh automatic temporal values as one unit. This is called when the
  // tab regains focus and immediately before Save/Print, so an invoice left
  // open across midnight cannot pair yesterday's date with today's sequence.
  // Manually edited fields are never overwritten.
  function refreshAutomaticTemporalFields(markDirty) {
    var changed = false;
    var dateInput = document.querySelector('[data-field="meta.date"]');
    var validityInput = document.querySelector('[data-field="meta.validity"]');
    var today = todayJalaliString();

    if (dateIsAutoSuggested && dateInput && today && dateInput.value !== today) {
      dateInput.value = today;
      changed = true;
    }
    if (numberIsAutoSuggested && refreshLiveInvoiceNumber()) changed = true;
    if (validityIsAutoSuggested && validityInput && validityModeEl.value !== "manual") {
      var validity = resolveValidityValue(validityModeEl.value);
      if (validityInput.value !== validity) {
        validityInput.value = validity;
        changed = true;
      }
    }

    if (changed) {
      fitStaticFields();
      if (markDirty) {
        isDirty = true;
        setStatus("تاریخ و شمارهٔ خودکار با روز جاری هماهنگ شد؛ تغییرات ذخیره‌نشده");
      } else {
        updateDocumentIdentity();
      }
    }
    return changed;
  }

  function blankInvoice() {
    var profileKey = DEFAULT_PROFILE_KEY;
    var profile = resolveProfile(profileKey);
    var invoiceDate = todayJalaliString();
    return {
      version: 7,
      orientation: "landscape",
      headerGray: true,
      font: DEFAULT_FONT_KEY,
      fontScale: DEFAULT_FONT_SCALE,
      meta: {
        title: "پیش‌فاکتور",
        date: invoiceDate,
        number: suggestInvoiceNumber(profileKey, invoiceDate),
        validityMode: DEFAULT_VALIDITY_MODE,
        validity: resolveValidityValue(DEFAULT_VALIDITY_MODE, invoiceDate),
      },
      buyer: { name: "", nationalId: "", address: "", postalCode: "", phone: "" },
      seller: sellerFromProfile(profile),
      company: companyFromProfile(profileKey, profile),
      taxPercent: "۱۰",
      notes: "",
      includeStamp: true,
      // Seven landscape rows are only the starting point for a new document. From this
      // point onward the user's exact row count is authoritative.
      items: makeBlankRows(defaultInvoiceRowCount("landscape")),
    };
  }

  // Assigns to a [data-field] input if the document still has one. Fields can
  // legitimately disappear from the markup (company.address and company.phones
  // did when the footer became website-only) while staying part of the saved
  // document shape, so a missing element is not an error.
  function setField(name, value) {
    var el = document.querySelector('[data-field="' + name + '"]');
    if (el) el.value = value;
  }

  // Overwrites only the company fields (name/nationalId/address/phones/logo)
  // and the seller-info block with a profile's defaults — buyer, rows and
  // totals are untouched, so switching companies mid-edit is safe and
  // reversible.
  function applyCompanyProfile(profileKey) {
    var profile = resolveProfile(profileKey);
    var key = COMPANY_PROFILES[profileKey] ? profileKey : DEFAULT_PROFILE_KEY;
    resetAdHocCompanyAssets();
    resetInvoiceAssetOverrides();
    var brandingProfile = Object.assign({}, profile, {
      logo: effectiveCompanyAsset(key, "logo"),
      stamp: effectiveCompanyAsset(key, "stamp"),
    });

    document.getElementById("inv-company-name").textContent = profile.name;
    // company.address / company.phones no longer have an input of their own:
    // the footer band is website-only now, and the seller card is where those
    // two are shown and edited. setField tolerates the missing element so the
    // profile data can keep carrying them for sellerFromProfile.
    setField("company.address", profile.address);
    setField("company.phones", profile.phones);
    setField("company.website", profile.website || "");
    var seller = sellerFromProfile(profile);
    document.querySelector('[data-field="seller.name"]').value = seller.name;
    document.querySelector('[data-field="seller.nationalId"]').value = seller.nationalId;
    document.querySelector('[data-field="seller.address"]').value = seller.address;
    document.querySelector('[data-field="seller.postalCode"]').value = seller.postalCode;
    document.querySelector('[data-field="seller.phone"]').value = seller.phone;
    setCompanyBranding(key, brandingProfile);
    profileSelectEl.value = key;
    setStampSrc(brandingProfile.stamp);
    lastProfileKey = key;
    refreshStampUploadPreview();
    // Values were set programmatically (no input events), so re-fit the
    // static fields and refresh the footer's empty-item state directly.
    fitStaticFields();
  }

  // Logo, faint watermark and the per-company color theme (the
  // data-company attribute drives the CSS custom-property theme in
  // invoice.css) always change together — one helper so they can't drift.
  function setCompanyBranding(profileKey, profile) {
    if (profile.logo) {
      logoChipEl.hidden = false;
      logoEl.hidden = false;
      logoEl.setAttribute("src", profile.logo);
      watermarkEl.setAttribute("src", profile.logo);
    } else {
      logoEl.hidden = true;
      logoChipEl.hidden = true;
      logoEl.removeAttribute("src");
      watermarkEl.removeAttribute("src");
    }
    sheet.setAttribute("data-company", COMPANY_PROFILES[profileKey] ? profileKey : DEFAULT_PROFILE_KEY);
  }

  // Unhide before every attempt so a previous load failure never sticks,
  // and hide again on `error` (listener above) so a missing/broken file
  // renders as the empty dashed placeholder box instead of a broken-image
  // icon (especially in print). `has-stamp` on the surrounding box (see
  // invoice.css) suppresses that dashed placeholder border once a stamp is
  // actually showing.
  function syncStampVisibility() {
    var shouldShow = !!(stampRequested && stampAvailable && stampEl.getAttribute("src"));
    stampEl.hidden = !shouldShow;
    stampAreaEl.classList.toggle("has-stamp", shouldShow);
    sheet.classList.toggle("stamp-enabled", shouldShow);
    if (includeStampEl) {
      includeStampEl.checked = !!stampRequested;
      includeStampEl.disabled = !stampAvailable;
    }
  }

  function setStampSrc(src) {
    stampAvailable = false;
    if (!src) {
      stampEl.hidden = true;
      stampEl.removeAttribute("src");
      stampAreaEl.classList.remove("has-stamp");
      sheet.classList.remove("stamp-enabled");
      refreshStampUploadPreview();
      syncStampVisibility();
      return;
    }
    stampEl.setAttribute("src", src);
    if (stampEl.complete && stampEl.naturalWidth) {
      stampAvailable = true;
      syncStampVisibility();
    } else {
      stampEl.hidden = true;
    }
    refreshStampUploadPreview();
  }

  function refreshStampUploadPreview() {
    if (!stampUploadPreviewEl || !stampUploadEmptyEl || !stampUploadStatusEl) return;
    var profileKey = profileSelectEl.value;
    var profile = resolveProfile(profileKey);
    var fallbackStamp = effectiveCompanyAsset(profileKey, "stamp");
    var src = stampEl.getAttribute("src") || fallbackStamp || "";
    if (src) {
      stampUploadPreviewEl.src = src;
      stampUploadPreviewEl.hidden = false;
      stampUploadEmptyEl.hidden = true;
      stampUploadStatusEl.textContent = invoiceAssetOverrides.stamp != null
        ? "مهر موقت فقط برای همین پیش‌فاکتور فعال است."
        : "مهر پیش‌فرض «" + (profile.label || profile.name) + "» فعال است.";
    } else {
      stampUploadPreviewEl.hidden = true;
      stampUploadPreviewEl.removeAttribute("src");
      stampUploadEmptyEl.hidden = false;
      stampUploadStatusEl.textContent = "برای شرکت انتخاب‌شده مهری ثبت نشده است.";
    }
  }

  function applyHeaderGray(enabled) {
    var active = enabled !== false;
    sheet.classList.toggle("header-gray", active);
    if (headerGrayToggleEl) headerGrayToggleEl.checked = active;
  }

  function setCompanyLogoPreview(src, label) {
    pendingCompanyLogoData = src || "";
    if (pendingCompanyLogoData) {
      companyLogoPreviewEl.src = pendingCompanyLogoData;
      companyLogoPreviewEl.hidden = false;
      companyLogoEmptyEl.hidden = true;
      companyLogoStatusEl.textContent = label || "لوگو آمادهٔ ثبت است.";
    } else {
      companyLogoPreviewEl.hidden = true;
      companyLogoPreviewEl.removeAttribute("src");
      companyLogoEmptyEl.hidden = false;
      companyLogoStatusEl.textContent = "PNG، JPG، WebP یا SVG";
    }
  }

  function resizeImageFile(file, maxDimension) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//i.test(file.type || "")) {
        reject(new Error("فایل انتخاب‌شده تصویر معتبر نیست."));
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        reject(new Error("حجم تصویر باید کمتر از ۱۰ مگابایت باشد."));
        return;
      }

      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("خواندن تصویر ممکن نشد.")); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("ساختار تصویر قابل استفاده نیست.")); };
        img.onload = function () {
          try {
            var width = img.naturalWidth || img.width;
            var height = img.naturalHeight || img.height;
            if (!width || !height) {
              reject(new Error("ابعاد تصویر قابل تشخیص نیست."));
              return;
            }
            var scale = Math.min(1, maxDimension / Math.max(width, height));
            var canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            var context = canvas.getContext("2d");
            if (!context) throw new Error("پردازش تصویر در این مرورگر پشتیبانی نمی‌شود.");
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = "high";
            context.drawImage(img, 0, 0, canvas.width, canvas.height);
            var dataUrl = canvas.toDataURL("image/webp", 0.9);
            if (!dataUrl || dataUrl.length > 3.5 * 1024 * 1024) {
              reject(new Error("تصویر پس از بهینه‌سازی هنوز بیش از حد بزرگ است."));
              return;
            }
            resolve(dataUrl);
          } catch (err) {
            reject(new Error(err && err.message ? err.message : "پردازش تصویر ممکن نشد."));
          }
        };
        img.src = String(reader.result || "");
      };
      reader.readAsDataURL(file);
    });
  }

  function closeCompanyEditor() {
    companyEditorDialogEl.hidden = true;
    companyEditorErrorEl.hidden = true;
    companyLogoFileEl.value = "";
  }

  function setCompanyEditorFieldValue(field, value) {
    var nextValue = value == null ? "" : String(value);
    field.defaultValue = nextValue;
    field.value = nextValue;
  }

  function openCompanyEditor(mode) {
    var selectedKey = profileSelectEl.value;
    var editingExisting = mode === "edit" && !isCustomProfile(selectedKey);
    var adHoc = isCustomProfile(selectedKey);
    var profile = resolveProfile(selectedKey);
    companyEditorMode = editingExisting ? "edit" : "create";
    companyEditorProfileKey = editingExisting ? selectedKey : null;
    companyEditorFormEl.reset();
    companyEditorErrorEl.hidden = true;
    if (editingExisting || adHoc) {
      setCompanyEditorFieldValue(companyEditorNameEl, document.getElementById("inv-company-name").textContent.trim());
      setCompanyEditorFieldValue(companyEditorNationalIdEl, document.querySelector('[data-field="seller.nationalId"]').value);
      setCompanyEditorFieldValue(companyEditorPostalCodeEl, document.querySelector('[data-field="seller.postalCode"]').value);
      setCompanyEditorFieldValue(companyEditorAddressEl, document.querySelector('[data-field="seller.address"]').value);
      setCompanyEditorFieldValue(companyEditorPhonesEl, document.querySelector('[data-field="seller.phone"]').value);
      setCompanyEditorFieldValue(companyEditorWebsiteEl, document.querySelector('[data-field="company.website"]').value);
      var currentLogo = adHoc ? adHocCompanyAssets.logo : profile.logo;
      setCompanyLogoPreview(currentLogo, currentLogo ? "لوگوی فعلی شرکت" : "");
    } else {
      [companyEditorNameEl, companyEditorNationalIdEl, companyEditorPostalCodeEl,
        companyEditorAddressEl, companyEditorPhonesEl, companyEditorWebsiteEl]
        .forEach(function (field) { setCompanyEditorFieldValue(field, ""); });
      setCompanyLogoPreview("", "");
    }
    companyEditorTitleEl.textContent = editingExisting ? "ویرایش شرکت فعلی" : "ثبت شرکت جدید";
    companyEditorDescriptionEl.textContent = editingExisting
      ? "تغییرات به‌عنوان مشخصات پایهٔ این شرکت در همین مرورگر ذخیره می‌شود و برای سندهای جدید هم در دسترس است."
      : "اطلاعات این شرکت روی همین مرورگر ذخیره و به فهرست «شرکت صادرکننده» اضافه می‌شود.";
    companyEditorSubmitEl.textContent = editingExisting ? "ذخیرهٔ تغییرات شرکت" : "ثبت و انتخاب شرکت";
    closeSettingsPanel();
    companyEditorDialogEl.hidden = false;
  }

  function saveCompanyProfileFromEditor() {
    var name = companyEditorNameEl.value.trim();
    if (!name) {
      companyEditorErrorEl.textContent = "نام شرکت را وارد کنید.";
      companyEditorErrorEl.hidden = false;
      companyEditorNameEl.focus();
      return false;
    }

    var editingExisting = companyEditorMode === "edit" && COMPANY_PROFILES[companyEditorProfileKey];
    var profileKey = editingExisting
      ? companyEditorProfileKey
      : "company-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    var previousProfile = editingExisting ? Object.assign({}, COMPANY_PROFILES[profileKey]) : null;
    var profile = profileFromCompanyData({
      name: name,
      logo: pendingCompanyLogoData,
      stamp: editingExisting ? previousProfile.stamp : "",
      nationalId: toPersianDigits(companyEditorNationalIdEl.value.trim()),
      address: companyEditorAddressEl.value.trim(),
      postalCode: toPersianDigits(companyEditorPostalCodeEl.value.trim()),
      phones: toPersianDigits(companyEditorPhonesEl.value.trim()),
      website: companyEditorWebsiteEl.value.trim(),
    }, editingExisting ? !!previousProfile.userCreated : true);

    COMPANY_PROFILES[profileKey] = profile;
    try {
      persistProfileDetails(profileKey);
      if (editingExisting && !profile.userCreated && pendingCompanyLogoData !== previousProfile.logo) {
        persistProfileAsset(profileKey, "logo", pendingCompanyLogoData);
      }
    } catch (err) {
      if (previousProfile) COMPANY_PROFILES[profileKey] = previousProfile;
      else delete COMPANY_PROFILES[profileKey];
      companyEditorErrorEl.textContent = "فضای ذخیرهٔ مرورگر کافی نیست؛ تصویر کوچک‌تری انتخاب کنید.";
      companyEditorErrorEl.hidden = false;
      return false;
    }

    renderCompanyProfileOptions(profileKey);
    applyCompanyProfile(profileKey);
    stampRequested = true;
    syncStampVisibility();
    if (numberIsAutoSuggested) {
      var numberInput = document.querySelector('[data-field="meta.number"]');
      if (numberInput) numberInput.value = suggestInvoiceNumber(profileKey, currentInvoiceDateValue());
    }
    isDirty = true;
    setStatus(editingExisting
      ? "مشخصات پایهٔ شرکت «" + profile.label + "» به‌روزرسانی شد."
      : "شرکت «" + profile.label + "» ثبت و انتخاب شد.");
    closeCompanyEditor();
    return true;
  }

  function makeBlankRows(n) {
    var rows = [];
    for (var i = 0; i < n; i += 1) {
      rows.push({ description: "", quantity: "", unit: "", unitPrice: "", discount: "" });
    }
    return rows;
  }

  function defaultInvoiceRowCount(orientation) {
    return orientation === "portrait"
      ? DEFAULT_INVOICE_ROWS_BY_ORIENTATION.portrait
      : DEFAULT_INVOICE_ROWS_BY_ORIENTATION.landscape;
  }

  function syncManagedDefaultRows(nextOrientation) {
    if (!defaultRowCountManaged) return;
    var currentRows = Array.prototype.slice.call(rowsBody.querySelectorAll("tr"));
    var expectedCurrentCount = defaultInvoiceRowCount(currentOrientation());
    if (currentRows.length !== expectedCurrentCount || currentRows.some(function (tr) { return !rowIsBlank(tr); })) {
      defaultRowCountManaged = false;
      return;
    }
    var targetCount = defaultInvoiceRowCount(nextOrientation);
    while (currentRows.length < targetCount) {
      createRow({}, { skipRecalc: true });
      currentRows.push(rowsBody.lastElementChild);
    }
    while (currentRows.length > targetCount) {
      currentRows.pop().remove();
    }
  }

  // ---------- Path helpers ----------

  function getPath(obj, path) {
    return path.split(".").reduce(function (o, k) {
      return o == null ? undefined : o[k];
    }, obj);
  }

  function setPath(obj, path, value) {
    var keys = path.split(".");
    var o = obj;
    for (var i = 0; i < keys.length - 1; i += 1) {
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }

  // ---------- Status ----------

  function updateDocumentIdentity() {
    if (!currentDocumentTitleEl) return;
    var buyer = document.querySelector('[data-field="buyer.name"]');
    var number = document.querySelector('[data-field="meta.number"]');
    var buyerName = buyer ? buyer.value.trim() : "";
    var invoiceNumber = number ? number.value.trim() : "";
    if (currentSavedName) {
      currentDocumentTitleEl.textContent = currentSavedName + (invoiceNumber ? " · " + invoiceNumber : "");
    } else if (buyerName) {
      currentDocumentTitleEl.textContent = buyerName + (invoiceNumber ? " · " + invoiceNumber : "");
    } else {
      currentDocumentTitleEl.textContent = invoiceNumber ? "پیش‌فاکتور " + invoiceNumber : "پیش‌فاکتور جدید";
    }
  }

  function setStatus(text) {
    statusEl.textContent = text;
    if (statusDotEl) {
      statusDotEl.classList.toggle("is-dirty", isDirty);
      statusDotEl.classList.toggle("has-error", calculationErrors.length > 0);
    }
    updateDocumentIdentity();
  }

  function nowLabel() {
    try {
      return new Date().toLocaleTimeString("fa-IR");
    } catch (err) {
      return "";
    }
  }

  // ---------- Orientation ----------

  function currentOrientation() {
    return sheet.classList.contains("orientation-portrait") ? "portrait" : "landscape";
  }

  function setOrientation(name) {
    var normalized = name === "portrait" ? "portrait" : "landscape";
    sheet.classList.remove("orientation-landscape", "orientation-portrait");
    sheet.classList.add("orientation-" + normalized);
    document.getElementById("orientation-landscape").checked = normalized === "landscape";
    document.getElementById("orientation-portrait").checked = normalized === "portrait";
    pageStyleEl.textContent = "@page { size: A4 " + normalized + "; margin: 0; }";
    fitSheetScale();
  }

  // ---------- Screen preview scaling ----------
  //
  // Shrinks the on-screen preview to fit the window's width instead of
  // forcing horizontal scrolling on smaller screens (the old fixed 0.55
  // zoom under 900px). Uses `zoom` on the wrapper (never the sheet itself);
  // print output is guarded against any leftover factor by the
  // `zoom: 1 !important` rule in invoice.css. Sheet width is derived from
  // the A4 dimensions directly (mm → CSS px) rather than measured, so the
  // already-applied zoom can never feed back into the calculation.
  function fitSheetScale() {
    var sheetWidthPx = (currentOrientation() === "landscape" ? 297 : 210) * MM_TO_PX;
    var available = document.documentElement.clientWidth - 32; // viewport padding
    var scale = Math.min(1, available / sheetWidthPx);
    scaleWrapperEl.style.zoom = scale >= 1 ? "" : String(scale);
  }

  // ---------- Document font ----------

  function setFont() {
    // One approved corporate typeface keeps every saved and printed invoice
    // visually consistent. Older files carrying another font are normalized.
    document.documentElement.setAttribute("data-font", DEFAULT_FONT_KEY);
    fontSelectEl.value = DEFAULT_FONT_KEY;
  }

  function setFontScale() {
    document.documentElement.style.setProperty("--doc-font-scale", DEFAULT_FONT_SCALE);
    fontSizeSelectEl.value = String(DEFAULT_FONT_SCALE);
    updateZoomStepperUI();
    return DEFAULT_FONT_SCALE;
  }

  // Keeps the visible zoom stepper (the toolbar's real UI for this control)
  // in sync with the hidden #font-size-select it actually drives — the
  // displayed percentage and the −/+ buttons' disabled-at-the-ends state.
  function updateZoomStepperUI() {
    if (!zoomValueEl) return;
    var idx = fontSizeSelectEl.selectedIndex;
    var pct = Math.round(parseFloat(fontSizeSelectEl.options[idx].value) * 100);
    zoomValueEl.textContent = toPersianDigits(String(pct)) + "٪";
    if (zoomOutBtnEl) zoomOutBtnEl.disabled = idx <= 0;
    if (zoomInBtnEl) zoomInBtnEl.disabled = idx >= fontSizeSelectEl.options.length - 1;
  }

  // Steps the hidden #font-size-select by one preset and dispatches the
  // same "change" event a native select would fire, so the stepper reuses
  // that listener's existing setFontScale/recalcAll/isDirty logic exactly
  // rather than duplicating it here.
  function stepFontSize(delta) {
    var max = fontSizeSelectEl.options.length - 1;
    var idx = fontSizeSelectEl.selectedIndex + delta;
    if (idx < 0) idx = 0;
    if (idx > max) idx = max;
    if (idx === fontSizeSelectEl.selectedIndex) return;
    fontSizeSelectEl.selectedIndex = idx;
    fontSizeSelectEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---------- Numeric auto-fit ----------
  //
  // Large Rial amounts must never clip, overflow their cell, or spill into
  // an adjacent column. Table columns are fixed-width (table-layout: fixed)
  // and the totals column is a flex item with min-width: 0 (see
  // invoice.css), so a value wider than its box is reliably detectable via
  // scrollWidth vs. clientWidth — this shrinks the element's own font-size
  // (never the value's precision or digits) until it fits, or bottoms out
  // at FIT_MIN_SCALE. Applied to every numeric input/output element after
  // each recalculation and on orientation change (column widths differ
  // between landscape/portrait).

  var FIT_MIN_SCALE = 0.82;
  var FIT_STEP = 0.03;

  function autoGrowTextarea(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.max(el.scrollHeight, 18) + "px";
  }

  function autoGrowTextareas() {
    document.querySelectorAll(".inv-autogrow, .inv-textarea, .cell-textarea").forEach(autoGrowTextarea);
  }

  function autoGrowNotes() {
    autoGrowTextarea(document.querySelector(".inv-textarea"));
  }

  // The footer's and amount-words strip's "is this section actually empty"
  // classes — cheap enough to refresh on every recalc, unlike the metrics
  // pass below, since they only read values that are already known.
  function refreshEmptyStates() {
    // The footer band holds nothing but the website, so a profile without one
    // would print as an empty gray strip — mark the band so print drops it
    // (see @media print in invoice.css).
    var footer = document.querySelector(".inv-footer");
    var site = footer && footer.querySelector("input[data-field]");
    if (footer) footer.classList.toggle("is-empty", !(site && site.value.trim()));

    // Same treatment for the amount-in-words strip: on a document with no
    // items it is a label followed by a dash and nothing else.
    var words = document.querySelector(".inv-amount-words");
    var wordsValue = words && words.querySelector("[data-total]");
    if (words) {
      words.classList.toggle(
        "is-empty",
        !(wordsValue && wordsValue.textContent.trim())
      );
    }
  }

  // The actual metrics re-fit: font-size shrink for every static field plus
  // the notes textarea's height. Only needed when something could have
  // changed those fields' rendered widths — orientation changes, loading a
  // document, fonts finishing load, or right before
  // print — never on an ordinary row/tax keystroke, which can't touch any
  // of these fields. recalcAll (below) calls this conditionally and always
  // calls refreshEmptyStates on its own, so callers that only need the
  // metrics pass (like applyCompanyProfile) can still call this directly.
  function fitStaticFields() {
    // Long-form editable prose wraps; it is never reduced to unreadable
    // microtype. Only compact financial figures use fitNumericEl, with a
    // conservative 82% floor.
    autoGrowTextareas();
    refreshEmptyStates();
  }

  // SLACK_PX: Chrome reports scrollWidth = clientWidth + 1 for some RTL
  // inputs even when the content fits comfortably (sub-pixel rounding), and
  // that phantom pixel never goes away no matter how small the font gets —
  // without the tolerance the loop would bottom out at FIT_MIN_SCALE on a
  // value that was never actually overflowing.
  var FIT_SLACK_PX = 1;

  function fitNumericEl(el) {
    el.style.fontSize = "";
    el.classList.remove("numeric-overflow");
    if (!el.isConnected) return true;
    var available = el.clientWidth + FIT_SLACK_PX;
    if (el.clientWidth === 0 || el.scrollWidth <= available) return true;
    var basePx = parseFloat(window.getComputedStyle(el).fontSize);
    if (!basePx) return true;
    var scale = 1;
    while (scale - FIT_STEP >= FIT_MIN_SCALE) {
      scale -= FIT_STEP;
      el.style.fontSize = (basePx * scale).toFixed(2) + "px";
      if (el.scrollWidth <= available) return true;
    }
    el.classList.add("numeric-overflow");
    return false;
  }

  // ---------- Row rendering ----------

  function handleCellKeydown(e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    var field = this.getAttribute("data-row-field");
    var tr = this.closest("tr");
    var rows = Array.prototype.slice.call(rowsBody.querySelectorAll("tr"));
    var idx = rows.indexOf(tr);
    var nextRow = rows[idx + 1];
    if (nextRow) {
      var nextInput = nextRow.querySelector('[data-row-field="' + field + '"]');
      if (nextInput) nextInput.focus();
    } else {
      // Enter on the last row creates the next real editing row and keeps the
      // user in the same column.
      createRow({}, { focusField: field });
    }
  }

  function reformatNumericCell(el, field) {
    if (!el.value.trim()) return;
    if (field === "quantity") {
      var qty = strictQuantity(el.value);
      if (qty.valid) el.value = formatQtyMilli(qty.value);
    } else {
      var amount = strictMoney(el.value, field === "discount");
      if (amount.valid) el.value = amount.value === 0n && field === "discount" ? "" : formatBigRial(amount.value);
    }
    fitNumericEl(el);
  }

  function syncRowAccessibility(tr, rowNumber) {
    var numberLabel = toPersianDigits(rowNumber);
    ROW_FIELDS.forEach(function (field) {
      var input = tr.querySelector('[data-row-field="' + field + '"]');
      if (input) input.setAttribute("aria-label", "ردیف " + numberLabel + " — " + ROW_FIELD_LABELS[field]);
    });
    var deleteButton = tr.querySelector(".row-delete");
    if (deleteButton) deleteButton.setAttribute("aria-label", "حذف ردیف " + numberLabel);
  }

  // opts.focusField keeps keyboard entry in the same column when a row is
  // created through Enter or the inline Add action.
  function createRow(data, opts) {
    data = data || {};
    var frag = rowTemplate.content.cloneNode(true);
    var tr = frag.querySelector("tr");

    ROW_FIELDS.forEach(function (field) {
      var input = tr.querySelector('[data-row-field="' + field + '"]');
      input.value = data[field] || "";
      // A row cell can never change another field's text metrics — only the
      // row/summary figures and the amount-words emptiness — so skip the
      // full static-field refit on every keystroke here.
      input.addEventListener("input", function () {
        defaultRowCountManaged = false;
        livePersianizeDigits(input);
        if (input.classList.contains("cell-textarea")) autoGrowTextarea(input);
        recalcAll({ skipStaticFit: true });
      });
      input.addEventListener("focus", function () {
        this.select();
      });
      input.addEventListener("keydown", handleCellKeydown);
      if (field === "quantity" || field === "unitPrice" || field === "discount") {
        input.addEventListener("blur", function () {
          this.dataset.touched = "true";
          reformatNumericCell(this, field);
          recalcAll({ skipStaticFit: true });
        });
      } else {
        input.addEventListener("blur", function () {
          this.dataset.touched = "true";
          this.value = toPersianDigits(this.value);
          recalcAll({ skipStaticFit: true });
        });
      }
    });

    tr.querySelector(".row-delete").addEventListener("click", async function () {
      if (!rowIsBlank(tr)) {
        var confirmed = await confirmApp("حذف قلم", "این قلم از پیش‌فاکتور حذف شود؟", "حذف", true);
        if (!confirmed) return;
      }
      defaultRowCountManaged = false;
      tr.remove();
      recalcAll();
      isDirty = true;
      setStatus("قلم حذف شد؛ تغییرات ذخیره‌نشده");
    });

    rowsBody.appendChild(tr);
    var addedRow = rowsBody.lastElementChild;
    if (opts && opts.focusField) {
      var toFocus = addedRow.querySelector('[data-row-field="' + opts.focusField + '"]');
      if (toFocus) toFocus.focus();
    }
    // Bulk document loading appends every row first, then performs one
    // calculation/layout pass.
    if (!opts || !opts.skipRecalc) recalcAll();
    return addedRow;
  }

  function addRow() {
    defaultRowCountManaged = false;
    createRow({}, { focusField: "description" });
    isDirty = true;
    setStatus("تغییرات ذخیره‌نشده");
  }

  // ---------- Calculations and validation ----------

  var calculationErrors = [];
  var financialBlockingErrors = [];

  function rowIsBlank(tr) {
    return ROW_FIELDS.every(function (field) {
      var input = tr.querySelector('[data-row-field="' + field + '"]');
      return !input || !input.value.trim();
    });
  }

  function normalizeStrictNumber(value) {
    return toAsciiDigits(String(value == null ? "" : value))
      .trim()
      .replace(/[٬,\s]/g, "")
      .replace(/٫/g, ".");
  }

  function strictMoney(value, emptyAsZero) {
    var normalized = normalizeStrictNumber(value);
    if (!normalized && emptyAsZero) return { valid: true, calculable: true, value: 0n };
    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return { valid: false, calculable: false, value: 0n };
    return {
      valid: /^\d+$/.test(normalized),
      calculable: true,
      value: parseDecimalToBigIntScaled(normalized, 0),
    };
  }

  function strictQuantity(value) {
    var normalized = normalizeStrictNumber(value);
    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return { valid: false, calculable: false, value: 0n };
    var parsed = parseQtyMilli(normalized);
    return {
      valid: /^\d+(?:\.\d{1,3})?$/.test(normalized) && parsed > 0n,
      calculable: true,
      value: parsed,
    };
  }

  function strictPercent(value) {
    var normalized = normalizeStrictNumber(value);
    if (!normalized) return { valid: true, calculable: true, value: 0n };
    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return { valid: false, calculable: false, value: 0n };
    var parsed = parsePercentBps(normalized);
    return {
      valid: /^\d+(?:\.\d{1,2})?$/.test(normalized) && parsed >= 0n && parsed <= 10000n,
      calculable: true,
      value: parsed,
    };
  }

  function clearInlineError(input) {
    var holder = input && (input.closest("td") || input.closest(".inv-field") || input.closest("dd"));
    if (holder) {
      holder.classList.remove("has-error");
      holder.removeAttribute("data-error");
    }
    if (input) input.removeAttribute("aria-invalid");
  }

  function setInlineError(input) {
    if (!input) return;
    clearInlineError(input);
    // Warnings belong in the single banner above the sheet. Keep only the
    // accessibility state on the control; never paint a cell red or inject a
    // message into the invoice itself.
    input.setAttribute("aria-invalid", "true");
  }

  function recalcAll(opts) {
    var rows = rowsBody.querySelectorAll("tr");
    var filledRows = 0;
    var gross = 0n;
    var discountSum = 0n;
    var afterDiscountSum = 0n;
    calculationErrors = [];
    financialBlockingErrors = [];

    rows.forEach(function (tr, rowPosition) {
      var rowNumber = rowPosition + 1;
      syncRowAccessibility(tr, rowNumber);
      var blank = rowIsBlank(tr);
      tr.classList.toggle("is-blank-row", blank);
      tr.classList.remove("has-financial-error");

      var descriptionInput = tr.querySelector('[data-row-field="description"]');
      var qtyInput = tr.querySelector('[data-row-field="quantity"]');
      var priceInput = tr.querySelector('[data-row-field="unitPrice"]');
      var discountInput = tr.querySelector('[data-row-field="discount"]');
      [descriptionInput, qtyInput, priceInput, discountInput].forEach(clearInlineError);

      var totalEl = tr.querySelector('[data-row-computed="total"]');
      var afterDiscountEl = tr.querySelector('[data-row-computed="afterDiscount"]');

      if (blank) {
        tr.querySelector(".row-index-badge").textContent = toPersianDigits(rowNumber);
        totalEl.textContent = "";
        afterDiscountEl.textContent = "";
        return;
      }

      filledRows += 1;
      tr.querySelector(".row-index-badge").textContent = toPersianDigits(rowNumber);

      var rowErrors = [];
      var rowFinancialErrors = [];
      if (!descriptionInput.value.trim()) {
        rowErrors.push("شرح کالا یا خدمت وارد نشده است");
        setInlineError(descriptionInput);
      }

      var qty = strictQuantity(qtyInput.value);
      if (!qty.valid) {
        rowErrors.push("تعداد/مقدار معتبر نیست");
        rowFinancialErrors.push("تعداد/مقدار معتبر نیست");
        setInlineError(qtyInput);
      }

      var price = strictMoney(priceInput.value, false);
      if (!price.valid) {
        rowErrors.push("مبلغ واحد معتبر نیست");
        rowFinancialErrors.push("مبلغ واحد معتبر نیست");
        setInlineError(priceInput);
      }

      var discount = strictMoney(discountInput.value, true);
      if (!discount.valid) {
        rowErrors.push("تخفیف معتبر نیست");
        rowFinancialErrors.push("تخفیف معتبر نیست");
        setInlineError(discountInput);
      }

      var total = 0n;
      if (qty.valid && price.valid) total = bigRoundDiv(qty.value * price.value, 1000n);
      if (discount.valid && qty.valid && price.valid && discount.value > total) {
        rowErrors.push("تخفیف از مبلغ کل ردیف بیشتر است");
        rowFinancialErrors.push("تخفیف از مبلغ کل ردیف بیشتر است");
        setInlineError(discountInput);
      }

      rowErrors.forEach(function (message) {
        calculationErrors.push("ردیف " + toPersianDigits(rowNumber) + ": " + message);
      });
      rowFinancialErrors.forEach(function (message) {
        financialBlockingErrors.push("ردیف " + toPersianDigits(rowNumber) + ": " + message);
      });

      // A missing description is unrelated to the arithmetic. Invalid numeric
      // values are never allowed to alter an authoritative total: an invalid
      // quantity/price excludes this row, while an invalid or excessive
      // discount is neutralized to zero. Healthy rows continue to calculate.
      if (qty.valid && price.valid) {
        var usableDiscount = discount.valid && discount.value <= total ? discount.value : 0n;
        var afterDiscount = total - usableDiscount;
        totalEl.textContent = formatBigRial(total);
        afterDiscountEl.textContent = formatBigRial(afterDiscount);
        gross += total;
        discountSum += usableDiscount;
        afterDiscountSum += afterDiscount;
      } else {
        totalEl.textContent = "";
        afterDiscountEl.textContent = "";
      }

      fitNumericEl(totalEl);
      fitNumericEl(afterDiscountEl);
      fitNumericEl(qtyInput);
      fitNumericEl(priceInput);
      fitNumericEl(discountInput);
    });

    var taxPercentInput = document.querySelector('[data-field="taxPercent"]');
    clearInlineError(taxPercentInput);
    var tax = strictPercent(taxPercentInput.value);
    if (!tax.valid) {
      calculationErrors.push("درصد مالیات باید بین صفر تا صد باشد");
      financialBlockingErrors.push("درصد مالیات باید بین صفر تا صد باشد");
      setInlineError(taxPercentInput);
    }

    var usableTax = tax.valid ? tax.value : 0n;
    var taxTotal = bigRoundDiv(afterDiscountSum * usableTax, 10000n);
    var netTotal = afterDiscountSum + taxTotal;
    var money = function (value) {
      return filledRows ? formatBigRial(value) + " ریال" : "";
    };
    setTotal("grossTotal", money(gross));
    setTotal("discountTotal", money(discountSum));
    setTotal("afterDiscountTotal", money(afterDiscountSum));
    setTotal("taxTotal", money(taxTotal));
    setTotal("netTotal", money(netTotal));
    setTotal("netTotalWords", filledRows ? rialToWordsBig(netTotal) : "");

    // Show calculation warnings as the user types. Output validation may add
    // document-level notes (date, number, parties) to this same banner.
    renderOutputWarnings(calculationErrors);

    if (opts && opts.skipStaticFit) refreshEmptyStates();
    else fitStaticFields();
    updateDocumentIdentity();
    if (statusDotEl) statusDotEl.classList.toggle("has-error", calculationErrors.length > 0);
  }

  function clearStaticValidation() {
    sheet.querySelectorAll(".inv-field.has-error, .inv-meta dd.has-error").forEach(function (holder) {
      holder.classList.remove("has-error");
      holder.removeAttribute("data-error");
    });
  }

  function requireField(selector, message, errors) {
    var input = document.querySelector(selector);
    if (input && !input.value.trim()) errors.push(message);
  }

  function renderOutputWarnings(warnings) {
    var combined = storageWarnings.concat(warnings || []);
    var unique = combined.filter(function (text, index) { return combined.indexOf(text) === index; });
    validationListEl.innerHTML = "";
    unique.forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      validationListEl.appendChild(li);
    });
    validationEl.hidden = unique.length === 0;
    return unique;
  }

  function validateInvoiceForOutput() {
    validationRequested = true;
    clearStaticValidation();
    recalcAll();
    var errors = calculationErrors.slice();
    requireField('[data-field="meta.date"]', "تاریخ پیش‌فاکتور وارد نشده است", errors);
    requireField('[data-field="meta.number"]', "شماره پیش‌فاکتور وارد نشده است", errors);
    requireField('[data-field="seller.name"]', "نام فروشنده وارد نشده است", errors);
    requireField('[data-field="buyer.name"]', "نام خریدار وارد نشده است", errors);
    if (!Array.prototype.some.call(rowsBody.querySelectorAll("tr"), function (tr) { return !rowIsBlank(tr); })) {
      errors.push("حداقل یک قلم کالا یا خدمت وارد کنید");
    }
    if (validityModeEl.value === "manual") {
      requireField('[data-field="meta.validity"]', "تاریخ اعتبار پیش‌فاکتور وارد نشده است", errors);
    }

    return renderOutputWarnings(errors);
  }

  function blockAuthoritativeAction(actionLabel) {
    recalcAll();
    if (financialBlockingErrors.length === 0) return false;
    validationRequested = true;
    renderOutputWarnings(calculationErrors);
    setStatus(actionLabel + " انجام نشد؛ خطاهای مالی را اصلاح کنید.");
    return true;
  }

  function setTotal(key, text) {
    var el = document.querySelector('[data-total="' + key + '"]');
    if (!el) return;
    el.textContent = text;
    if (key === "netTotal" && toolbarPayableEl) toolbarPayableEl.textContent = text || "—";
    // Amount in words has its own compact single-line print treatment in CSS;
    // the numeric fitter assumes tabular figures and must not be applied here.
    if (key !== "netTotalWords") fitNumericEl(el);
  }

  // ---------- Live Persian-digit typing ----------
  //
  // Every text field only swapped Latin digits for Persian ones on blur, so
  // a value being typed showed in Latin digits until the user tabbed away —
  // this runs the same swap on every keystroke instead. toPersianDigits only
  // ever replaces individual digit characters one-for-one, so the string
  // length never changes; restoring the exact caret offset afterwards is
  // therefore safe and keeps the conversion invisible while typing.
  function livePersianizeDigits(el) {
    var converted = toPersianDigits(el.value);
    if (converted === el.value) return;
    var start = el.selectionStart;
    var end = el.selectionEnd;
    el.value = converted;
    if (start !== null && end !== null) el.setSelectionRange(start, end);
  }

  // ---------- Field bindings ----------

  function wireStaticFieldBindings() {
    document.querySelectorAll("[data-field]").forEach(function (el) {
      var field = el.getAttribute("data-field");
      if (field === "taxPercent") {
        // Keep this field's own live shrink-to-fit (it's the one static
        // field a keystroke here could actually overflow), but skip
        // refitting every other unrelated static field on the page.
        el.addEventListener("input", function () {
          livePersianizeDigits(el);
          fitNumericEl(el);
          recalcAll({ skipStaticFit: true });
        });
        el.addEventListener("focus", function () {
          if (this.select) this.select();
        });
        el.addEventListener("blur", function () {
          this.dataset.touched = "true";
          var percent = strictPercent(this.value);
          if (percent.valid) this.value = formatPercentBps(percent.value);
          recalcAll();
        });
      } else {
        if (el.isContentEditable && field === "meta.title") {
          el.addEventListener("keydown", function (event) {
            if (event.key === "Enter") {
              event.preventDefault();
              el.blur();
            }
          });
        }
        el.addEventListener("blur", function () {
          el.dataset.touched = "true";
          if (el.isContentEditable) el.textContent = toPersianDigits(el.textContent);
          else el.value = toPersianDigits(el.value);
          if (field === "meta.date") {
            dateIsAutoSuggested = false;
            if (numberIsAutoSuggested) refreshLiveInvoiceNumber();
            refreshValidityFromDate();
          }
          if (field === "meta.validity") validityIsAutoSuggested = false;
          recalcAll({ skipStaticFit: false });
        });
        if (el.tagName === "INPUT") {
          el.addEventListener("input", function () {
            livePersianizeDigits(el);
            fitNumericEl(el);
            // Once the user has actually typed into the number field, it is
            // no longer a live suggestion — a later company switch must not
            // overwrite whatever they put there.
            if (field === "meta.number") numberIsAutoSuggested = false;
            if (field === "meta.date") dateIsAutoSuggested = false;
            if (field === "meta.validity") validityIsAutoSuggested = false;
            // The footer band is a single website field now; its is-empty
            // state (and the amount-in-words strip's) is derived centrally in
            // fitStaticFields rather than per-item here.
            if (el.closest(".inv-footer")) fitStaticFields();
            updateDocumentIdentity();
          });
        } else if (el.tagName === "TEXTAREA") {
          el.addEventListener("input", function () {
            livePersianizeDigits(el);
            autoGrowTextarea(el);
            updateDocumentIdentity();
          });
        }
      }
    });
  }

  // ---------- Collect / apply document ----------

  function collectInvoiceData() {
    var data = {
      version: 7,
      orientation: currentOrientation(),
      headerGray: sheet.classList.contains("header-gray"),
      font: DEFAULT_FONT_KEY,
      fontScale: DEFAULT_FONT_SCALE,
      meta: {},
      buyer: {},
      seller: {},
      company: {},
      taxPercent: "",
      notes: "",
      includeStamp: !!stampRequested,
      items: [],
    };

    document.querySelectorAll("[data-field]").forEach(function (el) {
      var value = el.isContentEditable ? el.textContent.trim() : el.value;
      setPath(data, el.getAttribute("data-field"), value);
    });

    // A profile supplies defaults, never a lock. Preserve every company and
    // seller edit in this document, regardless of which profile it started
    // from, while still embedding the active branding assets for portability.
    var profileKey = COMPANY_PROFILES[profileSelectEl.value] ? profileSelectEl.value : DEFAULT_PROFILE_KEY;
    var profile = resolveProfile(profileKey);
    var enteredCompany = Object.assign({}, data.company);
    data.company = Object.assign({}, companyFromProfile(profileKey, profile), enteredCompany, {
      profile: profileKey,
      nationalId: data.seller.nationalId || "",
      address: data.seller.address || "",
      postalCode: data.seller.postalCode || "",
      phones: data.seller.phone || "",
    });
    data.company.logo = effectiveCompanyAsset(profileKey, "logo");
    data.company.stamp = effectiveCompanyAsset(profileKey, "stamp");
    data.company.logoOverride = invoiceAssetOverrides.logo != null;
    data.company.stampOverride = invoiceAssetOverrides.stamp != null;
    // meta.validityMode isn't a [data-field] (same as company.profile above)
    // since it's a mode picker, not editable document text.
    data.meta.validityMode = validityModeEl.value;

    rowsBody.querySelectorAll("tr").forEach(function (tr) {
      var row = {};
      ROW_FIELDS.forEach(function (field) {
        row[field] = tr.querySelector('[data-row-field="' + field + '"]').value;
      });
      data.items.push(row);
    });

    return data;
  }

  function applyInvoiceData(raw, options) {
    defaultRowCountManaged = !!(options && options.manageDefaultRows);
    var profileKey = (raw && raw.company && raw.company.profile) || DEFAULT_PROFILE_KEY;
    if (!COMPANY_PROFILES[profileKey]) profileKey = registerEmbeddedProfile(profileKey, raw && raw.company);
    if (!COMPANY_PROFILES[profileKey]) profileKey = DEFAULT_PROFILE_KEY;
    var profile = resolveProfile(profileKey);
    var defaults = blankInvoice();
    // Field-by-field fallback must come from the RESOLVED profile (the one
    // this file was actually saved under), not always the hardcoded default
    // profile — otherwise opening a Kara Borj Parseh file that happens to
    // omit one company field (e.g. an older export) would silently backfill
    // it with Foulad Bonyan's value.
    var profileDefaults = companyFromProfile(profileKey, profile);
    var customProfile = isCustomProfile(profileKey);
    var sellerDefaults = customProfile
      ? { name: "", nationalId: "", address: "", postalCode: "", phone: "" }
      : sellerFromProfile(profile);
    var companyData = Object.assign({}, profileDefaults, raw && raw.company, { profile: profileKey });
    var sellerData = Object.assign({}, sellerDefaults, raw && raw.seller);
    if (!companyData.name) companyData.name = sellerData.name || "";
    if (!sellerData.name) sellerData.name = companyData.name || "";
    var dataOrientation = (raw && raw.orientation) || defaults.orientation;
    var data = {
      orientation: dataOrientation,
      headerGray: raw && raw.headerGray != null ? !!raw.headerGray : defaults.headerGray,
      font: DEFAULT_FONT_KEY,
      fontScale: DEFAULT_FONT_SCALE,
      meta: Object.assign({}, defaults.meta, raw && raw.meta),
      buyer: Object.assign({}, defaults.buyer, raw && raw.buyer),
      seller: sellerData,
      company: companyData,
      taxPercent: raw && raw.taxPercent != null ? raw.taxPercent : defaults.taxPercent,
      notes: raw && raw.notes != null ? raw.notes : defaults.notes,
      includeStamp: raw && raw.includeStamp != null ? !!raw.includeStamp : defaults.includeStamp,
      items: raw && Array.isArray(raw.items)
        ? raw.items.slice()
        : makeBlankRows(defaultInvoiceRowCount(dataOrientation)),
    };

    document.querySelectorAll("[data-field]").forEach(function (el) {
      var value = getPath(data, el.getAttribute("data-field"));
      if (value == null) value = "";
      if (el.isContentEditable) {
        el.textContent = value;
      } else {
        el.value = value;
      }
    });

    validityModeEl.value = VALID_VALIDITY_MODES[data.meta.validityMode]
      ? data.meta.validityMode
      : DEFAULT_VALIDITY_MODE;
    syncValidityFieldVisibility(validityModeEl.value);

    document.getElementById("inv-company-name").textContent = data.company.name || "";
    if (customProfile) {
      adHocCompanyAssets = {
        logo: String(data.company.logo || ""),
        stamp: String(data.company.stamp || ""),
      };
      invoiceAssetOverrides = { logo: null, stamp: null };
    } else {
      resetAdHocCompanyAssets();
      invoiceAssetOverrides = {
        logo: data.company.logoOverride === true
          ? String(data.company.logo || "")
          : (data.company.logoOverride == null && data.company.logo && String(data.company.logo) !== String(profile.logo || "")
            ? String(data.company.logo)
            : null),
        stamp: data.company.stampOverride === true
          ? String(data.company.stamp || "")
          : (data.company.stampOverride == null && data.company.stamp && String(data.company.stamp) !== String(profile.stamp || "")
            ? String(data.company.stamp)
            : null),
      };
    }
    profileSelectEl.value = profileKey;
    var effectiveBranding = Object.assign({}, profile, {
      logo: effectiveCompanyAsset(profileKey, "logo"),
      stamp: effectiveCompanyAsset(profileKey, "stamp"),
    });
    setCompanyBranding(profileKey, effectiveBranding);
    applyHeaderGray(data.headerGray);
    stampRequested = data.includeStamp;
    setStampSrc(effectiveBranding.stamp);
    lastProfileKey = profileKey;
    syncTemporaryAssetControls();
    syncStampVisibility();

    rowsBody.innerHTML = "";
    // Not `data.items.forEach(createRow)`:  Array.prototype.forEach calls its
    // callback as (item, index, array), and createRow's second parameter is
    // an opts object (it reads opts.focusField) — passed directly, the
    // numeric index would land there instead. skipRecalc keeps every item
    // contiguous (see createRow's comment) — recalcAll() below runs once,
    // after all of them are in.
    data.items.forEach(function (row) {
      createRow(row, { skipRecalc: true });
    });
    setOrientation(data.orientation);
    setFont();
    setFontScale();
    validationRequested = false;
    validationEl.hidden = true;
    dateIsAutoSuggested = false;
    validityIsAutoSuggested = false;
    recalcAll();
  }

  // ---------- Saved invoices (named entries in localStorage) ----------
  //
  // Replaces the old single anonymous autosave slot with a visible, named
  // list so it's always clear what is saved and where: every entry has a
  // name and a timestamp, shown in the "ذخیره‌شده‌ها" panel with explicit
  // Open/Delete actions. "ذخیره" updates the currently-loaded entry once one
  // exists (asking for a name only the first time); "جدید" / opening a file
  // from disk detach from that entry so the next Save starts a new one.

  function addStorageWarning(message) {
    if (storageWarnings.indexOf(message) === -1) storageWarnings.push(message);
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
    var normalized = normalizeSavedEntry(entry, entry && entry.id);
    if (!normalized) throw new Error("Invalid saved entry");
    localStorage.setItem(SAVED_ENTRY_PREFIX + normalized.id, JSON.stringify(normalized));
  }

  function removeSavedEntry(id) {
    localStorage.removeItem(SAVED_ENTRY_PREFIX + id);
  }

  function migrateSavedListStorage() {
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
      // Remove the monolithic source only after every independent entry write
      // succeeds. Quota/security failures leave it recoverable and visible.
      localStorage.removeItem(SAVED_LIST_KEY);
    } catch (err) {
      addStorageWarning("انتقال ذخیره‌های قدیمی کامل نشد؛ نسخهٔ اصلی برای بازیابی حفظ شد.");
    }
  }

  // A one-time upgrade path so users who saved under the old single-slot
  // autosave don't lose that invoice: it becomes the first named entry.
  function migrateLegacyAutosave() {
    try {
      var legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!legacyRaw) return;
      var data = JSON.parse(legacyRaw);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid legacy autosave");
      var id = "inv-legacy-autosave";
      if (!localStorage.getItem(SAVED_ENTRY_PREFIX + id)) {
        persistSavedEntry({ id: id, name: "بازیابی‌شده از نسخهٔ قبلی برنامه", savedAt: Date.now(), data: data });
      }
      // Only remove the source after the replacement write has completed.
      // A quota/security failure must leave the legacy invoice recoverable.
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (err) {
      // Keep the source intact. A future session (or a user-created backup)
      // may still be able to recover it once storage becomes available.
      addStorageWarning("ذخیرهٔ خودکار نسخهٔ قدیمی خراب است یا منتقل نشد؛ نسخهٔ خام آن حذف نشد.");
    }
  }

  function suggestEntryName(data) {
    if (data.buyer && data.buyer.name) return data.buyer.name;
    if (data.meta && data.meta.date) return "پیش‌فاکتور " + data.meta.date;
    return "پیش‌فاکتور " + nowLabel();
  }

  function formatSavedTime(ts) {
    try {
      var d = new Date(ts);
      return d.toLocaleDateString("fa-IR") + " — " + d.toLocaleTimeString("fa-IR");
    } catch (err) {
      return "";
    }
  }

  function renderSavedList() {
    var list = loadSavedList();
    var entries = Object.keys(list)
      .map(function (id) {
        return list[id];
      })
      .sort(function (a, b) {
        return b.savedAt - a.savedAt;
      });

    savedCountEl.textContent = toPersianDigits(String(entries.length));
    savedListEl.innerHTML = "";
    savedEmptyEl.hidden = entries.length > 0;

    entries.forEach(function (entry) {
      var li = document.createElement("li");
      if (entry.id === currentSavedId) li.classList.add("is-current");

      var info = document.createElement("div");
      info.className = "saved-item-info";
      var nameEl = document.createElement("span");
      nameEl.className = "saved-item-name";
      nameEl.textContent = entry.name;
      var timeEl = document.createElement("span");
      timeEl.className = "saved-item-time";
      var entryNumber = entry.data && entry.data.meta && entry.data.meta.number ? entry.data.meta.number : "بدون شماره";
      var entryCompanyKey = entry.data && entry.data.company && entry.data.company.profile;
      var entryCompany = isCustomProfile(entryCompanyKey) && entry.data.company.name
        ? entry.data.company.name
        : resolveProfile(entryCompanyKey).label;
      timeEl.textContent = entryNumber + " · " + entryCompany + " · " + formatSavedTime(entry.savedAt) + (entry.id === currentSavedId ? " — در حال ویرایش" : "");
      info.appendChild(nameEl);
      info.appendChild(timeEl);

      var actions = document.createElement("div");
      actions.className = "saved-item-actions";

      var openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "باز کردن";
      openBtn.addEventListener("click", function () {
        openSavedEntry(entry.id);
      });

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "danger";
      deleteBtn.textContent = "حذف";
      deleteBtn.addEventListener("click", function () {
        deleteSavedEntry(entry.id);
      });

      actions.appendChild(openBtn);
      actions.appendChild(deleteBtn);

      li.appendChild(info);
      li.appendChild(actions);
      savedListEl.appendChild(li);
    });
    renderOutputWarnings(calculationErrors);
  }

  async function saveCurrent(forceNew) {
    refreshAutomaticTemporalFields(true);
    if (blockAuthoritativeAction("ذخیره")) return false;
    var list = loadSavedList();
    var data = collectInvoiceData();
    var name;
    var isNewEntry = !!forceNew || !currentSavedId || !list[currentSavedId];

    if (!isNewEntry) {
      name = list[currentSavedId].name;
    } else {
      var suggested = currentSavedName || suggestEntryName(data);
      var result = await showAppDialog({
        title: forceNew ? "ذخیره با نام جدید" : "نام سند",
        message: "نامی انتخاب کنید که بعداً در فهرست ذخیره‌شده‌ها به‌سادگی پیدا شود.",
        inputValue: suggested,
        actions: [
          { id: "save", label: "ذخیره", primary: true },
          { id: "cancel", label: "انصراف" },
        ],
      });
      if (result.action !== "save") return false;
      name = result.value || suggested;
      currentSavedId = "inv-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    }

    try {
      // Another tab may have committed the visible live suggestion while the
      // naming dialog was open. Rebase only untouched suggestions; manually
      // entered and imported numbers remain exactly as authored.
      refreshLiveInvoiceNumber();
      data = collectInvoiceData();
      persistSavedEntry({
        id: currentSavedId,
        name: name,
        savedAt: Date.now(),
        data: dataForBrowserStorage(data),
      });
      // Commit every valid daily-format number, not only untouched automatic
      // suggestions. Manually corrected and file-imported numbers must also
      // advance the counter or the next document can reuse them.
      commitInvoiceNumber(data.company.profile, data.meta.number);
      numberIsAutoSuggested = false;
      dateIsAutoSuggested = false;
      validityIsAutoSuggested = false;
      currentSavedName = name;
      isDirty = false;
      defaultRowCountManaged = false;
      renderSavedList();
      setStatus("ذخیره شد — ساعت " + nowLabel());
      return true;
    } catch (err) {
      setStatus("ذخیره در مرورگر ناموفق بود؛ از «پشتیبان فایل» استفاده کنید.");
      return false;
    }
  }

  async function openSavedEntry(id) {
    var list = loadSavedList();
    var entry = list[id];
    if (!entry) return;
    if (isDirty) {
      var confirmed = await confirmApp("باز کردن سند", "تغییرات ذخیره‌نشده از بین می‌رود. «" + entry.name + "» باز شود؟", "باز کردن");
      if (!confirmed) return;
      entry = loadSavedList()[id];
      if (!entry) {
        renderSavedList();
        setStatus("این سند در برگهٔ دیگری حذف شده است.");
        return;
      }
    }

    applyInvoiceData(entry.data);
    currentSavedId = id;
    currentSavedName = entry.name;
    isDirty = false;
    numberIsAutoSuggested = false;
    setStatus("سند ذخیره‌شده باز شد.");
    closeSavedPanel();
    renderSavedList();
  }

  async function deleteSavedEntry(id) {
    var list = loadSavedList();
    var entry = list[id];
    if (!entry) return;
    var confirmed = await confirmApp("حذف سند", "«" + entry.name + "» حذف شود؟ این کار قابل بازگشت نیست.", "حذف", true);
    if (!confirmed) return;

    try {
      // Delete only this entry's independent key. No whole-list snapshot is
      // written, so saves made by another tab while confirmation was open are
      // preserved.
      removeSavedEntry(id);
    } catch (err) {
      setStatus("حذف سند از ذخیرهٔ مرورگر ناموفق بود.");
      return;
    }
    if (currentSavedId === id) {
      currentSavedId = null;
      currentSavedName = "";
    }

    renderSavedList();
    setStatus("«" + entry.name + "» حذف شد.");
  }

  function openSavedPanel() {
    renderSavedList();
    savedPanelEl.hidden = false;
    document.getElementById("btn-saved-list").setAttribute("aria-expanded", "true");
  }

  function closeSavedPanel() {
    savedPanelEl.hidden = true;
    document.getElementById("btn-saved-list").setAttribute("aria-expanded", "false");
  }

  function toggleSavedPanel() {
    if (savedPanelEl.hidden) {
      openSavedPanel();
    } else {
      closeSavedPanel();
    }
  }

  // ---------- Export / Open from file ----------

  function safeFilenamePart(value) {
    return toAsciiDigits(value || "")
      .replace(/[\\/:*?\"<>|\s]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function exportEditable() {
    var data = collectInvoiceData();
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var companyName = isCustomProfile(data.company.profile) ? data.company.name : resolveProfile(data.company.profile).label;
    var parts = ["پیش-فاکتور", safeFilenamePart(companyName), safeFilenamePart(data.meta.number), safeFilenamePart(data.buyer.name)].filter(Boolean);
    var a = document.createElement("a");
    a.href = url;
    a.download = parts.join("_") + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    setStatus("فایل پشتیبان دانلود شد؛ وضعیت سند همچنان " + (isDirty ? "ذخیره‌نشده است." : "ذخیره است."));
  }

  async function openFromFile(file) {
    if (isDirty) {
      var confirmed = await confirmApp("باز کردن فایل", "تغییرات ذخیره‌نشده از بین می‌رود. فایل «" + file.name + "» باز شود؟", "باز کردن");
      if (!confirmed) return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result));
        applyInvoiceData(data);
        // A file opened from disk isn't yet one of the browser's saved
        // entries — it's detached until the user hits "ذخیره" again, at
        // which point it's saved as a new named entry rather than silently
        // overwriting whatever was last open in the browser.
        currentSavedId = null;
        currentSavedName = "";
        isDirty = false;
        // The number came from the opened file, not a live suggestion —
        // switching companies afterward must not overwrite it.
        numberIsAutoSuggested = false;
        setStatus("فایل «" + file.name + "» بازشد.");
        renderSavedList();
      } catch (err) {
        showAppDialog({ title: "فایل نامعتبر", message: "فایل انتخاب‌شده معتبر نیست یا خراب است.", actions: [{ id: "ok", label: "متوجه شدم", primary: true }] });
      }
    };
    reader.onerror = function () {
      showAppDialog({ title: "خطا در خواندن فایل", message: "خواندن فایل ممکن نشد.", actions: [{ id: "ok", label: "متوجه شدم", primary: true }] });
    };
    reader.readAsText(file, "utf-8");
  }

  // ---------- Print document generation ----------

  function copyLiveValues(source, clone) {
    var sourceFields = source.querySelectorAll("input, textarea, select");
    var cloneFields = clone.querySelectorAll("input, textarea, select");
    sourceFields.forEach(function (field, index) {
      var target = cloneFields[index];
      if (!target) return;
      if (field.type === "checkbox" || field.type === "radio") target.checked = field.checked;
      else target.value = field.value;
    });
  }

  function replaceFormControlsWithText(root) {
    Array.prototype.slice.call(root.querySelectorAll("input, textarea, select")).forEach(function (field) {
      var replacement = field.tagName === "TEXTAREA" ? document.createElement("div") : document.createElement("span");
      replacement.className = field.className + " print-field-value";
      replacement.classList.remove("no-screen");
      replacement.removeAttribute("style");
      if (field.tagName === "SELECT") {
        replacement.textContent = field.options[field.selectedIndex] ? field.options[field.selectedIndex].text : "";
      } else {
        replacement.textContent = field.value || "";
      }
      Array.prototype.slice.call(field.attributes).forEach(function (attr) {
        if (attr.name.indexOf("data-") === 0) replacement.setAttribute(attr.name, attr.value);
      });
      field.replaceWith(replacement);
    });
    root.querySelectorAll("[contenteditable]").forEach(function (el) { el.removeAttribute("contenteditable"); });
  }

  function actualSourceRows() {
    return Array.prototype.filter.call(rowsBody.querySelectorAll("tr"), function (tr) {
      return !rowIsBlank(tr);
    });
  }

  function printableSourceRows() {
    // The editor is the source of truth. Preserve every row, including empty
    // rows and their exact order, because spacing is part of the user's form.
    return Array.prototype.slice.call(rowsBody.querySelectorAll("tr"));
  }

  function makeContinuationHeader(pageNo, totalPages) {
    var profileKey = profileSelectEl.value;
    var profile = Object.assign({}, resolveProfile(profileKey), {
      logo: effectiveCompanyAsset(profileKey, "logo"),
      stamp: effectiveCompanyAsset(profileKey, "stamp"),
    });
    var number = document.querySelector('[data-field="meta.number"]').value;
    var date = document.querySelector('[data-field="meta.date"]').value;
    var header = document.createElement("header");
    header.className = "print-continuation-head";
    header.innerHTML =
      '<div class="print-continuation-brand"><img alt="" /><strong></strong></div>' +
      '<div class="print-continuation-title">ادامهٔ پیش‌فاکتور</div>' +
      '<div class="print-continuation-meta"><div></div><div></div></div>';
    var continuationLogo = header.querySelector("img");
    if (profile.logo) continuationLogo.src = profile.logo;
    else continuationLogo.remove();
    header.querySelector("strong").textContent = document.getElementById("inv-company-name").textContent || profile.label;
    var titleField = document.querySelector('[data-field="meta.title"]');
    var documentTitle = titleField && titleField.textContent.trim() ? titleField.textContent.trim() : "پیش‌فاکتور";
    header.querySelector(".print-continuation-title").textContent = "ادامهٔ " + documentTitle;
    var meta = header.querySelectorAll(".print-continuation-meta div");
    meta[0].textContent = "شماره: " + number;
    meta[1].textContent = "تاریخ: " + date + " · صفحه " + toPersianDigits(pageNo) + " از " + toPersianDigits(totalPages);
    return header;
  }

  function clonePrintPage(rowSources, options) {
    options = options || {};
    var clone = sheet.cloneNode(true);
    copyLiveValues(sheet, clone);
    clone.removeAttribute("id");
    clone.querySelectorAll("[id]").forEach(function (el) { el.removeAttribute("id"); });
    clone.classList.add("print-page");
    clone.classList.toggle("layout-compact", !!options.compact);
    clone.classList.remove("orientation-landscape", "orientation-portrait");
    clone.classList.add("orientation-" + options.orientation);

    var cloneBody = clone.querySelector("tbody");
    cloneBody.innerHTML = "";
    rowSources.forEach(function (sourceRow, index) {
      var rowClone = sourceRow.cloneNode(true);
      copyLiveValues(sourceRow, rowClone);
      rowClone.classList.remove("is-blank-row", "has-financial-error");
      rowClone.querySelector(".row-index-badge").textContent = toPersianDigits((options.startIndex || 0) + index + 1);
      cloneBody.appendChild(rowClone);
    });

    var validation = clone.querySelector(".invoice-validation");
    if (validation) validation.remove();
    var draftNote = clone.querySelector(".inv-stamp-draft-note");
    if (draftNote) draftNote.remove();

    if (options.continuation) {
      var fullHead = clone.querySelector(".inv-head");
      var parties = clone.querySelector(".inv-parties");
      var continuation = makeContinuationHeader(options.pageNo || 1, options.totalPages || 1);
      if (fullHead) fullHead.replaceWith(continuation);
      if (parties) parties.remove();
    }

    if (!options.finalPage) {
      [".inv-amount-words", ".inv-summary", ".inv-footer"].forEach(function (selector) {
        var el = clone.querySelector(selector);
        if (el) el.remove();
      });
      var marker = document.createElement("div");
      marker.className = "print-page-marker";
      marker.textContent = "ادامه در صفحهٔ بعد · پیش‌فاکتور " + document.querySelector('[data-field="meta.number"]').value;
      clone.appendChild(marker);
    }

    replaceFormControlsWithText(clone);
    clone.querySelectorAll(".has-error").forEach(function (el) {
      el.classList.remove("has-error");
      el.removeAttribute("data-error");
    });
    if (!stampRequested) {
      var clonedStamp = clone.querySelector(".inv-signature-stamp");
      if (clonedStamp) clonedStamp.remove();
      clone.classList.remove("stamp-enabled");
    }

    if ((options.totalPages || 1) > 1) {
      var pageNumber = document.createElement("span");
      pageNumber.className = "print-page-number";
      pageNumber.textContent = "صفحه " + toPersianDigits(options.pageNo || 1) + " از " + toPersianDigits(options.totalPages || 1);
      clone.appendChild(pageNumber);
    }
    return clone;
  }

  function pageFits(page) {
    printDocumentEl.innerHTML = "";
    printDocumentEl.classList.add("is-measuring");
    printDocumentEl.appendChild(page);
    void page.offsetHeight;
    var fits = page.scrollHeight <= page.clientHeight + 2;
    printDocumentEl.innerHTML = "";
    printDocumentEl.classList.remove("is-measuring");
    return fits;
  }

  function singlePageFits(rows, orientation, compact) {
    return pageFits(clonePrintPage(rows, {
      orientation: orientation,
      compact: compact,
      finalPage: true,
      pageNo: 1,
      totalPages: 1,
    }));
  }

  function maxFittingPrefix(rows, options) {
    var count = 0;
    for (var i = 1; i <= rows.length; i += 1) {
      var candidate = clonePrintPage(rows.slice(0, i), options);
      if (!pageFits(candidate)) break;
      count = i;
    }
    return count;
  }

  function maxFittingSuffix(rows, options) {
    var count = 0;
    for (var i = 1; i <= rows.length; i += 1) {
      var candidate = clonePrintPage(rows.slice(rows.length - i), options);
      if (!pageFits(candidate)) break;
      count = i;
    }
    return count;
  }

  function buildPrintPlan(rows, orientation) {
    if (singlePageFits(rows, orientation, false)) {
      return { compact: false, chunks: [rows], orientation: orientation };
    }
    if (singlePageFits(rows, orientation, true)) {
      return { compact: true, chunks: [rows], orientation: orientation };
    }

    var compact = true;
    var finalCount = maxFittingSuffix(rows, {
      orientation: orientation,
      compact: compact,
      continuation: true,
      finalPage: true,
      pageNo: 2,
      totalPages: 2,
    });
    if (rows.length && finalCount === 0) {
      return {
        compact: compact,
        chunks: [],
        orientation: orientation,
        overflowRowIndex: rows.length - 1,
        overflowKind: "final-page",
      };
    }
    // Do not crowd the final page while leaving the first half empty. If two
    // balanced halves both fit their respective page structures, prefer that
    // distribution; for very large documents the normal greedy loop below
    // still creates as many continuation pages as required.
    var firstCapacity = maxFittingPrefix(rows, {
      orientation: orientation,
      compact: compact,
      continuation: false,
      finalPage: false,
      pageNo: 1,
      totalPages: 2,
    });
    var balancedFinal = Math.min(finalCount, Math.ceil(rows.length / 2));
    if (rows.length - balancedFinal <= firstCapacity) finalCount = balancedFinal;
    finalCount = Math.min(finalCount, Math.max(1, rows.length - 1));
    var remaining = rows.slice(0, rows.length - finalCount);
    var finalRows = rows.slice(rows.length - finalCount);
    var chunks = [];
    var first = true;
    var startIndex = 0;

    while (remaining.length) {
      var capacity = maxFittingPrefix(remaining, {
        orientation: orientation,
        compact: compact,
        continuation: !first,
        finalPage: false,
        startIndex: startIndex,
        pageNo: chunks.length + 1,
        totalPages: 2,
      });
      if (capacity === 0) {
        return {
          compact: compact,
          chunks: [],
          orientation: orientation,
          overflowRowIndex: startIndex,
          overflowKind: "row",
        };
      }
      var chunk = remaining.slice(0, capacity);
      chunks.push(chunk);
      remaining = remaining.slice(capacity);
      startIndex += chunk.length;
      first = false;
    }
    chunks.push(finalRows);
    return { compact: compact, chunks: chunks, orientation: orientation };
  }

  // Rebuild and measure the exact final page structures (including real page
  // numbers and continuation headers) before opening the browser print UI.
  // This is the last safety net against CSS/rounding drift after planning.
  function verifyPrintPlanFits(plan) {
    var totalPages = plan.chunks.length;
    var startIndex = 0;
    for (var index = 0; index < totalPages; index += 1) {
      var chunk = plan.chunks[index];
      var page = clonePrintPage(chunk, {
        orientation: plan.orientation,
        compact: plan.compact,
        continuation: index > 0,
        finalPage: index === totalPages - 1,
        startIndex: startIndex,
        pageNo: index + 1,
        totalPages: totalPages,
      });
      startIndex += chunk.length;
      if (!pageFits(page)) return { fits: false, pageNo: index + 1 };
    }
    return { fits: true, pageNo: null };
  }

  function renderPrintPlan(plan) {
    printDocumentEl.innerHTML = "";
    var totalPages = plan.chunks.length;
    var startIndex = 0;
    plan.chunks.forEach(function (chunk, index) {
      var page = clonePrintPage(chunk, {
        orientation: plan.orientation,
        compact: plan.compact,
        continuation: index > 0,
        finalPage: index === totalPages - 1,
        startIndex: startIndex,
        pageNo: index + 1,
        totalPages: totalPages,
      });
      startIndex += chunk.length;
      printDocumentEl.appendChild(page);
    });
    document.body.classList.add("print-mode");
    printDocumentEl.setAttribute("aria-hidden", "false");
    return totalPages;
  }

  function cleanupPrintDocument() {
    document.body.classList.remove("print-mode");
    printDocumentEl.classList.remove("is-measuring");
    printDocumentEl.innerHTML = "";
    printDocumentEl.setAttribute("aria-hidden", "true");
  }

  async function printInvoice() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    refreshAutomaticTemporalFields(true);
    recalcAll();
    var warnings = validateInvoiceForOutput();
    if (financialBlockingErrors.length) {
      setStatus("چاپ انجام نشد؛ خطاهای مالی را اصلاح کنید.");
      return false;
    }

    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    autoGrowTextareas();
    var rows = printableSourceRows();
    var orientation = currentOrientation();

    // Portrait columns are intentionally narrower. Switch automatically when
    // necessary; printing must never wait for an application dialog.
    if (orientation === "portrait" && sheet.querySelector(".inv-table .numeric-overflow, .inv-totals .numeric-overflow")) {
      setOrientation("landscape");
      recalcAll();
      orientation = "landscape";
      isDirty = true;
      setStatus("جهت چاپ برای خوانایی مبالغ افقی شد؛ تغییرات ذخیره‌نشده");
      warnings.push("برای خوانایی مبالغ، جهت چاپ به‌صورت خودکار افقی شد");
    }
    if (sheet.querySelector(".inv-table .numeric-overflow, .inv-totals .numeric-overflow")) {
      warnings.push("حداقل یکی از مبالغ بسیار طولانی است؛ مقدار آن را بررسی کنید");
    }

    var plan = buildPrintPlan(rows, orientation);
    if (plan.overflowRowIndex != null) {
      warnings.push(
        "ردیف " + toPersianDigits(plan.overflowRowIndex + 1) +
        " بلندتر از ظرفیت یک صفحهٔ A4 است؛ برای جلوگیری از حذف محتوا، چاپ متوقف شد. شرح را کوتاه‌تر یا به چند ردیف تقسیم کنید"
      );
      renderOutputWarnings(warnings);
      cleanupPrintDocument();
      setStatus("چاپ انجام نشد؛ یک ردیف در صفحهٔ A4 جا نمی‌شود.");
      return false;
    }
    var fitVerification = verifyPrintPlanFits(plan);
    if (!fitVerification.fits) {
      warnings.push(
        "صفحهٔ " + toPersianDigits(fitVerification.pageNo) +
        " در محدودهٔ A4 جا نمی‌شود؛ برای جلوگیری از حذف محتوا، چاپ متوقف شد"
      );
      renderOutputWarnings(warnings);
      cleanupPrintDocument();
      setStatus("چاپ انجام نشد؛ چیدمان نهایی از محدودهٔ A4 بیرون می‌زند.");
      return false;
    }
    if (plan.chunks.length > 1) warnings.push("این پیش‌فاکتور در " + toPersianDigits(plan.chunks.length) + " صفحه چاپ می‌شود");
    renderOutputWarnings(warnings);

    renderPrintPlan(plan);
    var data = collectInvoiceData();
    commitInvoiceNumber(data.company.profile, data.meta.number);
    numberIsAutoSuggested = false;
    dateIsAutoSuggested = false;
    validityIsAutoSuggested = false;

    var oldTitle = document.title;
    var dataForName = collectInvoiceData();
    document.title = [
      "پیش‌فاکتور",
      safeFilenamePart(dataForName.meta.number),
      safeFilenamePart(dataForName.buyer.name || dataForName.company.name || resolveProfile(dataForName.company.profile).label),
    ].filter(Boolean).join("_");
    window.setTimeout(function () {
      window.print();
      document.title = oldTitle;
    }, 0);
    return true;
  }

  window.addEventListener("afterprint", cleanupPrintDocument);

  // ---------- Wire up toolbar ----------

  function hasMeaningfulInvoiceData() {
    var buyer = document.querySelector('[data-field="buyer.name"]');
    return !!((buyer && buyer.value.trim()) || actualSourceRows().length);
  }

  function closeSettingsPanel() {
    settingsPanelEl.hidden = true;
    settingsBtnEl.setAttribute("aria-expanded", "false");
  }

  function toggleSettingsPanel() {
    settingsPanelEl.hidden = !settingsPanelEl.hidden;
    settingsBtnEl.setAttribute("aria-expanded", settingsPanelEl.hidden ? "false" : "true");
    if (!settingsPanelEl.hidden) closeSavedPanel();
  }

  async function applyTemporaryLogoFile(file) {
    if (!file) return;
    var previousLogo = invoiceAssetOverrides.logo;
    try {
      var dataUrl = await resizeImageFile(file, 720);
      invoiceAssetOverrides.logo = dataUrl;
      setCompanyBranding(profileSelectEl.value, Object.assign({}, resolveProfile(profileSelectEl.value), {
        logo: dataUrl,
      }));
      syncTemporaryAssetControls();
      isDirty = true;
      setStatus("لوگوی موقت فقط برای همین پیش‌فاکتور اعمال شد.");
    } catch (err) {
      invoiceAssetOverrides.logo = previousLogo;
      await showAppDialog({
        title: "تغییر لوگو ناموفق بود",
        message: err.message || "تصویر لوگو قابل استفاده نیست.",
        actions: [{ id: "ok", label: "متوجه شدم", primary: true }],
      });
    }
  }

  async function applyTemporaryStampFile(file) {
    if (!file) return;
    var previousStamp = invoiceAssetOverrides.stamp;
    stampUploadStatusEl.textContent = "در حال آماده‌سازی مهر موقت…";
    try {
      var dataUrl = await resizeImageFile(file, 900);
      invoiceAssetOverrides.stamp = dataUrl;
      stampRequested = true;
      setStampSrc(dataUrl);
      syncTemporaryAssetControls();
      syncStampVisibility();
      isDirty = true;
      setStatus("مهر موقت فقط برای همین پیش‌فاکتور اعمال شد.");
    } catch (err) {
      invoiceAssetOverrides.stamp = previousStamp;
      setStampSrc(effectiveCompanyAsset(profileSelectEl.value, "stamp"));
      await showAppDialog({
        title: "تغییر مهر ناموفق بود",
        message: err.message || "تصویر مهر قابل استفاده نیست.",
        actions: [{ id: "ok", label: "متوجه شدم", primary: true }],
      });
    }
  }

  function restoreDefaultAsset(assetName) {
    invoiceAssetOverrides[assetName] = null;
    var profileKey = profileSelectEl.value;
    isDirty = true;
    if (assetName === "logo") {
      setCompanyBranding(profileKey, Object.assign({}, resolveProfile(profileKey), {
        logo: effectiveCompanyAsset(profileKey, "logo"),
      }));
      setStatus("لوگوی پیش‌فرض شرکت برای این پیش‌فاکتور برگشت.");
    } else {
      setStampSrc(effectiveCompanyAsset(profileKey, "stamp"));
      stampRequested = true;
      syncStampVisibility();
      setStatus("مهر پیش‌فرض شرکت برای این پیش‌فاکتور برگشت.");
    }
    syncTemporaryAssetControls();
  }

  function wireToolbar() {
    dialogInputEl.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      var primary = dialogActionsEl.querySelector("button.primary");
      if (primary) primary.click();
    });

    document.getElementById("btn-new").addEventListener("click", async function () {
      if (isDirty) {
        var confirmed = await confirmApp("پیش‌فاکتور جدید", "تغییرات ذخیره‌نشده از بین می‌رود. یک سند جدید ایجاد شود؟", "ایجاد سند جدید");
        if (!confirmed) return;
      }
      applyInvoiceData(blankInvoice(), { manageDefaultRows: true });
      currentSavedId = null;
      currentSavedName = "";
      isDirty = false;
      numberIsAutoSuggested = true;
      dateIsAutoSuggested = true;
      validityIsAutoSuggested = true;
      stampRequested = true;
      syncStampVisibility();
      setStatus("سند جدید آماده است.");
      renderSavedList();
    });

    var fileInput = document.getElementById("file-open");
    document.getElementById("btn-open").addEventListener("click", function () {
      closeSettingsPanel();
      fileInput.click();
    });
    fileInput.addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) openFromFile(file);
      e.target.value = "";
    });

    profileSelectEl.addEventListener("change", async function () {
      var nextKey = this.value;
      var previousKey = lastProfileKey || DEFAULT_PROFILE_KEY;
      if (nextKey === previousKey) return;
      if (hasMeaningfulInvoiceData() || isDirty) {
        this.value = previousKey;
        var confirmed = await confirmApp(
          "تغییر شرکت صادرکننده",
          "با تغییر شرکت، نام و شناسهٔ فروشنده، لوگو، وب‌سایت، مهر و شمارهٔ پیشنهادی سند با پروفایل جدید هماهنگ می‌شود. اطلاعات خریدار و اقلام حفظ خواهند شد.",
          "تغییر شرکت"
        );
        if (!confirmed) return;
        this.value = nextKey;
      }
      applyCompanyProfile(nextKey);
      stampRequested = true;
      syncStampVisibility();
      if (numberIsAutoSuggested) {
        var numberInput = document.querySelector('[data-field="meta.number"]');
        if (numberInput) numberInput.value = suggestInvoiceNumber(nextKey, currentInvoiceDateValue());
      }
      isDirty = true;
      setStatus(isCustomProfile(nextKey) ? "نام و مشخصات شرکت را وارد کنید." : "شرکت صادرکننده تغییر کرد؛ سند دوباره نیاز به تأیید دارد.");
      if (isCustomProfile(nextKey)) document.getElementById("inv-company-name").focus();
    });

    validityModeEl.addEventListener("change", function () {
      var input = document.querySelector('[data-field="meta.validity"]');
      if (input) input.value = resolveValidityValue(this.value);
      syncValidityFieldVisibility(this.value);
      validityIsAutoSuggested = this.value !== "manual";
      if (this.value === "manual" && input) input.focus();
      isDirty = true;
      setStatus("تغییرات ذخیره‌نشده");
    });

    document.getElementById("btn-save").addEventListener("click", function () { saveCurrent(false); });
    document.getElementById("btn-save-as").addEventListener("click", function () {
      closeSettingsPanel();
      saveCurrent(true);
    });
    document.getElementById("btn-export").addEventListener("click", function () {
      closeSettingsPanel();
      exportEditable();
    });
    document.getElementById("btn-add-row").addEventListener("click", addRow);

    var savedListBtn = document.getElementById("btn-saved-list");
    savedListBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closeSettingsPanel();
      toggleSavedPanel();
    });
    document.getElementById("btn-saved-close").addEventListener("click", closeSavedPanel);
    savedPanelEl.addEventListener("click", function (e) { e.stopPropagation(); });

    settingsBtnEl.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleSettingsPanel();
    });
    settingsPanelEl.addEventListener("click", function (e) { e.stopPropagation(); });

    headerGrayToggleEl.addEventListener("change", function () {
      applyHeaderGray(this.checked);
      isDirty = true;
      setStatus(this.checked ? "پس‌زمینهٔ خاکستری هدر و فوتر فعال شد." : "پس‌زمینهٔ هدر و فوتر خاموش شد.");
    });

    document.getElementById("btn-company-profile-edit").addEventListener("click", function () {
      openCompanyEditor("edit");
    });
    document.getElementById("btn-company-editor").addEventListener("click", function () {
      openCompanyEditor("create");
    });
    document.getElementById("btn-company-editor-cancel").addEventListener("click", closeCompanyEditor);
    companyEditorDialogEl.addEventListener("click", function (e) {
      if (e.target === companyEditorDialogEl) closeCompanyEditor();
    });
    companyEditorFormEl.addEventListener("submit", function (e) {
      e.preventDefault();
      saveCompanyProfileFromEditor();
    });
    document.getElementById("btn-company-logo").addEventListener("click", function () {
      companyLogoFileEl.click();
    });
    companyLogoFileEl.addEventListener("change", async function () {
      var file = this.files && this.files[0];
      this.value = "";
      if (!file) return;
      companyEditorErrorEl.hidden = true;
      companyLogoStatusEl.textContent = "در حال آماده‌سازی لوگو…";
      try {
        var dataUrl = await resizeImageFile(file, 720);
        setCompanyLogoPreview(dataUrl, file.name + " · بهینه‌شده برای چاپ");
      } catch (err) {
        companyEditorErrorEl.textContent = err.message || "افزودن لوگو ممکن نشد.";
        companyEditorErrorEl.hidden = false;
        setCompanyLogoPreview("", "");
      }
    });

    [temporaryLogoBtnEl, temporaryLogoSettingsBtnEl].forEach(function (button) {
      if (button) button.addEventListener("click", function () {
        closeSettingsPanel();
        temporaryLogoFileEl.click();
      });
    });
    temporaryLogoFileEl.addEventListener("change", async function () {
      var file = this.files && this.files[0];
      this.value = "";
      await applyTemporaryLogoFile(file);
    });

    [temporaryStampBtnEl, document.getElementById("btn-stamp-upload")].forEach(function (button) {
      if (button) button.addEventListener("click", function () {
        closeSettingsPanel();
        stampUploadFileEl.click();
      });
    });
    stampUploadFileEl.addEventListener("change", async function () {
      var file = this.files && this.files[0];
      this.value = "";
      await applyTemporaryStampFile(file);
    });
    logoResetBtnEl.addEventListener("click", function () { restoreDefaultAsset("logo"); });
    stampResetBtnEl.addEventListener("click", function () { restoreDefaultAsset("stamp"); });

    includeStampEl.addEventListener("change", function () {
      stampRequested = this.checked;
      syncStampVisibility();
      isDirty = true;
      setStatus(stampRequested ? "مهر فروشنده در پیش‌فاکتور نمایش داده می‌شود." : "مهر از پیش‌فاکتور حذف شد.");
    });

    document.addEventListener("click", function () {
      if (!savedPanelEl.hidden) closeSavedPanel();
      if (!settingsPanelEl.hidden) closeSettingsPanel();
    });
    document.getElementById("btn-print").addEventListener("click", function () {
      closeSettingsPanel();
      printInvoice();
    });

    document.getElementById("orientation-landscape").addEventListener("change", function () {
      if (!this.checked) return;
      syncManagedDefaultRows("landscape");
      setOrientation("landscape");
      recalcAll();
      isDirty = true;
      setStatus("جهت چاپ: افقی");
    });
    document.getElementById("orientation-portrait").addEventListener("change", function () {
      if (!this.checked) return;
      syncManagedDefaultRows("portrait");
      setOrientation("portrait");
      recalcAll();
      isDirty = true;
      setStatus("جهت چاپ: عمودی");
    });
  }

  // ---------- Boot ----------

  function boot() {
    if (document.fonts && document.fonts.load) {
      // Prime the one approved corporate typeface before any measurement or
      // print snapshot is taken.
      document.fonts.load('700 16px "Vazirmatn"');
      document.fonts.load('400 16px "Vazirmatn"');
    }
    if (document.fonts && document.fonts.ready) {
      // Numeric auto-fit measures rendered pixel widths; if it ran against
      // a fallback font before the active document font finished loading,
      // those widths are wrong. Re-run once the real font is active.
      //
      // The trailing setTimeout, not requestAnimationFrame: fonts.ready
      // resolves before the layout it changes has been laid out, and rAF is
      // never serviced in a tab that is not painting. A timeout task is, and
      // forcing a layout read from it returns settled geometry either way.
      document.fonts.ready.then(function () {
        recalcAll();
        setTimeout(recalcAll, 0);
      });
    }

    wireStaticFieldBindings();
    wireToolbar();

    // Keep the preview fitted to the window (also re-run by setOrientation,
    // whose sheet is a different width).
    fitSheetScale();
    window.addEventListener("resize", fitSheetScale);
    window.addEventListener("focus", function () {
      refreshAutomaticTemporalFields(true);
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refreshAutomaticTemporalFields(true);
    });

    // Keyboard shortcuts: Ctrl+S saves to the browser list (instead of the
    // browser's useless "save page" dialog), Ctrl+P routes through the same
    // font-safe print path as the toolbar button, Escape closes the
    // saved-invoices panel.
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        var k = e.key.toLowerCase();
        if (k === "s") {
          e.preventDefault();
          saveCurrent();
        } else if (k === "p") {
          e.preventDefault();
          printInvoice();
        }
      } else if (e.key === "Escape") {
        if (!appDialogEl.hidden) closeAppDialog({ action: "cancel", value: "" });
        if (!companyEditorDialogEl.hidden) closeCompanyEditor();
        closeSavedPanel();
        closeSettingsPanel();
      }
    });

    // Closing/reloading the tab with unsaved changes deserves the browser's
    // standard "leave site?" confirmation — this is an offline tool, there
    // is no other safety net.
    window.addEventListener("beforeunload", function (e) {
      if (!isDirty) return undefined;
      e.preventDefault();
      e.returnValue = "";
      return "";
    });

    migrateSavedListStorage();
    migrateLegacyAutosave();
    hydrateCompanyProfiles();
    // Every load starts a clean blank invoice — nothing is auto-restored.
    // Previously-saved invoices stay reachable from the "ذخیره‌شده‌ها" panel
    // (see openSavedEntry above), they just aren't loaded automatically.
    applyInvoiceData(blankInvoice(), { manageDefaultRows: true });
    currentSavedId = null;
    currentSavedName = "";
    numberIsAutoSuggested = true;
    dateIsAutoSuggested = true;
    validityIsAutoSuggested = true;
    stampRequested = true;
    syncStampVisibility();
    setStatus("آماده برای ثبت پیش‌فاکتور جدید.");
    renderSavedList();
    isDirty = false;

    // Wired after the initial load so programmatic value-setting above
    // doesn't immediately mark the fresh document as having unsaved changes.
    sheet.addEventListener("input", function () {
      isDirty = true;
      if (validationRequested) validateInvoiceForOutput();
      setStatus("تغییرات ذخیره‌نشده");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
