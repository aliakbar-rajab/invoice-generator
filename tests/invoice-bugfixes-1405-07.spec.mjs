/*
 * Regression tests for the defects found in the 1405/07/06 bug hunt. Each one
 * was first reproduced against the unfixed app; the neighbouring behaviour a
 * fix could plausibly have broken is asserted alongside it.
 */
import { test, expect, openApp } from "./fixtures.mjs";

const SAVED_PREFIX = "preinvoice.saved.entry.v2.";

const GOOD_DATA = {
  version: 7,
  orientation: "landscape",
  meta: { title: "پیش‌فاکتور اصلی", date: "۱۴۰۵/۰۱/۰۱", number: "۱۴۰۵۰۱۰۱-۰۰۱", validityMode: "today" },
  buyer: { name: "خریدار اصلی" },
  seller: { name: "فروشنده" },
  company: { profile: "fouladBonyan", name: "بنیان فولاد داریا" },
  taxPercent: "۱۰",
  items: [{ description: "کالا", quantity: "۱", unit: "عدد", unitPrice: "۱۰۰۰" }],
};

// A value JSON can carry that the DOM cannot take: assigning it to a field
// throws "Cannot convert object to primitive value", partway through
// applyInvoiceData.
const UNASSIGNABLE = { toString: 1 };

function withChanges(changes) {
  return Object.assign(JSON.parse(JSON.stringify(GOOD_DATA)), changes);
}

async function seedSavedEntry(page, id, data) {
  await page.evaluate(({ key, entry }) => localStorage.setItem(key, JSON.stringify(entry)), {
    key: SAVED_PREFIX + id,
    entry: { id, name: id, savedAt: 1750000000000, data },
  });
}

async function openSaved(page, id) {
  await page.locator("#btn-saved-list").click();
  await page.locator("#saved-list li", { hasText: id }).getByRole("button", { name: "باز کردن" }).click();
}

async function importJsonFile(page, filename, contents) {
  await page.evaluate(({ name, body }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([body], name, { type: "application/json" }));
    const input = document.getElementById("file-open");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { name: filename, body: JSON.stringify(contents) });
}

const storedEntry = (page, id) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SAVED_PREFIX + id);

// ---------------------------------------------------------------------------
// A file that fails halfway through opening must not be saved over the entry
// that was open before it
// ---------------------------------------------------------------------------

test("a file that fails to apply puts the previous document back, still bound to its entry", async ({ page }) => {
  await openApp(page);
  await seedSavedEntry(page, "entry-kept", GOOD_DATA);
  await openSaved(page, "entry-kept");
  await expect(page.getByLabel("نام خریدار", { exact: true })).toHaveValue("خریدار اصلی");
  await page.getByLabel("تلفن خریدار", { exact: true }).fill("۰۹۱۲");

  await importJsonFile(page, "broken.json", withChanges({
    meta: { title: "عنوان فایل دیگر", date: "۱۳۹۹/۰۹/۰۹", number: UNASSIGNABLE },
    buyer: { name: "خریدار فایل" },
  }));
  await expect(page.locator("#app-dialog-title")).toContainText("باز کردن فایل");
  await page.locator("#app-dialog-actions button.primary").click();
  await expect(page.locator("#app-dialog-title")).toContainText("فایل نامعتبر");
  await expect(page.locator("#app-dialog-message")).toContainText("سند قبلی بدون تغییر باقی ماند");
  await page.locator("#app-dialog-actions button").first().click();

  // Nothing of the broken file is left on the sheet — including the fields it
  // managed to write before it threw — and the unsaved edit survives.
  await expect(page.locator('[data-field="meta.title"]')).toHaveText("پیش‌فاکتور اصلی");
  await expect(page.locator('[data-field="meta.date"]')).toHaveValue("۱۴۰۵/۰۱/۰۱");
  await expect(page.getByLabel("نام خریدار", { exact: true })).toHaveValue("خریدار اصلی");
  await expect(page.getByLabel("تلفن خریدار", { exact: true })).toHaveValue("۰۹۱۲");
  await expect(page.locator("#status-dot")).toHaveClass(/is-dirty/);

  // Still the same entry, so Save updates it in place — with the real document.
  await page.keyboard.press("Control+s");
  await expect(page.locator("#toolbar-status")).toContainText("ذخیره شد");
  const stored = await storedEntry(page, "entry-kept");
  expect(stored.data.meta.title).toBe("پیش‌فاکتور اصلی");
  expect(stored.data.meta.date).toBe("۱۴۰۵/۰۱/۰۱");
  expect(stored.data.buyer.phone).toBe("۰۹۱۲");
  expect(await page.evaluate(() => window.__rejections)).toEqual([]);
});

test("a saved entry that fails to apply also leaves the document on screen as it was", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("کار نیمه‌تمام");
  await seedSavedEntry(page, "entry-broken", withChanges({ buyer: { name: UNASSIGNABLE } }));
  await openSaved(page, "entry-broken");
  await page.locator("#app-dialog-actions button.primary").click();
  await expect(page.locator("#app-dialog-title")).toContainText("سند باز نشد");
  await page.locator("#app-dialog-actions button").first().click();

  await expect(page.getByLabel("نام خریدار", { exact: true })).toHaveValue("کار نیمه‌تمام");
  await expect(page.locator("#status-dot")).toHaveClass(/is-dirty/);
});

