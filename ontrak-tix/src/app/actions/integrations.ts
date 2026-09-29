"use server";

/**
 * Integrations console actions (M6): the app-facing entry points for
 * `/admin/integrations`.
 *
 * As everywhere else in the desk, these marshal form data, translate a
 * `ServiceResult` into a redirect, and decide nothing. The permission
 * (`tenant:manage`), the validation and the audit events belong to
 * `ApiTokenService` and `WebhookService` — a second copy of a rule here is how two
 * copies drift apart.
 *
 * One thing this file *does* own, because it is a presentation problem: **the two
 * secrets that are readable exactly once.** A minted token and a webhook signing
 * secret are returned by their services at creation and never again, so there has
 * to be somewhere for them to be until the person who asked has copied them. That
 * somewhere is a short-lived, `httpOnly`, path-scoped cookie rather than a query
 * parameter: a secret in a URL ends up in browser history, in the Referer header
 * and in every access log between here and the browser. The console renders it
 * once and offers a button that clears the cookie, and if nobody does, it expires
 * in fifteen minutes.
 */

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { hasPermission, type Actor } from "../../lib/access-rules";
import { apiTokenServicesFor, chatNotifyServicesFor, webhookServicesFor } from "../../lib/db";
import {
  REVEAL_PATH,
  REVEAL_TTL_SECONDS,
  revealCookie,
  type RevealKind,
} from "../../lib/integration-console-rules";
import { requireActor, sessionCookieSecure } from "../../lib/session";

const HOME = REVEAL_PATH;

function fail(message: string): never {
  redirect(`${HOME}?error=${encodeURIComponent(message)}`);
}

function done(message: string): never {
  revalidatePath(HOME);
  redirect(`${HOME}?flash=${encodeURIComponent(message)}`);
}

/** Tenant-wide configuration is an administrator's, checked here as well as in the service. */
async function requireIntegrationsAdmin(): Promise<Actor> {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "tenant:manage")) redirect("/inbox");
  return actor;
}

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

/** Leave the one-time secret somewhere the console can show it, and nowhere else. */
async function reveal(kind: RevealKind, id: string, secret: string): Promise<void> {
  const store = await cookies();
  store.set(revealCookie(kind), JSON.stringify({ id, secret }), {
    httpOnly: true,
    sameSite: "lax",
    // A one-time secret is the worst thing to hand a browser that will not store it:
    // the operator mints a token, the cookie is dropped, and the console reports a
    // secret it can no longer show. Same rule as the session, asked in one place.
    secure: await sessionCookieSecure(),
    path: REVEAL_PATH,
    maxAge: REVEAL_TTL_SECONDS,
  });
}

/** Forget a secret the moment the person who asked for it says they have it. */
export async function dismissRevealAction(formData: FormData): Promise<void> {  await requireIntegrationsAdmin();
  const store = await cookies();
  const which: RevealKind = text(formData, "which") === "webhook" ? "webhook" : "token";
  store.delete(revealCookie(which));
  done("Hidden. The value was never stored anywhere else, so it cannot be shown again.");
}

/* --------------------------------------------------------------- tokens */

export async function createApiTokenAction(formData: FormData): Promise<void> {
  const actor = await requireIntegrationsAdmin();
  const expires = text(formData, "expiresInDays");
  const rate = text(formData, "rateLimitPerMinute");

  const created = await apiTokenServicesFor().create(actor, {
    name: text(formData, "name"),
    scopes: formData.getAll("scopes").map((value) => String(value)),
    expiresInDays: expires === "" ? null : Number(expires),
    rateLimitPerMinute: rate === "" ? undefined : Number(rate),
  });
  if (!created.ok) fail(created.error);

  await reveal("token", created.value.token.id, created.value.secret);
  revalidatePath(HOME);
  redirect(`${HOME}?minted=${encodeURIComponent(created.value.token.id)}`);
}

export async function revokeApiTokenAction(formData: FormData): Promise<void> {
  const actor = await requireIntegrationsAdmin();
  const tokenId = text(formData, "tokenId");
  if (!tokenId) fail("Choose a token first.");

  const result = await apiTokenServicesFor().revoke(actor, tokenId);
  if (!result.ok) fail(result.error);
  done(`Token “${result.value.name}” revoked`);
}

/* ------------------------------------------------------------- webhooks */

export async function registerWebhookAction(formData: FormData): Promise<void> {
  const actor = await requireIntegrationsAdmin();

  const created = await webhookServicesFor().register(actor, {
    name: text(formData, "name"),
    url: text(formData, "url"),
    events: formData.getAll("events").map((value) => String(value)),
  });
  if (!created.ok) fail(created.error);

  await reveal("webhook", created.value.endpoint.id, created.value.secret);
  revalidatePath(HOME);
  redirect(`${HOME}?registered=${encodeURIComponent(created.value.endpoint.id)}`);
}

