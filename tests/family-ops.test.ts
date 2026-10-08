/**
 * The operations guide may not name a port the family stack does not publish.
 *
 * `docs/family-operations.md` opens by saying it is written for the deployment that
 * exists and is "deliberately specific — addresses, ports and the commands that were
 * actually run", because a guide that describes an architecture instead of a
 * deployment is "a guide nobody can follow at 3am". Specific is exactly what makes it
 * worth checking: a port that moved in `docker-compose.all.yml` leaves the guide
 * pointing at a closed one, and the reader who trusts it concludes the product is
 * down. This is the same failure the service map had (see `service-map.test.ts`),
 * one layer down: a document that describes a deployment has to describe *this* one.
 *
 * So three claims are checked mechanically, each settled by files:
 *
 *  * every port in the guide's "What runs where" table is a port the family compose
 *    publishes;
 *  * every deployment the guide says has a production overlay has one, with the target
 *    that starts it;
 *  * the redirect URIs it lists for the `ontrak` client are exactly the ones
 *    `scripts/cerulean-ontrak.py` registers, each at a name that script publishes —
 *    because the guide is what an operator registers the client from while the script
 *    is what fills Cerulean's `.env`, and the two had already drifted: the page stopped
 *    at five while the client registers six, with Genie's callback missing from it.
 *
 * What it does not check is which product *should* be in the table, or whether a
 * product is worth listing: those are decisions, and the audit records them — §9/Q4
 * settles whether the family edge may serve one, and §8 keeps the lab off the page
 * either way, because the page lists what this deployment serves.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/** The guide, the file that decides the ports, the file that starts a deployment, and
 * the script that provisions the trust plane. */
const GUIDE = path.join("docs", "family-operations.md");
const COMPOSE = "docker-compose.all.yml";
const MAKEFILE = "Makefile";
const PROVISION = path.join("scripts", "cerulean-ontrak.py");

/** The deployments the guide says have a production overlay, and how each is started. */
const OVERLAYS: Record<string, { compose: string; target: string }> = {
  Training: { compose: "docker-compose.prod.yml", target: "prod-up" },
  Tix: { compose: "ontrak-tix/docker-compose.prod.yml", target: "tix-prod-up" },
  Sentinel: { compose: "ontrak-sentinel/docker-compose.prod.yml", target: "sentinel-prod-up" },
  Genie: { compose: "ontrak-genie/docker-compose.prod.yml", target: "genie-prod-up" },
};

