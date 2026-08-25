/*
 * Copies the invoice branding assets and the embedded font from the repo
 * root into worker/public/, which is what the ASSETS binding serves (see
 * wrangler.jsonc).
 *
 * These files used to be committed twice — byte-identical copies under
 * assets/ + fonts/ and again under worker/public/. The root copies are the
 * single source of truth now; worker/public/assets and worker/public/fonts
 * are generated and gitignored. Run before dev / deploy / tests, which the
 * package.json scripts already do.
 */
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(workerRoot, "..");

const PAIRS = [
  ["assets", "public/assets"],
  ["fonts", "public/fonts"],
];

for (const [from, to] of PAIRS) {
  const source = path.join(repoRoot, from);
  const target = path.join(workerRoot, to);
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  console.log(`synced ${from}/ -> worker/${to}/`);
}
