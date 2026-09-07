/*
 * Regression tests for the web-interface-guidelines review (1405/06/02):
 * dialog focus trap, the saved-panel close button's accessible name,
 * inputmode hints on numeric/tel/url fields, dialog-button hover feedback,
 * and overscroll containment on the two scrollable overlay panels.
 */
import { test, expect, openApp, cell } from "./fixtures.mjs";


// Opens the plain two-button "پیش‌فاکتور جدید" confirm dialog by making the
// current document dirty first (btn-new only prompts when isDirty is true).
async function openConfirmDialog(page) {
  await cell(page, 1, "description").fill("کالای آزمایشی");
  await page.locator("#btn-new").click();
  await expect(page.locator("#app-dialog")).toBeVisible();
}

// ---------------------------------------------------------------------------
// Accessible name on the icon-only close button
// ---------------------------------------------------------------------------

test("saved-panel close button exposes an accessible name beyond the ✕ glyph", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("#btn-saved-close")).toHaveAttribute("aria-label", "بستن");
});

// ---------------------------------------------------------------------------
// inputmode hints
// ---------------------------------------------------------------------------

test("numeric/tel/url fields carry matching inputmode hints", async ({ page }) => {
  await openApp(page);
  for (const field of ["seller.postalCode", "seller.nationalId", "buyer.postalCode", "buyer.nationalId"]) {
    await expect(page.locator(`[data-field="${field}"]`)).toHaveAttribute("inputmode", "numeric");
  }
  for (const field of ["seller.phone", "buyer.phone"]) {
    await expect(page.locator(`[data-field="${field}"]`)).toHaveAttribute("inputmode", "tel");
  }
  await expect(page.locator('[data-field="company.website"]')).toHaveAttribute("inputmode", "url");

  await page.locator("#btn-settings").click();
  await page.locator("#btn-company-editor").click();
  await expect(page.locator("#company-editor-dialog")).toBeVisible();
  await expect(page.locator("#company-editor-phones")).toHaveAttribute("inputmode", "tel");
  await expect(page.locator("#company-editor-website")).toHaveAttribute("inputmode", "url");
});

// ---------------------------------------------------------------------------
// Dialog focus trap
// ---------------------------------------------------------------------------

// The dialogs are native <dialog>s opened with showModal(), so the focus trap
// is the browser's: nothing behind the dialog is reachable by Tab, and the
// background is genuinely inert rather than merely labelled aria-modal.
// Chromium's wrap passes through <body> on its way from the last control back
// to the first, so these walk the cycle rather than asserting a single step.
async function tabThroughCycle(page, presses, key = "Tab") {
  const seen = [];
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press(key);
    seen.push(await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      const dialog = el.closest("dialog[open]");
      return dialog ? `in:${dialog.id}` : `OUTSIDE:${el.id || el.tagName}`;
    }));
  }
  return seen;
}

test("Tab stays inside the confirm dialog instead of escaping to the toolbar behind it", async ({ page }) => {
  await openApp(page);
  await openConfirmDialog(page);

  const buttons = page.locator("#app-dialog-actions button");
  await expect(buttons).toHaveCount(2);
  const first = buttons.nth(0);
  const last = buttons.nth(1);

  // Walking the whole cycle must never reach a control behind the dialog.
  await last.focus();
  const forward = await tabThroughCycle(page, 6);
  expect(forward.filter((step) => step.startsWith("OUTSIDE:"))).toEqual([]);

  // ...and it does come back round to the first action.
  await last.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();

  await last.click();
  await expect(page.locator("#app-dialog")).toBeHidden();
});

test("Escape closes the confirm dialog and settles it as a cancel", async ({ page }) => {
  await openApp(page);
  await openConfirmDialog(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#app-dialog")).toBeHidden();
  // Cancelling «پیش‌فاکتور جدید» must leave the typed row untouched.
  await expect(cell(page, 1, "description")).toHaveValue("کالای آزمایشی");
});

test("Tab stays inside the company editor dialog across its full field list", async ({ page }) => {
  await openApp(page);
  await page.locator("#btn-settings").click();
  await page.locator("#btn-company-editor").click();
  await expect(page.locator("#company-editor-dialog")).toBeVisible();

  const first = page.locator("#company-editor-name");
  const last = page.locator("#btn-company-editor-submit");

  await last.focus();
  await expect(last).toBeFocused();
  const forward = await tabThroughCycle(page, 8);
  expect(forward.filter((step) => step.startsWith("OUTSIDE:"))).toEqual([]);

  await last.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();

  await page.locator("#btn-company-editor-cancel").click();
  await expect(page.locator("#company-editor-dialog")).toBeHidden();
});

test("focus trap only ever engages while a dialog is actually open", async ({ page }) => {
  await openApp(page);
  const companySelect = page.locator("#company-profile");
  await companySelect.focus();
  await expect(companySelect).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(companySelect).not.toBeFocused();
  await expect(page.locator("#app-dialog")).toBeHidden();
  await expect(page.locator("#company-editor-dialog")).toBeHidden();
});

// ---------------------------------------------------------------------------
// Hover feedback on dialog action buttons
// ---------------------------------------------------------------------------

test("dialog action buttons visibly react to hover", async ({ page }) => {
  await openApp(page);
  await openConfirmDialog(page);

  const cancelBtn = page.locator("#app-dialog-actions button").nth(1);
  const restColor = await cancelBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
  await cancelBtn.hover();
  const hoverColor = await cancelBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(hoverColor).not.toBe(restColor);

  await cancelBtn.click();
  await expect(page.locator("#app-dialog")).toBeHidden();
});

// ---------------------------------------------------------------------------
// Overscroll containment on the two scrollable overlay panels
// ---------------------------------------------------------------------------

test("scrollable overlay panels contain overscroll instead of chaining to the page", async ({ page }) => {
  await openApp(page);

  await page.locator("#btn-settings").click();
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#settings-panel")).toHaveCSS("overscroll-behavior-y", "contain");
  await page.locator("#btn-settings").click();

  await page.locator("#btn-saved-list").click();
  await expect(page.locator("#saved-panel")).toBeVisible();
  await expect(page.locator("#saved-panel")).toHaveCSS("overscroll-behavior-y", "contain");
});
