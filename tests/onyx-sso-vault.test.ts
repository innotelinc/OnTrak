/**
 * ONYX's sign-in may not carry its own credentials.
 *
 * The proxy in front of the storage console is the one service in the family whose
 * secrets cannot resolve themselves: it is a stock `oauth2-proxy` image, so its
 * entrypoint *is* the proxy and there is nothing inside the container to turn a
 * `vault://` reference into a value. The fix is a split that has to hold in three
 * files at once — references in `onyx-sso/.env.example`, an environment in the compose
 * file that holds no values, and a deploy that reads the vault before it starts the
 * stack — and any one of them drifting puts the client secret back in a file on a host
 * or, worse, ships a proxy that starts fine and gates nothing.
 *
 * So this pins the split rather than the wiring: the compose service must interpolate
 * its three credentials from the environment (a literal value there is the regression),
 * the template must name the same three keys as references under one vault path, and
 * `scripts/deploy.sh` must resolve them before `up`. What it does not check is that the
 * vault holds them — that is a deployment's to answer, and `node scripts/vault-env.mjs`
 * answers it there, failing loudly rather than starting a proxy with empty credentials.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const COMPOSE = "docker-compose.all.yml";
const TEMPLATE = path.join("onyx-sso", ".env.example");
const DEPLOY = path.join("scripts", "deploy.sh");
const VAULT_PATH = "cerulean/ontrak/onyx-sso";

/** The keys the proxy reads its credentials from. */
const KEYS = ["OAUTH2_PROXY_CLIENT_ID", "OAUTH2_PROXY_CLIENT_SECRET", "OAUTH2_PROXY_COOKIE_SECRET"];

function read(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

/** The `onyx-sso` service block as raw lines. */
function onyxBlock(): string[] {
  const lines = read(COMPOSE).split("\n");
  const start = lines.findIndex((line) => line === "  onyx-sso:");
  assert.notEqual(start, -1, `${COMPOSE} has no onyx-sso service`);

  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

test("the compose file interpolates ONYX's credentials and holds none of them", () => {
  const block = onyxBlock();
  const text = block.join("\n");

  assert.doesNotMatch(
    text,
    /^\s+env_file:/m,
    "an env_file would put the proxy's credentials back in a file on the host",
  );

  for (const key of KEYS) {
    const line = new RegExp(`^\\s+${key}:\\s*(.+)$`, "m").exec(text)?.[1];
    assert.ok(line, `${key} is not set on onyx-sso`);
    assert.equal(
      line.trim(),
      `\${${key}:-}`,
      `${key} must be interpolated from the environment the deploy resolves, not written here`,
    );
  }
});

test("the template names the same keys as references under one vault path", () => {
  const entries = new Map(
    read(TEMPLATE)
      .split("\n")
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => {
        const [key = "", value = ""] = line.split("=");
        return [key, value] as const;
      }),
  );

  assert.deepEqual([...entries.keys()].sort(), [...KEYS].sort(), `${TEMPLATE} must list exactly the three keys`);
  for (const [key, value] of entries) {
    assert.equal(
      value,
      `vault://${VAULT_PATH}#${key}`,
      `${key} must reference ${VAULT_PATH}, not carry a value`,
    );
  }
});

test("the deploy resolves the vault before the stack starts", () => {
  const text = read(DEPLOY);
  const resolve = text.indexOf("scripts/vault-env.mjs");
  // The invocation, not the sentence in the header comment that explains why `up` is
  // not the end of a deploy — that one appears before any of this code.
  const up = text.indexOf('"${compose[@]}" up -d --build');

  assert.notEqual(resolve, -1, "scripts/deploy.sh never calls the vault resolver");
  assert.ok(up !== -1 && resolve < up, "the resolution must happen before the stack is started");
  for (const key of KEYS) {
    assert.ok(text.includes(key), `scripts/deploy.sh does not resolve ${key}`);
  }
});
