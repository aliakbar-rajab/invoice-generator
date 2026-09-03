/*
 * In-Memory Invoice Document Module.
 *
 * Owns the pure domain model, arbitrary-precision financial computations,
 * document validation invariants, Jalali calendar operations, and
 * serialization formats. Independent of DOM nodes and view adapters.
 */

var PN = (typeof window !== "undefined" && window.PersianNumbers)
  ? window.PersianNumbers
  : (typeof require === "function" ? require("./persian-numbers.js") : null);

if (!PN) {
  PN = {
    toAsciiDigits: function (v) { return String(v || ""); },
    toPersianDigits: function (v) { return String(v || ""); },
    normalizeStrictNumber: function (v) { return String(v || "").trim(); },
    parseMoneyBig: function () { return 0n; },
    parseQtyMilli: function () { return 0n; },
    parsePercentBps: function () { return 0n; },
    formatBigRial: function () { return "۰ ریال"; },
    formatQtyMilli: function () { return "۰"; },
    formatPercentBps: function () { return "۰"; },
    bigRoundDiv: function (n, d) { return d ? n / d : 0n; },
    rialToWordsBig: function () { return "صفر ریال"; }
  };
}

  var ROW_FIELDS = ["description", "quantity", "unit", "unitPrice"];
  var ROW_FIELD_LABELS = {
    description: "شرح کالا یا خدمت",
    quantity: "تعداد یا مقدار",
    unit: "واحد",
    unitPrice: "مبلغ واحد",
  };

  // ---------- Jalali Calendar Engine ----------

  var JALALI_MONTH_LENGTHS = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];

  function isJalaliLeapYear(jy) {
    var a = jy - 474;
    var b = (a % 2820 + 2820) % 2820 + 474;
    return (((b + 38) * 682) % 2816) < 682;
  }

  function jalaliMonthLength(jy, jm) {
    if (jm < 1 || jm > 12) return 30;
    if (jm <= 6) return 31;
    if (jm <= 11) return 30;
    return isJalaliLeapYear(jy) ? 30 : 29;
  }

  function gregorianToJalaliParts(gy, gm, gd) {
    var g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var gy2 = (gm > 2) ? (gy + 1) : gy;
    var days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) +
      Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1];
    var jy = -1595 + (33 * Math.floor(days / 12053));
    days %= 12053;
    jy += 4 * Math.floor(days / 1461);
    days %= 1461;
    if (days > 365) {
      jy += Math.floor((days - 1) / 365);
      days = (days - 1) % 365;
    }
    var jm, jd;
    if (days < 216) {
      jm = 1 + Math.floor(days / 31);
      jd = 1 + (days % 31);
    } else {
      jm = 7 + Math.floor((days - 216) / 30);
      jd = 1 + ((days - 216) % 30);
    }
    return { jy: jy, jm: jm, jd: jd };
  }

  function jalaliPartsToGregorianDate(jy, jm, jd) {
    var a = jy - 475;
    var b = (a % 2820 + 2820) % 2820 + 475;
    var days = jd - 1 + (jm <= 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186) +
      Math.floor(((b * 682) - 110) / 2816) + (b - 1) * 365 +
      Math.floor((a / 2820)) * 1029983 + (1948320.5 - 0.5);
    var jdn = Math.floor(days) + 0.5;
    var l = jdn + 68569;
    var n = Math.floor((4 * l) / 146097);
    l = l - Math.floor((146097 * n + 3) / 4);
    var i = Math.floor((4000 * (l + 1)) / 1461001);
    l = l - Math.floor((1461 * i) / 4) + 31;
    var j = Math.floor((80 * l) / 2447);
    var d = l - Math.floor((2447 * j) / 80);
    l = Math.floor(j / 11);
    var m = j + 2 - 12 * l;
    var y = 100 * (n - 49) + i + l;
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  }

  function formatJalaliYmd(jy, jm, jd) {
    var m = jm < 10 ? "0" + jm : String(jm);
    var d = jd < 10 ? "0" + jd : String(jd);
    return PN.toPersianDigits(jy + "/" + m + "/" + d);
  }

  function todayJalaliParts() {
    var now = new Date();
    return gregorianToJalaliParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  function todayJalaliString() {
    var p = todayJalaliParts();
    return formatJalaliYmd(p.jy, p.jm, p.jd);
  }

  function tomorrowJalaliString() {
    var now = new Date();
    var tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    var p = gregorianToJalaliParts(tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate());
    return formatJalaliYmd(p.jy, p.jm, p.jd);
  }

  function parseJalaliDate(raw) {
    if (!raw) return null;
    var ascii = PN.toAsciiDigits(String(raw)).trim();
    var match = ascii.match(/^(\d{2,4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
    if (!match) return null;
    var y = parseInt(match[1], 10);
    var m = parseInt(match[2], 10);
    var d = parseInt(match[3], 10);
    if (y < 100) y += 1400;
    if (m < 1 || m > 12) return null;
    var maxD = jalaliMonthLength(y, m);
    if (d < 1 || d > maxD) return null;
    return { jy: y, jm: m, jd: d, formatted: formatJalaliYmd(y, m, d) };
  }

  // ---------- Document Factory & Normalization ----------

  function createBlankItem() {
    return {
      description: "",
      quantity: "",
      unit: "",
      unitPrice: ""
    };
  }

  function itemIsBlank(item) {
    if (!item) return true;
    for (var i = 0; i < ROW_FIELDS.length; i += 1) {
      var val = item[ROW_FIELDS[i]];
      if (val !== null && val !== undefined && String(val).trim() !== "") {
        return false;
      }
    }
    return true;
  }

  function createBlankInvoice(options) {
    var opts = options || {};
    var orientation = opts.orientation || "landscape";
    var defaultCount = opts.defaultRowCount || (orientation === "portrait" ? 14 : 7);
    var rows = [];
    for (var i = 0; i < defaultCount; i += 1) {
      rows.push(createBlankItem());
    }

    return {
      version: 1,
      meta: {
        title: "پیش‌فاکتور",
        date: todayJalaliString(),
        number: "",
        validity: tomorrowJalaliString(),
        validityMode: "today"
      },
      company: {
        profileKey: opts.companyKey || "fouladBonyan",
        name: "",
        website: ""
      },
      seller: {
        name: "",
        address: "",
        postalCode: "",
        nationalId: "",
        phone: ""
      },
      buyer: {
        name: "",
        address: "",
        postalCode: "",
        nationalId: "",
        phone: ""
      },
      items: rows,
      taxPercent: "۱۰",
      notes: "",
      directives: {
        orientation: orientation,
        includeStamp: true,
        headerGray: true
      },
      assets: {
        logo: null,
        stamp: null
      }
    };
  }

  function normalizeInvoiceData(raw) {
    if (!raw || typeof raw !== "object") return null;

    var normalized = createBlankInvoice();
    if (raw.meta && typeof raw.meta === "object") {
      if (typeof raw.meta.title === "string") normalized.meta.title = raw.meta.title;
      if (typeof raw.meta.date === "string") normalized.meta.date = raw.meta.date;
      if (typeof raw.meta.number === "string") normalized.meta.number = raw.meta.number;
      if (typeof raw.meta.validity === "string") normalized.meta.validity = raw.meta.validity;
      if (typeof raw.meta.validityMode === "string") normalized.meta.validityMode = raw.meta.validityMode;
    }

    if (raw.company && typeof raw.company === "object") {
      if (typeof raw.company.profileKey === "string") normalized.company.profileKey = raw.company.profileKey;
      if (typeof raw.company.name === "string") normalized.company.name = raw.company.name;
      if (typeof raw.company.website === "string") normalized.company.website = raw.company.website;
    }

    var parties = ["seller", "buyer"];
    for (var p = 0; p < parties.length; p += 1) {
      var partyKey = parties[p];
      if (raw[partyKey] && typeof raw[partyKey] === "object") {
        var fields = ["name", "address", "postalCode", "nationalId", "phone"];
        for (var f = 0; f < fields.length; f += 1) {
          var fk = fields[f];
          if (typeof raw[partyKey][fk] === "string") {
            normalized[partyKey][fk] = raw[partyKey][fk];
          }
        }
      }
    }

    if (Array.isArray(raw.items)) {
      normalized.items = raw.items.map(function (it) {
        var clean = createBlankItem();
        if (it && typeof it === "object") {
          for (var i = 0; i < ROW_FIELDS.length; i += 1) {
            var f = ROW_FIELDS[i];
            clean[f] = it[f] != null ? String(it[f]) : "";
          }
        }
        return clean;
      });
    }

    // Default tax: if taxPercent is missing in raw backup, default to 0%
    if (raw.taxPercent !== undefined && raw.taxPercent !== null) {
      normalized.taxPercent = String(raw.taxPercent);
    } else {
      normalized.taxPercent = "۰";
    }

    if (typeof raw.notes === "string") normalized.notes = raw.notes;

    if (raw.directives && typeof raw.directives === "object") {
      if (raw.directives.orientation === "portrait" || raw.directives.orientation === "landscape") {
        normalized.directives.orientation = raw.directives.orientation;
      }
      if (typeof raw.directives.includeStamp === "boolean") {
        normalized.directives.includeStamp = raw.directives.includeStamp;
      }
      if (typeof raw.directives.headerGray === "boolean") {
        normalized.directives.headerGray = raw.directives.headerGray;
      }
    }

    if (raw.assets && typeof raw.assets === "object") {
      normalized.assets.logo = raw.assets.logo || null;
      normalized.assets.stamp = raw.assets.stamp || null;
    }

    return normalized;
  }

  // ---------- Financial Calculations ----------

  function computeItemTotal(item) {
    if (itemIsBlank(item)) {
      return { isBlank: true, isValid: true, totalBig: 0n, totalFormatted: "" };
    }

    var qRaw = item.quantity;
    var pRaw = item.unitPrice;

    var qtyMilli = (qRaw !== "" && qRaw !== null && qRaw !== undefined)
      ? PN.parseQtyMilli(qRaw)
      : null;
    var unitPrice = (pRaw !== "" && pRaw !== null && pRaw !== undefined)
      ? PN.parseMoneyBig(pRaw)
      : null;

    var hasQtyError = (qRaw !== "" && qRaw !== null && qRaw !== undefined) && qtyMilli === null;
    var hasPriceError = (pRaw !== "" && pRaw !== null && pRaw !== undefined) && unitPrice === null;

    if (hasQtyError || hasPriceError) {
      return {
        isBlank: false,
        isValid: false,
        hasQtyError: hasQtyError,
        hasPriceError: hasPriceError,
        totalBig: 0n,
        totalFormatted: ""
      };
    }

    var q = qtyMilli != null ? qtyMilli : 0n;
    var p = unitPrice != null ? unitPrice : 0n;
    var lineTotal = PN.bigRoundDiv(q * p, 1000n);

    return {
      isBlank: false,
      isValid: true,
      qtyMilli: q,
      unitPrice: p,
      totalBig: lineTotal,
      totalFormatted: lineTotal > 0n ? PN.formatBigRial(lineTotal) : (lineTotal === 0n ? "۰" : PN.formatBigRial(lineTotal))
    };
  }

  function computeTotals(invoice) {
    var items = (invoice && Array.isArray(invoice.items)) ? invoice.items : [];
    var rowResults = [];
    var grossTotal = 0n;
    var hasRowErrors = false;
    var activeCount = 0;

    for (var i = 0; i < items.length; i += 1) {
      var res = computeItemTotal(items[i]);
      rowResults.push(res);
      if (!res.isBlank) {
        activeCount += 1;
        if (!res.isValid) {
          hasRowErrors = true;
        } else {
          grossTotal += res.totalBig;
        }
      }
    }

    var taxRaw = invoice ? invoice.taxPercent : "۱۰";
    var taxBps = PN.parsePercentBps(taxRaw);
    var hasTaxError = taxBps === null;
    var effectiveTaxBps = taxBps != null ? taxBps : 0n;

    var taxTotal = PN.bigRoundDiv(grossTotal * effectiveTaxBps, 10000n);
    var netTotal = grossTotal + taxTotal;

    return {
      rows: rowResults,
      activeRowCount: activeCount,
      hasErrors: hasRowErrors || hasTaxError,
      hasTaxError: hasTaxError,
      grossTotal: grossTotal,
      taxTotal: taxTotal,
      netTotal: netTotal,
      grossTotalFormatted: PN.formatBigRial(grossTotal) + " ریال",
      taxTotalFormatted: PN.formatBigRial(taxTotal) + " ریال",
      netTotalFormatted: PN.formatBigRial(netTotal) + " ریال",
      netTotalWords: PN.rialToWordsBig(netTotal)
    };
  }

  // ---------- Document Validation Invariants ----------

  function validateInvoice(invoice) {
    var warnings = [];
    if (!invoice) {
      return [{ message: "سند پیش‌فاکتور یافت نشد." }];
    }

    var totals = computeTotals(invoice);

    if (totals.hasErrors) {
      warnings.push({ message: "برخی مقادیر عددی نامعتبر هستند و باید اصلاح شوند." });
    }

    if (totals.activeRowCount === 0) {
      warnings.push({ field: "items", message: "حداقل یک قلم کالا یا خدمت باید وارد شود." });
    }

    if (!invoice.meta || !invoice.meta.title || !invoice.meta.title.trim()) {
      warnings.push({ field: "meta.title", message: "عنوان سند نباید خالی باشد." });
    }

    if (!invoice.meta || !invoice.meta.date || !invoice.meta.date.trim()) {
      warnings.push({ field: "meta.date", message: "تاریخ پیش‌فاکتور نباید خالی باشد." });
    }

    var sellerName = (invoice.company && invoice.company.name) || (invoice.seller && invoice.seller.name) || "";
    if (!sellerName.trim()) {
      warnings.push({ field: "seller.name", message: "نام فروشنده نباید خالی باشد." });
    }

    var buyerName = (invoice.buyer && invoice.buyer.name) || "";
    if (!buyerName.trim()) {
      warnings.push({ field: "buyer.name", message: "نام خریدار نباید خالی باشد." });
    }

    return warnings;
  }

if (typeof window !== "undefined") {
  window.InvoiceDocument = {
    ROW_FIELDS: ROW_FIELDS,
    ROW_FIELD_LABELS: ROW_FIELD_LABELS,
    isJalaliLeapYear: isJalaliLeapYear,
    jalaliMonthLength: jalaliMonthLength,
    gregorianToJalaliParts: gregorianToJalaliParts,
    jalaliPartsToGregorianDate: jalaliPartsToGregorianDate,
    formatJalaliYmd: formatJalaliYmd,
    todayJalaliParts: todayJalaliParts,
    todayJalaliString: todayJalaliString,
    tomorrowJalaliString: tomorrowJalaliString,
    parseJalaliDate: parseJalaliDate,
    createBlankItem: createBlankItem,
    itemIsBlank: itemIsBlank,
    createBlankInvoice: createBlankInvoice,
    normalizeInvoiceData: normalizeInvoiceData,
    computeItemTotal: computeItemTotal,
    computeTotals: computeTotals,
    validateInvoice: validateInvoice,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ROW_FIELDS: ROW_FIELDS,
    ROW_FIELD_LABELS: ROW_FIELD_LABELS,
    isJalaliLeapYear: isJalaliLeapYear,
    jalaliMonthLength: jalaliMonthLength,
    gregorianToJalaliParts: gregorianToJalaliParts,
    jalaliPartsToGregorianDate: jalaliPartsToGregorianDate,
    formatJalaliYmd: formatJalaliYmd,
    todayJalaliParts: todayJalaliParts,
    todayJalaliString: todayJalaliString,
    tomorrowJalaliString: tomorrowJalaliString,
    parseJalaliDate: parseJalaliDate,
    createBlankItem: createBlankItem,
    itemIsBlank: itemIsBlank,
    createBlankInvoice: createBlankInvoice,
    normalizeInvoiceData: normalizeInvoiceData,
    computeItemTotal: computeItemTotal,
    computeTotals: computeTotals,
    validateInvoice: validateInvoice,
  };
}
