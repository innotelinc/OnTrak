/**
 * Put the lab's scenarios into this deployment.
 *
 *   npm run lab:import                       # the 14 scenarios shipped in scenarios/
 *   npm run lab:import -- --from <dir>       # a lab checkout, converted to JSON
 *   npm run lab:import -- --author someone@example.com
 *   npm run lab:import -- --dry-run          # plan and report, write nothing
 *
 * OnTrak Lab authors scenarios as `scenario.yaml` directories and its own runner grades
 * them against a live machine; this app's catalogue, assignments and reports live in
 * Postgres. Step 5 of the consolidation audit mapped one to the other
 * (`src/lib/lab-scenario-import.ts`) and recorded the gap that followed: nothing wrote the
 * mapping to a database, so no scenario was tagged `lab` in any deployment, the student
 * page's lab door was drawn nowhere, and the completion boundary had no task to file a
 * result against. This is that missing half.
 *
 * The records are the lab's real `scenario.yaml` files converted once to JSON, and they
 * are the whole catalogue rather than a sample (`scenarios/<id>/scenario.json`). A lab
 * checkout can be used directly once its YAML is converted, because this repository has no
 * YAML reader and adding one to a deploy path for a single use would be a dependency for
 * nothing; `--from` takes the converted directory.
 *
 * Writes are idempotent per slug, so running it on every release is safe: it refreshes the
 * fields the lab owns and leaves the author alone.
 *
 * Saying it plainly: this does not deploy a lab and does not grade anything. It is what
 * makes a lab-tagged scenario exist, which is the precondition for both.
 */

import { PrismaClient } from "@prisma/client";

import { scenarioEntriesFrom, scenarioRoot } from "../src/lib/lab/dataset";
import { labScenarioUpdate, labScenarioWrite, planLabImport, type LabImportSource } from "../src/lib/lab-import";
import { labConfigFromEnv, labSessionUrl } from "../src/lib/lab-rules";

const prisma = new PrismaClient();

const DEFAULT_FROM = scenarioRoot();

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

/**
 * The records to import, from the tree a host reads.
 *
 * `scenarioEntriesFrom` rather than a directory listing, so the script and a deployment
 * agree about the layout: this used to read a flat directory of `.json` files, which was
 * the test-fixture shape and not the shape `scenarios/` has.
 */
function readSources(directory: string): LabImportSource[] {
  return scenarioEntriesFrom(directory).map((entry) => ({ name: entry.fileName, raw: entry.record }));
}

async function main(): Promise<void> {
  const from = flag("from") ?? DEFAULT_FROM;
  const dryRun = process.argv.includes("--dry-run");
  const wanted = flag("author");

  const { rows, refused } = planLabImport(readSources(from));

  // Every refusal, before anything is written: a deployment holding part of the lab's
  // catalogue is a state nobody can reason about, and an operator fixing one problem per
  // run is the same problem reported slowly.
  if (refused.length > 0) {
    console.error(`lab:import refused ${refused.length} of ${refused.length + rows.length} scenarios:`);
    for (const entry of refused) {
      console.error(`  ${entry.name}`);
      for (const issue of entry.issues) console.error(`    - ${issue}`);
    }
    console.error("Nothing was written. Fix the lab scenarios and run this again.");
    process.exitCode = 1;
    return;
  }

  const author = wanted
    ? await prisma.user.findUnique({ where: { email: wanted.trim().toLowerCase() } })
    : await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  if (!author) {
    throw new Error(
      wanted
        ? `No account here has the email ${wanted}. Scenarios need an author: run \`npm run db:seed\`, or pass --author.`
        : "This deployment has no ADMIN account to attribute the imported scenarios to. Run `npm run db:seed`, or pass --author.",
    );
  }

  const lab = labSessionUrl(labConfigFromEnv());
  let created = 0;
  let updated = 0;

  for (const scenario of rows) {
    const existing = await prisma.scenario.findUnique({ where: { slug: scenario.slug }, select: { id: true } });
    if (dryRun) {
      console.log(`  would ${existing ? "update" : "create"} ${scenario.slug}`);
      existing ? (updated += 1) : (created += 1);
      continue;
    }

    if (existing) {
      await prisma.scenario.update({ where: { slug: scenario.slug }, data: labScenarioUpdate(scenario) });
      updated += 1;
    } else {
      await prisma.scenario.create({ data: labScenarioWrite(scenario, author.id) });
      created += 1;
    }
  }

  console.log(
    `${dryRun ? "Would import" : "Imported"} ${rows.length} lab scenarios: ${created} created, ${updated} refreshed` +
      `${dryRun ? " (dry run — nothing written)" : ""}. Author: ${author.email}.`,
  );
  // Where the door leads, so an operator reading the output knows whether students can
  // reach what they just wrote. Both facts come from the one reader that decides them.
  console.log(
    lab
      ? `The lab door is open: students run these at ${lab}.`
      : "No lab is configured for this deployment, so the catalogue shows these as graded elsewhere and offers no door.",
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
