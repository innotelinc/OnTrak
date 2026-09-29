import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { requireActor } from "../../../../lib/session";
import { hasPermission } from "../../../../lib/access-rules";
import { apiTokenServicesFor, chatNotifyServicesFor, rmmServicesFor, webhookServicesFor } from "../../../../lib/db";
import { allApiScopes, API_PREFIX, API_VERSION } from "../../../../lib/public-api-rules";
import {
  CHAT_EVENTS,
  CHAT_MAX_ATTEMPTS,
  CHAT_PROVIDERS,
  chatProviderLabel,
} from "../../../../lib/chat-notify-rules";
import {
  DELIVERY_MAX_ATTEMPTS,
  allWebhookEvents,
  type DeliveryStatus,
} from "../../../../lib/webhook-rules";
import { RMM_SECRET_ENV } from "../../../../lib/rmm-rules";
import { REVEAL_COOKIE, REVEAL_WEBHOOK_COOKIE, revealedSecret } from "../../../../lib/integration-console-rules";
import {
  createApiTokenAction,
  dismissRevealAction,
  registerChatChannelAction,
  registerWebhookAction,
  removeChatChannelAction,
  removeWebhookAction,
  revokeApiTokenAction,
  rotateWebhookSecretAction,
  setChatChannelEnabledAction,
  setWebhookEnabledAction,
  sweepChatNotifyAction,
  sweepWebhooksAction,
  testChatChannelAction,
} from "../../../actions/integrations";

export const metadata = { title: "Integrations" };

