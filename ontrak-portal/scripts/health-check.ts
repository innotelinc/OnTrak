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
 * The "healthy" rule is the dashboard's, on purpose: any answer at all — 2xx,
 * 3xx to a sign-in, 401, 403 — means the product is serving. The question is "is
 * it there", not "am I allowed in".
 *
 * Exit 0 when every product answered, 1 when any did not.
 */

import { PRODUCTS } from "../src/lib/portal-rules";

interface Probe {
  key: string;
  url: string;
  status: number;
  healthy: boolean;
  detail?: string;
}

async function probe(key: string, url: string): Promise<Probe> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const healthy =
      response.ok ||
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400);
    return { key, url, status: response.status, healthy };
  } catch (error) {
    return {
      key,
      url,
      status: 0,
      healthy: false,
      detail: error instanceof Error ? error.message : "no response",
    };
  }
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const base = process.env.ONTRAK_BASE_DOMAIN ?? "ontrak.innotel.us";
  const scheme = process.env.ONTRAK_PORTAL_SECURE === "false" ? "http" : "https";

  const results = await Promise.all(
    PRODUCTS.map((product) => probe(product.key, `${scheme}://${product.host}.${base}${product.health}`)),
  );

  if (asJson) {
    console.log(JSON.stringify({ base, results }, null, 2));
  } else {
    for (const result of results) {
      const label = result.healthy ? "ok  " : "DOWN";
      const detail = result.status > 0 ? String(result.status) : result.detail ?? "no response";
      console.log(`${label} ${result.url} — ${detail}`);
    }
  }

  process.exit(results.every((result) => result.healthy) ? 0 : 1);
}

void main();
