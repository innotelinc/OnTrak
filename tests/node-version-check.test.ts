/**
 * The deploy's Node check may not quietly stop covering a product.
 *
 * `scripts/check-node-versions.sh` asks every family app container what Node it runs and
 * compares it with the `engines.node` of the package the service is built from. That is
 * the only place the two statements of one fact are compared, and it is a list written by
 * hand — the one shape that goes stale the way the service map did (`service-map.test.ts`)
 * and the guide's port table did (`family-ops.test.ts`). A new product adds a service and
 * a `package.json`; nobody remembers the shell script, the deploy keeps passing, and the
 * product is the one nobody checked.
 *
 * So the list is derived here rather than trusted: a service that is built from this
 * repository, starts a Node image and is meant to keep running (it has a healthcheck) must
 * appear in the script. The reverse is checked too, because an entry naming a service that
 * no longer exists is a check that passes by checking nothing. And the majors must agree
 * across the family: one Node is the point of the move, and a package left declaring an
 * older one would make the script demand a runtime the others do not use.
 *
 * What it does not check is what the containers are doing now — that needs Docker and a
 * running stack, which is the deploy's job and not a unit test's. This settles the claims
 * the files can settle on their own.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const CHECK = path.join("scripts", "check-node-versions.sh");
const DEPLOY = path.join("scripts", "deploy.sh");
const COMPOSE = "docker-compose.all.yml";

function read(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

/** The service/package pairs the script compares, as written in its `services` heredoc. */
function checked(): Map<string, string> {
  const [, table = ""] = read(CHECK).split(/<<'EOF'\n/);
  const [body = ""] = table.split(/^EOF$/m);
  const pairs = new Map<string, string>();
  for (const line of body.split("\n")) {
    const pair = /^([a-z0-9][a-z0-9-]*)\s+(\S+)\s*$/.exec(line);
    if (pair) pairs.set(pair[1], pair[2]);
  }
  assert.notEqual(pairs.size, 0, `${CHECK} lists no services`);
  return pairs;
}

/** The `services:` block, one entry per service, as the raw lines under it. */
function serviceBlocks(): Map<string, string[]> {
  const lines = read(COMPOSE).split("\n");
  const start = lines.indexOf("services:");
  assert.notEqual(start, -1, `${COMPOSE} has no top-level services: line`);

  const blocks = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
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

/** The build context a service is built from, or null when it is not built here. */
function context(block: string[]): string | null {
  const text = block.join("\n");
  const declared = /^ {6}context:\s*(\S+)\s*$/m.exec(text)?.[1];
  if (declared) return declared;
  return /^ {4}build:\s*$/m.test(text) ? "." : null;
}

/** Whether a Dockerfile builds *on* a Node image — the question, not a guess at the tag. */
function nodeBased(dir: string): boolean {
  const file = path.join(process.cwd(), dir, "Dockerfile");
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  return /^\s*(FROM|ARG\s+BASE_IMAGE=)\s*\S*node:/m.test(text);
}

test("the Node check covers every long-running service built on a Node image", () => {
  const checkedServices = checked();
  const expected = [...serviceBlocks()]
    .filter(([, block]) => /^ {4}healthcheck:/m.test(block.join("\n")))
    .filter(([, block]) => {
      const dir = context(block);
      return dir !== null && nodeBased(dir);
    })
    .map(([name]) => name)
    .sort();

  assert.notEqual(expected.length, 0, "no long-running Node services found to check");
  assert.deepEqual(
    [...checkedServices.keys()].sort(),
    expected,
    `${CHECK} does not list exactly the long-running Node services in ${COMPOSE}`,
  );
});

test("every checked package declares the same Node major", () => {
  const majors = new Map<string, string>();
  for (const [service, dir] of checked()) {
    const file = path.join(process.cwd(), dir, "package.json");
    assert.ok(existsSync(file), `${service} is checked against ${dir}, which has no package.json`);
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { engines?: { node?: string } };
    const range = pkg.engines?.node;
    assert.ok(range, `${dir}/package.json declares no engines.node for ${service} to check`);
    const major = /(\d+)/.exec(range)?.[1];
    assert.ok(major, `${dir}/package.json has no major in engines.node "${range}"`);
    majors.set(dir, major);
  }

  const distinct = [...new Set(majors.values())];
  assert.equal(
    distinct.length,
    1,
    `the family declares more than one Node major: ${[...majors].map(([d, m]) => `${d}=${m}`).join(", ")}`,
  );
});

test("the deploy runs the Node check before it reports success", () => {
  const text = read(DEPLOY);
  assert.match(
    text,
    /scripts\/check-node-versions\.sh/,
    "scripts/deploy.sh does not run scripts/check-node-versions.sh",
  );
  // After `up` and before the capture: a stack on the wrong Node is a deploy failure, not
  // something to discover from a failed capture turn.
  const up = text.indexOf("up -d --build");
  const check = text.indexOf("check-node-versions.sh");
  const smoke = text.indexOf("deploy: running a capture");
  assert.ok(up !== -1 && check > up, "the Node check must run after the stack is up");
  assert.ok(smoke === -1 || check < smoke, "the Node check must run before the capture");
});
