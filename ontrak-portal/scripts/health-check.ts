/**
 * Probe every product's health path, and fail when one does not answer.
 *
 * The dashboard asks the same question on every request, so a product that has
 * stopped answering shows as a grey tile — easy to miss, and easy to leave that
 * way. This asks it where an exit code carries the answer, so a missing endpoint
 * fails a check instead of a tile.
 *
 *   npm run health:check
 *   ONTRAK_BASE_DOMAIN=ontrak.innotel.us npm run health:check
 *   npm run health:check -- --json
 *
 * It asks it *the way the dashboard does*: from the same code (`probeFleet`), so the
 * same statuses count as an answer — 2xx, 3xx to a sign-in, 401, 403 — and the same
 * `ONTRAK_<KEY>_INTERNAL_URL` override is honoured. That second half is the one worth
 * saying out loud. A deployment sets those addresses when the public name is not
 * reachable from where the question is asked — hairpin NAT, or a certificate this host
 * does not trust — which is exactly the situation a check like this one runs in, and a
 * check that ignored them would report the whole family down while the dashboard it
 * describes drew every light green.
 *
 * A product with no health path to ask is a failure, not a pass. The question this
 * answers is "is every product answering", and "we did not look" is not a yes — the
 * same reason the dashboard never draws a green light it did not test.
 *
 * *Which* products, though, is the products **this deployment runs**. OnTrak Lab is the
 * catalogue's one optional product: a peer Python host, not a service in the family stack,
 * and absent unless an operator has both enabled it and said where it is. Probing it
 * anyway would fail a deployment for a product it does not run — the false "DOWN" this
 * command exists to make visible, turned on the command itself — so the lab is skipped,
 * in as many words, until the deployment says where it is.
 *
 * Exit 0 when every product answered, 1 when any did not.
 */

import { PRODUCTS, addressFor, runsHere, type ProductAddresses } from "../src/lib/portal-rules";
import { LAB_ENABLED_ENV, LAB_URL_ENV, labAddress } from "../src/lib/config";
import { probeFleet } from "../src/lib/sync-client";

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const base = process.env.ONTRAK_BASE_DOMAIN ?? "ontrak.innotel.us";
  const secure = process.env.ONTRAK_PORTAL_SECURE !== "false";

  const addresses: ProductAddresses = {};
  const lab = labAddress();
  if (lab) addresses.lab = lab;

  const monitored = PRODUCTS.filter((entry) => runsHere(entry, addresses));
  const skipped = PRODUCTS.filter((entry) => !runsHere(entry, addresses)).map((entry) => entry.key);

  const results = await probeFleet(
    monitored.map((entry) => ({
      key: entry.key,
      url: addressFor(entry, { baseDomain: base, secure, addresses }),
      health: entry.health ?? null,
    })),
    (key) => process.env[`ONTRAK_${key.toUpperCase()}_INTERNAL_URL`],
  );

  if (asJson) {
    console.log(JSON.stringify({ base, skipped, results }, null, 2));
  } else {
    for (const result of results) {
      const label =
        result.reachability === "up" ? "ok  " : result.reachability === "unknown" ? "none" : "DOWN";
      console.log(`${label} ${result.url} — ${result.detail}`);
    }
    if (skipped.length > 0) {
      console.log(
        `skip ${skipped.join(", ")} — not part of this deployment ` +
        `(set ${LAB_ENABLED_ENV} and ${LAB_URL_ENV} to include the lab)`,
      );
    }
  }

  process.exit(results.every((result) => result.reachability === "up") ? 0 : 1);
}

void main();
