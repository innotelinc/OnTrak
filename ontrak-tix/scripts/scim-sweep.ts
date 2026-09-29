/**
 * Outbound provisioning sweep (M2), from a terminal or a scheduler that is not HTTP.
 *
 * The same run as `POST /api/scim/push`, without a secret to configure: it uses
 * the deployment's own database and its own `ONTRAK_TIX_SCIM_*` configuration
 * directly, which is what a cron on the box, a Kubernetes job or an operator
 * checking that the sync still works actually wants.
 *
 *   npm run sweep:scim              # every tenant
 *   npm run sweep:scim -- acme      # one tenant, by slug
 *   npm run sweep:scim -- --dry-run # report what would change, change nothing
 *
 * Exit codes separate "nothing needed doing" from "the sweep did not run": `0` for
 * a completed sweep (whatever it found), `1` for one that could not be carried
 * out, `2` for usage. A run that pushed nowhere because nothing is configured is
 * the second kind — a scheduler has to be able to tell them apart.
 */

import { prisma, scimSyncServicesFor } from "../src/lib/db";
import { planScimPush, deskPerson, scimTargetFromEnv } from "../src/lib/scim-rules";
import { HttpScimClient } from "../src/lib/scim-client";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("--dryRun");
const slug = args.find((arg) => !arg.startsWith("-"));

async function main(): Promise<number> {
  const { target, issues } = scimTargetFromEnv();
  if (!target) {
    console.error(issues[0] ?? "No outbound identity provider is configured.");
    return 1;
  }

  const tenants = await prisma.tenant.findMany({
    where: slug ? { slug } : undefined,
    select: { id: true, slug: true },
    orderBy: { slug: "asc" },
  });
  if (slug && tenants.length === 0) {
    console.error(`Unknown tenant "${slug}".`);
    return 2;
  }

  const client = new HttpScimClient(target);
  const service = scimSyncServicesFor();
  let failed = 0;

  for (const tenant of tenants) {
    if (dryRun) {
      // Compared against the provider without writing to it: the same plan the
      // sync would apply, reported instead of applied.
      const people = await prisma.user.findMany({
        where: { tenantId: tenant.id },
        orderBy: { email: "asc" },
      });
      let wouldChange = 0;
      for (const person of people) {
        const desk = deskPerson(person);
        const existing =
          (await client.findByExternalId(desk.id)) ?? (await client.findByUserName(desk.email));
        const plan = planScimPush(desk, existing);
        if (plan.action === "NOOP") continue;
        wouldChange += 1;
        console.log(`${tenant.slug}: would ${plan.action.toLowerCase()} ${desk.email} — ${plan.reason}`);
      }
      console.log(`${tenant.slug}: ${people.length} people, ${wouldChange} would change (dry run)`);
      continue;
    }

    const result = await service.pushTenant(tenant.id);
    if (!result.ok) {
      console.error(`${tenant.slug}: ${result.error}`);
      failed += 1;
      continue;
    }

    const outcome = result.value;
    console.log(
      `${tenant.slug}: considered ${outcome.total} · created ${outcome.created} · updated ${outcome.updated} · off ${outcome.deactivated} · unchanged ${outcome.unchanged}`,
    );
    for (const push of outcome.pushed) {
      console.log(`  ${push.action.toLowerCase()} ${push.email} — ${push.reason}`);
    }
    // The refusals are the interesting half: they are where the desk and the
    // provider disagree, and somebody will have to decide which one is right.
    for (const failure of outcome.failures) {
      console.error(`  refused ${failure.email} — ${failure.reason}`);
    }
    if (outcome.failures.length > 0) failed += 1;
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
