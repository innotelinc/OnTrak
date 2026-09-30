#!/usr/bin/env node
/**
 * Check that Sentinel's sign-in page carries the product and the way in, and nothing else.
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
 * Sentinel renders its whole console as HTML from `src/lib/console-rules.ts`, so
 * the file cannot be scanned whole: elsewhere it legitimately says "one identity"
 * (a filter narrowed to a single subject) and "second factor" (the feature the
 * console is named for). The guard therefore reads only the section between the
 * file's `/*  Sign in  *\/` and `/*  Overview  *\/` markers, and **fails if it
 * cannot find them** — a marker rename must not quietly turn the guard off.
 *
 * The slice is comments-stripped, so the explanation of *why* the family has one
 * identity layer stays welcome while the sentence does not.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = "src/lib/console-rules.ts";

/** The section whose rendered copy is the front door. */
const SECTION = "Sign in";

/**
 * Phrases that must not appear on the sign-in page.
 *
 * Each is a tagline or a pitch, not a feature: the page can offer a form, but it
 * does not sell the identity service, and it never speaks for the family.
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

const source = fs.readFileSync(path.join(ROOT, SOURCE), "utf8");

// The section headers this file uses to divide the console: a comment whose only
// content is a name, e.g. `/*  Sign in     */`.
const headers = [...source.matchAll(/\/\*\s{2,}([A-Za-z][A-Za-z ]*?)\s{2,}\*\//g)].map((match) => ({
  name: match[1].trim(),
  at: match.index,
}));

const start = headers.findIndex((header) => header.name === SECTION);
if (start === -1) {
  console.error(`FAIL  ${SOURCE} has no “${SECTION}” section marker, so the guard cannot find the page it guards.`);
  process.exit(1);
}

const from = headers[start].at;
const to = start + 1 < headers.length ? headers[start + 1].at : source.length;
const text = stripComments(source.slice(from, to));
const lower = text.toLowerCase();
/** Line number in the file as a whole: the slice starts at `from`, not at zero. */
const lineAt = (index) => source.slice(0, from + index).split("\n").length;

const problems = [];

for (const [phrase, why] of GATE_PHRASES) {
  let at = lower.indexOf(phrase);
  while (at !== -1) {
    problems.push(`${SOURCE}:${lineAt(at)}  “${phrase}” — ${why}`);
    at = lower.indexOf(phrase, at + phrase.length);
  }
}

const link = FAMILY_LINK.exec(text);
if (link !== null) {
  problems.push(`${SOURCE}:${lineAt(link.index)}  “${link[0]}” — a link back to the family`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  not ok  ${problem}`);
  console.error(`\nFAIL  ${problems.length} problem${problems.length === 1 ? "" : "s"} in the ${SECTION} section`);
  console.error("      The front door carries the product and the way in. Everything else goes.");
  process.exit(1);
}

console.log(`OK  ${SECTION} section, no family taglines and no login-screen copy`);
