/**
 * The family-stack job may not call the stack up while part of it is down.
 *
 * `Family stack` is the one CI job that boots six products together, and it is the
 * artefact behind `make all-up` — so what it waits for *is* the definition of "the
 * family came up". It waited for three (training, tix, sentinel) and printed "all
 * three products are up" while `docker-compose.all.yml` started seven services: the
 * portal, Genie, and both halves of Sync were booted and never asked. A product that
 * never came up therefore left the job green, which is the same failure as a status
 * light that is never asked — a green that means nothing.
 *
 * So two claims are checked mechanically, both settled by files:
 *
 *  * every service the family stack publishes a port for is waited for by the job;
 *  * every product the portal draws a status light for is pointed at a service that
 *    answers the path the portal asks — because the portal asks
 *    `<ONTRAK_<KEY>_INTERNAL_URL><health>` from inside its own container, and a
 *    probe aimed at the wrong half of a two-service product reads exactly like an
 *    outage. Sync's `/health` is its dashboard's; its API answers only under `/api`,
 *    so pointing the light at the API drew a healthy Sync as down.
 *
 * What it does not check is which products *should* be in the family stack. OnTrak
 * Lab's light has no wiring here on purpose: the lab is OnTrak-dev's control plane, a
 * peer deployment rather than a directory of this repository, and nothing in this
 * compose file starts one. §9/Q4 answers the question that stood here — the family
 * edge *can* front a lab, as one name over the lab's single published port — and an
 * edge that can front one does not put a service in `docker-compose.all.yml`.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/** The stack, the job that boots it, and the file that decides which lights exist. */
const COMPOSE = "docker-compose.all.yml";
const WORKFLOW = path.join(".github", "workflows", "ci.yml");
const PORTAL_RULES = path.join("ontrak-portal", "src", "lib", "portal-rules.ts");

/**
 * Lights the family stack does not serve, and why.
 *
 * OnTrak Lab is OnTrak-dev's Python control plane: it runs on its own host, it is not a
 * service in this compose file, and §9/Q4 — which asked whether the family edge could
 * serve one — was answered in the direction of an edge, not of a service here. It is
 * also the portal catalogue's one *optional* product:
 * the family stack enables neither `ONTRAK_LAB_ENABLED` nor `ONTRAK_LAB_URL`, and the
 * dashboard draws no lab tile at all until a deployment sets both — so the light skipped
 * here is one this stack never draws.
 */
const NOT_IN_FAMILY_STACK = new Set(["lab"]);

function read(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

/** The `services:` block, one entry per service, as the raw lines under it. */
function serviceBlocks(file: string = COMPOSE): Map<string, string[]> {
  const lines = read(file).split("\n");
  const start = lines.indexOf("services:");
  assert.notEqual(start, -1, `${COMPOSE} has no top-level services: line`);

  const blocks = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
    // The next top-level key (`volumes:`) ends the section — and it is why this is
    // not a grep: the volume names are two-space indented, exactly like a service.
    if (/^\S/.test(line)) break;
    const service = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/.exec(line);
    if (service) {
      current = service[1];
      blocks.set(current, []);
      continue;
    }
    if (current) blocks.get(current)!.push(line);
  }
  return blocks;
}

/**
 * The ports a service publishes, both sides of the mapping.
 *
 * The sides are different addresses of the same listener and both get used here: a
 * client on the host dials the left one (`tix-app` is `3001` on the host), and a peer
 * on the compose network dials the right one through the service name (`tix-app:3000`,
 * which is what the portal's probe does). A variable's default is what a deployment
 * gets without being told otherwise: `"3000:3000"`,
 * `"${ONTRAK_SYNC_WEB_PORT:-8421}:8421"` and `"${PORT:-5514}:${PORT:-5514}/udp"`.
 *
 * A fourth shape is the same mapping pinned to a host interface —
 * `"${ONTRAK_TRAINING_BIND_HOST:-0.0.0.0}:3000:3000"` — where the *bind host* is the
 * first field. It is dropped rather than read: it is an address, not a port, and the
 * two ports that matter are the two after it. (Reading numbers out of the entry
 * instead would find `0` in the address and call it the host port, which is how a
 * check like this reports a product as unpublished while it sits there answering.)
 */
