#!/usr/bin/env node
/**
 * Check that no page carries the family's taglines, or a login screen's sales copy.
 *
 *   npm run copy:check
 *
 * Why this exists: signing in is the product's front door, and a front door says
 * which product it belongs to and lets you in. Everything else that accumulates
 * there — the family's taglines ("one identity, every product"), a description of
 * the identity service's accounts, groups and second factors, a footer of
 * cross-links to the other products — belongs on a marketing page if anywhere,
 * and it is the copy that survives longest, because nothing breaks when it goes
 * stale: no test fails, no build errors, it just keeps being wrong on the one
 * screen every user sees first.
 *
 * The rules are split in two, because they are not the same rule:
 *
 *   page    a family tagline or a sign-in pitch must not appear on a page at all.
 *   chrome  the <header> and <footer> carry the product and the way in, and
 *           nothing else: no family links, no family names.
 *
 * Only HTML is read, and the vendored Unity theme is left alone: it is
 * byte-identical in every product (theme/tests/test_theme_copies.py in the family
 * repository fails if any copy drifts), so nothing here may rewrite it.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Directories that hold no page of this product's own. */
const SKIP_DIRS = new Set([
  ".agent",
  ".freebuff",
  ".git",
  "accounts",
  "dist",
  "node_modules",
  "sandbox",
  "workspace",
]);

/**
 * Phrases that must not appear anywhere on a page.
 *
 * Each is a tagline or a pitch, not a feature: a page can describe signing in,
 * but it does not sell it, and it never speaks for the rest of the family.
 */
const PAGE_PHRASES = [
  ["one identity", "the family's tagline for its identity service"],
  ["one sign-in", "the family's tagline for its identity service"],
  ["one signin", "the family's tagline for its identity service"],
  ["every product", "a family tagline — a page is about one product"],
  ["second factor", "login-screen sales copy"],
  ["accounts, groups", "login-screen sales copy"],
  ["single sign-on", "login-screen sales copy"],
];

/**
 * Phrases that must not appear in a <header> or <footer>.
 *
 * Narrower than the page rule only in where it applies: the chrome is the shared
 * part of every screen, so a family name there is a family name everywhere.
 */
const CHROME_PHRASES = [
  ["the family", "a reference to the family, not to this product"],
  ["family landing", "a link back to the family site"],
  ["platform stack", "a reference to the platform, not to this product"],
  ["innotel labs", "an attribution the product's own name already carries"],
  ["innotel-platform-stack", "a link back to the family's standards repository"],
];

/** Any link to the family's own sites, wherever the anchor text hides it. */
const CHROME_LINK = /https?:\/\/[^"'\s>]*innotelinc[^"'\s>]*/i;

/** Every HTML file under `dir`, deepest-last, skipping the vendored and generated. */
function pages(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      found.push(...pages(path.join(dir, entry.name)));
    } else if (entry.isFile() && (entry.name.endsWith(".html") || entry.name.endsWith(".htm"))) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/** The 1-based line a byte offset falls on, for a message a person can act on. */
function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

const problems = [];

function report(file, text, index, phrase, why) {
  const line = lineAt(text, index);
  problems.push(`${path.relative(ROOT, file)}:${line}  “${phrase}” — ${why}`);
}

/** Phrases anywhere on the page, then the header and footer on their own. */
function inspect(file) {
  const text = fs.readFileSync(file, "utf8");
  const lower = text.toLowerCase();

  for (const [phrase, why] of PAGE_PHRASES) {
    let at = lower.indexOf(phrase);
    while (at !== -1) {
      report(file, text, at, phrase, why);
      at = lower.indexOf(phrase, at + phrase.length);
    }
  }

  const chrome = /<(header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi;
  for (let match = chrome.exec(text); match !== null; match = chrome.exec(text)) {
    const block = match[0];
    const start = match.index;
    const blockLower = block.toLowerCase();

    for (const [phrase, why] of CHROME_PHRASES) {
      let at = blockLower.indexOf(phrase);
      while (at !== -1) {
        report(file, text, start + at, phrase, why);
        at = blockLower.indexOf(phrase, at + phrase.length);
      }
    }

    const link = CHROME_LINK.exec(block);
    if (link !== null) {
      report(file, text, start + link.index, link[0], "a family link in the header or footer");
    }
  }
}

const files = pages(ROOT).sort();
for (const file of files) inspect(file);

if (problems.length > 0) {
  for (const problem of problems) console.error(`  not ok  ${problem}`);
  console.error(`\nFAIL  ${problems.length} problem${problems.length === 1 ? "" : "s"} in ${files.length} page${files.length === 1 ? "" : "s"}`);
  console.error("      The front door carries the product and the way in. Everything else goes.");
  process.exit(1);
}

console.log(`OK  ${files.length} page${files.length === 1 ? "" : "s"}, no family taglines and no login-screen copy`);
