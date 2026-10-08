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
 * So two claims are checked mechanically — every port in the guide's "What runs
 * where" table is a port the family compose publishes, and every deployment the guide
 * says has a production overlay has one, with the target that starts it. Both are
 * settled by files, which is why they can be asserted rather than reviewed.
 *
 * What it does not check is which product *should* be in the table, or whether a
 * product is worth listing: those are decisions, and the audit records them (§8 keeps
 * the lab off the page until Q4 is answered).
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/** The guide, the file that decides the ports, and the file that starts a deployment. */
const GUIDE = path.join("docs", "family-operations.md");
const COMPOSE = "docker-compose.all.yml";
const MAKEFILE = "Makefile";

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