function publishedPorts(block: string[]): { host: string; container: string }[] {
  const ports: { host: string; container: string }[] = [];
  let inside = false;
  for (const line of block) {
    if (/^ {4}ports:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) inside = false;
    if (!inside) continue;
    const entry = /^\s*-\s*"?(.+?)"?\s*$/.exec(line)?.[1];
    if (!entry) continue;
    // The protocol suffix goes first, then the substitutions are expanded *before* the
    // split: a `${VAR:-5432}` holds a colon of its own, and splitting first would shear
    // it into two fields and read neither port.
    const fields = entry
      .replace(/\/\w+$/, "")
      .replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, (_match, fallback: string) => fallback)
      .split(":");
    if (fields.length === 3 && isPort(fields[1]) && isPort(fields[2])) {
      ports.push({ host: fields[1], container: fields[2] });
    } else if (fields.length === 2 && isPort(fields[0]) && isPort(fields[1])) {
      ports.push({ host: fields[0], container: fields[1] });
    }
  }
  return ports;
}

function isPort(field: string | undefined): boolean {
  return field !== undefined && /^\d+$/.test(field);
}

/** A `${VAR:?message}` whose value is the operator's, and is required to be there. */
const REQUIRED = "<required>";

/** An address that overlaps every other address on the host. */
function isWildcard(address: string): boolean {
  return address === "" || address === "0.0.0.0";
}

/**
 * Every published mapping in a compose file, with the address it is published on.
 *
 * Separate from `publishedPorts` above, which answers *which port* a service
 * serves and therefore drops the bind host: here the bind host is the whole
 * question. The address is the first field of a three-field entry, and a two-field
 * entry (`"5432:5432"`) has none — which is the wildcard, written as the empty
 * string so the rule below reads the same either way. The protocol is kept, because
 * one host port on TCP beside the same port on UDP is two listeners rather than one
 * published twice (`sentinel-app` is exactly that: syslog on 5514/tcp and on
 * 5514/udp). `${VAR:-default}` expands to its default — a default is what an
 * unconfigured deployment gets — while `${VAR:?message}` is left as a marker, since
 * that value belongs to the operator and is required to be named.
 */
function bindings(file: string): { service: string; address: string; port: string; protocol: string }[] {
  const found: { service: string; address: string; port: string; protocol: string }[] = [];
  for (const [service, block] of serviceBlocks(file)) {
    let inside = false;
    for (const line of block) {
      // `!override` rides on the `ports:` line, and a file that replaces the stack's
      // mappings is exactly the one this rule must still read.
      if (/^ {4}ports:\s*(!override)?\s*$/.test(line)) {
        inside = true;
        continue;
      }
      if (/^ {4}\S/.test(line)) inside = false;
      if (!inside) continue;
      const entry = /^\s*-\s*"?(.+?)"?\s*$/.exec(line)?.[1];
      if (!entry) continue;
      const protocol = /\/(tcp|udp)$/.exec(entry)?.[1] ?? "tcp";
      const expanded = entry
        .replace(/\/\w+$/, "")
        .replace(/\$\{[A-Z0-9_]+:?[^}]*\}/g, (match) =>
          match.includes(":?") ? REQUIRED : /:-(.*)\}$/.exec(match)?.[1] ?? match,
        );
      const fields = expanded.split(":");
      if (fields.length === 3 && isPort(fields[1]) && isPort(fields[2])) {
        found.push({ service, address: fields[0], port: fields[1], protocol });
      } else if (fields.length === 2 && isPort(fields[0]) && isPort(fields[1])) {
        found.push({ service, address: "", port: fields[0], protocol });
      }
    }
  }
  return found;
}

/** The `family` job's text, from its name to the next job. */
function familyJob(): string {
  const lines = read(WORKFLOW).split("\n");
  const start = lines.indexOf("  family:");
  assert.notEqual(start, -1, `${WORKFLOW} has no family job`);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[a-z]/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * The products the portal draws a light for, and the path it asks each one.
 *
 * Read from the catalogue rather than listed here: a hand-kept list would be the same
 * kind of stale claim this file exists to catch, one level down. The product objects
 * are cut at their own closing brace so a product that declares no `health` cannot
 * borrow the next one's.
 */
function portalLights(): { key: string; health: string }[] {
  const [, catalogue = ""] = read(PORTAL_RULES).split(/export const PRODUCTS[\s\S]*?= \[/);
  const [products = ""] = catalogue.split(/\n\];/);

  const lights: { key: string; health: string }[] = [];
  for (const chunk of products.split(/key: "/).slice(1)) {
    const key = /^([a-z]+)"/.exec(chunk)?.[1];
    if (!key) continue;
    const [fields = ""] = chunk.split(/\n {2}\},/);
    const health = /health: "([^"]+)"/.exec(fields)?.[1];
    if (health) lights.push({ key, health });
  }
  return lights;
}

