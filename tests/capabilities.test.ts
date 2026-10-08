/**
 * The capabilities panel's facts, as the control room reads them.
 *
 * The panel is a single list of what this deployment can reach, so the tests here are
 * about the three ways a list like that goes wrong: it forgets a product, it invents a
 * link that does not resolve, or it reports a URL it was never given as if somebody had
 * named it. The reader mirrors the portal's catalogue (`ontrak-portal/src/lib/portal-rules.ts`)
 * and delegates Sentinel to `sentinel-status.ts`, so what these tests pin down is the
 * *resolution*, not the naming.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { capabilities, type Capability, type CapabilityId } from "../src/lib/capabilities";
import { SENTINEL_CONTROL_CENTER_PATH } from "../src/lib/sentinel-status";

const ORDER: readonly CapabilityId[] = ["training", "tix", "sentinel", "sync", "genie", "lab"];

function byId(env: Record<string, string | undefined>): Map<CapabilityId, Capability> {
  return new Map(capabilities(env).map((entry) => [entry.id, entry]));
}

test("capabilities: an empty environment lists every product, in order", () => {
  const list = capabilities({});
  assert.deepEqual(
    list.map((entry) => entry.id),
    ORDER,
    "a product that is missing from the list is a product nobody can reach from here",
  );
});

test("capabilities: with nothing configured, each is reached by the family's own names", () => {
  const found = byId({});

  for (const id of ORDER) {
    const entry = found.get(id)!;
    assert.equal(entry.named, false, `${id} was never named in this environment`);
    assert.equal(entry.note, null);
    assert.ok(entry.url, `${id} still resolves by the family's naming`);
  }

  assert.equal(found.get("training")!.url, "https://its.ontrak.innotel.us");
  assert.equal(found.get("tix")!.url, "https://tix.ontrak.innotel.us");
  assert.equal(found.get("sync")!.url, "https://sync.ontrak.innotel.us");
  assert.equal(found.get("genie")!.url, "https://genie.ontrak.innotel.us");
  assert.equal(found.get("lab")!.url, "https://lab.ontrak.innotel.us");
  // Sentinel is reached at its control center, not at the bare host.
  assert.equal(found.get("sentinel")!.url, `https://sentinel.ontrak.innotel.us${SENTINEL_CONTROL_CENTER_PATH}`);
});

test("capabilities: a base domain and scheme follow the deployment", () => {
  const found = byId({ ONTRAK_PORTAL_BASE_DOMAIN: "lab.example.test", ONTRAK_PORTAL_SECURE: "false" });
  // A family served over plain HTTP must link to plain HTTP.
  assert.equal(found.get("tix")!.url, "http://tix.lab.example.test");
  assert.equal(found.get("lab")!.url, "http://lab.lab.example.test");
  // A trailing dot is the same name as without it.
  const dotted = byId({ ONTRAK_PORTAL_BASE_DOMAIN: "lab.example.test." });
  assert.equal(dotted.get("tix")!.url, "https://tix.lab.example.test");
});

test("capabilities: an explicit URL wins, is marked named, and loses its trailing slash", () => {
  const found = byId({
    ONTRAK_TIX_BASE_URL: "https://desk.internal.test/",
    ONTRAK_LAB_URL: "http://10.0.0.5:8080",
  });
  assert.equal(found.get("tix")!.url, "https://desk.internal.test");
  assert.equal(found.get("tix")!.named, true);
  assert.equal(found.get("lab")!.url, "http://10.0.0.5:8080");
  assert.equal(found.get("lab")!.named, true);
  // The ones not named are still on the family's names.
  assert.equal(found.get("genie")!.named, false);
});

test("capabilities: a quoted value is unquoted, the way .env's three readers half-agree", () => {
  const found = byId({ ONTRAK_TIX_BASE_URL: '"https://tix.example.test/"' });
  assert.equal(found.get("tix")!.url, "https://tix.example.test");
  assert.equal(found.get("tix")!.named, true);

  const single = byId({ ONTRAK_SYNC_URL: "'https://sync.example.test'" });
  assert.equal(single.get("sync")!.url, "https://sync.example.test");
});

test("capabilities: sentinel is delegated to its own reader", () => {
  // An explicit console URL is what the Sentinel reader calls ready.
  const explicit = byId({ SENTINEL_CONSOLE_URL: "https://sentinel.example.test" });
  assert.equal(explicit.get("sentinel")!.url, `https://sentinel.example.test${SENTINEL_CONTROL_CENTER_PATH}`);
  assert.equal(explicit.get("sentinel")!.named, true);
  assert.equal(explicit.get("sentinel")!.note, null);

  // The issuer is the fallback the Sentinel reader already knows about.
  const issuer = byId({ SENTINEL_ISSUER: "http://127.0.0.1:8787" });
  assert.equal(issuer.get("sentinel")!.url, `http://127.0.0.1:8787${SENTINEL_CONTROL_CENTER_PATH}`);
  assert.equal(issuer.get("sentinel")!.named, true);

  // A URL that cannot be opened is reported as no link, with the reason — never as a
  // family link that would be a dead end.
  const refused = byId({ SENTINEL_CONSOLE_URL: "sentinel.example.test" });
  assert.equal(refused.get("sentinel")!.url, null);
  assert.equal(refused.get("sentinel")!.named, false);
  assert.ok(refused.get("sentinel")!.note);
  assert.match(refused.get("sentinel")!.note!, /not an absolute URL/);
});
