/**
 * Retention sweep (M3), from a terminal or a scheduler that is not HTTP.
 *
 * The same run as `POST /api/incidents/retention-sweep`, without a secret to
 * configure: it uses the deployment's own database and storage directly, which is
 * what a cron on the box, a Kubernetes job or a person checking an operator's
 * work actually wants.
 *
 *   npm run sweep:retention                 # every tenant
 *   npm run sweep:retention -- acme         # one tenant, by slug
 *   npm run sweep:retention -- --dry-run    # report what would go, change nothing
 *
 * Exit codes separate \"nothing needed doing\" from \"the sweep did not run\":
 * `0` for a completed sweep (whatever it found), `1` for a sweep that could not
 * be carried out, `2` for usage.
 */

import { prisma, incidentDocsServicesFor } from "../src/lib/db";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("--dryRun");
const slug = args.find((arg) => !arg.startsWith("-"));

async function main(): Promise<number> {
  const tenants = await prisma.tenant.findMany({
    where: slug ? { slug } : undefined,
    select: { id: true, slug: true },
    orderBy: { slug: "asc" },
  });
  if (slug && tenants.length === 0) {
    console.error(`Unknown tenant "${slug}".`);
    return 2;
  }

  const docs = incidentDocsServicesFor();
  let failed = 0;

  for (const tenant of tenants) {
    const result = await docs.sweepRetention(tenant.id, { dryRun });
    if (!result.ok) {
      console.error(`${tenant.slug}: ${result.error}`);
      failed += 1;
      continue;
    }

    const report = result.value;
    console.log(
      `${tenant.slug}: considered ${report.considered} · purge ${report.purged} · retained ${report.retained} · held ${report.held} · ${report.bytesFreed} bytes${dryRun ? " (dry run)" : ""}`,
    );
    for (const purge of report.purges) {
      console.log(`  ${dryRun ? "would purge" : "purged"} ${purge.incidentRef} ${purge.key} (${purge.bytes} bytes) — ${purge.reason}`);
    }
    // The refusals are the interesting half: \"still held\" is why an artifact is
    // still here, and somebody will ask.
    for (const entry of report.skipped) {
      console.log(`  kept ${entry.key} — ${entry.reason}`);
    }
  }

  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
