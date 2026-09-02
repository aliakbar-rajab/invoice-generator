/*
 * The printed sheet, and whether the editor is honest about it.
 *
 * Two things are checked here that the rest of the suite cannot see. One is
 * what happens when the print dialog hands back a page box smaller than the
 * sheet was designed for — the browser will not tell us, and the loss only
 * shows on paper. The other is fidelity: the editor claims to be a preview of
 * the print clone, so wherever the two are solved separately they have to land
 * in the same place.
 */
import { test, expect } from "@playwright/test";
import { startRepoServer, stopRepoServer } from "./server-helper.mjs";

let server;
let baseURL;

test.beforeAll(async () => {
  ({ server, baseURL } = await startRepoServer());
});

test.afterAll(async () => {
  await stopRepoServer(server);
});

async function openApp(page) {
  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => { window.__printCalls += 1; };
  });
  await page.goto(baseURL);
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
}

const persian = (value) =>
  String(value).replace(/[0-9]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 1728));

async function fillRow(page, index, description, quantity, price) {
  const n = persian(index);
  await page.getByLabel(`ردیف ${n} — شرح کالا یا خدمت`, { exact: true }).fill(description);
  await page.getByLabel(`ردیف ${n} — تعداد یا مقدار`, { exact: true }).fill(quantity);
  await page.getByLabel(`ردیف ${n} — مبلغ واحد`, { exact: true }).fill(price);
}

async function printAndMeasure(page) {
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await page.waitForFunction(() => window.__printCalls > 0);
  await page.emulateMedia({ media: "print" });
}

// The page boxes Chrome's three Margins settings leave behind on A4, measured
// on the paper. The sheet has to survive all of them; Default is the one the
// dialog starts on, and the one a 287x200mm sheet used to lose 5mm off the top
// and bottom to.
const A4_LANDSCAPE_PAGE_BOXES = [
  { label: "Margins: None", w: 297, h: 210 },
  { label: "Margins: Minimum", w: 289, h: 202 },
  { label: "Margins: Default", w: 277, h: 190 },
];

test("the printed sheet survives every page box the print dialog can hand back", async ({ page }) => {
  await openApp(page);
  await fillRow(page, 1, "میلگرد آجدار A3 سایز ۱۶ شاخه ۱۲ متری", "12", "1500000");
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار آزمایشی");
  await printAndMeasure(page);

  for (const box of A4_LANDSCAPE_PAGE_BOXES) {
    const result = await page.evaluate(({ w, h }) => {
      const MM = 96 / 25.4;
      const root = document.getElementById("print-document");
      const slot = root.querySelector(".print-slot");
      const sheet = slot.querySelector(".print-page");
      // Stand in for the page box the dialog left behind. In real print media
      // the slot takes its height from 100vh and its width from the document,
      // both of which resolve to that box.
      root.style.width = `${w}mm`;
      slot.style.height = `${h}mm`;
      void slot.offsetHeight;
      const slotRect = slot.getBoundingClientRect();
      const sheetRect = sheet.getBoundingClientRect();
      root.style.width = "";
      slot.style.height = "";
      return {
        sheetWmm: sheetRect.width / MM,
        sheetHmm: sheetRect.height / MM,
        overflowTop: slotRect.top - sheetRect.top,
        overflowBottom: sheetRect.bottom - slotRect.bottom,
        overflowLeft: slotRect.left - sheetRect.left,
        overflowRight: sheetRect.right - slotRect.right,
      };
    }, box);

    // Nothing is cut off on any edge. `overflow: hidden` on the slot means a
    // failure here is silent on screen and only visible on paper, which is
    // exactly why it is asserted rather than eyeballed.
    for (const [edge, value] of Object.entries({
      top: result.overflowTop,
      bottom: result.overflowBottom,
      left: result.overflowLeft,
      right: result.overflowRight,
    })) {
      expect(value, `${box.label}: the sheet must not run off the ${edge} of the page box`)
        .toBeLessThanOrEqual(0.5);
    }

    // And it fits at its true size rather than by reflowing. A flex item
    // shrinks to its container by default, which redraws the design at the
    // wrong proportions instead of scaling it — `flex-shrink: 0` forbids that,
    // so the sheet is the same 277x190mm in every box above.
    expect(result.sheetWmm, `${box.label}: the sheet must keep its designed width`)
      .toBeCloseTo(277, 0);
    expect(result.sheetHmm, `${box.label}: the sheet must keep its designed height`)
      .toBeCloseTo(190, 0);
  }
});

test("the sheet, its print clone and the @page rule all agree on one box", async ({ page }) => {
  await openApp(page);

  for (const [orientation, radio, paper, sheetW, sheetH] of [
    ["landscape", "افقی", "297mm 210mm", 277, 190],
    ["portrait", "عمودی", "210mm 297mm", 190, 277],
  ]) {
    await page.locator(`#orientation-${orientation}`).check({ force: true });
    await expect(page.locator("#invoice-sheet")).toHaveClass(new RegExp(`orientation-${orientation}`));
    await page.waitForTimeout(250);

    const rule = await page.evaluate(() => document.getElementById("page-size-style").textContent);
    // The @page margin is half the difference between paper and sheet on each
    // axis, so the box the browser is asked for is the box the sheet is drawn
    // at. 297-2*10 = 277, 210-2*10 = 190.
    expect(rule, `${radio}: @page must ask for A4 in this orientation`).toContain(paper);
    expect(rule, `${radio}: @page margin must match the safe band`).toContain("margin: 10mm");

    const measured = await page.locator("#invoice-sheet").evaluate((sheet) => {
      const MM = 96 / 25.4;
      const styles = getComputedStyle(sheet);
      return {
        widthMm: parseFloat(styles.getPropertyValue("--page-w")) ,
        heightMm: parseFloat(styles.getPropertyValue("--page-h")),
        renderedWmm: sheet.getBoundingClientRect().width / MM,
      };
    });
    expect(measured.widthMm, `${radio}: --page-w`).toBeCloseTo(sheetW, 1);
    expect(measured.heightMm, `${radio}: --page-h`).toBeCloseTo(sheetH, 1);
    expect(measured.renderedWmm, `${radio}: the editor draws the same box`).toBeCloseTo(sheetW, 0);
  }
});

