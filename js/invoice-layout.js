/*
 * Print Layout & Rhythm Engine.
 *
 * Implements the solved vertical rhythm bisection algorithm, A4 page
 * capacity probing, multi-page relief calculations, and continuation headers.
 */

var PN = (typeof window !== "undefined" && window.PersianNumbers)
  ? window.PersianNumbers
  : (typeof require === "function" ? require("./persian-numbers.js") : null);

if (!PN) {
  PN = {
    toPersianDigits: function (v) { return String(v || ""); }
  };
}

  var MM_TO_PX = 96 / 25.4;
  var PAGE_BOX_MM = {
    landscape: { w: 277, h: 190 },
    portrait: { w: 190, h: 277 },
  };
  var PAPER_MM = {
    landscape: { w: 297, h: 210 },
    portrait: { w: 210, h: 297 },
  };
  var PAGE_SAFE_MARGIN_MM = 10;

  var DENSITY_BISECTION_STEPS = 10;
  var TYPE_BISECTION_STEPS = 6;
  var TYPE_SCALE_MIN = 0.9;
  var ROW_EXTRA_MAX_MM = 5;
  var BLOCK_EXTRA_MAX_MM = 14;
  var FIT_HEADROOM_PX = 1;
  var FIT_TOLERANCE_PX = 1;
  var MAX_PRINT_ITEM_ROWS_PER_PAGE = 16;
  var NO_EXTRA = { row: 0, block: 0 };

  function pageHeightPx(orientation) {
    return PAGE_BOX_MM[orientation === "portrait" ? "portrait" : "landscape"].h * MM_TO_PX;
  }

  function applySheetRhythm(el, density, extra, typeScale) {
    el.style.setProperty("--print-density", density.toFixed(4));
    el.style.setProperty("--print-row-extra", (extra.row || 0).toFixed(3) + "mm");
    el.style.setProperty("--print-block-extra", (extra.block || 0).toFixed(3) + "mm");
    el.style.setProperty("--doc-font-scale", typeScale.toFixed(4));
  }

  function fitSheetToPage(el, rowCount, targetPx, options) {
    var stretchRows = !options || options.stretchRows !== false;
    var limit = targetPx - FIT_HEADROOM_PX;
    el.classList.add("is-measuring-natural");
    try {
      var measure = function (density, typeScale) {
        applySheetRhythm(el, density, NO_EXTRA, typeScale);
        return el.getBoundingClientRect().height;
      };

      var typeScale = 1;
      if (measure(0, 1) > limit) {
        if (measure(0, TYPE_SCALE_MIN) > limit) return null;
        var typeLo = TYPE_SCALE_MIN;
        var typeHi = 1;
        for (var t = 0; t < TYPE_BISECTION_STEPS; t += 1) {
          var typeMid = (typeLo + typeHi) / 2;
          if (measure(0, typeMid) <= limit) typeLo = typeMid;
          else typeHi = typeMid;
        }
        typeScale = typeLo;
      }

      var density = 1;
      if (measure(1, typeScale) > limit) {
        var densityLo = 0;
        var densityHi = 1;
        for (var d = 0; d < DENSITY_BISECTION_STEPS; d += 1) {
          var densityMid = (densityLo + densityHi) / 2;
          if (measure(densityMid, typeScale) <= limit) densityLo = densityMid;
          else densityHi = densityMid;
        }
        density = densityLo;
      }

      var extra = NO_EXTRA;
      if (density === 1) {
        var slackMm = (limit - measure(1, typeScale)) / MM_TO_PX;
        var row = stretchRows && rowCount > 0
          ? Math.max(0, Math.min(ROW_EXTRA_MAX_MM, slackMm / rowCount))
          : 0;
        var block = Math.max(0, Math.min(BLOCK_EXTRA_MAX_MM, slackMm - row * rowCount));
        extra = { row: row, block: block };
        applySheetRhythm(el, density, extra, typeScale);
        if (el.getBoundingClientRect().height > limit) extra = NO_EXTRA;
      }

      applySheetRhythm(el, density, extra, typeScale);
      return { density: density, extra: extra, typeScale: typeScale };
    } finally {
      el.classList.remove("is-measuring-natural");
    }
  }

  function makeContinuationHeader(pageIndex, totalPages, companyName) {
    var header = document.createElement("header");
    header.className = "inv-continuation-header";

    var title = document.createElement("span");
    title.className = "inv-continuation-title";
    title.textContent = (companyName ? companyName + " — " : "") + "پیش‌فاکتور (ادامه)";

    var pageNumber = document.createElement("span");
    pageNumber.className = "inv-continuation-page";
    pageNumber.textContent = "صفحهٔ " + PN.toPersianDigits(String(pageIndex)) + " از " + PN.toPersianDigits(String(totalPages));

    header.appendChild(title);
    header.appendChild(pageNumber);
    return header;
  }

if (typeof window !== "undefined") {
  window.InvoiceLayout = {
    MM_TO_PX: MM_TO_PX,
    PAGE_BOX_MM: PAGE_BOX_MM,
    PAPER_MM: PAPER_MM,
    PAGE_SAFE_MARGIN_MM: PAGE_SAFE_MARGIN_MM,
    DENSITY_BISECTION_STEPS: DENSITY_BISECTION_STEPS,
    TYPE_BISECTION_STEPS: TYPE_BISECTION_STEPS,
    TYPE_SCALE_MIN: TYPE_SCALE_MIN,
    ROW_EXTRA_MAX_MM: ROW_EXTRA_MAX_MM,
    BLOCK_EXTRA_MAX_MM: BLOCK_EXTRA_MAX_MM,
    FIT_HEADROOM_PX: FIT_HEADROOM_PX,
    FIT_TOLERANCE_PX: FIT_TOLERANCE_PX,
    MAX_PRINT_ITEM_ROWS_PER_PAGE: MAX_PRINT_ITEM_ROWS_PER_PAGE,
    NO_EXTRA: NO_EXTRA,
    pageHeightPx: pageHeightPx,
    applySheetRhythm: applySheetRhythm,
    fitSheetToPage: fitSheetToPage,
    makeContinuationHeader: makeContinuationHeader,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MM_TO_PX: MM_TO_PX,
    PAGE_BOX_MM: PAGE_BOX_MM,
    PAPER_MM: PAPER_MM,
    PAGE_SAFE_MARGIN_MM: PAGE_SAFE_MARGIN_MM,
    DENSITY_BISECTION_STEPS: DENSITY_BISECTION_STEPS,
    TYPE_BISECTION_STEPS: TYPE_BISECTION_STEPS,
    TYPE_SCALE_MIN: TYPE_SCALE_MIN,
    ROW_EXTRA_MAX_MM: ROW_EXTRA_MAX_MM,
    BLOCK_EXTRA_MAX_MM: BLOCK_EXTRA_MAX_MM,
    FIT_HEADROOM_PX: FIT_HEADROOM_PX,
    FIT_TOLERANCE_PX: FIT_TOLERANCE_PX,
    MAX_PRINT_ITEM_ROWS_PER_PAGE: MAX_PRINT_ITEM_ROWS_PER_PAGE,
    NO_EXTRA: NO_EXTRA,
    pageHeightPx: pageHeightPx,
    applySheetRhythm: applySheetRhythm,
    fitSheetToPage: fitSheetToPage,
    makeContinuationHeader: makeContinuationHeader,
  };
}
