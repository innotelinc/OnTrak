"use server";

/**
 * Connector marketplace actions (M6): the app-facing entry points for
 * `/admin/connectors`.
 *
 * As everywhere else in the desk, these marshal form data, translate a
 * `ServiceResult` into a redirect, and decide nothing. The permission
 * (`tenant:manage`), the validation and the audit events belong to
 * `ConnectorService` — a second copy of a rule here is how two copies drift apart.
 *
 * One thing this file does own: **the config field names.** A connector's fields
 * come from its manifest, so the form posts them as `field_<key>` and this file
 * reads them back against the *manifest*, not against the form — a key the catalog
 * does not declare is never read, and the service refuses it if it somehow arrives.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actorHasPermission, type Actor } from "../../lib/access-rules";
import { connectorRegistry, connectorServicesFor } from "../../lib/db";
import { requireActor } from "../../lib/session";

const HOME = "/admin/connectors";

function fail(message: string): never {
  revalidatePath(HOME);
  redirect(`${HOME}?error=${encodeURIComponent(message)}`);
}

function done(message: string): never {
  revalidatePath(HOME);
  redirect(`${HOME}?flash=${encodeURIComponent(message)}`);
}

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

/** Installing a connector is tenant-wide configuration, so it is an administrator's. */
async function requireConnectorAdmin(): Promise<Actor> {
  const actor = await requireActor();
  if (!actorHasPermission(actor, "tenant:manage")) redirect("/inbox");
  return actor;
}

/** The submitted config, read against the manifest's own field list. */
function configFrom(formData: FormData, keys: readonly string[]): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of keys) config[key] = formData.get(`field_${key}`) ?? "";
  return config;
}

export async function installConnectorAction(formData: FormData): Promise<void> {
  const actor = await requireConnectorAdmin();
  const connectorId = text(formData, "connectorId");
  const manifest = connectorRegistry.get(connectorId);
  if (!manifest) fail("That connector is not in the catalog.");

  const config = configFrom(formData, manifest.configFields.map((field) => field.key));
  const result = await connectorServicesFor().install(actor, { connectorId, config });
  if (!result.ok) fail(result.error);
  done(`${manifest.name} installed.`);
}

export async function configureConnectorAction(formData: FormData): Promise<void> {
  const actor = await requireConnectorAdmin();
  const installationId = text(formData, "installationId");
  const installation = await connectorServicesFor().installation(actor.tenantId, installationId);
  if (!installation) fail("No such connector installation.");

  const manifest = connectorRegistry.get(installation.connectorId);
  if (!manifest) fail("That connector is no longer in the catalog.");

  const config = configFrom(formData, manifest.configFields.map((field) => field.key));
  const result = await connectorServicesFor().configure(actor, installationId, config);
  if (!result.ok) fail(result.error);
  done(`${manifest.name} updated.`);
}

export async function setConnectorEnabledAction(formData: FormData): Promise<void> {
  const actor = await requireConnectorAdmin();
  const installationId = text(formData, "installationId");
  const enabled = text(formData, "enabled") === "true";

  const result = enabled
    ? await connectorServicesFor().enable(actor, installationId)
    : await connectorServicesFor().disable(actor, installationId);
  if (!result.ok) fail(result.error);
  done(`${result.value.connectorId} ${enabled ? "switched on" : "switched off"}.`);
}

export async function removeConnectorAction(formData: FormData): Promise<void> {
  const actor = await requireConnectorAdmin();
  const installationId = text(formData, "installationId");

  const result = await connectorServicesFor().remove(actor, installationId);
  if (!result.ok) fail(result.error);
  done("Connector removed. The audit trail keeps the history.");
}
