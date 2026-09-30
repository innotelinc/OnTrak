#!/usr/bin/env node
/**
 * Check that the Sync sign-in gate carries the product and the way in, and nothing else.
 *
 *   npm run copy:check
 *
 * Why this exists: signing in is the product's front door, and a front door says
 * which product it belongs to and lets you in. Everything else that accumulates
 * there — the family's taglines ("one identity, every product"), a description of
 * the identity service's accounts, groups and second factors — belongs on a
 * marketing page if anywhere, and it is the copy that survives longest, because
 * nothing breaks when it goes stale: no test fails, no build errors, it just keeps
 * being wrong on the one screen every user sees first.
 *
 * The scan is comments-stripped, so the explanation of *why* the family has one
 * identity layer stays welcome while the sentence does not.
 *
 * One phrase is deliberately absent from the list: **"single sign-on"**. The gate
 * and the break-glass fallback are the same component (`LoginPanel.tsx`), and the
 * fallback names the normal path in visible labels — "use single sign-on", "Back to
 * single sign-on", and the honest "Single sign-on is not configured for this
 * deployment". Those are controls and states, not a pitch, so banning the phrase
 * would mean working around the rule rather than obeying it. The taglines above are
 * what this guards.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Every screen that is part of signing in: the gate and its fallback door. */
const GATE_FILES = [
  "components/LoginPanel.tsx",
  "app/login/page.tsx",
  "app/login/break-glass/page.tsx",
];

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

for (const file of GATE_FILES) {
  const text = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const lower = text.toLowerCase();

  for (const [phrase, why] of GATE_PHRASES) {
    let at = lower.indexOf(phrase);
    while (at !== -1) {
      problems.push(`${file}:${lineAt(text, at)}  “${phrase}” — ${why}`);
      at = lower.indexOf(phrase, at + phrase.length);
    }
  }

  const link = FAMILY_LINK.exec(text);
  if (link !== null) {
    problems.push(`${file}:${lineAt(text, link.index)}  “${link[0]}” — a link back to the family`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  not ok  ${problem}`);
  console.error(`\nFAIL  ${problems.length} problem${problems.length === 1 ? "" : "s"} in ${GATE_FILES.length} file${GATE_FILES.length === 1 ? "" : "s"}`);
  console.error("      The front door carries the product and the way in. Everything else goes.");
  process.exit(1);
}

console.log(`OK  ${GATE_FILES.length} gate files, no family taglines and no login-screen copy`);
