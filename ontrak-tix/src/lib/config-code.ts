/**
 * Config as code, the database half (2.4).
 *
 * `config-bundle.ts` decides what a bundle means and what applying it would
 * change; this file loads a tenant's configuration into that shape and writes a
 * bundle back. Keeping the split means the interesting rules — natural keys,
 * canonical bytes, every refusal, the diff — are tested without a database, and
 * what is left here is mechanical: it converts rows, upserts by natural key, and
 * records the import on the tenant's audit chain.
 *
 * Two decisions worth stating:
 *
 *  - **Upsert, never delete.** The bundle says what the desk should have. What
 *    the target has and the bundle does not name is left alone, because deleting
 *    a queue with open tickets or a field holding answers is a decision with its
 *    own consequences, not a side effect of a file.
 *  - **A tenant-slug mismatch is refused, not ignored.** Promoting staging into
 *    production is the point of this feature, so the mismatch is expected — but
 *    it is expected *deliberately*. Without a flag, a bundle aimed at the wrong
 *    environment stops before a single write, with both slugs in the sentence.
 */

import { randomUUID } from "node:crypto";

import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  buildBundle,
  diffBundle,
  readBundle,
  type BundleDiff,
  type ConfigBundle,
  type ConfigState,
  type CustomFieldConfig,
  type MacroConfig,
  type QueueConfig,
  type SlaPolicyConfig,
} from "./config-bundle";
import type { FieldType } from "./form-rules";
import type { RuleAction } from "./rule-rules";
import { asBusinessCalendar } from "./sla-store-prisma";

/* -------------------------------------------------------------------------- */
/*  The rows, described structurally                                         */
/* -------------------------------------------------------------------------- */

export interface ConfigQueueRow {
  id: string;
  slug: string;
  name: string;
}

export interface ConfigSlaRow {
  name: string;
  priority: string | null;
  responseMinutes: number;
  resolutionMinutes: number;
  warningFraction: number;
  /** `BusinessCalendar` as JSON; re-read through `asBusinessCalendar`. */
  calendar: unknown;
  /** A client-scoped promise is not configuration — see `loadConfigState`. */
  clientId?: string | null;
  queue: { slug: string } | null;
}

export interface ConfigFieldRow {
  key: string;
  label: string;
  type: string;
  options: string[];
  requiredByDefault: boolean;
  placeholder: string;
  helpText: string;
  archived: boolean;
}

export interface ConfigMacroRow {
  name: string;
  description: string;
  actions: unknown;
  enabled: boolean;
}

/**
 * The Prisma surface this feature needs, described structurally so the service
 * never depends on a generated type (the same convention as every other store).
 * `$transaction` is optional: Prisma has it, a test's fake does not need to.
 */
export interface ConfigCodeDb {
  tenant: {
    findUnique(args: unknown): Promise<{ id: string; slug: string } | null>;
  };
  queue: {
    findMany(args: unknown): Promise<ConfigQueueRow[]>;
    upsert(args: unknown): Promise<unknown>;
  };
  slaPolicy: {
    findMany(args: unknown): Promise<ConfigSlaRow[]>;
    upsert(args: unknown): Promise<unknown>;
  };
  customField: {
    findMany(args: unknown): Promise<ConfigFieldRow[]>;
    upsert(args: unknown): Promise<unknown>;
  };
  macro: {
    findMany(args: unknown): Promise<ConfigMacroRow[]>;
    upsert(args: unknown): Promise<unknown>;
  };
  $transaction?<T>(work: (tx: ConfigCodeDb) => Promise<T>): Promise<T>;
}

export interface ConfigCodeIds {
  id(): string;
  now(): string;
}

const defaultIds: ConfigCodeIds = {
  id: () => randomUUID(),
  now: () => new Date().toISOString(),
};

/* -------------------------------------------------------------------------- */
/*  Loading                                                                  */
/* -------------------------------------------------------------------------- */

export type ConfigLoad =
  | {
      ok: true;
      tenantId: string;
      bundle: ConfigBundle;
      /** Tenant-wide notes the command prints: what was left behind, and why. */
      omitted: string[];
      /**
       * Names of policies scoped to a client. They are not in the bundle, but an
       * import must know they exist: `(tenantId, name)` is unique, so a bundle's
       * same-named policy would otherwise quietly turn a client's promise into
       * the desk's own.
       */
      clientScoped: string[];
    }
  | { ok: false; error: string };

function asFields(rows: readonly ConfigFieldRow[]): CustomFieldConfig[] {
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    type: String(row.type).toUpperCase() as FieldType,
    options: [...row.options],
    requiredByDefault: row.requiredByDefault,
    placeholder: row.placeholder,
    helpText: row.helpText,
    archived: row.archived,
  }));
}

function asMacros(rows: readonly ConfigMacroRow[]): MacroConfig[] {
  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    actions: Array.isArray(row.actions) ? (row.actions as RuleAction[]) : [],
    enabled: row.enabled,
  }));
}

