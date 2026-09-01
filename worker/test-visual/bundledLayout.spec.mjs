import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildInvoiceHtml, MAX_ROWS_PER_PAGE } from "../src/lib/invoiceTemplate.js";
import { COMPANIES } from "../src/lib/companies.js";

/*
 * layoutInvoicePages is not called in the Worker — pdf.js hands it to
 * page.evaluate, which ships it to the render browser as
 * Function.toString(). That makes the BUNDLED text of the function, not the
 * source, what actually runs, and the two can differ: esbuild's keep-names
 * pass rewrote its inner helpers as `__name(fn, "fn")`, a module-scope helper
 * that does not exist in the page, so every PDF would have failed with
 * "__name is not defined" while every source-level test passed.
 *
 * So this one builds the Worker the way `wrangler deploy` does, pulls the
 * function back out of the bundle, and runs THAT.
 */

const workerRoot = fileURLToPath(new URL("..", import.meta.url));
const bundleDir = path.join(workerRoot, "tmp", "bundle-check");
const bundlePath = path.join(bundleDir, "index.js");

const fontPath = path.join(workerRoot, "public", "fonts", "vazirmatn-arabic-variable.woff2");

function invoiceHtml(itemCount) {
  const fontDataUri = `data:font/woff2;base64,${readFileSync(fontPath).toString("base64")}`;
  return buildInvoiceHtml({
    company: COMPANIES.fouladBonyan,
    fontDataUri,
    docNumber: "۱۴۰۵-۰۰۱",
    docDate: "۱۴۰۵/۰۶/۱۰",
    validity: "پایان روز جاری",
    buyerName: "مشتری تست",
    buyerAddress: "تهران، خیابان آزادی",
    buyerPostalCode: "۱۲۳۴۵۶۷۸۹۰",
    buyerNationalId: "۱۰۹۸۷۶۵۴۳۲۱",
    buyerPhone: "۰۲۱-۱۲۳۴۵۶۷۸",
    items: Array.from({ length: itemCount }, (_, index) => ({
      description: "قوطی صنعتی ۴۰ در ۴۰ ضخامت ۲ میلی‌متر شاخه ۶ متری",
      unit: "شاخه",
      quantityMilli: BigInt((index + 3) * 1000),
      unitPriceRial: BigInt((index + 2) * 1_250_000),
    })),
    includeStamp: true,
  });
}

// Lifts the function's own text out of the bundle by brace matching, which is
// exactly the slice Function.toString() would hand to page.evaluate.
function extractBundledFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  expect(start, `${name} must survive bundling`).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

let bundled;

test.beforeAll(async () => {
  mkdirSync(bundleDir, { recursive: true });
  // wrangler's own node entry point rather than the `npx` shim: spawning a
  // .cmd without a shell is EINVAL on Windows, and a shell here would be one
  // more thing between the test and the bundle it is checking.
  await promisify(execFile)(
    process.execPath,
    [
      path.join(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
      "deploy",
      "--dry-run",
      `--outdir=${bundleDir}`,
    ],
    { cwd: workerRoot }
  );
  expect(existsSync(bundlePath), "wrangler must have written a bundle").toBe(true);
  bundled = extractBundledFunction(readFileSync(bundlePath, "utf8"), "layoutInvoicePages");
});

test.describe.configure({ timeout: 180_000 });

test("the bundled page fitter is self-contained and runs in the render browser", async ({ page }) => {
  // The failure mode this exists for: a bundler helper called from inside a
  // function that is executed somewhere the helper does not exist.
  expect(bundled).not.toContain("__name");

  await page.setContent(invoiceHtml(17), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(
    ({ source, options }) => new Function(`return (${source})`)()(options),
    { source: bundled, options: { maxRowsPerPage: MAX_ROWS_PER_PAGE } }
  );

  expect(result.pages).toBe(2);
  const overflow = await page.evaluate(() =>
    Array.prototype.slice
      .call(document.querySelectorAll(".invoice-sheet"))
      .map((sheet) => sheet.scrollHeight - sheet.clientHeight)
  );
  expect(overflow.every((value) => value <= 2)).toBe(true);
});
