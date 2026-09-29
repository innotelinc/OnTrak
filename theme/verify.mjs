#!/usr/bin/env node
/*
 * Unity — verify (or re-vendor) the shared theme copies.
 *
 * `theme/ontrak-theme.js` and `theme/ontrak-theme.css` are the canonical copies, and
 * every product that uses them vendors them *byte-identical*. This is the check that
 * makes that true rather than aspirational: it walks the tree, finds every file named
 * like a theme asset outside `theme/`, and compares it to the canonical one.
 *
 *   node theme/verify.mjs            # fail on any difference
 *   node theme/verify.mjs --update   # re-vendor every copy from theme/
 *
 * Why byte-identical rather than "semantically equivalent": a theme's whole job is that
 * two products look the same, and the first place that stops being true is a copy
 * somebody fixed locally. A diff is the only signal that cannot be argued with.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const THEME_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(THEME_DIR);

/** The files this checks. A product that vendors one and not the other is a failure. */
const ASSETS = ["ontrak-theme.js", "ontrak-theme.css"];

/** Directories that never hold a vendored copy, and are expensive or wrong to walk. */
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "storage",
  ".agents",
]);

const canonical = new Map(ASSETS.map((name) => [name, readFileSync(join(THEME_DIR, name))]));

/** Every vendored copy in the tree, as absolute paths. */
function findCopies(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // `theme/` is the canonical copy, not a copy of it.
      if (join(dir, entry.name) === THEME_DIR) continue;
      findCopies(join(dir, entry.name), found);
    } else if (ASSETS.includes(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const update = process.argv.includes("--update");
const copies = findCopies(ROOT);

if (copies.length === 0) {
  console.log("unity-theme: no vendored copies found (nothing to check)");
  process.exit(0);
}

let stale = 0;

for (const copy of copies) {
  const name = basename(copy);
  const want = canonical.get(name);
  const have = readFileSync(copy);
  const where = relative(ROOT, copy);

  if (have.equals(want)) {
    console.log(`unity-theme: ok       ${where}`);
    continue;
  }

  stale += 1;
  if (update) {
    writeFileSync(copy, want);
    console.log(`unity-theme: updated  ${where}`);
  } else {
    console.log(`unity-theme: STALE    ${where}`);
  }
}

if (stale > 0 && !update) {
  console.error(
    `\nunity-theme: ${stale} copy(ies) differ from theme/. Fix theme/ and run` +
      ` \`node theme/verify.mjs --update\`, or fix the copy if the difference was the point —` +
      ` but not by hand-editing one of two files and leaving the other.`,
  );
  process.exit(1);
}

console.log(
  update
    ? `unity-theme: re-vendored ${stale} copy(ies) from theme/`
    : `unity-theme: clean (${copies.length} copy(ies) match theme/)`,
);
