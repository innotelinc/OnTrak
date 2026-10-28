/**
 * Config as code (2.4), from a terminal: export a desk's configuration, diff a
 * bundle against another environment, and promote it.
 *
 *   npx tsx scripts/config-code.ts export --tenant acme --out acme.json
 *   npx tsx scripts/config-code.ts import --file acme.json --tenant acme --dry-run
 *   npx tsx scripts/config-code.ts import --file staging.json --tenant acme \
 *     --allow-tenant-slug
 *
 * The dry run is the same code path as the apply, stopped before the first
 * write, so what it prints is what the import would do — not a second opinion.
 * The audit entry is written only when something changed.
 *
 * Exit codes separate "the command ran" from "the command refused": `0` for a
 * completed export/import (whatever it found), `1` for a bundle this build
 * refused or a write that failed, `2` for usage.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { readBundle, serializeBundle, type BundleDiff } from "../src/lib/config-bundle";
import { applyConfigBundle, loadConfigState, type ConfigCodeDb } from "../src/lib/config-code";
import { prisma, ticketServicesFor } from "../src/lib/db";

const args = process.argv.slice(2);
const command = args[0]?.toLowerCase();
const has = (flag: string) => args.includes(flag);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const USAGE = `Usage:
  config-code export --tenant <slug> [--out <file>]
  config-code import --file <path> --tenant <slug> [--dry-run] [--allow-tenant-slug]

  export   Write the tenant's queues, SLA policies, custom fields and macros as
           one canonical JSON file (stdout unless --out is given).
  import   Apply a bundle by natural key. Upserts only: nothing is deleted.
           --dry-run prints the diff and writes nothing.
           --allow-tenant-slug permits a promotion whose source and target
           tenant slugs differ (staging → production).`;

function describeCounts(bundle: { queues: unknown[]; slaPolicies: unknown[]; customFields: unknown[]; macros: unknown[] }): string {
  return [
    `${bundle.queues.length} queue${bundle.queues.length === 1 ? "" : "s"}`,
    `${bundle.slaPolicies.length} SLA polic${bundle.slaPolicies.length === 1 ? "y" : "ies"}`,
    `${bundle.customFields.length} custom field${bundle.customFields.length === 1 ? "" : "s"}`,
    `${bundle.macros.length} macro${bundle.macros.length === 1 ? "" : "s"}`,
  ].join(" · ");
}

function printDiff(diff: BundleDiff): void {
  console.log(`${diff.from} → ${diff.to}: ${diff.summary}`);
  const sections: Array<[string, BundleDiff["queues"]]> = [
    ["queue", diff.queues],
    ["SLA policy", diff.slaPolicies],
    ["custom field", diff.customFields],
    ["macro", diff.macros],
  ];
  for (const [label, section] of sections) {
    for (const entry of section.create) console.log(`  + ${label} ${entry.key}`);
    for (const entry of section.update) {
      console.log(`  ~ ${label} ${entry.key} (${entry.fields.join(", ")})`);
    }
  }
}

async function runExport(): Promise<number> {
  const tenant = option("--tenant");
  if (!tenant) {
    console.error("export needs --tenant <slug>.");
    console.error(USAGE);
    return 2;
  }

  const loaded = await loadConfigState(prisma as unknown as ConfigCodeDb, tenant);
  if (!loaded.ok) {
    console.error(loaded.error);
    return 1;
  }
  for (const note of loaded.omitted) console.error(note);

  const bytes = serializeBundle(loaded.bundle);
  const out = option("--out");
  if (out) {
    writeFileSync(out, bytes, "utf8");
    console.log(`${loaded.bundle.tenant}: ${describeCounts(loaded.bundle)} → ${out}`);
  } else {
    process.stdout.write(bytes);
  }
  return 0;
}

async function runImport(): Promise<number> {
  const file = option("--file");
  const tenant = option("--tenant");
  if (!file || !tenant) {
    console.error("import needs --file <path> and --tenant <slug>.");
    console.error(USAGE);
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const read = readBundle(raw);
  if (!read.ok) {
    console.error(`${file} is not a bundle this build can apply:`);
    for (const issue of read.issues) console.error(`  ${issue.field}: ${issue.message}`);
    return 1;
  }

  const result = await applyConfigBundle(prisma as unknown as ConfigCodeDb, ticketServicesFor().audit, {
    targetSlug: tenant,
    bundle: read.bundle,
    actor: process.env.ONTRAK_TIX_ACTOR ?? "config-code",
    dryRun: has("--dry-run"),
    allowTenantSlug: has("--allow-tenant-slug"),
  });
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }

  printDiff(result.diff);
  if (!result.applied) {
    console.log("Dry run — nothing was written.");
  } else if (result.diff.changes === 0) {
    console.log("Already current — nothing to write.");
  } else {
    console.log(`Applied ${result.diff.changes} change${result.diff.changes === 1 ? "" : "s"}.`);
  }
  return 0;
}

async function main(): Promise<number> {
  if (command === "export") return runExport();
  if (command === "import") return runImport();
  console.error(USAGE);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
