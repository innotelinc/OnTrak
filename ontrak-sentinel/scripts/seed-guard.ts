/**
 * Seed Guard with the sample telemetry corpus.
 *
 * Posts every batch in `src/lib/detection-samples.ts` to a running deployment's ingest surface
 * (`POST /guard/v1/events`), so a fresh Control center fills with one alert per shipped rule and
 * an operator can see what detection looks like before wiring a real sensor.
 *
 *   SENTINEL_BASE_URL=https://sentinel.ontrak.innotel.us \
 *   SENTINEL_GUARD_TOKEN=… \
 *   SENTINEL_GUARD_ORGANIZATION=demo \
 *   npx tsx scripts/seed-guard.ts
 *
 * It is idempotent in the way detection already is: a batch re-posted in the same minute
 * updates its alert rather than raising a second one, so running it twice is not a mess.
 *
 * The script exits non-zero if a request failed, or if a batch did not raise a rule it exists
 * to raise — which makes it usable as a smoke test after a deploy, not just a convenience.
 */

import { sampleBatches } from "../src/lib/detection-samples";

interface IngestReport {
  accepted?: number;
  alerts?: { ruleId: string; severity?: string; created?: boolean }[];
  error?: string;
  error_description?: string;
}

async function main(): Promise<number> {
  const baseUrl = (process.env.SENTINEL_BASE_URL ?? process.env.SENTINEL_ISSUER ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const token = (process.env.SENTINEL_GUARD_TOKEN ?? "").trim();
  const organization = (process.env.SENTINEL_GUARD_ORGANIZATION ?? "").trim();

  if (!token) {
    console.error(
      "[seed] SENTINEL_GUARD_TOKEN is unset, so this deployment does not accept telemetry. " +
        "Set it (the ingest surface is mounted only when a token exists) and run again.",
    );
    return 1;
  }
  if (!organization) {
    console.warn(
      "[seed] SENTINEL_GUARD_ORGANIZATION is unset; the tenant is looked up from the deployment's " +
        "own configuration. A multi-tenant deployment will refuse the batch without it.",
    );
  }

  const url = `${baseUrl}/guard/v1/events`;
  let failed = false;

  console.log(`[seed] posting to ${url}${organization ? ` as ${organization}` : ""}`);
  console.log("");

  for (const batch of sampleBatches()) {
    let report: IngestReport;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...(organization ? { "x-sentinel-organization": organization } : {}),
        },
        body: JSON.stringify({ source: batch.source, sensor: batch.sensor, events: batch.events }),
      });
      report = (await response.json().catch(() => ({}))) as IngestReport;
      if (!response.ok) {
        failed = true;
        console.error(`✖ ${batch.name}: HTTP ${response.status} — ${report.error_description ?? report.error ?? response.statusText}`);
        continue;
      }
    } catch (error) {
      failed = true;
      console.error(`✖ ${batch.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const fired = new Set((report.alerts ?? []).map((alert) => alert.ruleId));
    const missing = batch.expect.filter((ruleId) => !fired.has(ruleId));
    if (missing.length > 0) failed = true;

    const raised = batch.expect.map((ruleId) => `${fired.has(ruleId) ? "✓" : "✗"} ${ruleId}`).join("  ");
    console.log(`${missing.length === 0 ? "✓" : "✖"} ${batch.name} — accepted ${report.accepted ?? 0}, raised ${raised}`);
  }

  console.log("");
  if (failed) {
    console.error(
      "[seed] one or more batches did not raise the rule they exist for. Check that the deployed " +
        "build ships the expected rulebook (GET /guard/v1/rules) and that the organization is configured.",
    );
    return 1;
  }
  console.log("[seed] every sample batch raised the rule it names. Open /console/control-center to see them.");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[seed] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
