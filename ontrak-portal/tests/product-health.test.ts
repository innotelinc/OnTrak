/**
 * Every product answers its health path, and the portal knows which path that is.
 *
 * The dashboard once drew "not answering" for Sentinel because it probed
 * `/health` on a product that had no such route. This pins the convention — one
 * path, answered by every product, without a credential — so the tile table
 * cannot drift to a path nobody serves. What proves the products agree is the
 * live probe, `npm run health:check`; this is what stops the table itself from
 * being the bug.
 *
 * The file also holds the rule that there is only *one* such question. The check and
 * the dashboard have to agree about the same deployment — an operator reading "DOWN"
 * while the page draws a green light believes neither — and they did not: the script
 * carried its own status list and its own address, and ignored the
 * `ONTRAK_<KEY>_INTERNAL_URL` overrides the page honours. Both go through
 * `probeFleet` now, and a file that recomputes the rule has to say so out loud.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PRODUCTS } from "../src/lib/portal-rules";

/**
 * The exact path each product serves, written down per product.
 *
 * The convention is `/health`, answered by every product the family builds, and
 * that is what all but one entry lists. The exception is the lab: it is the Python
 * control plane (OnTrak-dev) — a peer service, not a Next.js app, and not ours to
 * change — and it answers `/healthz`. Probing it at `/health` would draw exactly the
 * false "not answering" the dashboard once drew for Sentinel, so the rule is not
 * "every product says `/health`" but "every product declares the path it serves, and
 * the catalogue's list is the whole list". A product whose route moves still fails
 * this, and a product added without a path here fails too.
 */
const EXPECTED_HEALTH: Record<string, string> = {
  its: "/health",
  tix: "/health",
  sentinel: "/health",
  sync: "/health",
  genie: "/health",
  lab: "/healthz",
};

test("the declared list covers exactly the catalogue", () => {
  assert.deepEqual(
    PRODUCTS.map((product) => product.key).sort(),
    Object.keys(EXPECTED_HEALTH).sort(),
    "every product needs a health path, and no path here may name a product that is gone",
  );
});

test("every product declares the path it serves", () => {
  for (const product of PRODUCTS) {
    assert.equal(
      product.health,
      EXPECTED_HEALTH[product.key],
      `${product.key} must answer ${EXPECTED_HEALTH[product.key]} — the dashboard probes this exact path`,
    );
  }
});

test("every product has a single-label host to build a URL from", () => {
  for (const product of PRODUCTS) {
    assert.match(
      product.host,
      /^[a-z0-9-]+$/,
      `${product.key} needs one subdomain label (got "${product.host}")`,
    );
  }
});

/** The one module allowed to decide what counts as a product answering. */
const RULE_OWNER = path.join("src", "lib", "sync-client.ts");

/** What a line says when it is not the liveness rule. A reason has to follow the colon. */
const EXEMPT = "health-rule-exempt:";

/** The two halves of the rule: a 401 and a 403 both read as "serving". */
const SIGNS = [/status === 401/, /status === 403/];

/** Every `.ts`/`.tsx`/`.mjs` under a directory: the code that could ask the question. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|mjs)$/.test(entry.name) ? [full] : [];
  });
}

/** Prose about the rule is not an application of it. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** Each line carrying half of the liveness rule, as `path:line: source`. */
function ruleLinesIn(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) =>
      isComment(line) || !SIGNS.some((sign) => sign.test(line))
        ? []
        : [`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`],
    );
}

/** The whole tree that could ask the question: the app, and the check that mirrors it. */
function everyProbeFile(): string[] {
  return [
    ...sourceFiles(path.join(process.cwd(), "src")),
    ...sourceFiles(path.join(process.cwd(), "scripts")),
  ];
}

test("the health guard reads the tree it claims to guard", () => {
  // A walk that silently found nothing would pass the check below by defining it
  // away, so it has to prove it saw the source and the module it exempts.
  const src = sourceFiles(path.join(process.cwd(), "src"));
  assert.ok(src.length >= 15, `the walk found only ${src.length} files under src/`);
  assert.ok(
    everyProbeFile().includes(path.join(process.cwd(), RULE_OWNER)),
    `the walk must include ${RULE_OWNER}, which owns the rule`,
  );

  const ownerLines = ruleLinesIn(path.join(process.cwd(), RULE_OWNER)).join("\n");
  assert.ok(
    SIGNS.every((sign) => sign.test(ownerLines)),
    `the rule's signature is gone from ${RULE_OWNER}, so this guard would pass by finding nothing`,
  );
});

test("the liveness rule is asked in one place", () => {
  const offenders = everyProbeFile()
    .filter((file) => path.relative(process.cwd(), file) !== RULE_OWNER)
    .filter((file) => {
      const lines = ruleLinesIn(file);
      const countsBoth =
        lines.some((line) => SIGNS[0].test(line)) && lines.some((line) => SIGNS[1].test(line));
      return countsBoth && !lines.some((line) => line.includes(EXEMPT));
    });

  assert.deepEqual(
    offenders,
    [],
    "which statuses count as a product answering is decided by probeProduct() in " +
      `${RULE_OWNER}, so the dashboard and \`npm run health:check\` cannot disagree about ` +
      "the same deployment. A file that genuinely asks a different question marks its " +
      `line "${EXEMPT} <reason>":\n` +
      offenders.join("\n"),
  );
});

test("every liveness exemption says why it is not the same question", () => {
  const excuses = everyProbeFile()
    .flatMap(ruleLinesIn)
    .filter((line) => line.includes(EXEMPT))
    .filter((line) => line.slice(line.indexOf(EXEMPT) + EXEMPT.length).trim().length < 10);

  assert.deepEqual(excuses, [], `an exemption has to say why: ${excuses.join(", ")}`);
});
