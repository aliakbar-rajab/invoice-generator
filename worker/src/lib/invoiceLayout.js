/*
 * Page fitting for the generated invoice, run INSIDE the rendering browser.
 *
 * This module exports one function and it never executes in the Worker: pdf.js
 * hands it to `page.evaluate()`, so it is serialised with Function.toString()
 * and run in the page that is about to be printed. Everything it needs is
 * therefore in its own body — no imports, no closure over module scope, and
 * every inner helper is a plain declaration rather than a named arrow, since
 * a bundler that rewrites those (esbuild's keep-names pass, see keep_names in
 * wrangler.jsonc) would leave a call to a helper the page has never heard of.
 *
 * It is the bot's half of the app's fitSheetToPage/realizePrintPlan pair (see
 * js/app.js). The template has already chunked the items into pages; what is
 * left is the part that only a layout engine can answer:
 *
 *   1. Relief — a page whose descriptions wrap onto extra lines can overflow
 *      even at the tightest setting. Its trailing rows move to the next page
 *      until it fits, exactly as the app's capacity probe would have placed
 *      them, and a new final page is spun off if the last one runs out.
 *   2. Rhythm — each page is then solved for the most generous
 *      --print-density at which its content still fills A4 without spilling,
 *      so a seven-item invoice and a sixteen-item one are the same document
 *      at two densities rather than one layout with a hole in it.
 */

/**
 * @param {object} options
 * @param {number} options.maxRowsPerPage - hard per-sheet item cap (16)
 * @returns {{pages: number, densities: number[], typeScales: number[]}}
 */