// ---------------------------------------------------------------------------
// A dialog opened straight after another closes waits for its own answer
// ---------------------------------------------------------------------------

test("the notice after a confirmation is not cancelled by the confirmation's own close event", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("کار نیمه‌تمام");
  await seedSavedEntry(page, "entry-race", withChanges({ buyer: { name: UNASSIGNABLE } }));
  await openSaved(page, "entry-race");
  await page.locator("#app-dialog-actions button.primary").click();
  await expect(page.locator("#app-dialog-title")).toContainText("سند باز نشد");

  // openSavedEntry sets this status only once the notice has been answered.
  // The confirmation's late `close` event used to settle the notice's promise
  // immediately, so the code ran on while the notice was still on screen.
  await page.waitForTimeout(300);
  await expect(page.locator("#app-dialog")).toBeVisible();
  await expect(page.locator("#toolbar-status")).not.toContainText("باز نشد");

  await page.locator("#app-dialog-actions button").first().click();
  await expect(page.locator("#toolbar-status")).toContainText("باز نشد");
});

test("Escape still cancels a dialog", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار");
  await page.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#app-dialog")).toBeHidden();
  // The Save flow saw a cancel and wrote nothing.
  expect(await page.evaluate((prefix) =>
    Object.keys(localStorage).filter((k) => k.startsWith(prefix)).length, SAVED_PREFIX)).toBe(0);
});

// ---------------------------------------------------------------------------
// Opening an invoice from a deleted company does not bring the company back
// ---------------------------------------------------------------------------

test("an invoice saved under a deleted company opens under «سایر» without re-creating it", async ({ page }) => {
  await openApp(page);
  await seedSavedEntry(page, "entry-orphan", withChanges({
    company: { profile: "company-deleted1", name: "شرکت حذف‌شده" },
    seller: { name: "شرکت حذف‌شده", address: "نشانی قدیمی" },
  }));
  await openSaved(page, "entry-orphan");

  await expect(page.locator("#company-profile")).toHaveValue("other");
  await expect(page.locator("#inv-company-name")).toHaveText("شرکت حذف‌شده");
  await expect(page.locator('[data-field="seller.address"]')).toHaveValue("نشانی قدیمی");
  await expect(page.locator("#company-profile option")).toHaveText(["بنیان فولاد داریا", "کارا برج پارسه", "سایر"]);
  expect(await page.evaluate(() => localStorage.getItem("preinvoice.companyProfiles.v1"))).toBeNull();
});

test("importing a file still adds its company to this browser, as before", async ({ page }) => {
  await openApp(page);
  await importJsonFile(page, "colleague.json", withChanges({
    company: { profile: "company-colleague1", name: "شرکت همکار" },
  }));
  await expect(page.locator("#company-profile")).toHaveValue("company-colleague1");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("preinvoice.companyProfiles.v1")));
  expect(Object.keys(stored)).toEqual(["company-colleague1"]);
});

// ---------------------------------------------------------------------------
// One malformed saved record does not take down the saved list and boot
// ---------------------------------------------------------------------------

test("a saved record with a non-text number still lists, and boot still tracks unsaved changes", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openApp(page);
  await seedSavedEntry(page, "entry-odd", withChanges({
    meta: { number: { nested: true } },
    company: { profile: "company-x", name: ["not", "text"] },
  }));
  await page.reload();
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);

  expect(errors).toEqual([]);
  await expect(page.locator("#saved-count")).toHaveText("۱");
  await page.locator("#btn-saved-list").click();
  await expect(page.locator("#saved-list li .saved-item-time")).toContainText("بدون شماره");
  await expect(page.locator("#saved-list li .saved-item-time")).toContainText("شرکت نامشخص");
  await page.locator("#btn-saved-close").click();

  // The input listener is wired at the very end of boot.
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار");
  await expect(page.locator("#status-dot")).toHaveClass(/is-dirty/);
});

// ---------------------------------------------------------------------------
// Merely visiting the date field does not stop it following the day
// ---------------------------------------------------------------------------

test("an untouched date that was only focused still rolls over at midnight", async ({ page }) => {
  // 23:59 in Tehran (UTC+03:30).
  await page.clock.install({ time: new Date("2026-09-28T20:29:00Z") });
  await openApp(page);
  const dateInput = page.locator('[data-field="meta.date"]');
  const before = await dateInput.inputValue();
  await dateInput.focus();
  await dateInput.press("Tab");

  await page.clock.setSystemTime(new Date("2026-09-28T20:31:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  const today = await page.evaluate(() => new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()));
  expect(today).not.toBe(before);
  await expect(dateInput).toHaveValue(today);
});

test("a date the user typed is still never overwritten at midnight", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-28T20:29:00Z") });
  await openApp(page);
  const dateInput = page.locator('[data-field="meta.date"]');
  await dateInput.fill("۱۴۰۵/۰۲/۰۲");
  await dateInput.press("Tab");

  await page.clock.setSystemTime(new Date("2026-09-28T20:31:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dateInput).toHaveValue("۱۴۰۵/۰۲/۰۲");
});