/**
 * A tenant's promotable configuration, as a bundle.
 *
 * A policy scoped to a *client* is not exported, and `omitted` says how many
 * were left behind: a client is business data (a contract, a set of people), not
 * configuration, and importing one into an environment that has never heard of
 * that client would either fail or attach a promise to the wrong row. The count
 * is returned rather than swallowed so the command can say it out loud.
 */
export async function loadConfigState(db: ConfigCodeDb, tenantSlug: string): Promise<ConfigLoad> {
  const tenant = await db.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) return { ok: false, error: `No tenant has the slug “${tenantSlug}”.` };

  const queueRows = await db.queue.findMany({
    where: { tenantId: tenant.id },
    orderBy: { slug: "asc" },
    select: { id: true, slug: true, name: true },
  });
  const policyRows = await db.slaPolicy.findMany({
    where: { tenantId: tenant.id },
    orderBy: { name: "asc" },
    include: { queue: { select: { slug: true } } },
  });
  const fieldRows = await db.customField.findMany({
    where: { tenantId: tenant.id },
    orderBy: { key: "asc" },
    select: {
      key: true,
      label: true,
      type: true,
      options: true,
      requiredByDefault: true,
      placeholder: true,
      helpText: true,
      archived: true,
    },
  });
  const macroRows = await db.macro.findMany({
    where: { tenantId: tenant.id },
    orderBy: { name: "asc" },
    select: { name: true, description: true, actions: true, enabled: true },
  });

  const clientScoped = policyRows.filter((row) => row.clientId).length;
  const omitted =
    clientScoped === 0
      ? []
      : [
          `${clientScoped} SLA ${clientScoped === 1 ? "policy is" : "policies are"} scoped to a client and ${
            clientScoped === 1 ? "is" : "are"
          } not carried: clients are business data, not configuration.`,
        ];

  const queues: QueueConfig[] = queueRows.map((row) => ({ slug: row.slug, name: row.name }));
  const slaPolicies: SlaPolicyConfig[] = policyRows
    .filter((row) => !row.clientId)
    .map((row) => ({
      name: row.name,
      queue: row.queue?.slug ?? null,
      priority: row.priority,
      responseMinutes: row.responseMinutes,
      resolutionMinutes: row.resolutionMinutes,
      warningFraction: row.warningFraction,
      calendar: asBusinessCalendar(row.calendar),
    }));

  const bundle = buildBundle({
    tenant: tenant.slug,
    queues,
    slaPolicies,
    customFields: asFields(fieldRows),
    macros: asMacros(macroRows),
  });

  // A file this build would refuse on import is not a promotion, it is a lossy
  // copy: the canonical form keeps only the fields this feature decided to carry,
  // so a row the desk's own validators reject (a macro action stored with the
  // wrong field name) would leave the export looking complete while meaning less
  // than the database. Refusing here names the rows instead of writing that file.
  const readable = readBundle(bundle);
  if (!readable.ok) {
    const issues = readable.issues.map((issue) => `${issue.field}: ${issue.message}`).join(" · ");
    return {
      ok: false,
      error: `This desk's configuration would not be accepted back, so nothing was exported: ${issues}`,
    };
  }

  return {
    ok: true,
    tenantId: tenant.id,
    bundle,
    omitted,
    clientScoped: policyRows.filter((row) => row.clientId).map((row) => row.name),
  };
}

/* -------------------------------------------------------------------------- */
/*  Applying                                                                 */
/* -------------------------------------------------------------------------- */

export interface ConfigImportOptions {
  targetSlug: string;
  bundle: ConfigBundle;
  /** Who is running the import; recorded on the chain and on new rows. */
  actor: string;
  dryRun?: boolean;
  /** Set only when promoting between environments, where the slugs differ by design. */
  allowTenantSlug?: boolean;
  ids?: ConfigCodeIds;
}

export type ConfigImport = { ok: true; applied: boolean; diff: BundleDiff } | { ok: false; error: string };

async function inTransaction<T>(db: ConfigCodeDb, work: (tx: ConfigCodeDb) => Promise<T>): Promise<T> {
  return db.$transaction ? db.$transaction(work) : work(db);
}

/**
 * Apply a bundle to a tenant, or (with `dryRun`) say what it would do.
 *
 * The writes are grouped so a reader can see the dependency order: queues first
 * (a policy points at one), then the policies, then the fields and macros, which
 * point at nothing. Each is an upsert on its natural key — the same key the diff
 * compared — so re-running an import is a no-op and an interrupted one is safe to
 * repeat.
 */
