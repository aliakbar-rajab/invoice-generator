/*
 * Regression tests for the eight defects found in the 1405/06/01 bug hunt.
 * One describe block per defect; each asserts the broken behaviour is gone AND
 * that the neighbouring behaviour it could plausibly have broken still works.
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
    window.__rejections = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.__rejections.push(String((event.reason && event.reason.message) || event.reason));
    });
  });
  await page.goto(baseURL);
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
}

const persian = (n) => String(n).replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 1728));
const ROW_LABEL = {
  description: "شرح کالا یا خدمت",
  quantity: "تعداد یا مقدار",
  unit: "واحد",
  unitPrice: "مبلغ واحد"
};
const cell = (page, n, field) => page.getByLabel(`ردیف ${persian(n)} — ${ROW_LABEL[field]}`, { exact: true });
const warnings = (page) => page.locator("#invoice-validation-list li");
const warningTexts = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll("#invoice-validation-list li")).map((li) => li.textContent));

async function fillValidFirstRow(page, price = "1000") {
  await cell(page, 1, "description").fill("کالای آزمایشی");
  await cell(page, 1, "quantity").fill("1");
  await cell(page, 1, "unitPrice").fill(price);
}

// ---------------------------------------------------------------------------
// Defect 1 — separators are only stripped when they really are grouping
// ---------------------------------------------------------------------------

// "1,5" is a comma used as a DECIMAL separator, which is what many keyboards
// produce. It used to be read as 15 — a silent tenfold error — while "1.5"
// was correctly rejected.
const MALFORMED_GROUPING = ["1,5", "1 5", "1٬5", "12,34", "1,00", "1,0000", "1,000,00", "1.0,5"];
const VALID_GROUPING = [
  ["1000", "۱٬۰۰۰"],
  ["1,000", "۱٬۰۰۰"],
  ["1٬000", "۱٬۰۰۰"],
  ["1 000", "۱٬۰۰۰"],
  ["1,000,000", "۱٬۰۰۰٬۰۰۰"],
  ["1٬234٬567", "۱٬۲۳۴٬۵۶۷"]
];

test("malformed grouping is rejected in the unit price instead of multiplying by ten", async ({ page }) => {
  await openApp(page);
  await cell(page, 1, "description").fill("کالا");
  await cell(page, 1, "quantity").fill("1");
  for (const bad of MALFORMED_GROUPING) {
    await cell(page, 1, "unitPrice").fill(bad);
    await cell(page, 1, "unitPrice").blur();
    await expect(warnings(page), `unit price "${bad}" must be rejected`)
      .toContainText("مبلغ واحد معتبر نیست");
    // Never silently contributes an invented amount to the totals: the row is
    // excluded outright rather than counted at ten times its value.
    await expect(page.locator('[data-row-computed="total"]').first()).toHaveText("");
    await expect(page.locator('[data-total="netTotal"]')).toHaveText("۰ ریال");
  }
});

test("legitimate grouping still parses in the unit price", async ({ page }) => {
  await openApp(page);
  await cell(page, 1, "description").fill("کالا");
  await cell(page, 1, "quantity").fill("1");
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill("0");
  for (const [input, expected] of VALID_GROUPING) {
    await cell(page, 1, "unitPrice").fill(input);
    await cell(page, 1, "unitPrice").blur();
    await expect(warnings(page), `unit price "${input}" must be accepted`).toHaveCount(0);
    await expect(page.locator('[data-total="netTotal"]')).toHaveText(expected + " ریال");
    // Reformatting on blur normalizes it to the app's own grouped form, which
    // must itself parse back to the same number.
    await expect(cell(page, 1, "unitPrice")).toHaveValue(expected);
  }
});

test("malformed grouping is rejected in the quantity", async ({ page }) => {
  await openApp(page);
  await cell(page, 1, "description").fill("کالا");
  await cell(page, 1, "unitPrice").fill("1000");
  for (const bad of MALFORMED_GROUPING) {
    await cell(page, 1, "quantity").fill(bad);
    await cell(page, 1, "quantity").blur();
    await expect(warnings(page), `quantity "${bad}" must be rejected`)
      .toContainText("تعداد/مقدار معتبر نیست");
    await expect(page.locator('[data-row-computed="total"]').first()).toHaveText("");
  }
  // The decimal forms the app itself writes are untouched.
  await cell(page, 1, "quantity").fill("2٫5");
  await cell(page, 1, "quantity").blur();
  await expect(warnings(page)).toHaveCount(0);
  await expect(page.locator('[data-row-computed="total"]').first()).toHaveText("۲٬۵۰۰");
  await cell(page, 1, "quantity").fill("1٬234٫567");
  await cell(page, 1, "quantity").blur();
  await expect(warnings(page)).toHaveCount(0);
  await expect(cell(page, 1, "quantity")).toHaveValue("۱٬۲۳۴٫۵۶۷");
});

test("a malformed tax rate is reported and blocks output, never applied as ten times itself", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page, "1000");
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill("1,5");
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).blur();
  // 1,5 used to become 15% (۱۵۰ ریال). It is now neither 15% nor a silent 0%.
  await expect(warnings(page)).toContainText("درصد مالیات");
  await expect(page.locator('[data-total="taxTotal"]')).toHaveText("۰ ریال");
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(0);
  await expect(page.locator("#toolbar-status")).toContainText("خطاهای مالی");
  // A genuine decimal rate still works.
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill("1.5");
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).blur();
  await expect(warnings(page)).toHaveCount(0);
  await expect(page.locator('[data-total="taxTotal"]')).toHaveText("۱۵ ریال");
});

test("the app's own formatted figures survive a save and reopen unchanged", async ({ page }) => {
  await openApp(page);
  await cell(page, 1, "description").fill("میلگرد");
  await cell(page, 1, "quantity").fill("2٫5");
  await cell(page, 1, "unitPrice").fill("1,200,000");
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار");
  await page.getByLabel("درصد مالیات و عوارض", { exact: true }).blur();
  await expect(page.locator('[data-total="netTotal"]')).toHaveText("۳٬۳۰۰٬۰۰۰ ریال");

  await page.getByRole("button", { name: "ذخیره", exact: true }).click();
  await page.locator("#app-dialog-input").fill("گرد کردن");
  await page.locator("#app-dialog-actions button").first().click();
  await expect(page.locator("#toolbar-status")).toContainText("ذخیره شد");
  await page.getByRole("button", { name: "پیش‌فاکتور جدید", exact: true }).click();
  await page.evaluate(() => document.getElementById("btn-saved-list").click());
  await page.locator("#saved-list button", { hasText: "باز کردن" }).first().click();

  await expect(page.locator('[data-total="netTotal"]')).toHaveText("۳٬۳۰۰٬۰۰۰ ریال");
  await expect(warnings(page)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Defect 2 — impossible Jalali dates are rejected, never papered over
// ---------------------------------------------------------------------------

async function setDate(page, value) {
  await page.locator('[data-field="meta.date"]').fill(value);
  await page.locator('[data-field="meta.date"]').blur();
}

test("impossible and garbled invoice dates are reported instead of accepted", async ({ page }) => {
  await openApp(page);
  // ۱۴۰۴/۱۲/۳۰ parses as three numbers but 1404 is not a leap year, so Esfand
  // has 29 days and that date does not exist.
  for (const bad of ["۱۴۰۴/۱۲/۳۰", "۱۴۰۴/۱۳/۰۱", "۱۴۰۴/۰۲/۳۲", "۹۹۹۹/۹۹/۹۹", "۰۰۰۰/۰۰/۰۰", "abc", "۱۴۰۴/۰۶"]) {
    await setDate(page, bad);
    await expect(warnings(page), `date "${bad}" must be reported`)
      .toContainText("تاریخ پیش‌فاکتور یک تاریخ معتبر شمسی نیست");
  }
});

test("an impossible date blanks the validity field rather than substituting the real-world date", async ({ page }) => {
  await openApp(page);
  const validity = page.locator('[data-field="meta.validity"]');
  for (const mode of ["today", "tomorrow"]) {
    await page.locator("#meta-validity-mode").selectOption(mode);
    await setDate(page, "۱۴۰۴/۱۲/۳۰");
    // Previously: today's / tomorrow's real date — six months away from the
    // date printed in the header, and indistinguishable from a real answer.
    await expect(validity, `${mode} mode must not invent a validity`).toHaveValue("");
    await setDate(page, "abc");
    await expect(validity).toHaveValue("");
  }
});

test("real Jalali dates, including leap-year Esfand 30, still resolve correctly", async ({ page }) => {
  await openApp(page);
  await page.locator("#meta-validity-mode").selectOption("tomorrow");
  const validity = page.locator('[data-field="meta.validity"]');
  // 1403 IS a leap year, so 1403/12/30 exists and rolls into the new year.
  await setDate(page, "۱۴۰۳/۱۲/۳۰");
  await expect(warnings(page)).toHaveCount(0);
  await expect(validity).toHaveValue("۱۴۰۴/۰۱/۰۱");
  // Month-length rollovers on both sides of the 31/30-day boundary.
  await setDate(page, "۱۴۰۴/۰۶/۳۱");
  await expect(validity).toHaveValue("۱۴۰۴/۰۷/۰۱");
  await setDate(page, "۱۴۰۴/۰۷/۳۰");
  await expect(validity).toHaveValue("۱۴۰۴/۰۸/۰۱");
  await setDate(page, "۱۴۰۴/۱۲/۲۹");
  await expect(validity).toHaveValue("۱۴۰۵/۰۱/۰۱");
  await page.locator("#meta-validity-mode").selectOption("today");
  await setDate(page, "۱۴۰۴/۰۶/۳۱");
  await expect(validity).toHaveValue("۱۴۰۴/۰۶/۳۱");
  await expect(warnings(page)).toHaveCount(0);
});

test("an empty date is reported as missing, not as invalid", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار");
  await setDate(page, "");
  // An absent date is not an impossible one — no banner entry at all until
  // output validation asks for it.
  expect((await warningTexts(page)).join("\n")).not.toContain("یک تاریخ معتبر شمسی نیست");
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect(warnings(page)).toContainText("تاریخ پیش‌فاکتور وارد نشده است");
  expect((await warningTexts(page)).join("\n")).not.toContain("یک تاریخ معتبر شمسی نیست");
});

// ---------------------------------------------------------------------------
// Defect 3 — a rejected logo file changes nothing
// ---------------------------------------------------------------------------

async function openCompanyEditorFor(page, mode) {
  await page.evaluate((which) => {
    document.getElementById("btn-settings").click();
    document.getElementById(which === "edit" ? "btn-company-profile-edit" : "btn-company-editor").click();
  }, mode);
  await expect(page.locator("#company-editor-dialog")).toBeVisible();
}

async function pickCompanyLogo(page, name, type, body) {
  await page.evaluate(({ n, t, b }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([b], n, { type: t }));
    const input = document.getElementById("company-logo-file");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { n: name, t: type, b: body });
}

test("a rejected logo file leaves the company's existing logo completely intact", async ({ page }) => {
  await openApp(page);
  const shippedLogo = await page.locator("#inv-logo").getAttribute("src");
  expect(shippedLogo).toBeTruthy();

  await openCompanyEditorFor(page, "edit");
  await expect(page.locator("#company-logo-preview")).toBeVisible();
  await pickCompanyLogo(page, "notes.txt", "text/plain", "definitely not an image");
  await expect(page.locator("#company-editor-error")).toBeVisible();
  // The preview must still show the logo that was already on the profile.
  await expect(page.locator("#company-logo-preview")).toBeVisible();
  await expect(page.locator("#company-logo-empty")).toBeHidden();
  expect(await page.locator("#company-logo-preview").getAttribute("src")).toBe(shippedLogo);

  // Saving an unrelated edit afterwards must not drop the logo.
  await page.locator("#company-editor-address").fill("نشانی تازه");
  await page.locator("#btn-company-editor-submit").click();
  await expect(page.locator("#company-editor-dialog")).toBeHidden();
  await expect(page.locator("#inv-logo")).toBeVisible();
  expect(await page.locator("#inv-logo").getAttribute("src")).toBe(shippedLogo);

  // No empty asset override may be written — it would be a record that
  // hydration ignores yet hasBuiltInProfileOverride counts.
  const assets = await page.evaluate(() => localStorage.getItem("preinvoice.profileAssets.v1"));
  expect(assets === null || JSON.parse(assets).fouladBonyan === undefined).toBe(true);

  // Live state and reloaded state must agree.
  await page.reload();
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
  await expect(page.locator("#inv-logo")).toBeVisible();
  expect(await page.locator("#inv-logo").getAttribute("src")).toBe(shippedLogo);
  await expect(page.locator('[data-field="seller.address"]')).toHaveValue("نشانی تازه");
});

test("a rejected logo file on a new company leaves the picker empty without an error state", async ({ page }) => {
  await openApp(page);
  await openCompanyEditorFor(page, "create");
  await expect(page.locator("#company-logo-empty")).toBeVisible();
  await pickCompanyLogo(page, "notes.txt", "text/plain", "not an image");
  await expect(page.locator("#company-editor-error")).toBeVisible();
  await expect(page.locator("#company-logo-empty")).toBeVisible();
  await expect(page.locator("#company-logo-preview")).toBeHidden();
});

// ---------------------------------------------------------------------------
// Defect 4 — user-created companies can be deleted
// ---------------------------------------------------------------------------

async function createCompany(page, name) {
  await openCompanyEditorFor(page, "create");
  await page.locator("#company-editor-name").fill(name);
  await page.locator("#btn-company-editor-submit").click();
  await expect(page.locator("#company-editor-dialog")).toBeHidden();
}

test("a user-created company can be deleted and stays deleted", async ({ page }) => {
  await openApp(page);
  await createCompany(page, "شرکت موقتی");
  const createdKey = await page.locator("#company-profile").inputValue();
  expect(createdKey.startsWith("company-")).toBe(true);

  await openCompanyEditorFor(page, "edit");
  await expect(page.locator("#btn-company-editor-delete")).toBeVisible();
  await expect(page.locator("#btn-company-editor-reset")).toBeHidden();
  await page.locator("#btn-company-editor-delete").click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-actions button.danger").click();

  await expect(page.locator("#toolbar-status")).toContainText("حذف شد");
  await expect(page.locator("#company-profile option")).toHaveText([
    "بنیان فولاد داریا", "کارا برج پارسه", "سایر"
  ]);
  // The document moved onto the default company rather than staying branded
  // by one the app no longer knows.
  await expect(page.locator("#company-profile")).toHaveValue("fouladBonyan");
  await expect(page.locator("#inv-company-name")).toHaveText("بنیان فولاد داریا");

  const stored = await page.evaluate((key) => ({
    profiles: JSON.parse(localStorage.getItem("preinvoice.companyProfiles.v1") || "{}"),
    seq: localStorage.getItem("pishFaktor.dailySeq." + key)
  }), createdKey);
  expect(stored.profiles[createdKey]).toBeUndefined();
  expect(stored.seq).toBeNull();

  await page.reload();
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
  await expect(page.locator("#company-profile option")).toHaveText([
    "بنیان فولاد داریا", "کارا برج پارسه", "سایر"
  ]);
});

test("cancelling the delete confirmation keeps the company", async ({ page }) => {
  await openApp(page);
  await createCompany(page, "شرکت ماندگار");
  await openCompanyEditorFor(page, "edit");
  await page.locator("#btn-company-editor-delete").click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-actions button", { hasText: "انصراف" }).click();
  await expect(page.locator("#company-profile option")).toContainText(["شرکت ماندگار"]);
  const profiles = await page.evaluate(() => JSON.parse(localStorage.getItem("preinvoice.companyProfiles.v1") || "{}"));
  expect(Object.keys(profiles)).toHaveLength(1);
});

test("shipped companies offer restore, never delete", async ({ page }) => {
  await openApp(page);
  await openCompanyEditorFor(page, "edit");
  await expect(page.locator("#btn-company-editor-delete")).toBeHidden();
  await expect(page.locator("#btn-company-editor-reset")).toBeVisible();
});

test("a delete whose storage write fails changes nothing at all", async ({ page }) => {
  await openApp(page);
  await createCompany(page, "شرکت مقاوم");
  const createdKey = await page.locator("#company-profile").inputValue();
  const before = await page.evaluate(() => localStorage.getItem("preinvoice.companyProfiles.v1"));

  await page.evaluate(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "preinvoice.companyProfiles.v1") throw new Error("QuotaExceededError");
      return real.call(this, key, value);
    };
  });

  await openCompanyEditorFor(page, "edit");
  await page.locator("#btn-company-editor-delete").click();
  await page.locator("#app-dialog-actions button.danger").click();
  await expect(page.locator("#toolbar-status")).toContainText("چیزی تغییر نکرد");

  const after = await page.evaluate(() => localStorage.getItem("preinvoice.companyProfiles.v1"));
  expect(after).toBe(before);
  // Still selectable, still in memory: no half-removed company.
  await expect(page.locator("#company-profile option")).toContainText(["شرکت مقاوم"]);
  await expect(page.locator("#company-profile")).toHaveValue(createdKey);
});

// ---------------------------------------------------------------------------
// Defect 5 — the tax message states the rule it actually enforces
// ---------------------------------------------------------------------------

test("the tax warning names the decimal limit, not just the range", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  // 99.999 is squarely between 0 and 100; what it violates is the two-decimal
  // limit, which the old message never mentioned.
  for (const value of ["99.999", "0.005", "200", "-1"]) {
    await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill(value);
    await page.getByLabel("درصد مالیات و عوارض", { exact: true }).blur();
    const texts = await warningTexts(page);
    expect(texts, `tax "${value}"`).toContain("درصد مالیات باید عددی بین ۰ تا ۱۰۰ و حداکثر با دو رقم اعشار باشد");
    expect(texts).not.toContain("درصد مالیات باید بین صفر تا صد باشد");
  }
  // The in-range two-decimal values it describes are still accepted.
  for (const value of ["99.99", "0", "100", "9.5"]) {
    await page.getByLabel("درصد مالیات و عوارض", { exact: true }).fill(value);
    await page.getByLabel("درصد مالیات و عوارض", { exact: true }).blur();
    await expect(warnings(page), `tax "${value}" must be accepted`).toHaveCount(0);
  }
});

// ---------------------------------------------------------------------------
// Defect 6 — saved entries show their own company, never the default one
// ---------------------------------------------------------------------------

async function seedSavedEntry(page, id, name, company) {
  await page.evaluate(({ entryId, entryName, entryCompany }) => {
    localStorage.setItem("preinvoice.saved.entry.v2." + entryId, JSON.stringify({
      id: entryId,
      name: entryName,
      savedAt: 1750000000000,
      data: {
        version: 7,
        meta: { number: "۱۴۰۴۰۱۰۱-۰۰۱" },
        buyer: {}, seller: {}, company: entryCompany, items: []
      }
    }));
  }, { entryId: id, entryName: name, entryCompany: company });
}

test("a saved entry from an unknown company shows that company, not the default one", async ({ page }) => {
  await openApp(page);
  await seedSavedEntry(page, "inv-gone", "سند مهاجر", { profile: "company-not-here", name: "شرکت مهمان" });
  await seedSavedEntry(page, "inv-nameless", "سند بی‌نام", { profile: "company-also-gone" });
  await page.evaluate(() => document.getElementById("btn-saved-list").click());

  const lines = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#saved-list .saved-item-time")).map((el) => el.textContent));
  const joined = lines.join("\n");
  expect(joined).toContain("شرکت مهمان");
  expect(joined).toContain("شرکت نامشخص");
  // The whole point: neither may borrow the default company's identity.
  expect(joined).not.toContain("بنیان فولاد داریا");
});

test("saved entries from known and ad-hoc companies are labelled exactly as before", async ({ page }) => {
  await openApp(page);
  await seedSavedEntry(page, "inv-known", "سند شناخته", { profile: "karaBorjParseh", name: "کارا برج پارسه" });
  await seedSavedEntry(page, "inv-adhoc", "سند سایر", { profile: "other", name: "شرکت دلخواه" });
  await page.evaluate(() => document.getElementById("btn-saved-list").click());
  const joined = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#saved-list .saved-item-time")).map((el) => el.textContent).join("\n"));
  expect(joined).toContain("کارا برج پارسه");
  expect(joined).toContain("شرکت دلخواه");
});

test("deleting a company leaves its saved invoices readable under their own name", async ({ page }) => {
  await openApp(page);
  await createCompany(page, "شرکت رفتنی");
  const createdKey = await page.locator("#company-profile").inputValue();
  await fillValidFirstRow(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار");
  await page.getByRole("button", { name: "ذخیره", exact: true }).click();
  await page.locator("#app-dialog-input").fill("سند شرکت رفتنی");
  await page.locator("#app-dialog-actions button").first().click();
  await expect(page.locator("#toolbar-status")).toContainText("ذخیره شد");

  await page.evaluate((key) => { document.getElementById("company-profile").value = key; }, createdKey);
  await openCompanyEditorFor(page, "edit");
  await page.locator("#btn-company-editor-delete").click();
  await page.locator("#app-dialog-actions button.danger").click();
  await expect(page.locator("#toolbar-status")).toContainText("حذف شد");

  await page.evaluate(() => document.getElementById("btn-saved-list").click());
  const joined = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#saved-list .saved-item-time")).map((el) => el.textContent).join("\n"));
  expect(joined).toContain("شرکت رفتنی");
  expect(joined).not.toContain("بنیان فولاد داریا");
});

// ---------------------------------------------------------------------------
// Defect 7 — Enter-created rows are a structural change like any other
// ---------------------------------------------------------------------------

test("Enter on the last row marks the document dirty", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("#status-dot")).not.toHaveClass(/is-dirty/);
  await cell(page, 7, "description").focus();
  await cell(page, 7, "description").press("Enter");
  await expect(page.locator("#inv-rows tr")).toHaveCount(8);
  await expect(page.locator("#status-dot")).toHaveClass(/is-dirty/);
  await expect(page.locator("#toolbar-status")).toContainText("تغییرات ذخیره‌نشده");
  // Focus still follows the same column, as it did before.
  await expect(cell(page, 8, "description")).toBeFocused();
});

test("a row added with Enter survives an orientation switch", async ({ page }) => {
  await openApp(page);
  await cell(page, 7, "description").press("Enter");
  await expect(page.locator("#inv-rows tr")).toHaveCount(8);
  // The managed default-row count must no longer apply: switching to portrait
  // used to reset this document back to the 14-row default and drop the row.
  await page.locator("#orientation-portrait").check();
  await expect(page.locator("#inv-rows tr")).toHaveCount(8);
});

test("an untouched document still follows the orientation row defaults", async ({ page }) => {
  await openApp(page);
  await page.locator("#orientation-portrait").check();
  await expect(page.locator("#inv-rows tr")).toHaveCount(14);
  await page.locator("#orientation-landscape").check();
  await expect(page.locator("#inv-rows tr")).toHaveCount(7);
});

// ---------------------------------------------------------------------------
// Defect 8 — Save, Print and modals do not interleave
// ---------------------------------------------------------------------------

test("Ctrl+P while the save-naming dialog is open does not print behind it", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار");
  await page.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(page.locator("#app-dialog")).toBeVisible();

  await page.keyboard.press("Control+p");
  await expect(page.locator("#toolbar-status")).toContainText("ابتدا پنجرهٔ باز را ببندید");
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(0);
  await expect(page.locator("#app-dialog")).toBeVisible();
  await expect(page.locator("#print-document .print-page")).toHaveCount(0);

  // The interrupted save still completes normally.
  await page.locator("#app-dialog-input").fill("سند سالم");
  await page.locator("#app-dialog-actions button").first().click();
  await expect(page.locator("#toolbar-status")).toContainText("ذخیره شد");

  // And printing works again once nothing is pending.
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
});

test("printing is refused while the company editor is open", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  await openCompanyEditorFor(page, "edit");
  await page.keyboard.press("Control+p");
  await expect(page.locator("#toolbar-status")).toContainText("ابتدا پنجرهٔ باز را ببندید");
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(0);
  await expect(page.locator("#company-editor-dialog")).toBeVisible();
  await page.locator("#btn-company-editor-cancel").click();
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
});

test("a second save request while one is pending is ignored, not stacked", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  await page.getByRole("button", { name: "ذخیره", exact: true }).click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  // Ctrl+S is the only way to re-enter saveCurrent while the prompt is up:
  // the modal backdrop already swallows pointer events aimed at the toolbar,
  // so the keyboard path is exactly the one the busy flag has to cover.
  await expect(page.locator("#btn-save")).toBeVisible();
  expect(await page.evaluate(() => {
    const button = document.getElementById("btn-save").getBoundingClientRect();
    const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
    return !!(hit && hit.closest("#app-dialog"));
  })).toBe(true);
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-input").fill("یک نسخه");
  await page.locator("#app-dialog-actions button").first().click();
  await expect(page.locator("#toolbar-status")).toContainText("ذخیره شد");

  const names = await page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.indexOf("preinvoice.saved.entry.") === 0)
    .map((key) => JSON.parse(localStorage.getItem(key)).name));
  expect(names).toEqual(["یک نسخه"]);
  expect(await page.evaluate(() => window.__rejections)).toEqual([]);
});

test("saving is refused while another confirmation is waiting, instead of cancelling it", async ({ page }) => {
  await openApp(page);
  await createCompany(page, "شرکت در معرض حذف");
  await fillValidFirstRow(page);
  await openCompanyEditorFor(page, "edit");
  await page.locator("#btn-company-editor-delete").click();
  await expect(page.locator("#app-dialog-title")).toHaveText("حذف شرکت");

  // Ctrl+S here used to open the naming prompt over the top, which settled the
  // delete confirmation as a cancel — abandoning it without ever saying so.
  await page.keyboard.press("Control+s");
  await expect(page.locator("#toolbar-status")).toContainText("ابتدا پنجرهٔ باز را ببندید");
  await expect(page.locator("#app-dialog-title")).toHaveText("حذف شرکت");
  await expect(page.locator("#app-dialog-input-wrap")).toBeHidden();

  // The confirmation is still live and still does what it says.
  await page.locator("#app-dialog-actions button.danger").click();
  await expect(page.locator("#toolbar-status")).toContainText("حذف شد");
  const entries = await page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.indexOf("preinvoice.saved.entry.") === 0));
  expect(entries).toHaveLength(0);
  // Saving works again once nothing is pending.
  await page.locator("#btn-save").click();
  await expect(page.locator("#app-dialog-input-wrap")).toBeVisible();
});

test("a browser that cannot format a canonical Jalali date accuses nobody", async ({ page }) => {
  // An ICU build that ignores `2-digit` would make todayJalaliString()'s own
  // output unparseable by invoiceDateDigits. The capability probe has to catch
  // that, or impossible-date detection brands every real date invalid —
  // including the one the app itself just generated.
  await page.addInitScript(() => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    function Unpadded(locale, options) {
      const inner = new RealDateTimeFormat(locale, options);
      if (String(locale).indexOf("ca-persian") === -1) return inner;
      // Persian digits, so the stripping pattern must be Persian-aware —
      // \d matches ASCII only and would leave the padding untouched, quietly
      // testing nothing at all.
      return {
        format: (value) => inner.format(value).replace(/(^|[^۰-۹])۰([۰-۹])/g, "$1$2"),
        formatToParts: (value) => inner.formatToParts(value)
      };
    }
    Unpadded.prototype = RealDateTimeFormat.prototype;
    Intl.DateTimeFormat = Unpadded;
  });
  await openApp(page);
  // Proof the degraded environment is real: the app's own boot date came back
  // without zero padding, so it no longer carries the canonical 8 digits.
  const bootDate = await page.locator('[data-field="meta.date"]').inputValue();
  expect(bootDate.replace(/[^۰-۹]/g, "")).not.toHaveLength(8);

  expect((await warningTexts(page)).join("\n")).not.toContain("یک تاریخ معتبر شمسی نیست");
  await setDate(page, "۱۴۰۴/۰۶/۳۱");
  expect((await warningTexts(page)).join("\n")).not.toContain("یک تاریخ معتبر شمسی نیست");
  // Even the date that IS impossible is left alone: unverifiable is not the
  // same as wrong, and a guess here would be the very thing being fixed.
  await setDate(page, "۱۴۰۴/۱۲/۳۰");
  expect((await warningTexts(page)).join("\n")).not.toContain("یک تاریخ معتبر شمسی نیست");
  expect(await page.evaluate(() => window.__rejections)).toEqual([]);
});

test("print still works normally when nothing else is pending", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار");
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
  await expect(page.locator("#print-document .print-page")).toHaveCount(1);
  // A second print afterwards is not blocked by a stuck busy flag.
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(2);
});

test("a print that is refused for overflow still releases the busy flag", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page);
  await cell(page, 1, "description").fill("شرح بسیار بلند ".repeat(1500));
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect(page.locator("#toolbar-status")).toContainText("در صفحهٔ A4 جا نمی‌شود");
  await cell(page, 1, "description").fill("شرح کوتاه");
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار");
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
});

test("website field in footer preserves ASCII digits on typing and blur", async ({ page }) => {
  await openApp(page);
  const websiteInput = page.locator('[data-field="company.website"]');
  await websiteInput.fill("www.site123.ir/page45");
  await websiteInput.blur();
  expect(await websiteInput.inputValue()).toBe("www.site123.ir/page45");
  expect(await page.evaluate(() => window.__rejections)).toEqual([]);
});

test("Enter key on company name heading blurs without adding newlines or div tags", async ({ page }) => {
  await openApp(page);
  const companyHeading = page.locator("#inv-company-name");
  await companyHeading.click();
  await page.keyboard.press("Enter");
  const isFocused = await companyHeading.evaluate((el) => document.activeElement === el);
  expect(isFocused).toBe(false);
  const innerHtml = await companyHeading.innerHTML();
  expect(innerHtml).not.toContain("<br>");
  expect(innerHtml).not.toContain("<div>");
  expect(await page.evaluate(() => window.__rejections)).toEqual([]);
});

test("deleting the currently open document marks the document dirty to guard against closing tab", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار تستی برای حذف");
  await page.locator("#btn-save").click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-input").fill("سند تست حذف");
  await page.locator("#app-dialog-actions button").first().click();
  await expect(page.locator("#toolbar-status")).toContainText("ذخیره شد");

  await page.locator("#btn-saved-list").click();
  await expect(page.locator("#saved-panel")).toBeVisible();
  await page.locator(".saved-item-actions button.danger").first().click();
  await expect(page.locator("#app-dialog")).toBeVisible();
  await page.locator("#app-dialog-actions button.danger").click();
  await expect(page.locator("#toolbar-status")).toContainText("حذف شد");

  const dirtyFlag = await page.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(dirtyFlag).toBe(true);
  expect(await page.evaluate(() => window.__rejections)).toEqual([]);
});

test("parsePercentBps and formatPercentBps are exported and round-trip correctly", async () => {
  const p = await import("../js/persian-numbers.js");
  expect(typeof p.parsePercentBps).toBe("function");
  expect(typeof p.formatPercentBps).toBe("function");
  expect(p.parsePercentBps("10")).toBe(1000n);
  expect(p.parsePercentBps("10.5")).toBe(1050n);
  expect(p.formatPercentBps(1000n)).toBe("۱۰");
  expect(p.formatPercentBps(1050n)).toBe("۱۰٫۵");
});

test("leading decimal values (.5 and ٫۵) in quantity and taxPercent compute accurately without error", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page, "1000000");
  await cell(page, 1, "quantity").fill(".5");
  await cell(page, 1, "quantity").press("Tab");

  // .5 * 1000000 = 500000
  await expect(page.locator("#inv-rows tr").first().locator('[data-row-computed="total"]')).toHaveText("۵۰۰٬۰۰۰");

  const taxInput = page.getByLabel("درصد مالیات و عوارض", { exact: true });
  await taxInput.fill(".5");
  await taxInput.press("Tab");
  await expect(taxInput).toHaveValue("۰٫۵");

  // Gross 500,000 + 0.5% tax (2,500) = 502,500
  await expect(page.locator('[data-total="grossTotal"]')).toHaveText("۵۰۰٬۰۰۰ ریال");
  await expect(page.locator('[data-total="taxTotal"]')).toHaveText("۲٬۵۰۰ ریال");
  await expect(page.locator('[data-total="netTotal"]')).toHaveText("۵۰۲٬۵۰۰ ریال");

  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار آزمایشی");
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
});

test("decimal tax percentage (10.5%) does not shrink font or cause false numeric-overflow warning", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page, "1000000");
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار آزمایشی");

  const taxInput = page.getByLabel("درصد مالیات و عوارض", { exact: true });
  await taxInput.fill("10.5");
  await taxInput.press("Tab");
  await expect(taxInput).toHaveValue("۱۰٫۵");

  const overflow = await taxInput.evaluate((el) => el.classList.contains("numeric-overflow"));
  expect(overflow).toBe(false);

  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);

  const texts = await warningTexts(page);
  expect(texts.some((t) => t.includes("مبالغ بسیار طولانی"))).toBe(false);
});

test("modal dialogs restore focus to the opening element when dismissed", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page, "1000");

  const newBtn = page.locator("#btn-new");
  await newBtn.focus();
  await newBtn.click();
  await expect(page.locator("#app-dialog")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#app-dialog")).toBeHidden();
  await expect(newBtn).toBeFocused();

  const settingsBtn = page.locator("#btn-settings");
  await settingsBtn.click();
  const editorBtn = page.locator("#btn-company-editor");
  await editorBtn.focus();
  await editorBtn.click();
  await expect(page.locator("#company-editor-dialog")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#company-editor-dialog")).toBeHidden();
  await expect(settingsBtn).toBeFocused();
});

test("an older backup without taxPercent defaults to 0% tax, not imposing 10%", async ({ page }) => {
  await openApp(page);
  const legacyWithoutTax = {
    version: 7,
    orientation: "landscape",
    meta: { number: "۱۴۰۴۰۱۰۱-۰۰۲", date: "۱۴۰۴/۰۱/۰۱" },
    buyer: { name: "خریدار فاقد مالیات" },
    seller: {},
    company: { profile: "fouladBonyan" },
    notes: "",
    items: [
      { description: "کالای معاف", quantity: "1", unit: "عدد", unitPrice: "1000000" },
    ],
  };
  await page.evaluate((data) => {
    const input = document.getElementById("file-open");
    const file = new File([JSON.stringify(data)], "legacy.json", { type: "application/json" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, legacyWithoutTax);

  await expect(page.getByLabel("نام خریدار", { exact: true })).toHaveValue("خریدار فاقد مالیات");
  await expect(page.getByLabel("درصد مالیات و عوارض", { exact: true })).toHaveValue("۰");
  await expect(page.locator('[data-total="netTotal"]')).toHaveText("۱٬۰۰۰٬۰۰۰ ریال");
});

test("natural unpadded Jalali dates (۱۴۰۴/۶/۱ or 1404/6/1) parse without error and format with zero padding on blur", async ({ page }) => {
  await openApp(page);
  const dateInput = page.locator('[data-field="meta.date"]');
  await dateInput.fill("1404/6/1");
  await dateInput.press("Tab");
  await expect(dateInput).toHaveValue("۱۴۰۴/۰۶/۰۱");
  const warnings = await warningTexts(page);
  expect(warnings.some((w) => w.includes("یک تاریخ معتبر شمسی نیست"))).toBe(false);
});

test("a single-row invoice whose description is taller than an A4 page is blamed on row 1, not closing block", async ({ page }) => {
  await openApp(page);
  await fillValidFirstRow(page, "1000000");
  await page.getByLabel("نام خریدار", { exact: true }).fill("خریدار آزمایشی");

  // Delete all remaining blank rows (rows 2 through 7) so only row 1 exists
  const rows = page.locator("#inv-rows tr");
  while ((await rows.count()) > 1) {
    await rows.nth(1).locator(".row-delete").click();
  }
  await expect(rows).toHaveCount(1);

  // Fill row 1 with massive text exceeding an entire A4 page
  await cell(page, 1, "description").fill("شرح بسیار بلند که در صفحه جا نمی‌شود ".repeat(400));
  await page.getByRole("button", { name: "چاپ / PDF", exact: true }).click();

  const warnings = await warningTexts(page);
  expect(warnings.some((w) => w.includes("ردیف ۱ بلندتر از ظرفیت یک صفحهٔ A4 است"))).toBe(true);
  expect(warnings.some((w) => w.includes("بخش پایانی سند"))).toBe(false);
});

test("Shift+Enter in description textarea inserts a newline rather than advancing to the next row", async ({ page }) => {
  await openApp(page);
  const desc = cell(page, 1, "description");
  await desc.fill("خط اول");
  await desc.press("Shift+Enter");
  await desc.type("خط دوم");
  await expect(desc).toHaveValue("خط اول\nخط دوم");
  await expect(desc).toBeFocused();
});

test("closing saved-panel and settings-panel restores focus to their trigger buttons", async ({ page }) => {
  await openApp(page);

  // Saved panel
  const savedBtn = page.locator("#btn-saved-list");
  await savedBtn.click();
  await expect(page.locator("#saved-panel")).toBeVisible();
  const closeBtn = page.locator("#btn-saved-close");
  await closeBtn.focus();
  await closeBtn.click();
  await expect(page.locator("#saved-panel")).toBeHidden();
  await expect(savedBtn).toBeFocused();

  // Settings panel
  const settingsBtn = page.locator("#btn-settings");
  await settingsBtn.click();
  await expect(page.locator("#settings-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-panel")).toBeHidden();
  await expect(settingsBtn).toBeFocused();
});

test("company editor allows removing an uploaded logo and stamp", async ({ page }) => {
  await openApp(page);
  await page.locator("#btn-settings").click();
  await page.locator("#btn-company-editor").click();
  await expect(page.locator("#company-editor-dialog")).toBeVisible();

  // Pick a logo
  const logoInput = page.locator("#company-logo-file");
  const logoBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  await logoInput.setInputFiles({
    name: "test-logo.png",
    mimeType: "image/png",
    buffer: logoBuffer,
  });
  await expect(page.locator("#btn-company-logo-remove")).toBeVisible();

  // Remove the logo
  await page.locator("#btn-company-logo-remove").click();
  await expect(page.locator("#btn-company-logo-remove")).toBeHidden();
  await expect(page.locator("#company-logo-empty")).toBeVisible();

  await page.locator("#btn-company-editor-cancel").click();
});