/**
 * The integrations console (M6): what may reach the desk, and what the desk told.
 *
 * The M6 surfaces were built API-first — a token is minted by a `POST`, a webhook
 * is registered by a `POST`, a delivery log is read by a `GET` — and an integrator
 * with `curl` needs nothing more. Everybody else needs this page, and it is built
 * around the three questions a desk actually asks:
 *
 *  1. **"What is talking to us, and as whom?"** — every token with its prefix, its
 *     scopes, its rate limit and its last use. The prefix is what makes a leaked
 *     token findable rather than merely long, and it is the only part of the secret
 *     that can be shown, because the secret is a hash in the database and nothing
 *     can read it back.
 *  2. **"Where do we send things, and did it arrive?"** — every endpoint with its
 *     delivery log: `DELIVERED`, `RETRYING` with the instant of the next attempt,
 *     or `EXHAUSTED` after five tries. The sweep is a button here as well as a
 *     scheduled call, so an administrator can watch a retry instead of waiting half
 *     a day to find out whether the backoff was right.
 *  3. **"What is the desk working on by itself?"** — the monitored conditions the
 *     RMM connector has open, each with the ticket it became, so a machine-raised
 *     outage is as visible as one a person raised.
 *  4. **"Who in the business hears about this?"** — the Slack and Teams rooms, which
 *     are a different audience from an integration: a webhook is reconciled by a
 *     system and a chat message is read by whoever is on call. Each channel has its
 *     delivery log and a button that posts one message now, because a chat webhook
 *     URL pasted slightly wrong fails *silently*, and the only way to find out is to
 *     watch a message arrive.
 *
 * Gated on `tenant:manage`: this is tenant-wide configuration, and minting a
 * credential that can read every ticket in the tenant is the same weight as
 * deciding who administers it.
 */
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string; minted?: string; registered?: string }>;
}) {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "tenant:manage")) redirect("/inbox");

  const { flash, error, minted, registered } = await searchParams;

  const [tokens, endpoints, deliveries, conditions, chatChannels, chatDeliveries] = await Promise.all([
    apiTokenServicesFor().list(actor),
    webhookServicesFor().list(actor),
    webhookServicesFor().listDeliveries(actor, { limit: 40 }),
    rmmServicesFor().links(actor.tenantId),
    chatNotifyServicesFor().list(actor),
    chatNotifyServicesFor().listDeliveries(actor, { limit: 20 }),
  ]);

  const tokenList = tokens.ok ? tokens.value : [];
  const endpointList = endpoints.ok ? endpoints.value : [];
  const deliveryList = deliveries.ok ? deliveries.value : [];
  const openConditions = conditions.filter((link) => link.state === "OPEN");
  const channelList = chatChannels.ok ? chatChannels.value : [];
  const chatDeliveryList = chatDeliveries.ok ? chatDeliveries.value : [];
  // The first refusal if the service said no — a signed-in agent who reached this
  // page by URL gets the sentence, not an empty screen that looks like an outage.
  const readError =
    (!tokens.ok && tokens.error) ||
    (!endpoints.ok && endpoints.error) ||
    (!deliveries.ok && deliveries.error) ||
    (!chatChannels.ok && chatChannels.error) ||
    (!chatDeliveries.ok && chatDeliveries.error) ||
    null;

  // The cookie read is this file's; what the value means is the pure module's.
  const jar = await cookies();
  const revealedToken = revealedSecret(jar.get(REVEAL_COOKIE)?.value, minted);
  const revealedWebhook = revealedSecret(jar.get(REVEAL_WEBHOOK_COOKIE)?.value, registered);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Integrations</h1>
        <p className="text-sm text-ink-soft">
          The versioned REST API is at <code className="text-ink">{API_PREFIX}</code> ({API_VERSION}), authenticated with a
          bearer token. Tokens are stored as a hash, so a secret is readable exactly once, when it is created; what is kept
          is the prefix below, which is enough to recognise one and not enough to use one.
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}
      {readError ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {readError}
        </p>
      ) : null}
      {flash ? <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p> : null}

      {revealedToken ? (
        <SecretPanel
          title="Copy this token now"
          which="token"
          secret={revealedToken}
          note="This is the only time it can be read: what the database holds is a hash, not the token."
        />
      ) : null}
      {revealedWebhook ? (
        <SecretPanel
          title="Copy this signing secret now"
          which="webhook"
          secret={revealedWebhook}
          note={`A delivery is signed HMAC-SHA256 over "{timestamp}.{body}". The secret is shown once and can be rotated.`}
        />
      ) : null}

      {/* ----------------------------------------------------------- tokens */}
      <section aria-labelledby="api-tokens" className="space-y-3">
        <div>
          <h2 id="api-tokens" className="font-display text-base font-semibold text-ink">
            API tokens
          </h2>
          <p className="text-xs text-ink-faint">
            A token carries scopes and the least role that could serve them, so an integration can never do something an
            agent could not. A token cannot mint another token.
          </p>
        </div>

        {tokenList.length === 0 ? (
          <p className="rounded-xl2 border border-line bg-surface p-4 text-sm text-ink-soft">
            No tokens yet. Until one is minted, nothing outside a browser session can reach the API.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
            {tokenList.map((token) => {
              const active = token.revokedAt === null && (token.expiresAt === null || Date.parse(token.expiresAt) > Date.now());
              return (
                <li key={token.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink">{token.name}</span>
                    <code className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-ink-soft">{token.tokenPrefix}…</code>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        active ? "bg-teal/10 text-teal" : "bg-surface-muted text-ink-faint"
                      }`}
                    >
                      {token.revokedAt !== null ? "revoked" : active ? "active" : "expired"}
                    </span>
                    <form action={revokeApiTokenAction} className="ml-auto">
                      <input type="hidden" name="tokenId" value={token.id} />
                      <button type="submit" className="text-xs font-semibold text-pink hover:underline">
                        Revoke
                      </button>
                    </form>
                  </div>
                  <p className="mt-1 text-xs text-ink-soft">
                    {token.scopes.join(", ")} · {token.rateLimitPerMinute} req/min · created {stamp(token.createdAt)} ·{" "}
                    {token.expiresAt === null ? "no expiry" : `expires ${stamp(token.expiresAt)}`} ·{" "}
                    {token.lastUsedAt === null ? "never used" : `last used ${stamp(token.lastUsedAt)}`}
                  </p>
                  {token.revokedAt !== null ? (
                    <p className="mt-1 text-xs text-ink-faint">Revoked {stamp(token.revokedAt)}. The row stays, so “who had that?” has an answer.</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <form action={createApiTokenAction} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
          <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">Mint a token</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Name</span>
              <input name="name" required className={inputClass} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Expires in days</span>
              <input name="expiresInDays" inputMode="numeric" placeholder="never" className={inputClass} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Requests a minute</span>
              <input name="rateLimitPerMinute" inputMode="numeric" placeholder="60" className={inputClass} />
            </label>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold text-ink">Scopes</legend>
            {allApiScopes().map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm text-ink-soft">
                <input type="checkbox" name="scopes" value={scope} className="size-4 rounded border-line" />
                <code className="text-xs text-ink">{scope}</code>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-ink-faint">
            The secret is shown once. An expiry is optional; a token with none is a choice somebody made on purpose.
          </p>
          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-xs font-semibold text-brand-ink">
            Mint token
          </button>
        </form>
      </section>

      {/* --------------------------------------------------------- webhooks */}
      <section aria-labelledby="webhook-endpoints" className="space-y-3">
        <div>
          <h2 id="webhook-endpoints" className="font-display text-base font-semibold text-ink">
            Webhook endpoints
          </h2>
          <p className="text-xs text-ink-faint">
            A destination is checked when it is registered — https, or http only on a loopback address — and every delivery
            is signed with a timestamp, so a captured one can be refused rather than replayed.
          </p>
        </div>

        {endpointList.length === 0 ? (
          <p className="rounded-xl2 border border-line bg-surface p-4 text-sm text-ink-soft">
            No endpoints yet. Nothing is being told about a ticket until one is registered.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
            {endpointList.map((endpoint) => (
              <li key={endpoint.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{endpoint.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      endpoint.enabled ? "bg-teal/10 text-teal" : "bg-surface-muted text-ink-faint"
                    }`}
                  >
                    {endpoint.enabled ? "on" : "off"}
                  </span>
                  <span className="ml-auto flex flex-wrap items-center gap-3 text-xs font-semibold">
                    <form action={rotateWebhookSecretAction}>
                      <input type="hidden" name="endpointId" value={endpoint.id} />
                      <button type="submit" className="text-ink-soft hover:text-brand">
                        Rotate secret
                      </button>
                    </form>
                    <form action={setWebhookEnabledAction}>
                      <input type="hidden" name="endpointId" value={endpoint.id} />
                      <input type="hidden" name="enabled" value={endpoint.enabled ? "false" : "true"} />
                      <button type="submit" className="text-ink-soft hover:text-brand">
                        {endpoint.enabled ? "Switch off" : "Switch on"}
                      </button>
                    </form>
                    <form action={removeWebhookAction}>
                      <input type="hidden" name="endpointId" value={endpoint.id} />
                      <button type="submit" className="text-pink hover:underline">
                        Remove
                      </button>
                    </form>
                  </span>
                </div>
                <p className="mt-1 break-all text-xs text-ink-soft">{endpoint.url}</p>
                <p className="mt-1 text-xs text-ink-faint">
                  {endpoint.events.join(", ")} · registered {stamp(endpoint.createdAt)}
                  {endpoint.disabledAt === null ? "" : ` · switched off ${stamp(endpoint.disabledAt)}`}
                </p>
              </li>
            ))}
          </ul>
        )}

        <form action={registerWebhookAction} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
          <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">Register an endpoint</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Name</span>
              <input name="name" required className={inputClass} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">URL</span>
              <input name="url" required placeholder="https://example.test/hooks/tickets" className={inputClass} />
            </label>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold text-ink">Events</legend>
            {allWebhookEvents().map((event) => (
              <label key={event} className="flex items-center gap-2 text-sm text-ink-soft">
                <input type="checkbox" name="events" value={event} className="size-4 rounded border-line" />
                <code className="text-xs text-ink">{event}</code>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-ink-faint">
            The signing secret is shown once, and a delivered event is never retried by hand — the log below is the record.
          </p>
          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-xs font-semibold text-brand-ink">
            Register endpoint
          </button>
        </form>
      </section>

      {/* -------------------------------------------------------- deliveries */}
      <section aria-labelledby="deliveries" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="deliveries" className="font-display text-base font-semibold text-ink">
              Delivery log
            </h2>
            <p className="text-xs text-ink-faint">
              The row is written before the attempt, so a delivery that was due while the process was dying is still
              visible. Retries back off and stop after {DELIVERY_MAX_ATTEMPTS} attempts.
            </p>
          </div>
          <form action={sweepWebhooksAction}>
            <button type="submit" className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink-soft hover:border-brand/40 hover:text-brand">
              Deliver what is due now
            </button>
          </form>
        </div>

        {deliveryList.length === 0 ? (
          <p className="rounded-xl2 border border-line bg-surface p-4 text-sm text-ink-soft">
            Nothing has been delivered yet. The log fills the first time an event matches an endpoint.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
            {deliveryList.map(({ delivery, endpointName }) => (
              <li key={delivery.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs font-semibold text-ink">{delivery.event}</code>
                  <span className="text-xs text-ink-soft">→ {endpointName ?? "a removed endpoint"}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_CLASS[delivery.status]}`}>
                    {delivery.status.toLowerCase()}
                  </span>
                  <span className="ml-auto text-xs text-ink-faint">{stamp(new Date(delivery.createdAt).toISOString())}</span>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  attempt {delivery.attemptCount} of {DELIVERY_MAX_ATTEMPTS}
                  {delivery.lastStatusCode === null ? " · nothing answered" : ` · HTTP ${delivery.lastStatusCode}`}
                  {delivery.nextAttemptAt === null ? "" : ` · next try ${stamp(new Date(delivery.nextAttemptAt).toISOString())}`}
                  {delivery.lastError ? ` · ${delivery.lastError}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
        {deliveryList.length > 0 ? (
          <p className="text-xs text-ink-faint">
            The exact bytes that were signed are kept on each delivery, so “what did you send us?” is answered from the
            record rather than reconstructed.
          </p>
        ) : null}
      </section>

      {/* ---------------------------------------------------- chat notifications */}
      <section aria-labelledby="chat-channels" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="chat-channels" className="font-display text-base font-semibold text-ink">
              Chat notifications
            </h2>
            <p className="text-xs text-ink-faint">
              Slack and Teams, because that is where on-call already is. The URL is checked against the hosts the provider
              owns, so a channel can only ever be a room at Slack or Microsoft — and a ticket's subject is escaped before it
              is posted, because a subject containing <code className="text-ink">&lt;!channel&gt;</code> would otherwise page
              the room from a help-desk form.
            </p>
          </div>
          <form action={sweepChatNotifyAction}>
            <button
              type="submit"
              className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-semibold text-ink-soft hover:border-brand/40 hover:text-brand"
            >
              Deliver what is due now
            </button>
          </form>
        </div>

        {channelList.length === 0 ? (
          <p className="rounded-xl2 border border-line bg-surface p-4 text-sm text-ink-soft">
            No rooms yet. Until one is registered, the desk tells integrations about a ticket and tells nobody's channel.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
            {channelList.map((channel) => (
              <li key={channel.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{channel.name}</span>
                  <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                    {chatProviderLabel(channel.provider)}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      channel.enabled ? "bg-teal/10 text-teal" : "bg-surface-muted text-ink-faint"
                    }`}
                  >
                    {channel.enabled ? "on" : "off"}
                  </span>
                  <span className="ml-auto flex flex-wrap items-center gap-3 text-xs font-semibold">
                    <form action={testChatChannelAction}>
                      <input type="hidden" name="channelId" value={channel.id} />
                      <button type="submit" className="text-ink-soft hover:text-brand">
                        Send a test message
                      </button>
                    </form>
                    <form action={setChatChannelEnabledAction}>
                      <input type="hidden" name="channelId" value={channel.id} />
                      <input type="hidden" name="enabled" value={channel.enabled ? "false" : "true"} />
                      <button type="submit" className="text-ink-soft hover:text-brand">
                        {channel.enabled ? "Switch off" : "Switch on"}
                      </button>
                    </form>
                    <form action={removeChatChannelAction}>
                      <input type="hidden" name="channelId" value={channel.id} />
                      <button type="submit" className="text-pink hover:underline">
                        Remove
                      </button>
                    </form>
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-faint">
                  {channel.events.join(", ")} · registered {stamp(channel.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-faint">
          The webhook URL is a credential — anybody holding it can post into that room — so it is shown here once and never
          written to the audit trail, which records the channel's name and provider instead.
        </p>

        <form action={registerChatChannelAction} className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
          <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">Register a room</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Provider</span>
              <select name="provider" defaultValue="SLACK" className={inputClass}>
                {CHAT_PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>
                    {chatProviderLabel(provider)}
                  </option>
                ))}
              </select>
            </label>
            {/* Deliberately not "Name" and "URL": the webhook section above already
                has one of each, and two labels a screen reader cannot tell apart is a
                form nobody can fill in from a keyboard. */}
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Room name</span>
              <input name="name" required placeholder="On-call" className={inputClass} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-semibold text-ink">Webhook address</span>
              <input name="url" required placeholder="https://hooks.slack.com/services/…" className={inputClass} />
            </label>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold text-ink">Events</legend>
            {CHAT_EVENTS.map((event) => (
              <label key={event} className="flex items-center gap-2 text-sm text-ink-soft">
                <input type="checkbox" name="events" value={event} className="size-4 rounded border-line" />
                <code className="text-xs text-ink">{event}</code>
              </label>
            ))}
          </fieldset>
          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-xs font-semibold text-brand-ink">
            Register room
          </button>
        </form>

        <div>
          <h3 className="font-display text-sm font-semibold text-ink">Chat delivery log</h3>
          <p className="text-xs text-ink-faint">
            The same state machine as a webhook — retries back off and stop after {CHAT_MAX_ATTEMPTS} attempts — because
            “did the room hear about it?” should have one answer in this product.
          </p>
        </div>
        {chatDeliveryList.length === 0 ? (
          <p className="rounded-xl2 border border-line bg-surface p-4 text-sm text-ink-soft">
            Nothing has been posted yet. Send a test message, or let a ticket be created.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
            {chatDeliveryList.map(({ delivery, channelName, provider }) => (
              <li key={delivery.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs font-semibold text-ink">{delivery.event}</code>
                  <span className="text-xs text-ink-soft">
                    → {channelName ?? "a removed channel"}
                    {provider === null ? "" : ` (${chatProviderLabel(provider)})`}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_CLASS[delivery.status]}`}>
                    {delivery.status.toLowerCase()}
                  </span>
                  <span className="ml-auto text-xs text-ink-faint">{stamp(new Date(delivery.createdAt).toISOString())}</span>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  attempt {delivery.attemptCount} of {CHAT_MAX_ATTEMPTS}
                  {delivery.lastStatusCode === null ? " · nothing answered" : ` · HTTP ${delivery.lastStatusCode}`}
                  {delivery.nextAttemptAt === null ? "" : ` · next try ${stamp(new Date(delivery.nextAttemptAt).toISOString())}`}
                  {delivery.lastError ? ` · ${delivery.lastError}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ----------------------------------------------------------- monitoring */}
      <section aria-labelledby="monitoring" className="space-y-3">
        <div>
          <h2 id="monitoring" className="font-display text-base font-semibold text-ink">
            Monitoring conditions
          </h2>
          <p className="text-xs text-ink-faint">
            A monitoring system POSTs one alert to <code className="text-ink">/api/rmm</code> with{" "}
            <code className="text-ink">{RMM_SECRET_ENV}</code> as its shared secret. A failing check opens a ticket and a
            recovery closes it, walking the ticket’s own lifecycle; a condition that clears and fails again is a new ticket.
          </p>
        </div>

        {openConditions.length === 0 ? (
          <p className="rounded-xl2 border border-line bg-surface p-4 text-sm text-ink-soft">
            No monitored condition is open. Whatever the monitoring system is watching, nothing is failing right now.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
            {openConditions.map((link) => (
              <li key={link.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">
                    {link.check} on {link.host}
                  </span>
                  <span className="rounded-full bg-amber/10 px-2 py-0.5 text-[11px] font-semibold text-amber">{link.severity}</span>
                  <a href={`/inbox/${link.ticketId}`} className="ml-auto text-xs font-semibold text-brand hover:underline">
                    {link.ticketRef}
                  </a>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  {link.source} · failing since {stamp(link.openedAt)} · seen {link.occurrences} time
                  {link.occurrences === 1 ? "" : "s"}
                  {link.reopenCount === 0 ? "" : ` · recurrence ${link.reopenCount + 1}`}
                </p>
                <p className="mt-1 text-xs text-ink-faint">{link.lastSummary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const inputClass = "w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink";

const STATUS_CLASS: Record<DeliveryStatus, string> = {
  DELIVERED: "bg-teal/10 text-teal",
  RETRYING: "bg-amber/10 text-amber",
  EXHAUSTED: "bg-pink/10 text-pink",
  PENDING: "bg-surface-muted text-ink-faint",
};

/** A timestamp as a person reads one, without a locale fighting the assertion in a test. */
function stamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** The reveal banner: the secret, once, with the button that puts it away. */
function SecretPanel({
  title,
  which,
  secret,
  note,
}: {
  title: string;
  which: "token" | "webhook";
  secret: string;
  note: string;
}) {
  return (
    <section
      aria-label={title}
      className="space-y-2 rounded-xl2 border border-brand/40 bg-brand-soft/30 p-4"
    >
      <h2 className="font-display text-sm font-semibold text-ink">{title}</h2>
      <p className="break-all rounded-xl2 border border-line bg-surface px-3 py-2 font-mono text-xs text-ink">{secret}</p>
      <p className="text-xs text-ink-soft">{note}</p>
      <form action={dismissRevealAction}>
        <input type="hidden" name="which" value={which} />
        <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink">
          I have stored it — hide it
        </button>
      </form>
    </section>
  );
}
