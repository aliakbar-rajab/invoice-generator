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
  var SAVED_LIST_KEY = "preinvoice.saved.v1";
  var CUSTOM_PROFILES_KEY = "preinvoice.companyProfiles.v1";
  var PROFILE_ASSETS_KEY = "preinvoice.profileAssets.v1";

  // In-memory id of the saved-list entry currently loaded (null = unsaved/
  // new document). Save updates this entry in place once set; it is reset
  // on New / Open-from-file so those always start a fresh entry on next Save.
  var currentSavedId = null;
  var currentSavedName = "";
  var isDirty = false;
  var validationRequested = false;
  var stampRequested = false;
  var stampAvailable = false;
  var lastProfileKey = null;
  var pendingCompanyLogoData = "";
  // The catch-all «سایر» profile is document-scoped rather than a reusable
  // company identity. Keep its branding outside COMPANY_PROFILES so opening
  // one ad-hoc invoice can never leak its logo or stamp into the next one.
  var adHocCompanyAssets = { logo: "", stamp: "" };
  var MIN_INVOICE_ROWS = 8;

  // True while meta.number still holds a live suggestion (set by blankInvoice
  // on New/boot) rather than something the user typed or a value that came in
  // from a saved/opened file. Lets the company-profile switch below re-derive
  // the number under the newly-picked company's own sequence (see SEQ_KEY_
  // PREFIX) without ever clobbering a number the user actually typed.
  var numberIsAutoSuggested = false;

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
  var customCompanyNameWrapEl = document.getElementById("custom-company-name-wrap");
  var customCompanyNameEl = document.getElementById("custom-company-name");
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
    stampRequested = false;
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

  // Resolves a validity mode (see VALID_VALIDITY_MODES) to the text that
  // belongs in the printed "اعتبار پیش‌فاکتور" field. "manual" resolves to
  // an empty string — the field is left for the user to type into.
  function resolveValidityValue(mode) {
    if (mode === "tomorrow") return tomorrowJalaliString();
    if (mode === "manual") return "";
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
    if (!isCustomProfile(stored.company.profile)) {
      delete stored.company.logo;
      delete stored.company.stamp;
    }
    return stored;
  }

  function isCustomProfile(profileKey) {
    return profileKey === CUSTOM_PROFILE_KEY;
  }

  function resetAdHocCompanyAssets() {
    adHocCompanyAssets = { logo: "", stamp: "" };
  }

  function setCustomCompanyMode(profileKey, companyName) {
    var custom = isCustomProfile(profileKey);
    customCompanyNameWrapEl.hidden = !custom;
    customCompanyNameEl.value = custom ? companyName || "" : "";

    document.querySelectorAll('[data-field^="seller."]').forEach(function (field) {
      field.readOnly = !custom;
      field.classList.toggle("inv-readonly", !custom);
    });
    var website = document.querySelector('[data-field="company.website"]');
    if (website) {
      website.readOnly = false;
      website.classList.remove("inv-readonly");
    }
  }

  var SEQ_KEY_PREFIX = "pishFaktor.dailySeq.";

  // Number suggestions are deliberately side-effect free. Merely opening the
  // app, loading a file, or pressing New must never consume an accounting
  // number. The per-company counter advances only when the document is first
  // saved or intentionally printed/finalized (commitInvoiceNumber below).
  function suggestInvoiceNumber(profileKey) {
    var datePart = toAsciiDigits(todayJalaliString()).replace(/[^0-9]/g, "");
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
    var latest = suggestInvoiceNumber(profileSelectEl.value);
    if (!latest || latest === numberInput.value) return false;
    numberInput.value = latest;
    fitNumericEl(numberInput);
    updateDocumentIdentity();
    return true;
  }

  function blankInvoice() {
    var profileKey = DEFAULT_PROFILE_KEY;
    var profile = resolveProfile(profileKey);
    return {
      version: 5,
      orientation: "landscape",
      headerGray: true,
      font: DEFAULT_FONT_KEY,
      fontScale: DEFAULT_FONT_SCALE,
      meta: {
        title: "پیش‌فاکتور",
        date: todayJalaliString(),
        number: suggestInvoiceNumber(profileKey),
        validityMode: DEFAULT_VALIDITY_MODE,
        validity: resolveValidityValue(DEFAULT_VALIDITY_MODE),
      },
      buyer: { name: "", nationalId: "", address: "", postalCode: "", phone: "" },
      seller: sellerFromProfile(profile),
      company: companyFromProfile(profileKey, profile),
      taxPercent: "۱۰",
      notes: "",
      includeStamp: false,
      // Keep the familiar eight-row form visible. Unused rows are not saved,
      // but they remain on the editor and printed A4 as empty ruled rows.
      items: makeBlankRows(MIN_INVOICE_ROWS),
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
    var brandingProfile = isCustomProfile(key)
      ? Object.assign({}, profile, adHocCompanyAssets)
      : profile;

    document.getElementById("inv-company-name").textContent = profile.name;
    setCustomCompanyMode(key, profile.name);
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
    setStampSrc(brandingProfile.stamp);
    profileSelectEl.value = key;
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

  function invalidateFinalization() {
    if (!stampRequested) return false;
    stampRequested = false;
    syncStampVisibility();
    return true;
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
    var fallbackStamp = isCustomProfile(profileKey) ? adHocCompanyAssets.stamp : profile.stamp;
    var src = stampEl.getAttribute("src") || fallbackStamp || "";
    if (src) {
      stampUploadPreviewEl.src = src;
      stampUploadPreviewEl.hidden = false;
      stampUploadEmptyEl.hidden = true;
      stampUploadStatusEl.textContent = "مهر برای «" + (profile.label || profile.name) + "» آماده است.";
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

  function openCompanyEditor() {
    var adHoc = isCustomProfile(profileSelectEl.value);
    companyEditorFormEl.reset();
    companyEditorErrorEl.hidden = true;
    if (adHoc) {
      companyEditorNameEl.value = customCompanyNameEl.value.trim();
      companyEditorNationalIdEl.value = document.querySelector('[data-field="seller.nationalId"]').value;
      companyEditorPostalCodeEl.value = document.querySelector('[data-field="seller.postalCode"]').value;
      companyEditorAddressEl.value = document.querySelector('[data-field="seller.address"]').value;
      companyEditorPhonesEl.value = document.querySelector('[data-field="seller.phone"]').value;
      companyEditorWebsiteEl.value = document.querySelector('[data-field="company.website"]').value;
      setCompanyLogoPreview(adHocCompanyAssets.logo, "لوگوی فعلی این سند");
    } else {
      setCompanyLogoPreview("", "");
    }
    closeSettingsPanel();
    companyEditorDialogEl.hidden = false;
    window.setTimeout(function () { companyEditorNameEl.focus(); }, 0);
  }

  function createCompanyProfileFromEditor() {
    var name = companyEditorNameEl.value.trim();
    if (!name) {
      companyEditorErrorEl.textContent = "نام شرکت را وارد کنید.";
      companyEditorErrorEl.hidden = false;
      companyEditorNameEl.focus();
      return false;
    }

    var profileKey = "company-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    var profile = profileFromCompanyData({
      name: name,
      logo: pendingCompanyLogoData,
      stamp: "",
      nationalId: toPersianDigits(companyEditorNationalIdEl.value.trim()),
      address: companyEditorAddressEl.value.trim(),
      postalCode: toPersianDigits(companyEditorPostalCodeEl.value.trim()),
      phones: toPersianDigits(companyEditorPhonesEl.value.trim()),
      website: companyEditorWebsiteEl.value.trim(),
    }, true);

    COMPANY_PROFILES[profileKey] = profile;
    try {
      persistUserProfiles();
    } catch (err) {
      delete COMPANY_PROFILES[profileKey];
      companyEditorErrorEl.textContent = "فضای ذخیرهٔ مرورگر کافی نیست؛ تصویر کوچک‌تری انتخاب کنید.";
      companyEditorErrorEl.hidden = false;
      return false;
    }

    renderCompanyProfileOptions(profileKey);
    applyCompanyProfile(profileKey);
    stampRequested = false;
    syncStampVisibility();
    if (numberIsAutoSuggested) {
      var numberInput = document.querySelector('[data-field="meta.number"]');
      if (numberInput) numberInput.value = suggestInvoiceNumber(profileKey);
    }
    isDirty = true;
    setStatus("شرکت «" + profile.label + "» ثبت و انتخاب شد.");
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

  function ensureMinimumRows() {
    var missing = MIN_INVOICE_ROWS - rowsBody.querySelectorAll("tr").length;
    for (var i = 0; i < missing; i += 1) createRow({}, { skipRecalc: true });
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
      statusDotEl.classList.toggle("has-error", !!sheet.querySelector(".has-error"));
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
      var rows = rowsBody.querySelectorAll("tr");
      if (rows.length <= 1) {
        ROW_FIELDS.forEach(function (field) {
          rows[0].querySelector('[data-row-field="' + field + '"]').value = "";
        });
      } else {
        tr.remove();
      }
      ensureMinimumRows();
      recalcAll();
      invalidateFinalization();
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
    createRow({}, { focusField: "description" });
    invalidateFinalization();
    isDirty = true;
    setStatus("تغییرات ذخیره‌نشده");
  }

  // ---------- Calculations and validation ----------

  var calculationErrors = [];

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
    if (!normalized && emptyAsZero) return { valid: true, value: 0n };
    if (!/^\d+$/.test(normalized)) return { valid: false, value: 0n };
    try {
      return { valid: true, value: BigInt(normalized) };
    } catch (err) {
      return { valid: false, value: 0n };
    }
  }

  function strictQuantity(value) {
    var normalized = normalizeStrictNumber(value);
    if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return { valid: false, value: 0n };
    var parsed = parseQtyMilli(normalized);
    return { valid: parsed > 0n, value: parsed };
  }

  function strictPercent(value) {
    var normalized = normalizeStrictNumber(value);
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return { valid: false, value: 0n };
    var parsed = parsePercentBps(normalized);
    return { valid: parsed >= 0n && parsed <= 10000n, value: parsed };
  }

  function clearInlineError(input) {
    var holder = input && (input.closest("td") || input.closest(".inv-field") || input.closest("dd"));
    if (!holder) return;
    holder.classList.remove("has-error");
    holder.removeAttribute("data-error");
    input.removeAttribute("aria-invalid");
  }

  function setInlineError(input, message, force) {
    if (!input) return;
    clearInlineError(input);
    if (!(force || validationRequested || input.dataset.touched === "true")) return;
    var holder = input.closest("td") || input.closest(".inv-field") || input.closest("dd");
    if (!holder) return;
    holder.classList.add("has-error");
    holder.setAttribute("data-error", message);
    input.setAttribute("aria-invalid", "true");
  }

  function recalcAll(opts) {
    var rows = rowsBody.querySelectorAll("tr");
    var filledRows = 0;
    var gross = 0n;
    var discountSum = 0n;
    var afterDiscountSum = 0n;
    var hasFinancialError = false;
    calculationErrors = [];

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
      if (!descriptionInput.value.trim()) {
        rowErrors.push("شرح کالا یا خدمت وارد نشده است");
        setInlineError(descriptionInput, "شرح را وارد کنید");
      }

      var qty = strictQuantity(qtyInput.value);
      if (!qty.valid) {
        rowErrors.push("تعداد/مقدار معتبر نیست");
        setInlineError(qtyInput, "عدد مثبت، حداکثر ۳ رقم اعشار");
      }

      var price = strictMoney(priceInput.value, false);
      if (!price.valid) {
        rowErrors.push("مبلغ واحد معتبر نیست");
        setInlineError(priceInput, "مبلغ صحیح و بدون اعشار");
      }

      var discount = strictMoney(discountInput.value, true);
      if (!discount.valid) {
        rowErrors.push("تخفیف معتبر نیست");
        setInlineError(discountInput, "تخفیف صحیح و بدون اعشار");
      }

      var total = 0n;
      if (qty.valid && price.valid) total = bigRoundDiv(qty.value * price.value, 1000n);
      if (discount.valid && qty.valid && price.valid && discount.value > total) {
        rowErrors.push("تخفیف از مبلغ کل ردیف بیشتر است");
        setInlineError(discountInput, "حداکثر " + formatBigRial(total) + " ریال", true);
      }

      if (rowErrors.length) {
        hasFinancialError = true;
        tr.classList.add("has-financial-error");
        totalEl.textContent = qty.valid && price.valid ? formatBigRial(total) : "—";
        afterDiscountEl.textContent = "—";
        rowErrors.forEach(function (message) {
          calculationErrors.push("ردیف " + toPersianDigits(rowNumber) + ": " + message);
        });
      } else {
        var afterDiscount = total - discount.value;
        totalEl.textContent = formatBigRial(total);
        afterDiscountEl.textContent = formatBigRial(afterDiscount);
        gross += total;
        discountSum += discount.value;
        afterDiscountSum += afterDiscount;
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
      hasFinancialError = true;
      calculationErrors.push("درصد مالیات باید بین صفر تا صد باشد");
      setInlineError(taxPercentInput, "درصد معتبر بین ۰ تا ۱۰۰", true);
    }

    if (hasFinancialError) {
      ["grossTotal", "discountTotal", "afterDiscountTotal", "taxTotal", "netTotal"].forEach(function (key) {
        setTotal(key, filledRows ? "—" : "");
      });
      setTotal("netTotalWords", filledRows ? "اطلاعات مالی نیاز به اصلاح دارد" : "");
    } else {
      var taxTotal = bigRoundDiv(afterDiscountSum * tax.value, 10000n);
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
    }

    if (opts && opts.skipStaticFit) refreshEmptyStates();
    else fitStaticFields();
    updateDocumentIdentity();
    if (statusDotEl) statusDotEl.classList.toggle("has-error", !!sheet.querySelector(".has-error"));
  }

  function clearStaticValidation() {
    sheet.querySelectorAll(".inv-field.has-error, .inv-meta dd.has-error").forEach(function (holder) {
      holder.classList.remove("has-error");
      holder.removeAttribute("data-error");
    });
  }

  function requireField(selector, message, errors) {
    var input = document.querySelector(selector);
    if (input && !input.value.trim()) {
      setInlineError(input, message, true);
      errors.push(message);
    }
  }

  function validateInvoiceForOutput() {
    validationRequested = true;
    clearStaticValidation();
    recalcAll();
    var errors = calculationErrors.slice();
    requireField('[data-field="meta.date"]', "تاریخ پیش‌فاکتور وارد نشده است", errors);
    requireField('[data-field="meta.number"]', "شماره پیش‌فاکتور وارد نشده است", errors);
    requireField('[data-field="buyer.name"]', "نام خریدار وارد نشده است", errors);
    if (isCustomProfile(profileSelectEl.value) && !customCompanyNameEl.value.trim()) {
      errors.push("نام شرکت صادرکننده را وارد کنید");
    }
    if (!Array.prototype.some.call(rowsBody.querySelectorAll("tr"), function (tr) { return !rowIsBlank(tr); })) {
      errors.push("حداقل یک قلم کالا یا خدمت وارد کنید");
    }
    if (validityModeEl.value === "manual") {
      requireField('[data-field="meta.validity"]', "تاریخ اعتبار پیش‌فاکتور وارد نشده است", errors);
    }

    var unique = errors.filter(function (text, index) { return errors.indexOf(text) === index; });
    validationListEl.innerHTML = "";
    unique.forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      validationListEl.appendChild(li);
    });
    validationEl.hidden = unique.length === 0;
    if (unique.length) validationEl.scrollIntoView({ behavior: "smooth", block: "center" });
    return unique;
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
      version: 5,
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

    // Named profiles stay authoritative. «سایر» is intentionally editable,
    // so its typed company/seller details are preserved in saved files.
    var profileKey = COMPANY_PROFILES[profileSelectEl.value] ? profileSelectEl.value : DEFAULT_PROFILE_KEY;
    var profile = resolveProfile(profileKey);
    var enteredWebsite = data.company.website || "";
    if (isCustomProfile(profileKey)) {
      data.company = companyFromProfile(profileKey, profile);
      data.company.name = customCompanyNameEl.value.trim() || data.seller.name || "";
      data.company.nationalId = data.seller.nationalId || "";
      data.company.address = data.seller.address || "";
      data.company.phones = data.seller.phone || "";
      data.company.website = enteredWebsite;
      data.company.logo = adHocCompanyAssets.logo;
      data.company.stamp = adHocCompanyAssets.stamp;
    } else {
      data.company = companyFromProfile(profileKey, profile);
      data.company.website = enteredWebsite;
      data.seller = sellerFromProfile(profile);
    }
    // meta.validityMode isn't a [data-field] (same as company.profile above)
    // since it's a mode picker, not editable document text.
    data.meta.validityMode = validityModeEl.value;

    rowsBody.querySelectorAll("tr").forEach(function (tr) {
      if (rowIsBlank(tr)) return;
      var row = {};
      ROW_FIELDS.forEach(function (field) {
        row[field] = tr.querySelector('[data-row-field="' + field + '"]').value;
      });
      data.items.push(row);
    });

    return data;
  }

  function applyInvoiceData(raw) {
    var profileKey = (raw && raw.company && raw.company.profile) || DEFAULT_PROFILE_KEY;
    if (!COMPANY_PROFILES[profileKey]) profileKey = registerEmbeddedProfile(profileKey, raw && raw.company);
    if (!COMPANY_PROFILES[profileKey]) profileKey = DEFAULT_PROFILE_KEY;
    var profile = resolveProfile(profileKey);
    if (!isCustomProfile(profileKey) && raw && raw.company) {
      ["logo", "stamp"].forEach(function (assetName) {
        var embedded = String(raw.company[assetName] || "");
        var current = String(profile[assetName] || "");
        if (!/^data:image\//i.test(embedded) || /^data:image\//i.test(current)) return;
        profile[assetName] = embedded;
        try {
          if (profile.userCreated) persistUserProfiles();
          else persistProfileAsset(profileKey, assetName, embedded);
        } catch (err) {
          // The document still uses the embedded image for this session.
        }
      });
    }
    var defaults = blankInvoice();
    // Field-by-field fallback must come from the RESOLVED profile (the one
    // this file was actually saved under), not always the hardcoded default
    // profile — otherwise opening a Kara Borj Parseh file that happens to
    // omit one company field (e.g. an older export) would silently backfill
    // it with Foulad Bonyan's value.
    var profileDefaults = companyFromProfile(profileKey, profile);
    var customProfile = isCustomProfile(profileKey);
    var customSellerDefaults = { name: "", nationalId: "", address: "", postalCode: "", phone: "" };
    var companyData = customProfile
      ? Object.assign({}, profileDefaults, raw && raw.company, { profile: CUSTOM_PROFILE_KEY })
      : Object.assign({}, profileDefaults, {
          website: raw && raw.company && raw.company.website != null
            ? raw.company.website
            : profileDefaults.website,
        });
    var sellerData = customProfile
      ? Object.assign({}, customSellerDefaults, raw && raw.seller)
      : sellerFromProfile(profile);
    if (customProfile) {
      if (!companyData.name) companyData.name = sellerData.name || "";
      if (!sellerData.name) sellerData.name = companyData.name || "";
    }
    var data = {
      orientation: (raw && raw.orientation) || defaults.orientation,
      headerGray: raw && raw.headerGray != null ? !!raw.headerGray : defaults.headerGray,
      font: DEFAULT_FONT_KEY,
      fontScale: DEFAULT_FONT_SCALE,
      meta: Object.assign({}, defaults.meta, raw && raw.meta),
      buyer: Object.assign({}, defaults.buyer, raw && raw.buyer),
      seller: sellerData,
      company: companyData,
      taxPercent: raw && raw.taxPercent != null ? raw.taxPercent : defaults.taxPercent,
      notes: raw && raw.notes != null ? raw.notes : defaults.notes,
      includeStamp: !!(raw && raw.includeStamp),
      items: raw && raw.items && raw.items.length ? raw.items.filter(function (row) {
        return ROW_FIELDS.some(function (field) { return row && String(row[field] || "").trim(); });
      }) : defaults.items,
    };
    while (data.items.length < MIN_INVOICE_ROWS) {
      data.items.push(makeBlankRows(1)[0]);
    }

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
    setCustomCompanyMode(profileKey, data.company.name);
    if (customProfile) {
      adHocCompanyAssets = {
        logo: String(data.company.logo || ""),
        stamp: String(data.company.stamp || ""),
      };
    } else {
      resetAdHocCompanyAssets();
    }
    profileSelectEl.value = profileKey;
    setCompanyBranding(profileKey, customProfile ? adHocCompanyAssets : profile);
    applyHeaderGray(data.headerGray);
    stampRequested = data.includeStamp;
    setStampSrc(customProfile ? adHocCompanyAssets.stamp : profile.stamp);
    lastProfileKey = profileKey;
    syncStampVisibility();

    rowsBody.innerHTML = "";
    if (!data.items.length) data.items = makeBlankRows(MIN_INVOICE_ROWS);
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

  function loadSavedList() {
    try {
      var raw = localStorage.getItem(SAVED_LIST_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      return {};
    }
  }

  function persistSavedList(list) {
    localStorage.setItem(SAVED_LIST_KEY, JSON.stringify(list));
  }

  // A one-time upgrade path so users who saved under the old single-slot
  // autosave don't lose that invoice: it becomes the first named entry.
  function migrateLegacyAutosave() {
    try {
      var legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!legacyRaw) return;
      // Read this key strictly during migration. The ordinary UI treats a
      // corrupt list as empty so it can keep running, but migration must not
      // overwrite an unreadable list and compound the data loss.
      var savedRaw = localStorage.getItem(SAVED_LIST_KEY);
      var list = savedRaw ? JSON.parse(savedRaw) : {};
      if (!list || typeof list !== "object" || Array.isArray(list)) throw new Error("Invalid saved list");
      if (Object.keys(list).length === 0) {
        var data = JSON.parse(legacyRaw);
        var id = "inv-" + Date.now().toString(36);
        list[id] = { id: id, name: "بازیابی‌شده از نسخهٔ قبلی برنامه", savedAt: Date.now(), data: data };
        persistSavedList(list);
      }
      // Only remove the source after the replacement write has completed.
      // A quota/security failure must leave the legacy invoice recoverable.
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (err) {
      // Keep the source intact. A future session (or a user-created backup)
      // may still be able to recover it once storage becomes available.
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
  }

  async function saveCurrent(forceNew) {
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
      // The naming dialog may stay open while another tab saves. Refresh the
      // shared list immediately before writing so that tab's entries are not
      // overwritten by the stale pre-dialog snapshot.
      list = loadSavedList();
      list[currentSavedId] = {
        id: currentSavedId,
        name: name,
        savedAt: Date.now(),
        data: dataForBrowserStorage(data),
      };
      persistSavedList(list);
      // Commit every valid daily-format number, not only untouched automatic
      // suggestions. Manually corrected and file-imported numbers must also
      // advance the counter or the next document can reuse them.
      commitInvoiceNumber(data.company.profile, data.meta.number);
      numberIsAutoSuggested = false;
      currentSavedName = name;
      isDirty = false;
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

    delete list[id];
    persistSavedList(list);
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
    var rows = Array.prototype.slice.call(rowsBody.querySelectorAll("tr"));
    var filled = rows.filter(function (tr) { return !rowIsBlank(tr); });
    var fillerCount = Math.max(0, MIN_INVOICE_ROWS - filled.length);
    var fillers = rows.filter(rowIsBlank).slice(0, fillerCount);
    // Keep the familiar eight ruled rows on short invoices, but never let
    // extra Enter-created empty rows manufacture blank printed pages.
    return filled.concat(fillers);
  }

  function makeContinuationHeader(pageNo, totalPages) {
    var profileKey = profileSelectEl.value;
    var profile = isCustomProfile(profileKey)
      ? Object.assign({}, resolveProfile(profileKey), adHocCompanyAssets)
      : resolveProfile(profileKey);
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
    var tableActions = clone.querySelector(".inv-table-actions");
    if (tableActions) tableActions.remove();
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
    refreshLiveInvoiceNumber();
    recalcAll();
    var errors = validateInvoiceForOutput();
    if (errors.length) {
      await showAppDialog({
        title: "پیش‌فاکتور آمادهٔ چاپ نیست",
        message: "برای جلوگیری از صدور سند نادرست، موارد زیر را اصلاح کنید.",
        details: errors.slice(0, 8),
        actions: [{ id: "ok", label: "بازگشت و اصلاح", primary: true }],
      });
      return;
    }

    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    autoGrowTextareas();
    var rows = printableSourceRows();
    var orientation = currentOrientation();

    // Portrait columns are intentionally narrower. For legitimate very large
    // amounts, preserve readable type by moving to landscape rather than
    // squeezing digits below the approved minimum.
    if (orientation === "portrait" && sheet.querySelector(".inv-table .numeric-overflow, .inv-totals .numeric-overflow")) {
      var widthChoice = await showAppDialog({
        title: "مبالغ برای حالت عمودی عریض هستند",
        message: "برای حفظ خوانایی کامل ارقام، این سند در حالت افقی چاپ شود. در صورت نیاز، صفحه‌بندی چندصفحه‌ای به‌طور خودکار انجام می‌شود.",
        actions: [
          { id: "landscape", label: "تغییر به افقی", primary: true },
          { id: "cancel", label: "انصراف" },
        ],
      });
      if (widthChoice.action !== "landscape") return;
      setOrientation("landscape");
      recalcAll();
      orientation = "landscape";
      isDirty = true;
      setStatus("جهت سند برای خوانایی مبالغ به افقی تغییر کرد.");
    }
    if (sheet.querySelector(".inv-table .numeric-overflow, .inv-totals .numeric-overflow")) {
      await showAppDialog({
        title: "مبلغ بسیار طولانی است",
        message: "حداقل یکی از مبالغ در عرض استاندارد ستون جا نمی‌گیرد. مقدار را بررسی کنید؛ برنامه برای جا دادن عدد، متن را به اندازهٔ ناخوانا کوچک نمی‌کند.",
        actions: [{ id: "ok", label: "بازگشت و بررسی", primary: true }],
      });
      return;
    }

    // Landscape is preferred for ordinary invoices, but portrait often keeps
    // 9–17 items on one page. Offer that improvement before creating a
    // multi-page landscape document.
    if (orientation === "landscape" && !singlePageFits(rows, "landscape", true) && singlePageFits(rows, "portrait", true)) {
      var choice = await showAppDialog({
        title: "چیدمان بهتر برای این سند",
        message: "این تعداد قلم در حالت افقی به بیش از یک صفحه نیاز دارد، اما در حالت عمودی روی یک A4 جا می‌گیرد.",
        actions: [
          { id: "portrait", label: "تغییر به عمودی و چاپ", primary: true },
          { id: "multi", label: "چاپ چندصفحه‌ای افقی" },
          { id: "cancel", label: "انصراف" },
        ],
      });
      if (choice.action === "cancel") return;
      if (choice.action === "portrait") {
        setOrientation("portrait");
        orientation = "portrait";
        isDirty = true;
        setStatus("جهت سند برای چاپ یک‌صفحه‌ای به عمودی تغییر کرد.");
      }
    }

    var plan = buildPrintPlan(rows, orientation);
    if (plan.overflowRowIndex != null) {
      var overflowMessage = plan.overflowKind === "final-page"
        ? "بخش پایانی سند یا ردیف " + toPersianDigits(plan.overflowRowIndex + 1) + " در فضای چاپی A4 جا نمی‌گیرد. توضیحات پایانی یا شرح آن ردیف را کوتاه‌تر کنید."
        : "ردیف " + toPersianDigits(plan.overflowRowIndex + 1) + " حتی به‌تنهایی در فضای چاپی A4 جا نمی‌گیرد. شرح این ردیف را کوتاه‌تر یا بین چند قلم تقسیم کنید.";
      await showAppDialog({
        title: "محتوای سند برای یک صفحه بیش از حد بلند است",
        message: overflowMessage + " برنامه برای جلوگیری از بریده‌شدن متن، چاپ را متوقف کرد.",
        actions: [{ id: "ok", label: "بازگشت و اصلاح", primary: true }],
      });
      return;
    }
    if (plan.chunks.length > 1) {
      var confirmed = await showAppDialog({
        title: "چاپ چندصفحه‌ای",
        message: "این پیش‌فاکتور در " + toPersianDigits(plan.chunks.length) + " صفحه چاپ می‌شود. سربرگ ادامه در هر صفحه تکرار و جمع نهایی فقط در صفحهٔ آخر درج خواهد شد.",
        actions: [
          { id: "print", label: "چاپ " + toPersianDigits(plan.chunks.length) + " صفحه", primary: true },
          { id: "cancel", label: "انصراف" },
        ],
      });
      if (confirmed.action !== "print") return;
    }

    renderPrintPlan(plan);
    var data = collectInvoiceData();
    commitInvoiceNumber(data.company.profile, data.meta.number);
    numberIsAutoSuggested = false;

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
      applyInvoiceData(blankInvoice());
      currentSavedId = null;
      currentSavedName = "";
      isDirty = false;
      numberIsAutoSuggested = true;
      stampRequested = false;
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

    customCompanyNameEl.addEventListener("input", function () {
      if (!isCustomProfile(profileSelectEl.value)) return;
      livePersianizeDigits(this);
      var name = this.value.trim();
      document.getElementById("inv-company-name").textContent = name;
      var sellerName = document.querySelector('[data-field="seller.name"]');
      if (sellerName) sellerName.value = name;
      invalidateFinalization();
      fitStaticFields();
      isDirty = true;
      setStatus("تغییرات ذخیره‌نشده");
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
      stampRequested = false;
      syncStampVisibility();
      if (numberIsAutoSuggested) {
        var numberInput = document.querySelector('[data-field="meta.number"]');
        if (numberInput) numberInput.value = suggestInvoiceNumber(nextKey);
      }
      isDirty = true;
      setStatus(isCustomProfile(nextKey) ? "نام و مشخصات شرکت را وارد کنید." : "شرکت صادرکننده تغییر کرد؛ سند دوباره نیاز به تأیید دارد.");
      if (isCustomProfile(nextKey)) customCompanyNameEl.focus();
    });

    validityModeEl.addEventListener("change", function () {
      var input = document.querySelector('[data-field="meta.validity"]');
      if (input) input.value = resolveValidityValue(this.value);
      syncValidityFieldVisibility(this.value);
      if (this.value === "manual" && input) input.focus();
      invalidateFinalization();
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
      invalidateFinalization();
      isDirty = true;
      setStatus(this.checked ? "پس‌زمینهٔ خاکستری هدر فعال شد." : "پس‌زمینهٔ هدر خاموش شد.");
    });

    document.getElementById("btn-company-editor").addEventListener("click", openCompanyEditor);
    document.getElementById("btn-company-editor-cancel").addEventListener("click", closeCompanyEditor);
    companyEditorDialogEl.addEventListener("click", function (e) {
      if (e.target === companyEditorDialogEl) closeCompanyEditor();
    });
    companyEditorFormEl.addEventListener("submit", function (e) {
      e.preventDefault();
      createCompanyProfileFromEditor();
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

    document.getElementById("btn-stamp-upload").addEventListener("click", function () {
      stampUploadFileEl.click();
    });
    stampUploadFileEl.addEventListener("change", async function () {
      var file = this.files && this.files[0];
      this.value = "";
      if (!file) return;
      var profileKey = profileSelectEl.value;
      var profile = resolveProfile(profileKey);
      var adHocProfile = isCustomProfile(profileKey);
      var previousStamp = adHocProfile ? adHocCompanyAssets.stamp : profile.stamp || "";
      stampUploadStatusEl.textContent = "در حال آماده‌سازی مهر…";
      try {
        var dataUrl = await resizeImageFile(file, 900);
        if (adHocProfile) {
          adHocCompanyAssets.stamp = dataUrl;
        } else {
          profile.stamp = dataUrl;
          if (profile.userCreated) persistUserProfiles();
          else persistProfileAsset(profileKey, "stamp", dataUrl);
        }
        stampRequested = false;
        setStampSrc(dataUrl);
        syncStampVisibility();
        isDirty = true;
        setStatus("مهر جدید برای «" + (profile.label || profile.name) + "» ثبت شد.");
      } catch (err) {
        if (adHocProfile) adHocCompanyAssets.stamp = previousStamp;
        else profile.stamp = previousStamp;
        setStampSrc(previousStamp);
        await showAppDialog({
          title: "افزودن مهر ناموفق بود",
          message: err.message || "تصویر مهر قابل استفاده نیست.",
          actions: [{ id: "ok", label: "متوجه شدم", primary: true }],
        });
      }
    });

    includeStampEl.addEventListener("change", async function () {
      if (!this.checked) {
        stampRequested = false;
        syncStampVisibility();
        isDirty = true;
        setStatus("مهر از نسخهٔ چاپی حذف شد.");
        return;
      }
      var errors = validateInvoiceForOutput();
      if (errors.length) {
        this.checked = false;
        stampRequested = false;
        await showAppDialog({
          title: "سند هنوز نهایی نیست",
          message: "قبل از درج مهر، اطلاعات ضروری و مبالغ را تکمیل کنید.",
          details: errors.slice(0, 8),
          actions: [{ id: "ok", label: "بازگشت و اصلاح", primary: true }],
        });
        return;
      }
      var confirmed = await confirmApp("درج مهر شرکت", "این گزینه سند را به‌عنوان نسخهٔ نهایی علامت می‌زند و مهر شرکت انتخاب‌شده را در چاپ قرار می‌دهد.", "تأیید و درج مهر");
      stampRequested = confirmed;
      this.checked = confirmed;
      syncStampVisibility();
      if (confirmed) {
        isDirty = true;
        setStatus("نسخهٔ نهایی با مهر شرکت آماده شد.");
      }
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
      setOrientation("landscape");
      recalcAll();
      isDirty = true;
      setStatus("جهت چاپ: افقی");
    });
    document.getElementById("orientation-portrait").addEventListener("change", function () {
      if (!this.checked) return;
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

    migrateLegacyAutosave();
    hydrateCompanyProfiles();
    // Every load starts a clean blank invoice — nothing is auto-restored.
    // Previously-saved invoices stay reachable from the "ذخیره‌شده‌ها" panel
    // (see openSavedEntry above), they just aren't loaded automatically.
    applyInvoiceData(blankInvoice());
    currentSavedId = null;
    currentSavedName = "";
    numberIsAutoSuggested = true;
    stampRequested = false;
    syncStampVisibility();
    setStatus("آماده برای ثبت پیش‌فاکتور جدید.");
    renderSavedList();
    isDirty = false;

    // Wired after the initial load so programmatic value-setting above
    // doesn't immediately mark the fresh document as having unsaved changes.
    sheet.addEventListener("input", function () {
      var stampWasRemoved = invalidateFinalization();
      isDirty = true;
      if (validationRequested) {
        validationRequested = false;
        validationEl.hidden = true;
      }
      setStatus(stampWasRemoved ? "سند تغییر کرد؛ مهر نهایی برداشته شد." : "تغییرات ذخیره‌نشده");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