/** Every `.ts` file under a directory, or none where the directory is not there. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/**
 * Whether a service answers a path.
 *
 * Derived from the service's own build context rather than kept as a list. A Next app
 * answers a path when it has that route file; the two products that are not Next apps
 * (Sentinel and Genie) each name the one path they answer as `HEALTH_PATH`. That is
 * enough to tell Sync's dashboard, which has `app/health/route.ts`, from the API
 * beside it, which has no such route and answers only under `/api`.
 */
function servesHealthPath(block: string[], health: string): boolean {
  const context = /^ {6}context: (\S+)$/m.exec(block.join("\n"))?.[1] ?? ".";
  const root = path.join(process.cwd(), context);
  const segment = health.replace(/^\/+/, "");
  for (const route of [path.join("src", "app", segment, "route.ts"), path.join("app", segment, "route.ts")]) {
    if (existsSync(path.join(root, route))) return true;
  }
  const named = new RegExp(`HEALTH_PATH\\s*=\\s*"${health}"`);
  return filesUnder(path.join(root, "src")).some((file) => named.test(readFileSync(file, "utf8")));
}

/** The products the job asks the portal container about, in its own probe list. */
function portalProbes(): { name: string; key: string; path: string }[] {
  const lines = familyJob().split("\n");
  const start = lines.findIndex((line) => line.includes("<<'PROBES'"));
  if (start === -1) return [];
  // The terminator is indented like the block it closes, so it is matched trimmed.
  const end = lines.findIndex((line, index) => index > start && line.trim() === "PROBES");
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", key = "", probe = ""] = line.split(/\s+/);
      return { name, key, path: probe };
    });
}

test("family-stack: the stack and the job that boots it were both read", () => {
  // A parser that silently found nothing would pass the checks below by defining them
  // away, so both sides have to be shown to have content first.
  const serving = [...serviceBlocks()].filter(
    ([name, block]) => !name.endsWith("-db") && publishedPorts(block).length > 0,
  );
  assert.ok(
    serving.length >= 6,
    `docker-compose.all.yml yielded ${serving.length} serving services: ${serving.map(([n]) => n).join(", ")}`,
  );
  assert.ok(
    serving.some(([name]) => name === "portal-app"),
    `the walk found these services: ${[...serviceBlocks().keys()].join(", ")}`,
  );

  const job = familyJob();
  assert.ok(job.includes("Family stack"), "the family job was not read");
  assert.ok(job.includes(COMPOSE), "the family job does not boot the family stack");
  assert.ok(portalLights().length >= 5, `the portal catalogue yielded ${portalLights().length} lights`);
});

test("family-stack: the job waits for every product the stack serves", () => {
  const job = familyJob();
  const missed: string[] = [];

  for (const [name, block] of serviceBlocks()) {
    // The databases are the stack's own business: nothing outside dials them, and the
    // products answer for them. A one-shot job (a migrate, a seed) has no address.
    if (name.endsWith("-db")) continue;
    const ports = publishedPorts(block);
    if (!ports.length) continue;
    if (!ports.some((port) => job.includes(`127.0.0.1:${port.host}`))) {
      missed.push(`${name} (published ${ports.map((port) => port.host).join(", ")})`);
    }
  }

  assert.deepEqual(
    missed,
    [],
    "a service the family stack serves that the job never waits for is a product that " +
      `an outage can hide behind: ${missed.join("; ")}`,
  );
});