function read(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

/**
 * The host ports the family stack publishes.
 *
 * Matches `- "3000:3000"` and `- "${ONTRAK_SYNC_API_PORT:-8420}:8420"` alike: the
 * left side is what a browser on the host reaches, and a variable's default is what
 * the guide can promise without knowing the deployment.
 */
function publishedPorts(): Set<string> {
  const ports = new Set<string>();
  for (const line of read(COMPOSE).split("\n")) {
    const match = /^\s+- "?(?:\$\{[A-Z0-9_]+:-)?(\d+)\}?:(\d+)"?\s*$/.exec(line);
    if (match) ports.add(match[1]);
  }
  return ports;
}

/** Every port the guide's "What runs where" table names in its port column. */
function guidePorts(): string[] {
  const [, afterHeading = ""] = read(GUIDE).split(/^## 1\. What runs where\s*$/m);
  const [table = ""] = afterHeading.split(/^## /m);
  return table
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .flatMap((line) => {
      const column = line.split("|")[3] ?? "";
      return column.match(/\d{4,5}/g) ?? [];
    });
}

/**
 * The redirect URIs the guide lists for the `ontrak` client, in the order it lists them.
 *
 * Read from the fenced block under the heading, because the block is what an operator
 * copies into the provider: it is the copy that has to be right.
 */
function guideRedirectUris(): string[] {
  const [, afterHeading = ""] = read(GUIDE).split(
    /^### The redirect URIs registered on the `ontrak` client\s*$/m,
  );
  const fenced = afterHeading.split("```")[1] ?? "";
  return [...fenced.matchAll(/https:\/\/\S+/g)].map((match) => match[0]);
}

/**
 * The redirect URIs `scripts/cerulean-ontrak.py` registers on the same client.
 *
 * Parsed rather than run: the script needs a Cerulean service key to do anything, and a
 * check that cannot run without a credential is a check that stops being run.
 */
function scriptRedirectUris(): string[] {
  const [, afterList = ""] = read(PROVISION).split(/^REDIRECT_URIS = \[\s*$/m);
  const [block = ""] = afterList.split(/^\]/m);
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Every name the script publishes, as `<name>.<zone>`.
 *
 * The host map's `name` and the zone the script defaults to, both read from the file: a
 * hand-kept list here would be the same kind of stale claim one level down.
 */
function publishedNames(): Set<string> {
  const script = read(PROVISION);
  const rows = [...script.matchAll(/"name":\s*"([^"]+)"/g)].map((match) => match[1]);
  const zone = /env\("CERULEAN_ONTRAK_ZONE",\s*"([^"]+)"\)/.exec(script)?.[1] ?? "";
  assert.ok(rows.length >= 6, `the script's host map yielded ${rows.length} names`);
  assert.ok(zone, `${PROVISION} no longer states the zone its names live in`);
  return new Set(rows.map((name) => `${name}.${zone}`));
}

test("family-ops: the guide and the compose file it describes were both read", () => {
  // A parser that silently found nothing would pass the check below by defining it
  // away, so both sides have to be shown to have content first.
  const ports = guidePorts();
  assert.ok(ports.length >= 6, `the guide's port column yielded ${ports.length} ports`);
  assert.ok(
    publishedPorts().size >= 6,
    `the compose file yielded ${publishedPorts().size} published ports`,
  );
});

test("family-ops: every port the guide names is one the family stack publishes", () => {
  const published = publishedPorts();
  const wrong = guidePorts().filter((port) => !published.has(port));

  assert.deepEqual(
    wrong,
    [],
    "the guide has to describe the deployment that exists: docker-compose.all.yml " +
      `does not publish ${wrong.join(", ")}`,
  );
});

test("family-ops: the deployments the guide says have an overlay have one", () => {
  const guide = read(GUIDE);
  const sentence = guide.split("\n").find((line) => line.includes("overlays beside them")) ?? "";
  const makefile = read(MAKEFILE);

  const missing: string[] = [];
  for (const [name, { compose, target }] of Object.entries(OVERLAYS)) {
    if (!sentence.includes(name)) missing.push(`${name} is not named in the guide's overlay sentence`);
    if (!existsSync(path.join(process.cwd(), compose))) missing.push(`${compose} does not exist`);
    if (!new RegExp(`^${target}:`, "m").test(makefile)) missing.push(`make ${target} is not a target`);
  }

  assert.deepEqual(missing, [], missing.join("\n"));
});

test("family-ops: the guide and the script register one set of redirect URIs", () => {
  const guide = guideRedirectUris();
  const script = scriptRedirectUris();

  // Both sides have to be shown to have content, or two empty lists compare equal and
  // the check passes by defining itself away.
  assert.ok(guide.length >= 5, `the guide's redirect block yielded ${guide.length} URIs`);
  assert.ok(script.length >= 5, `REDIRECT_URIS yielded ${script.length} URIs`);

  const missing = script.filter((uri) => !guide.includes(uri));
  const extra = guide.filter((uri) => !script.includes(uri));

  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    "an operator registers the provider's client from the guide and fills Cerulean's " +
      "`.env` from `--print-redirect-uris`, so two lists that differ are a sign-in that " +
      `fails at the provider. Missing from the guide: ${missing.join(", ") || "none"}. ` +
      `Registered by the script but not the guide: ${extra.join(", ") || "none"}.`,
  );
});

test("family-ops: every redirect URI is a name the script publishes", () => {
  const names = publishedNames();
  const uris = [...new Set([...guideRedirectUris(), ...scriptRedirectUris()])];
  const orphans = uris.filter((uri) => !names.has(new URL(uri).host));

  assert.deepEqual(
    orphans,
    [],
    "a callback at a name with no proxy host is a sign-in that cannot complete: " +
      `${orphans.join(", ")} (published: ${[...names].join(", ")})`,
  );
});