export function layoutInvoicePages(options) {
  const MAX_ROWS = (options && options.maxRowsPerPage) || 16;
  const MM_TO_PX = 96 / 25.4;

  // Mirrors js/app.js. Ten steps resolve the density range to about one part
  // in a thousand — finer than any printer can render.
  const DENSITY_STEPS = 10;
  const TYPE_STEPS = 6;
  const TYPE_SCALE_MIN = 0.9;
  const ROW_EXTRA_MAX_MM = 5;
  const BLOCK_EXTRA_MAX_MM = 14;
  // Aim a hair under the page so the setting landed on has real headroom
  // rather than sitting exactly on the clipping boundary.
  const HEADROOM_PX = 1;
  // A page must always keep at least one item row; a sheet whose single row is
  // taller than A4 cannot be fixed by moving it somewhere else.
  const MIN_ROWS_PER_PAGE = 1;

  const NO_EXTRA = { row: 0, block: 0 };

  function toPersianDigits(value) {
    return String(value).replace(/[0-9]/g, function (digit) {
      return String.fromCharCode(digit.charCodeAt(0) + 1728);
    });
  }

  function applyRhythm(page, density, extra, typeScale) {
    page.style.setProperty("--print-density", density.toFixed(4));
    page.style.setProperty("--print-row-extra", (extra.row || 0).toFixed(3) + "mm");
    page.style.setProperty("--print-block-extra", (extra.block || 0).toFixed(3) + "mm");
    page.style.setProperty("--doc-font-scale", typeScale.toFixed(4));
  }

  // The height the page's content actually wants, as opposed to the fixed A4
  // box it is painted into.
  function naturalHeight(page) {
    page.classList.add("is-measuring-natural");
    const height = page.getBoundingClientRect().height;
    page.classList.remove("is-measuring-natural");
    return height;
  }

  function targetHeight(page) {
    // Read while the page is in its fixed-height state — this is the A4 box.
    return page.getBoundingClientRect().height - HEADROOM_PX;
  }

  /**
   * Applies the most generous rhythm at which the page's content still fits,
   * and reports it. Returns null when it does not fit even at the tightest
   * rhythm and the smallest type — the caller's cue to move rows off it.
   */
  function fitPage(page, rowCount, stretchRows) {
    const limit = targetHeight(page);
    function measure(density, typeScale) {
      applyRhythm(page, density, NO_EXTRA, typeScale);
      return naturalHeight(page);
    }

    let typeScale = 1;
    if (measure(0, 1) > limit) {
      // Second axis, deliberately narrow: a few per cent off the type rather
      // than a page break, but never below TYPE_SCALE_MIN.
      if (measure(0, TYPE_SCALE_MIN) > limit) return null;
      let lo = TYPE_SCALE_MIN;
      let hi = 1;
      for (let step = 0; step < TYPE_STEPS; step += 1) {
        const mid = (lo + hi) / 2;
        if (measure(0, mid) <= limit) lo = mid;
        else hi = mid;
      }
      typeScale = lo;
    }

    let density = 1;
    if (measure(1, typeScale) > limit) {
      let lo = 0;
      let hi = 1;
      for (let step = 0; step < DENSITY_STEPS; step += 1) {
        const mid = (lo + hi) / 2;
        if (measure(mid, typeScale) <= limit) lo = mid;
        else hi = mid;
      }
      density = lo;
    }

    // Density bottoms out at 1; a document short enough to leave the page
    // unfilled there spends what is left on the item rows and then on the
    // closing block, rather than leaving one dead band above the totals.
    let extra = NO_EXTRA;
    if (density === 1) {
      const slackMm = (limit - measure(1, typeScale)) / MM_TO_PX;
      const row = stretchRows && rowCount > 0
        ? Math.max(0, Math.min(ROW_EXTRA_MAX_MM, slackMm / rowCount))
        : 0;
      const block = Math.max(0, Math.min(BLOCK_EXTRA_MAX_MM, slackMm - row * rowCount));
      extra = { row, block };
      applyRhythm(page, density, extra, typeScale);
      // Both shares come from a measured slack, so this only trips on layout
      // rounding — but a residual that overflowed the page it was meant to
      // fill would be worse than no residual at all.
      if (naturalHeight(page) > limit) extra = NO_EXTRA;
    }

    applyRhythm(page, density, extra, typeScale);
    return { density, typeScale };
  }

  function sheetOf(page) {
    return page.querySelector("tbody");
  }

  function rowsOf(page) {
    return sheetOf(page).querySelectorAll("tr");
  }

  function makeContinuationPage(previous) {
    const page = document.createElement("article");
    page.className = previous.className;
    page.setAttribute("dir", "rtl");

    const head = document.getElementById("continuation-head-template");
    page.appendChild(head.content.cloneNode(true));

    const frame = previous.querySelector(".inv-table-frame").cloneNode(true);
    frame.querySelector("tbody").innerHTML = "";
    page.appendChild(frame);

    // The closing block belongs to whichever page is last, so it moves rather
    // than being duplicated.
    [".inv-summary", ".inv-footer"].forEach(function (selector) {
      const block = previous.querySelector(selector);
      if (block) page.appendChild(block);
    });

    const marker = document.createElement("div");
    marker.className = "print-page-marker";
    marker.textContent = document.body.dataset.continuationNote || "ادامه در صفحهٔ بعد";
    previous.appendChild(marker);

    previous.parentNode.insertBefore(page, previous.nextSibling);
    return page;
  }

  function pages() {
    return Array.prototype.slice.call(document.querySelectorAll(".invoice-sheet"));
  }

  // ---- 1. Relief ---------------------------------------------------------
  // Walk forward; whatever will not fit on a page is handed to the next one,
  // which the following iteration then re-checks in the same way.
  for (let index = 0; index < pages().length; index += 1) {
    const list = pages();
    const page = list[index];
    let guard = MAX_ROWS + 1;
    while (rowsOf(page).length > MIN_ROWS_PER_PAGE && guard > 0) {
      const isLast = index === pages().length - 1;
      const count = rowsOf(page).length;
      if (count <= MAX_ROWS && fitPage(page, count, isLast && pages().length === 1)) break;
      const next = pages()[index + 1] || makeContinuationPage(page);
      const rows = rowsOf(page);
      sheetOf(next).insertBefore(rows[rows.length - 1], sheetOf(next).firstChild);
      guard -= 1;
    }
  }

  // ---- 2. Renumber -------------------------------------------------------
  const finalPages = pages();
  let itemNumber = 0;
  finalPages.forEach(function (page, index) {
    rowsOf(page).forEach(function (row) {
      itemNumber += 1;
      const badge = row.querySelector(".row-index-badge");
      if (badge) badge.textContent = toPersianDigits(itemNumber);
    });
    const meta = page.querySelectorAll(".print-continuation-meta div");
    if (meta.length > 1) {
      meta[1].textContent = meta[1].textContent.replace(
        /صفحه .* از .*$/,
        "صفحه " + toPersianDigits(index + 1) + " از " + toPersianDigits(finalPages.length)
      );
    }
    if (finalPages.length > 1 && meta.length === 0 && !page.querySelector(".print-page-number")) {
      const number = document.createElement("span");
      number.className = "print-page-number";
      number.textContent =
        "صفحه " + toPersianDigits(index + 1) + " از " + toPersianDigits(finalPages.length);
      page.appendChild(number);
    }
  });

  // ---- 3. Solve ----------------------------------------------------------
  // Item rows only take a share of the residual on a single-sheet document:
  // across pages the rows are one continuous run, and stretching the few on
  // the last page to twice the height of the sixteen on the first reads as
  // two different tables.
  const densities = [];
  const typeScales = [];
  finalPages.forEach(function (page) {
    const solved = fitPage(page, rowsOf(page).length, finalPages.length === 1);
    densities.push(solved ? solved.density : 0);
    typeScales.push(solved ? solved.typeScale : TYPE_SCALE_MIN);
  });

  return { pages: finalPages.length, densities, typeScales };
}
