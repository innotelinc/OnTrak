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
 * So five claims are checked mechanically, each settled by files:
 *
 *  * every port in the guide's "What runs where" table is a port the family compose
 *    publishes;
 *  * every deployment the guide says has a production overlay has one, with the target
 *    that starts it;
 *  * the redirect URIs it lists for the `ontrak` client are exactly the ones
 *    `scripts/cerulean-ontrak.py` registers, each at a name that script publishes —
 *    because the guide is what an operator registers the client from while the script
 *    is what fills Cerulean's `.env`, and the two had already drifted: the page stopped
 *    at five while the client registers six, with Genie's callback missing from it;
 *  * the products its role table gives each role are the ones the portal's catalogue
 *    gives that role, because that table is where an operator decides which group to put
 *    somebody in — and it had drifted too: `SYSADMIN` reaches Genie, and the row said
 *    "Tix, Sentinel, Sync", four pages above a sentence saying sysadmins reach
 *    everything;
 *  * the accounts, passwords and join code its first-sign-in table names are the ones
 *    the seeds create — the table an operator reads on the first morning, where a stale
 *    row is a room that cannot sign in.
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
/** The catalogue that answers which products each role is shown. */
const PORTAL_RULES = path.join("ontrak-portal", "src", "lib", "portal-rules.ts");

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

/**
 * Every product in the portal's catalogue, with the roles it is shown to.
 *
 * Read from the catalogue rather than listed here — a hand-kept list would be the same
 * stale claim one level down — and cut at each product's own closing brace, so one
 * entry's role list cannot be borrowed by the entry below it.
 */
function catalogue(): { key: string; roles: string[]; optional: boolean }[] {
  const [, afterCatalogue = ""] = read(PORTAL_RULES).split(/export const PRODUCTS[\s\S]*?= \[/);
  const [products = ""] = afterCatalogue.split(/\n\];/);

  const entries: { key: string; roles: string[]; optional: boolean }[] = [];
  for (const chunk of products.split(/key: "/).slice(1)) {
    const key = /^([a-z]+)"/.exec(chunk)?.[1];
    if (!key) continue;
    const [fields = ""] = chunk.split(/\n {2}\},/);
    const listed = /roles: \[([^\]]*)\]/.exec(fields)?.[1] ?? "";
    entries.push({
      key,
      roles: [...listed.matchAll(/"([A-Z]+)"/g)].map((match) => match[1]),
      optional: /optional: true/.test(fields),
    });
  }
  return entries;
}

/**
 * How the guide writes each product's name in a table cell.
 *
 * A translation, and a checked one: the test refuses a catalogue key this map does not
 * know, so a seventh product cannot arrive in the catalogue and be missing from the
 * guide's role table without something failing.
 */
const CELL_NAME: Record<string, string> = {
  its: "training",
  tix: "Tix",
  sentinel: "Sentinel",
  sync: "Sync",
  genie: "Genie",
  lab: "the lab",
};

