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
 * Exit 0 when every product answered, 1 when any did not.
 */

import { PRODUCTS, urlFor } from "../src/lib/portal-rules";
import { probeFleet } from "../src/lib/sync-client";

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const base = process.env.ONTRAK_BASE_DOMAIN ?? "ontrak.innotel.us";
  const secure = process.env.ONTRAK_PORTAL_SECURE !== "false";

  const results = await probeFleet(
    PRODUCTS.map((product) => ({
      key: product.key,
      url: urlFor(product, base, secure),
      health: product.health ?? null,
    })),
    (key) => process.env[`ONTRAK_${key.toUpperCase()}_INTERNAL_URL`],
  );

  if (asJson) {
    console.log(JSON.stringify({ base, results }, null, 2));
  } else {
    for (const result of results) {
      const label =
        result.reachability === "up" ? "ok  " : result.reachability === "unknown" ? "none" : "DOWN";
      console.log(`${label} ${result.url} — ${result.detail}`);
    }
  }

  process.exit(results.every((result) => result.reachability === "up") ? 0 : 1);
}

void main();
