#!/usr/bin/env node
/**
 * Check that the sign-in gate and the shared chrome carry no family taglines.
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
 * Unlike the Genie console, the portal is a React app: its gate and its chrome are
 * `.tsx`, and the prose that must not appear lives both in JSX text and in the
 * comments explaining the design. Comments are stripped before the scan, so an
 * explanation of *why* the family has one identity layer stays welcome while the
 * sentence does not.
 *
 * The rules are split in two, because they are not the same rule:
 *
 *   gate    the sign-in page carries the product and the way in, and nothing else.
 *   chrome  the masthead and footer carry the product and who you are signed in
 *           as: no family links, no family names.
 *
 * The vendored Unity theme is not read: it is byte-identical in every product
 * (the family repository's `theme/tests/test_theme_copies.py` fails if any copy
 * drifts), so nothing here may rewrite it.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The sign-in page and the panel it renders: the front door, in full. */
const GATE_FILES = ["src/app/login/page.tsx", "src/components/SignInPanel.tsx"];

/** The chrome every screen shares. */
const CHROME_FILES = ["src/app/layout.tsx"];

/**
 * Phrases that must not appear on the gate.
 *
 * Each is a tagline or a pitch, not a feature: the page can offer the provider,
 * but it does not sell the identity service, and it never speaks for the family.
 */
const GATE_PHRASES = [
  ["one identity", "the family's tagline for its identity service"],
  ["one sign-in", "the family's tagline for its identity service"],
  ["one signin", "the family's tagline for its identity service"],
  ["every product", "a family tagline — a page is about one product"],
  ["second factor", "login-screen sales copy"],
  ["accounts, groups", "login-screen sales copy"],
  ["single sign-on", "login-screen sales copy"],
];

/** Phrases that must not appear in the masthead or the footer. */
const CHROME_PHRASES = [
  ["the family", "a reference to the family, not to this product"],
  ["family landing", "a link back to the family site"],
  ["platform stack", "a reference to the platform, not to this product"],
  ["innotel labs", "an attribution the product's own name already carries"],
  ["innotel-platform-stack", "a link back to the family's standards repository"],
];

/** Any link to the family's own sites, wherever the anchor text hides it. */
const FAMILY_LINK = /https?:\/\/[^"'\s>]*innotelinc[^"'\s>]*/i;

/**
 * Blank out comments while keeping every offset where it was, so the line a
 * problem is reported on is the line a person will find it on. The `[^:]` guard
 * in the line rule is what keeps `https://` inside a string intact.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + " ".repeat(match.length - lead.length));
}

/** The 1-based line an offset falls on, for a message a person can act on. */
function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

const problems = [];

function report(file, text, index, phrase, why) {
  problems.push(`${file}:${lineAt(text, index)}  “${phrase}” — ${why}`);
}

function inspect(file, phrases) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  const text = stripComments(source);
  const lower = text.toLowerCase();

  for (const [phrase, why] of phrases) {
    let at = lower.indexOf(phrase);
    while (at !== -1) {
      report(file, text, at, phrase, why);
      at = lower.indexOf(phrase, at + phrase.length);
    }
  }

  const link = FAMILY_LINK.exec(text);
  if (link !== null) report(file, text, link.index, link[0], "a link back to the family");
}

for (const file of GATE_FILES) inspect(file, GATE_PHRASES);
for (const file of CHROME_FILES) inspect(file, CHROME_PHRASES);

const files = GATE_FILES.length + CHROME_FILES.length;

if (problems.length > 0) {
  for (const problem of problems) console.error(`  not ok  ${problem}`);
  console.error(`\nFAIL  ${problems.length} problem${problems.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`);
  console.error("      The front door carries the product and the way in. Everything else goes.");
  process.exit(1);
}

console.log(`OK  ${files} files, no family taglines and no login-screen copy`);
