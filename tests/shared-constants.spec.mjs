/*
 * The editor and the bot's PDF are two separate implementations of one sheet.
 * The desktop app draws it from css/invoice.css and solves it with
 * fitSheetToPage() in js/app.js; the Worker draws it from
 * worker/src/lib/invoiceStyles.js and solves it with layoutInvoicePages() in
 * worker/src/lib/invoiceLayout.js.
 *
 * Those pairs are NOT removable duplication. The Worker's stylesheet is a
 * projection of the editor's onto plain (non-input) markup with the cascade
 * already resolved, and its solver has to stay closure-free because pdf.js
 * ships it into the render browser via Function.toString(). But the two only
 * produce the same document for as long as their shared numbers agree, and
 * nothing was checking that. These tests do.
 *
 * A failure here is not automatically a bug: it means one side moved and the
 * other has to move to match, or the difference belongs in the documented
 * exception list below, with its reason.
 *
 * Parsed by hand rather than with regular expressions on purpose. These read
 * source text, and a subtly wrong pattern would keep passing while comparing
 * nothing.
 */
import { test, expect, repoRoot } from "./fixtures.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

function stripBlockComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("/*", i);
    if (open === -1) return out + text.slice(i);
    out += text.slice(i, open);
    const close = text.indexOf("*/", open + 2);
    if (close === -1) return out;
    i = close + 2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The vertical-rhythm knob table
// ---------------------------------------------------------------------------

/*
 * Every ".invoice-sheet {" rule body, in source order. css/invoice.css
 * declares that block twice — the base table near the top, then the trailing
 * print-first refinement layer that overrides four of its values — so the
 * cascade has to be resolved (later wins) before the two files can be
 * compared. The refinement layer's values are the ones that print, and
 * therefore the ones the Worker mirrors.
 */
function sheetRuleBodies(text) {
  const NEWLINE = "\n";
  const RETURN = "\r";
  const bodies = [];
  const marker = ".invoice-sheet";
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) return bodies;
    from = at + marker.length;

    // Only rules whose entire selector is .invoice-sheet, so compound
    // selectors such as .invoice-sheet.header-gray are not folded in.
    const before = at === 0 ? NEWLINE : text[at - 1];
    if (before !== NEWLINE && before !== RETURN && before !== "`") continue;
    let after = from;
    while (after < text.length && (text[after] === " " || text[after] === NEWLINE || text[after] === RETURN)) {
      after += 1;
    }
    if (text[after] !== "{") continue;

    let i = after + 1;
    let depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") depth -= 1;
      i += 1;
    }
    bodies.push(text.slice(after + 1, i - 1));
    from = i;
  }
}

function collapseWhitespace(value) {
  return value.split(/[\s]+/).join(" ").trim();
}

function resolveKnobs(text) {
  const knobs = {};
  for (const body of sheetRuleBodies(text)) {
    for (const raw of stripBlockComments(body).split(";")) {
      const decl = raw.trim();
      if (!decl.startsWith("--")) continue;
      const colon = decl.indexOf(":");
      if (colon === -1) continue;
      knobs[decl.slice(0, colon).trim()] = collapseWhitespace(decl.slice(colon + 1));
    }
  }
  return knobs;
}

// Values that differ on purpose. Each needs a reason, not just an entry.
const KNOB_EXCEPTIONS = {
  // The editor's sheet paints the header/footer band white and adds the gray
  // through .header-gray, a per-document toggle. The bot renders every sheet
  // with that toggle on, so it bakes the .header-gray value in instead.
  "--band-fill": { app: "#fff", bot: "#e4e4e4" },
};

test("the editor and the bot agree on every shared sheet knob", () => {
  const app = resolveKnobs(read("css/invoice.css"));
  const bot = resolveKnobs(read("worker/src/lib/invoiceStyles.js"));

  // Guards the parser itself. Without these, a refactor that changed the
  // rule's shape would leave both sides empty and the comparison below would
  // pass while checking nothing at all.
  const shared = Object.keys(bot).filter((name) => name in app);
  expect(shared.length).toBeGreaterThan(35);
  expect(app["--print-density"]).toBe("1");
  expect(bot["--rhythm-row-h"]).toContain("var(--print-density)");

  const mismatched = {};
  for (const name of shared) {
    const allowed = KNOB_EXCEPTIONS[name];
    if (allowed && allowed.app === app[name] && allowed.bot === bot[name]) continue;
    if (app[name] !== bot[name]) mismatched[name] = { app: app[name], bot: bot[name] };
  }
  expect(mismatched).toEqual({});
});

// ---------------------------------------------------------------------------
// 2. The page-fitting solver constants
// ---------------------------------------------------------------------------

// The same bisection runs on both sides, so the editor's preview only tells
// the truth about the printed page while these agree. They are named
// differently in each file, so the pairs are spelled out.
const SOLVER_CONSTANTS = [
  ["DENSITY_BISECTION_STEPS", "DENSITY_STEPS"],
  ["TYPE_BISECTION_STEPS", "TYPE_STEPS"],
  ["TYPE_SCALE_MIN", "TYPE_SCALE_MIN"],
  ["ROW_EXTRA_MAX_MM", "ROW_EXTRA_MAX_MM"],
  ["BLOCK_EXTRA_MAX_MM", "BLOCK_EXTRA_MAX_MM"],
  ["FIT_HEADROOM_PX", "HEADROOM_PX"],
];

// The initialiser of a `var|const|let NAME = ...;`, or null when there is no
// such declaration — which is itself a drift worth failing on.
function declaredValue(text, name) {
  for (const line of text.split("\n")) {
    let trimmed = line.trim();
    if (trimmed.startsWith("export ")) trimmed = trimmed.slice("export ".length);
    for (const keyword of ["var ", "const ", "let "]) {
      const head = keyword + name;
      if (!trimmed.startsWith(head)) continue;
      const rest = trimmed.slice(head.length).trim();
      if (!rest.startsWith("=")) continue;
      let value = rest.slice(1).trim();
      if (value.endsWith(";")) value = value.slice(0, -1);
      return value.trim();
    }
  }
  return null;
}

test("the editor and the bot solve the page with the same constants", () => {
  const app = read("js/app.js");
  const bot = read("worker/src/lib/invoiceLayout.js");

  const mismatched = {};
  for (const [appName, botName] of SOLVER_CONSTANTS) {
    const appValue = declaredValue(app, appName);
    const botValue = declaredValue(bot, botName);
    if (appValue === null || botValue === null || appValue !== botValue) {
      mismatched[appName + "/" + botName] = { app: appValue, bot: botValue };
    }
  }
  expect(mismatched).toEqual({});
});

// The template chunks items at this number and the app splits its print plan
// at the same one, so a sheet carries the same rows in the editor and the PDF.
test("the editor and the bot cap a sheet at the same number of item rows", () => {
  expect(declaredValue(read("js/app.js"), "MAX_PRINT_ITEM_ROWS_PER_PAGE")).toBe("16");
  expect(declaredValue(read("worker/src/lib/invoiceTemplate.js"), "MAX_ROWS_PER_PAGE")).toBe("16");
});
