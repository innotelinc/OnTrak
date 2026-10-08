/**
 * The invariant the fix that moved a pass onto `src/lib/score-rules.ts` cannot
 * state for itself: nothing else decides one.
 *
 * That change was swept for by searching the tree for the word "passed", and the
 * sweep missed four screens that asked the same question without using it. Two
 * named the answer `ok`, one was an early return on `percent < passScore`, and one
 * lived in a file the search never opened. All four kept a private copy of the
 * rule, so an attempt worth zero points could be a pass on four screens and a
 * failure on every other surface that reports it.
 *
 * Nobody re-reads the whole source before every merge, so the check is mechanical:
 * a pass mark may be handed *to* the rule, but nothing outside the module that owns
 * it may compare a score to one. A line that genuinely is not a verdict says so,
 * with a reason, and that reason is in the diff that added it.
 *
 * The detector is deliberately simple rather than a parser. It wants a
 * space-padded operator, which is how comparisons are written here, so a generic
 * such as `Pick<CertificateAttempt, "score" | "passScore">` is not mistaken for
 * one, and prose about the rule is skipped. It can therefore be evaded by writing a
 * comparison with no spaces around the operator, and it only sees a pass mark that
 * is still called `passScore`: a copy held in a variable under another name is
 * invisible to it. It exists to catch the mistake a person makes, not to be a type
 * checker.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/** The one module allowed to compare a score to a pass mark. */
const OWNER = path.join("src", "lib", "score-rules.ts");

/** What a line says when it is not a verdict. A reason has to follow the colon. */
const EXEMPT = "pass-rule-exempt:";

/** Every `.ts`/`.tsx` under `src/`: the app whose verdicts this rule governs. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** A comparison, written the way this codebase writes them. */
const COMPARISON = / (?:>=|<=|<|>) /;

/** Prose about the rule is not an application of it. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** Each comparison against a pass mark in one file, as `path:line: source`. */
function comparisonsIn(file: string): string[] {
  const relative = path.relative(process.cwd(), file);
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      if (!line.includes("passScore") || isComment(line)) return [];
      if (!COMPARISON.test(line)) return [];
      return [`${relative}:${index + 1}: ${line.trim()}`];
    });
}

test("score: the guard reads the tree it claims to guard", () => {
  // A walk that silently finds nothing would pass the check below by defining it
  // away, so it has to prove it saw the source and the module it exempts.
  const files = sourceFiles(path.join(process.cwd(), "src"));
  assert.ok(files.length > 50, `the walk found only ${files.length} files under src/`);
  assert.ok(
    files.includes(path.join(process.cwd(), OWNER)),
    "the walk must include the module that owns the rule",
  );
});

test("score: nothing outside score-rules.ts compares a score to a pass mark", () => {
  const offenders = sourceFiles(path.join(process.cwd(), "src"))
    .filter((file) => path.relative(process.cwd(), file) !== OWNER)
    .flatMap(comparisonsIn)
    .filter((line) => !line.includes(EXEMPT));

  assert.deepEqual(
    offenders,
    [],
    "a pass is decided by clearedPassMark() in src/lib/score-rules.ts. If one of " +
      `these is genuinely not a verdict, end its line with "${EXEMPT} <reason>":\n` +
      offenders.join("\n"),
  );
});

test("score: every exemption says why it is not a verdict", () => {
  const excuses = sourceFiles(path.join(process.cwd(), "src")).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("pass-rule-exempt") && !/pass-rule-exempt:\s+\S/.test(line))
      .map((line) => `${path.relative(process.cwd(), file)}: ${line.trim()}`),
  );

  assert.deepEqual(excuses, [], `the marker needs a reason after it:\n${excuses.join("\n")}`);
});