export async function rotateWebhookSecretAction(formData: FormData): Promise<void> {
  const actor = await requireIntegrationsAdmin();
  const endpointId = text(formData, "endpointId");
  if (!endpointId) fail("Choose an endpoint first.");

  const rotated = await webhookServicesFor().rotateSecret(actor, endpointId);
  if (!rotated.ok) fail(rotated.error);

  await reveal("webhook", rotated.value.endpoint.id, rotated.value.secret);
  revalidatePath(HOME);
  redirect(`${HOME}?registered=${encodeURIComponent(rotated.value.endpoint.id)}`);
}

export async function setWebhookEnabledAction(formData: FormData): Promise<void> {
  const actor = await requireIntegrationsAdmin();
  const endpointId = text(formData, "endpointId");
  const enabled = text(formData, "enabled") === "true";
  if (!endpointId) fail("Choose an endpoint first.");

  const result = await webhookServicesFor().setEnabled(actor, endpointId, enabled);
  if (!result.ok) fail(result.error);
  done(`${result.value.name} ${enabled ? "switched on" : "switched off"}`);
}

export async function removeWebhookAction(formData: FormData): Promise<void> {
  const actor = await requireIntegrationsAdmin();
  const endpointId = text(formData, "endpointId");
  if (!endpointId) fail("Choose an endpoint first.");

  const result = await webhookServicesFor().remove(actor, endpointId);
  if (!result.ok) fail(result.error);
  done("Endpoint removed. Its delivery history is kept");
}

/**
 * Attempt everything the delivery log says is owed an attempt.
 *
 * The same call a scheduler makes; on this screen it exists so an administrator can
 * watch a retry happen instead of waiting half a day to find out whether the
 * backoff arithmetic was right.
 */
export async function sweepWebhooksAction(): Promise<void> {
  const actor = await requireIntegrationsAdmin();
  const swept = await webhookServicesFor().deliverDue(actor.tenantId, 50);
  done(
    `Swept ${swept.considered}: ${swept.delivered} delivered, ${swept.retrying} retrying, ${swept.exhausted} exhausted`,
  );
}

/* ------------------------------------------------------ chat notifications */

export async function registerChatChannelAction(formData: FormData): Promise<void> {
  const actor = await requireIntegrationsAdmin();

  const created = await chatNotifyServicesFor().register(actor, {
    provider: text(formData, "provider"),
    name: text(formData, "name"),
    url: text(formData, "url"),
    events: formData.getAll("events").map((value) => String(value)),
  });
  if (!created.ok) fail(created.error);
  done(`${created.value.name} registered. Send it a test message to prove the URL works.`);
}

export async function setChatChannelEnabledAction(formData: FormData): Promise<void> {
  const actor = await requireIntegrationsAdmin();
  const channelId = text(formData, "channelId");
  const enabled = text(formData, "enabled") === "true";
  if (!channelId) fail("Choose a channel first.");

  const result = await chatNotifyServicesFor().setEnabled(actor, channelId, enabled);
  if (!result.ok) fail(result.error);
  done(`${result.value.name} ${enabled ? "switched on" : "switched off"}`);
}

export async function removeChatChannelAction(formData: FormData): Promise<void> {
  const actor = await requireIntegrationsAdmin();
  const channelId = text(formData, "channelId");
  if (!channelId) fail("Choose a channel first.");

  const result = await chatNotifyServicesFor().remove(actor, channelId);
  if (!result.ok) fail(result.error);
  done("Channel removed. Its delivery history is kept");
}

/**
 * Post one message now, and report the provider's answer.
 *
 * The single most useful control on this screen: a chat webhook URL that was pasted
 * slightly wrong fails *silently* — nobody notices a message that never arrived — so
 * the way to find out is to make one arrive while somebody is watching.
 */
export async function testChatChannelAction(formData: FormData): Promise<void> {
  const actor = await requireIntegrationsAdmin();
  const channelId = text(formData, "channelId");
  if (!channelId) fail("Choose a channel first.");

  const result = await chatNotifyServicesFor().sendTest(actor, channelId);
  if (!result.ok) fail(result.error);

  const { statusCode, error } = result.value.outcome;
  if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
    done(`The provider accepted the test message (HTTP ${statusCode}). Look in the room.`);
  } else {
    fail(
      statusCode === null
        ? `Nothing answered: ${error ?? "the request failed"}. Check the URL and this deployment's egress.`
        : `The provider refused it: HTTP ${statusCode}.`,
    );
  }
}

export async function sweepChatNotifyAction(): Promise<void> {
  const actor = await requireIntegrationsAdmin();
  const swept = await chatNotifyServicesFor().deliverDue(actor.tenantId, 50);
  done(
    `Swept ${swept.considered}: ${swept.delivered} delivered, ${swept.retrying} retrying, ${swept.exhausted} exhausted`,
  );
}