export async function applyConfigBundle(
  db: ConfigCodeDb,
  audit: AuditSink | null,
  options: ConfigImportOptions,
): Promise<ConfigImport> {
  const loaded = await loadConfigState(db, options.targetSlug);
  if (!loaded.ok) return loaded;

  const source = options.bundle.tenant;
  if (source !== options.targetSlug && !options.allowTenantSlug) {
    return {
      ok: false,
      error:
        `This bundle is from “${source}” and would be applied to “${options.targetSlug}”. ` +
        "A promotion between environments is deliberate: pass --allow-tenant-slug to say so.",
    };
  }

  // A name is unique per tenant, and a client-scoped policy is not in the
  // bundle. Importing a tenant-wide policy with the same name would therefore
  // attach a client's promise to the whole desk, which is a change nobody wrote
  // in the file: refuse it and say which policy.
  const collision = options.bundle.slaPolicies
    .map((policy) => policy.name)
    .filter((name) => loaded.clientScoped.some((existing) => existing.toLowerCase() === name.toLowerCase()));
  if (collision.length > 0) {
    return {
      ok: false,
      error:
        `“${collision.join("”, “")}” ${collision.length === 1 ? "is" : "are"} scoped to a client in this environment. ` +
        "A bundle's same-named policy would make it the desk's own promise, so the import stops here: " +
        "rename one of them, or promote the client-scoped policy deliberately.",
    };
  }

  const current: ConfigState = {
    tenant: options.targetSlug,
    queues: loaded.bundle.queues,
    slaPolicies: loaded.bundle.slaPolicies,
    customFields: loaded.bundle.customFields,
    macros: loaded.bundle.macros,
  };
  const diff = diffBundle(current, options.bundle);
  if (options.dryRun) return { ok: true, applied: false, diff };

  const ids = options.ids ?? defaultIds;
  const bundle = buildBundle(options.bundle);

  await inTransaction(db, async (tx) => {
    for (const queue of bundle.queues) {
      await tx.queue.upsert({
        where: { tenantId_slug: { tenantId: loaded.tenantId, slug: queue.slug } },
        create: { tenantId: loaded.tenantId, slug: queue.slug, name: queue.name },
        update: { name: queue.name },
      });
    }

    // Resolved after the upserts so a queue created by this import is a valid
    // target for the policy that names it.
    const queueRows = await tx.queue.findMany({
      where: { tenantId: loaded.tenantId },
      select: { id: true, slug: true },
    });
    const queueIds = new Map(queueRows.map((row) => [row.slug, row.id]));

    for (const policy of bundle.slaPolicies) {
      if (policy.queue !== null && !queueIds.has(policy.queue)) {
        throw new Error(`Queue “${policy.queue}” was not written, so “${policy.name}” has nothing to attach to.`);
      }
      const queueId = policy.queue === null ? null : (queueIds.get(policy.queue) ?? null);
      const data = {
        priority: policy.priority,
        responseMinutes: policy.responseMinutes,
        resolutionMinutes: policy.resolutionMinutes,
        warningFraction: policy.warningFraction,
        calendar: policy.calendar as unknown as object,
        queueId,
        clientId: null,
      };
      await tx.slaPolicy.upsert({
        where: { tenantId_name: { tenantId: loaded.tenantId, name: policy.name } },
        create: { tenantId: loaded.tenantId, name: policy.name, ...data },
        update: data,
      });
    }

    for (const field of bundle.customFields) {
      const data = {
        label: field.label,
        type: field.type,
        options: [...field.options],
        requiredByDefault: field.requiredByDefault,
        placeholder: field.placeholder,
        helpText: field.helpText,
        archived: field.archived,
      };
      await tx.customField.upsert({
        where: { tenantId_key: { tenantId: loaded.tenantId, key: field.key } },
        create: { tenantId: loaded.tenantId, key: field.key, createdBy: options.actor, ...data },
        // `key` is the where clause and `createdBy` is history: neither is
        // editable through a promotion, and the field service refuses a key
        // change for the same reason.
        update: data,
      });
    }

    for (const macro of bundle.macros) {
      const data = {
        description: macro.description,
        actions: macro.actions as unknown as object,
        enabled: macro.enabled,
      };
      await tx.macro.upsert({
        where: { tenantId_name: { tenantId: loaded.tenantId, name: macro.name } },
        create: { tenantId: loaded.tenantId, name: macro.name, createdBy: options.actor, ...data },
        update: data,
      });
    }
  });

  // Nothing to say when nothing changed, but a promotion that did change the
  // desk belongs on the same chain as the tickets it shapes.
  if (audit && diff.changes > 0) {
    const event: AuditEventInput = {
      id: ids.id(),
      tenantId: loaded.tenantId,
      at: ids.now(),
      actor: options.actor,
      action: "config.import",
      targetType: "Tenant",
      targetId: loaded.tenantId,
      detail: {
        source,
        target: options.targetSlug,
        created: {
          queues: diff.queues.create.length,
          slaPolicies: diff.slaPolicies.create.length,
          customFields: diff.customFields.create.length,
          macros: diff.macros.create.length,
        },
        updated: {
          queues: diff.queues.update.length,
          slaPolicies: diff.slaPolicies.update.length,
          customFields: diff.customFields.update.length,
          macros: diff.macros.update.length,
        },
      },
    };
    await audit.append(event);
  }

  return { ok: true, applied: true, diff };
}