test("a figure too long for its column keeps its shrink in the print clone, on one line", async ({ page }) => {
  await openApp(page);
  // Long enough that fitNumericEl has to shrink the unit-price cell's font to
  // get the digits onto one line in the editor.
  await fillRow(page, 1, "کالای آزمایشی", "1", "999999999999999999999");
  await page.waitForTimeout(300);

  const readCell = (root) => {
    const price = root.querySelector('[data-row-field="unitPrice"]');
    return {
      inlineFontSize: price.style.fontSize,
      fontSize: parseFloat(getComputedStyle(price).fontSize),
      height: price.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(price).lineHeight),
    };
  };

  expect(
    (await page.locator("#inv-rows tr").first().evaluate(readCell)).inlineFontSize,
    "the editor must have shrunk the price to fit"
  ).not.toBe("");

  await printAndMeasure(page);

  // Read the editor again AFTER printing, not before: printing runs recalcAll,
  // which re-fits every numeric cell, and the clone is built from the state
  // that leaves behind. Comparing against the pre-print value would compare
  // the clone with an editor that no longer exists.
  const editor = await page.locator("#inv-rows tr").first().evaluate(readCell);
  expect(editor.height / editor.lineHeight, "the editor shows it on one line").toBeLessThan(1.6);

  const printed = await page.locator("#print-document .print-page").first().evaluate((sheet) => {
    const price = sheet.querySelector('tbody tr [data-row-field="unitPrice"]');
    return {
      tagName: price.tagName,
      text: price.textContent,
      fontSize: parseFloat(getComputedStyle(price).fontSize),
      whiteSpace: getComputedStyle(price).whiteSpace,
      height: price.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(price).lineHeight),
    };
  });

  // The <input> is swapped for a <span> on the way into the clone, and the
  // shrink lives as an inline font-size on the input. Dropped, the clone
  // printed the same number at full size, wrapped onto two lines, in a row
  // most of a centimetre taller than the editor's.
  expect(printed.tagName).toBe("SPAN");
  expect(printed.text, "the whole number must reach the page").toContain("۹۹۹");
  expect(printed.fontSize, "the print clone must carry the editor's shrink")
    .toBeCloseTo(editor.fontSize, 1);
  expect(printed.whiteSpace, "a money figure must not wrap in the clone").toBe("nowrap");
  expect(printed.height / printed.lineHeight, "it must print on one line, as previewed")
    .toBeLessThan(1.6);
});

test("the editor and the print clone draw an item row the same, not just the gap below it", async ({ page }) => {
  await openApp(page);
  const descriptions = [
    "میلگرد آجدار A3 سایز ۱۶ شاخه ۱۲ متری",
    "تیرآهن IPE سایز ۱۴ شاخه ۱۲ متری",
    "قوطی صنعتی ۴۰ در ۴۰ ضخامت ۲ میلی‌متر",
    "نبشی بال مساوی ۴۰ در ۴۰ شاخه ۶ متری",
  ];
  for (let index = 0; index < 12; index += 1) {
    if (index >= 7) await page.getByRole("button", { name: "افزودن ردیف/قلم جدید", exact: true }).click();
    await fillRow(page, index + 1, descriptions[index % descriptions.length], "10", "150000000");
  }
  // The editor's solve is debounced (scheduleSheetRhythm), so let it settle.
  await page.waitForTimeout(400);

  const read = (element) => {
    const cell = element.querySelector('tbody tr [data-row-field="description"]');
    const cellStyles = getComputedStyle(cell);
    return {
      // The leading as a RATIO, not in pixels: --rhythm-cell-line is declared
      // in em, so its pixel value depends on the density it was solved at.
      // Comparing pixels would be circular — two sheets at different densities
      // are supposed to have different pixel leading.
      cellLeading: parseFloat(cellStyles.lineHeight) / parseFloat(cellStyles.fontSize),
      rowHeight: element.querySelector("tbody tr").getBoundingClientRect().height,
    };
  };

  const editor = await page.locator("#invoice-sheet").evaluate(read);
  await printAndMeasure(page);
  const printed = await page.locator("#print-document .print-page").last().evaluate(read);

  // The item cells' leading used to be declared only under .print-page, so
  // the editor's rows sat on --rhythm-field-line while the clone's sat on the
  // looser --rhythm-cell-line. The preview drew every item row tighter than
  // it printed, and the gap below the table — the one thing that was being
  // checked — stayed inside its tolerance throughout, so nothing caught it.
  expect(editor.cellLeading, "the editor must use the item-cell leading, not the field leading")
    .toBeGreaterThanOrEqual(1.35);
  expect(Math.abs(editor.cellLeading - printed.cellLeading),
    "editor and clone must give item cells the same leading").toBeLessThanOrEqual(0.06);

  // What the user actually sees is the row, not the scalar behind it. The two
  // --print-density values still differ by up to ~0.25, and structurally must:
  // the editor carries a screen-only delete column and textareas pinned to
  // grown pixel heights, so it reaches its floor earlier than the clone does.
  // The claim the preview makes is about geometry, and the geometry agrees —
  // within about a third of a millimetre per row.
  expect(Math.abs(editor.rowHeight - printed.rowHeight),
    "an item row must be the same height in the preview and on the page")
    .toBeLessThanOrEqual(2);
});