/** The guide's role table: the group, the role, and the products it says that role is for. */
function guideRoleTable(): { group: string; role: string; belongsIn: string }[] {
  const [, afterHeading = ""] = read(GUIDE).split(/^### The role groups\s*$/m);
  const [section = ""] = afterHeading.split(/^### /m);
  return section
    .split("\n")
    .filter((line) => line.trimStart().startsWith("| `"))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return {
        group: cells[1] ?? "",
        role: (cells[2] ?? "").replace(/`/g, ""),
        belongsIn: cells[3] ?? "",
      };
    });
}

/**
 * The guide's first-sign-in table, one raw line per product.
 *
 * Whole lines rather than cells, because the Sync row carries a pipe of its own
 * (`docker logs ontrak-sync-api | grep …`): splitting on `|` would shear that row in
 * two, and the phrase it tells an operator to grep for is most of the check.
 */
function firstSignIn(): Map<string, string> {
  const [, afterHeading = ""] = read(GUIDE).split(/^## 6a\. Signing in for the first time\s*$/m);
  const [section = ""] = afterHeading.split(/^## /m);
  const rows = new Map<string, string>();
  for (const line of section.split("\n")) {
    const product = /^\|\s*([A-Za-z]+)/.exec(line)?.[1];
    if (product) rows.set(product.toLowerCase(), line);
  }
  return rows;
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

test("family-ops: the guide's role table is the catalogue's answer, role by role", () => {
  const products = catalogue();
  assert.ok(products.length >= 6, `the catalogue yielded ${products.length} products`);

  const unnamed = products.map((entry) => entry.key).filter((key) => !(key in CELL_NAME));
  assert.deepEqual(unnamed, [], `the role table has no name for: ${unnamed.join(", ")}`);

  const rows = guideRoleTable();
  assert.ok(rows.length >= 6, `the guide's role table yielded ${rows.length} rows`);

  // The guide describes the deployment this repository runs — the six the family stack
  // starts — so the catalogue's one optional product is deliberately not in its rows.
  const shown = products.filter((entry) => !entry.optional);
  const problems: string[] = [];

  for (const row of rows) {
    const wanted = shown.filter((entry) => entry.roles.includes(row.role)).map((entry) => entry.key);
    const cell = row.belongsIn.toLowerCase();
    const said = shown
      .filter((entry) => cell.includes("everything") || cell.includes(CELL_NAME[entry.key].toLowerCase()))
      .map((entry) => entry.key);

    const missing = wanted.filter((key) => !said.includes(key));
    const extra = said.filter((key) => !wanted.includes(key));
    if (missing.length > 0) problems.push(`${row.group} (${row.role}) does not name ${missing.join(", ")}`);
    if (extra.length > 0) {
      problems.push(`${row.group} (${row.role}) names ${extra.join(", ")}, which is not shown that role`);
    }
  }

  const absent = [...new Set(shown.flatMap((entry) => entry.roles))].filter(
    (role) => !rows.some((row) => row.role === role),
  );
  if (absent.length > 0) problems.push(`no row for ${absent.join(", ")}`);

  assert.deepEqual(problems, [], problems.join("\n"));
});

test("family-ops: the first-sign-in table names accounts the seeds actually create", () => {
  const rows = firstSignIn();

  // The training app's demo accounts, its default password and its join code, all read
  // from the files that create them rather than repeated here.
  const seed = read(path.join("prisma", "seed.ts"));
  const seeded = new Set(
    [...seed.matchAll(/"([a-z0-9._%+-]+@ontrak\.local)"/g)].map((match) => match[1]),
  );
  const seedPassword =
    /DEMO_PASSWORD_DEFAULT = "([^"]+)"/.exec(read(path.join("src", "lib", "seed-rules.ts")))?.[1] ?? "";
  const joinCode = /joinCode: "([^"]+)"/.exec(seed)?.[1] ?? "";
  assert.ok(seeded.size >= 3, `the training seed yielded ${seeded.size} demo addresses`);
  assert.ok(seedPassword !== "", "the training app's default demo password was not read");
  assert.ok(joinCode !== "", "the training seed's join code was not read");

  // The desk's demo accounts and password, from the desk's own seed.
  const deskSeed = read(path.join("ontrak-tix", "prisma", "seed.ts"));
  const deskSeeded = new Set(
    [...deskSeed.matchAll(/email: "([^"]+@acme\.test)"/g)].map((match) => match[1]),
  );
  const deskPassword = /const DEMO_PASSWORD = "([^"]+)"/.exec(deskSeed)?.[1] ?? "";
  assert.ok(deskSeeded.size >= 3, `the desk's seed yielded ${deskSeeded.size} demo addresses`);
  assert.ok(deskPassword !== "", "the desk's demo password was not read");

  const training = rows.get("training") ?? "";
  const tix = rows.get("tix") ?? "";
  const sync = rows.get("sync") ?? "";
  assert.ok(training !== "" && tix !== "" && sync !== "", "the guide's first-sign-in table was not read");

  const problems: string[] = [];

  // A guide may name fewer accounts than a seed creates, but never one it does not.
  for (const email of training.match(/[a-z0-9._%+-]+@ontrak\.local/g) ?? []) {
    if (!seeded.has(email)) problems.push(`Training names ${email}, which the seed does not create`);
  }
  // Every literal in this guide is a backticked token, and matching the token rather
  // than the bare text is what keeps `ChangeMe1234` from counting as `ChangeMe123`: a
  // substring test calls a drifted password correct because the old one is inside it.
  if (!training.includes(`\`${seedPassword}\``)) {
    problems.push(`Training does not state the seed's default password (${seedPassword}), so a first sign-in fails`);
  }
  if (!training.includes(`\`${joinCode}\``)) problems.push(`Training does not state the seed's join code (${joinCode})`);

  for (const email of tix.match(/[a-z0-9._%+-]+@acme\.test/g) ?? []) {
    if (!deskSeeded.has(email)) problems.push(`Tix names ${email}, which the desk's seed does not create`);
  }
  if (!tix.includes(`\`${deskPassword}\``)) {
    problems.push(`Tix does not state the desk's demo password (${deskPassword})`);
  }

  // Sync's first sign-in is a password printed once, so the guide tells an operator to
  // grep for a phrase — and the API has to be printing it.
  const phrase = /grep '([^']+)'/.exec(sync)?.[1] ?? "";
  assert.ok(phrase !== "", "the Sync row no longer names the phrase to grep for");
  if (!read(path.join("ontrak-sync", "backend", "ontrak", "api.py")).includes(phrase)) {
    problems.push(`Sync tells an operator to grep for "${phrase}", which the API never prints`);
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});
