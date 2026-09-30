#!/usr/bin/env node
/**
 * Run every product's sign-in copy guard, in one command.
 *
 *   make copy-check
 *   node scripts/copy-check.mjs
 *
 * Each product owns its guard, next to the thing it guards — `ontrak-genie/`,
 * `ontrak-portal/`, `ontrak-tix/`, `ontrak-sync/web/`, `ontrak-sentinel/` — because the
 * copy is per-product and so is the reason a phrase is or is not allowed there. What
 * was missing was one place to run them all, which is what this is: `make check` calls
 * it, so the front door is checked by the same command that checks the theme, the
 * types and the tests.
 *
 * The guards are **found rather than listed**. A product that gains one is covered
 * without this file being edited, and the count is printed on every run, so a guard
 * that is deleted shows up as a smaller number rather than as silence.
 *
 * The training app at the repository root is the one product without a guard, because
 * its sign-in is a student account form rather than a product gate. That is a gap, not
 * a decision to celebrate; it is named here so it is not mistaken for coverage.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Directories that hold no product's own source. */
const SKIP_DIRS = new Set([
  ".agent",
  ".freebuff",
  ".git",
  ".next",
  ".stack",
  "accounts",
  "build",
  "dist",
  "node_modules",
  "sandbox",
  "workspace",
]);

/** Every `scripts/copy-check.mjs` under the repository, excluding this one. */
function guards(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const child = path.join(dir, entry.name);
    const guard = path.join(child, "scripts", "copy-check.mjs");
    if (entry.name !== "scripts" && fs.existsSync(guard)) found.push(guard);
    found.push(...guards(child));
  }
  return found;
}

const found = guards(ROOT).sort();

if (found.length === 0) {
  console.error("copy-check: no product has a sign-in copy guard, which cannot be right.");
  process.exit(1);
}

const failed = [];

for (const guard of found) {
  const product = path.relative(ROOT, path.dirname(path.dirname(guard)));
  try {
    // The guard resolves its own root from its location, so it only needs its cwd.
    execFileSync(process.execPath, [guard], { cwd: path.dirname(path.dirname(guard)), stdio: "pipe" });
    console.log(`  ok    ${product}`);
  } catch (failure) {
    failed.push(product);
    const output = String(failure.stdout ?? "") + String(failure.stderr ?? "");
    console.error(`  FAIL  ${product}`);
    for (const line of output.split("\n").filter((line) => line.trim() !== "")) {
      console.error(`        ${line}`);
    }
  }
}

if (failed.length > 0) {
  console.error(`\ncopy-check: ${failed.length} of ${found.length} fronts failed — ${failed.join(", ")}`);
  console.error("        The front door carries the product and the way in. Everything else goes.");
  process.exit(1);
}

console.log(`\ncopy-check: ${found.length} product fronts clean`);
