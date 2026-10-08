/**
 * The service map may not call a product that is in the repository unbuilt.
 *
 * `docs/stack.md` answers "what is OnTrak made of", and its service map is read as a
 * statement about *this repository*: one row per component, with the technology it is
 * actually built from. That is what makes a stale row expensive rather than untidy.
 * `ontrak-sentinel` was listed as "(planned)" and "(unbuilt)" long after the
 * directory held the product, after `docker-compose.all.yml` started it as
 * `sentinel-app`, and after the Makefile counted it among the six the family stack
 * brings up. A reader who trusted the map would conclude that the family's own IdP
 * and IDS/IPS did not exist yet — in the same repository that ships them.
 *
 * The rule is the narrow half of that: a row naming a directory that is present here
 * may not describe it as planned, unbuilt or elsewhere. A component that genuinely is
 * not ours says so in its name (the lab's row carries "(not built from this
 * repository)" for exactly that reason), so nothing needs exempting.
 *
 * What it deliberately does not check is the prose. Whether a count in a sentence
 * matches the catalogue, or whether a row's description is still the best words for
 * the component, is a judgement; a guard that guessed at it would be wrong often
 * enough to be switched off. It settles the one claim a file can settle on its own.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/** The map, relative to the repository root the suite runs from. */
const MAP = path.join("docs", "stack.md");

/**
 * Labels claiming a component is not here.
 *
 * The lab's marker is in the list on purpose: it is true of the lab and false of every
 * directory this repository holds, which is the distinction the rule draws.
 */
const ABSENT = ["(planned)", "(unbuilt)", "not built from this repository"];

/** The service map's rows — the raw table lines, header included. */
function serviceMap(): string[] {
  const text = readFileSync(path.join(process.cwd(), MAP), "utf8");
  const [, afterHeading = ""] = text.split(/^## Service map\s*$/m);
  const [table = ""] = afterHeading.split(/^## /m);
  return table.split("\n").filter((line) => line.trimStart().startsWith("|"));
}

/**
 * The product directories in this repository, by directory name.
 *
 * Read from disk rather than listed here: a hand-kept list would be the same kind of
 * stale claim the guard exists to catch, one level down.
 */
function productDirectories(): string[] {
  return readdirSync(process.cwd(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ontrak-"))
    .map((entry) => entry.name)
    .sort();
}

test("docs: the service-map guard reads the table it claims to guard", () => {
  // A walk that quietly found an empty section would pass the checks below by
  // defining them away, so the table and its rows have to be shown to exist first.
  const rows = serviceMap();
  assert.ok(rows.length >= 8, `the service map has only ${rows.length} rows`);
  assert.ok(
    rows[0].includes("Component") && rows[0].includes("Technology"),
    `the first row should be the table's header, got: ${rows[0]}`,
  );

  const directories = productDirectories();
  assert.ok(
    directories.includes("ontrak-sentinel"),
    `the walk found these product directories: ${directories.join(", ")}`,
  );
});

test("docs: every product directory in this repository has a service-map row", () => {
  const rows = serviceMap();
  const missing = productDirectories().filter(
    (directory) => !rows.some((row) => row.includes(directory)),
  );

  assert.deepEqual(
    missing,
    [],
    "a product built here that the service map does not mention is invisible to the " +
      `reader asking what OnTrak is made of: ${missing.join(", ")}`,
  );
});

test("docs: no service-map row calls a directory that is here unbuilt", () => {
  const present = productDirectories();
  const offenders = serviceMap()
    .filter((row) => present.some((directory) => row.includes(directory)))
    .flatMap((row) =>
      ABSENT.filter((label) => row.includes(label)).map(
        (label) => `${label} — in the row: ${row.trim()}`,
      ),
    );

  assert.deepEqual(
    offenders,
    [],
    "the directory exists in this repository, so the row may not say it does not. If " +
      "the component really is built elsewhere, name it as the lab's row does and it " +
      `will not look like one of ours:\n${offenders.join("\n")}`,
  );
});
