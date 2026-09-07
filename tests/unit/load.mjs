/*
 * Loads the app's classic scripts the way index.html does: one shared global
 * scope, in order, with no module system involved. That is the real contract —
 * js/invoice-totals.js reaches bigRoundDiv through global scope, not an import
 * — so a loader that faked ES modules would be testing something the browser
 * never runs.
 *
 * Only the modules with a storage seam or a pure interface are loaded here.
 * js/app.js is not: it needs a DOM, and driving it is what tests/*.spec.mjs
 * does in a real browser.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCRIPTS = [
  "js/persian-numbers.js",
  "js/invoice-totals.js",
  "js/invoice-counter.js",
  "js/document-store.js",
];

// A localStorage good enough for what the two stores actually use: getItem,
// setItem, removeItem, length and key(i), with insertion order preserved.
export function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    snapshot() { return Object.fromEntries(map); },
  };
}

// A storage that refuses every write, for the paths that have to survive
// private mode and a full quota.
export function refusingStorage(seed) {
  const base = memoryStorage(seed);
  return Object.assign(Object.create(base), {
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem() { throw new Error("SecurityError"); },
  });
}

export function loadApp() {
  const context = vm.createContext({ console });
  for (const script of SCRIPTS) {
    const file = path.join(repoRoot, script);
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  }
  return context;
}