test("family-stack: every light the portal draws is aimed at a service that answers it", () => {
  const blocks = serviceBlocks();
  const compose = read(COMPOSE);
  const problems: string[] = [];

  for (const { key, health } of portalLights()) {
    if (NOT_IN_FAMILY_STACK.has(key)) continue;

    const name = `ONTRAK_${key.toUpperCase()}_INTERNAL_URL`;
    const assigned = new RegExp(`^\\s+${name}: (\\S+)$`, "m").exec(compose)?.[1];
    if (!assigned) {
      problems.push(`${name} is not set, so the ${key} light can never read up`);
      continue;
    }

    const parsed = /^http:\/\/([^:/]+):(\d+)$/.exec(assigned);
    if (!parsed) {
      problems.push(`${name}=${assigned} is not an http://host:port address`);
      continue;
    }
    const [, service = "", port = ""] = parsed;

    const block = blocks.get(service);
    if (!block) {
      problems.push(`${name}=${assigned} names ${service}, which the family stack does not run`);
      continue;
    }
    // The right-hand side of the mapping: the portal runs *inside* the network, so it
    // dials the service by name and the port the process listens on.
    if (!publishedPorts(block).some((published) => published.container === port)) {
      problems.push(`${name}=${assigned} asks ${service} on ${port}, which it does not listen on`);
      continue;
    }
    if (!servesHealthPath(block, health)) {
      problems.push(`${name}=${assigned} asks ${service} for ${health}, which ${service} does not answer`);
    }
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});

test("family-stack: the job asks the portal about every light it draws", () => {
  const probes = portalProbes();
  assert.ok(probes.length >= 5, `the job's portal probe list yielded ${probes.length} entries`);

  const lights = new Map(portalLights().map((light) => [light.key.toUpperCase(), light] as const));
  const problems: string[] = [];

  for (const probe of probes) {
    const light = lights.get(probe.key);
    if (!light) {
      problems.push(`${probe.name} is probed as ${probe.key}, which the portal draws no light for`);
      continue;
    }
    if (probe.path !== light.health) {
      problems.push(`${probe.name} is probed at ${probe.path}, but the portal asks ${light.health}`);
    }
  }

  const probed = new Set(probes.map((probe) => probe.key));
  for (const key of lights.keys()) {
    if (NOT_IN_FAMILY_STACK.has(key.toLowerCase())) continue;
    if (!probed.has(key)) problems.push(`the portal draws a ${key} light that the job never asks about`);
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});

/**
 * One host port, published twice, must be published on two specific addresses that
 * differ — and a compose file that cannot promise that must publish it once.
 *
 * The rule is dockerd's, and it is not a preference: given two mappings of one host
 * port, the daemon refuses the pair whenever the addresses overlap. The wildcard
 * beside a specific address, or one address twice, both fail with "failed to listen
 * on TCP socket: address already in use" — `docker run -p 127.0.0.1:80:80 -p
 * 0.0.0.0:80:80` is the two-line form of it — and `up -d` then aborts on whichever
 * container lost the race to bind. The family stack's three databases were published
 * on loopback *and* on `${ONTRAK_<PRODUCT>_DB_BIND_HOST}`, which defaults to
 * `0.0.0.0`: a wildcard beside a named address, so the `Family stack` job could not
 * boot the stack at all — while the machine the file was written on names a LAN
 * address and saw nothing wrong.
 *
 * Two claims are checked over every compose file at the root, the family stack and
 * the overlay that replaces its database mappings:
 *
 *  * no service may publish one host port twice on addresses that overlap (the
 *    wildcard, or the same address again);
 *  * a service that does publish one port twice must name two different addresses —
 *    which is why the loopback pair is a file of its own,
 *    `docker-compose.lan-db.yml`, whose addresses are required (`:?`) rather than
 *    defaulted to the wildcard the pair cannot have.
 *
 * What it cannot check is what an operator's variable holds at runtime, so a
 * required address counts as a specific one: refusing the wildcard there is the job
 * of the file that reads it, and that file says so in its header and in the
 * message the `${VAR:?}` prints.
 */
test("family-stack: no compose file publishes one host port on two overlapping addresses", () => {
  const files = readdirSync(process.cwd()).filter((name) => /^docker-compose.*\.ya?ml$/.test(name));
  assert.ok(files.includes(COMPOSE), `the walk did not find ${COMPOSE}: ${files.join(", ")}`);
  assert.ok(
    files.includes("docker-compose.lan-db.yml"),
    `the loopback pair is not a file of its own: ${files.join(", ")}`,
  );

  const problems: string[] = [];
  for (const file of files) {
    const byPort = new Map<string, { service: string; address: string }[]>();
    for (const binding of bindings(file)) {
      const key = `${binding.port}/${binding.protocol}`;
      if (!byPort.has(key)) byPort.set(key, []);
      byPort.get(key)!.push({ service: binding.service, address: binding.address });
    }

    for (const [key, mappings] of byPort) {
      if (mappings.length < 2) continue;
      const where = `${file}: ${[...new Set(mappings.map((mapping) => mapping.service))].join(", ")} publish ${key}`;
      const addresses = mappings.map((mapping) => mapping.address);
      if (addresses.some(isWildcard)) {
        problems.push(`${where} on the wildcard beside another address, and dockerd refuses that pair`);
      }
      const seen = new Set<string>();
      for (const address of addresses) {
        if (seen.has(address)) {
          problems.push(`${where} twice on ${address === "" ? "the wildcard" : address}, which is one address twice`);
        }
        seen.add(address);
      }
    }
  }

  assert.deepEqual(problems, [], problems.join("\n"));
});
