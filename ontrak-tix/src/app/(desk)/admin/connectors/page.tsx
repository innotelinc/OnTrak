import { redirect } from "next/navigation";

import { actorHasPermission } from "../../../../lib/access-rules";
import { catalogSections, type CatalogEntry } from "../../../../lib/connector-service";
import { connectorCapabilityLabel, connectorCategoryLabel } from "../../../../lib/connector-rules";
import { connectorRegistry, connectorServicesFor } from "../../../../lib/db";
import { requireActor } from "../../../../lib/session";
import {
  configureConnectorAction,
  installConnectorAction,
  removeConnectorAction,
  setConnectorEnabledAction,
} from "../../../actions/connectors";

export const metadata = { title: "Connectors" };

/**
 * Connectors (M6).
 *
 * One screen for the catalog: **what can talk to this desk, what it is doing, and
 * what it needs.** Two decisions shape it:
 *
 *  - **First-party connectors are listed, not installed here.** Slack, webhooks,
 *    RMM, SCIM and the rest each configure on their own screen, and the card links
 *    to it. Duplicating that into an install form would make two places the same
 *    endpoint is set — so this page is the *directory* for them and the *install
 *    point* only for third parties.
 *  - **A secret is never rendered back.** An installed connector shows its config
 *    with secrets masked (`maskConfig`), and editing leaves a secret field blank to
 *    keep it — the value exists in exactly one place, and it is not this page's HTML.
 */

const inputClass = "w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink";
const labelClass = "block text-xs font-semibold tracking-wide text-ink-faint uppercase";
const buttonClass = "rounded-xl2 border border-brand/40 bg-brand/10 px-3 py-2 text-sm font-semibold text-brand";

type Search = Promise<{ flash?: string; error?: string }>;

/** The config inputs for one connector's manifest, named for the action to read back. */
function ConfigFields({ entry, keepSecrets = false }: { entry: CatalogEntry; keepSecrets?: boolean }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {entry.manifest.configFields.map((field) => {
        const shown = entry.shownConfig[field.key];
        return (
          <label key={field.key} className="space-y-1">
            <span className={labelClass}>
              {field.label}
              {field.secret ? <span className="ml-2 text-ink-faint normal-case">secret</span> : null}
            </span>
            <input
              name={`field_${field.key}`}
              className={inputClass}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              // For an install a required field must be filled; for an edit a blank one
              // keeps what is stored, so it is never `required` there.
              required={!keepSecrets && field.required}
              placeholder={
                keepSecrets && shown
                  ? "Leave blank to keep the stored value"
                  : field.secret
                    ? "Stored securely"
                    : (field.hint ?? "")
              }
            />
          </label>
        );
      })}
    </div>
  );
}

/** One capability chip list — what a connector hears or reports. */
function Capabilities({ entry }: { entry: CatalogEntry }) {
  return (
    <p className="mt-1 flex flex-wrap gap-2">
      <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-soft">
        {connectorCategoryLabel(entry.manifest.category)}
      </span>
      {entry.manifest.capabilities.map((capability) => (
        <span key={capability} className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-faint">
          {connectorCapabilityLabel(capability)}
        </span>
      ))}
      {entry.manifest.configFields.length === 0 ? (
        <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-faint">No settings</span>
      ) : null}
    </p>
  );
}

export default async function ConnectorsPage({ searchParams }: { searchParams: Search }) {
  const actor = await requireActor();
  if (!actorHasPermission(actor, "tenant:manage")) redirect("/inbox");

  const query = await searchParams;
  const entries = await connectorServicesFor().catalog(actor.tenantId);
  const { installed, available, builtin } = catalogSections(entries);
  const catalogSize = connectorRegistry.list().length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Connectors</h1>
        <p className="text-sm text-ink-soft">
          What can talk to this desk, what it is doing, and what it needs. Installing a connector is
          declaring it here; a manifest is the whole contract, so a new connector is data, not code.
        </p>
      </div>

      {query.flash ? (
        <p className="rounded-xl2 border border-teal/30 bg-teal/10 px-3 py-2 text-sm text-ink-soft">{query.flash}</p>
      ) : null}
      {query.error ? (
        <p className="rounded-xl2 border border-pink/30 bg-pink/10 px-3 py-2 text-sm text-ink-soft">{query.error}</p>
      ) : null}

      {/* ------------------------------------------------------------- installed */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide text-ink-faint uppercase">
          Installed ({installed.length})
        </h2>
        {installed.length === 0 ? (
          <p className="text-sm text-ink-soft">No third-party connectors installed. Install one from the catalog below.</p>
        ) : (
          <ul className="space-y-3">
            {installed.map((entry) => (
              <li key={entry.manifest.id} className={`rounded-xl2 border border-line bg-surface px-4 py-3 ${entry.installation?.enabled ? "" : "opacity-70"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{entry.manifest.name}</span>
                  <span className="font-mono text-xs text-ink-faint">{entry.manifest.id}</span>
                  <span className="text-xs text-ink-faint">by {entry.manifest.vendor}</span>
                  {entry.installation?.enabled ? (
                    <span className="rounded-full border border-teal/40 px-2 py-0.5 text-xs text-teal">On</span>
                  ) : (
                    <span className="rounded-full border border-amber/40 px-2 py-0.5 text-xs text-amber">Off</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-ink-soft">{entry.manifest.summary}</p>
                <Capabilities entry={entry} />

                <form action={configureConnectorAction} className="mt-3 space-y-3">
                  <input type="hidden" name="installationId" value={entry.installation?.id ?? ""} />
                  <ConfigFields entry={entry} keepSecrets />
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="submit" className={buttonClass}>
                      Save settings
                    </button>
                  </div>
                </form>

                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <form action={setConnectorEnabledAction}>
                    <input type="hidden" name="installationId" value={entry.installation?.id ?? ""} />
                    <input type="hidden" name="enabled" value={entry.installation?.enabled ? "false" : "true"} />
                    <button type="submit" className="text-xs font-semibold text-ink-soft hover:text-ink">
                      {entry.installation?.enabled ? "Turn off" : "Turn on"}
                    </button>
                  </form>
                  <form action={removeConnectorAction}>
                    <input type="hidden" name="installationId" value={entry.installation?.id ?? ""} />
                    <button type="submit" className="text-xs font-semibold text-ink-faint hover:text-ink">
                      Remove
                    </button>
                  </form>
                  <a className="text-xs font-semibold text-brand hover:underline" href={`/${entry.manifest.docsPath}`}>
                    Docs
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------- available */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide text-ink-faint uppercase">
          Available to install ({available.length})
        </h2>
        {available.length === 0 ? (
          <p className="text-sm text-ink-soft">
            Nothing else is installable here. A third-party connector is added to the catalog by
            registering its manifest.
          </p>
        ) : (
          <ul className="space-y-3">
            {available.map((entry) => (
              <li key={entry.manifest.id} className="rounded-xl2 border border-line bg-surface px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{entry.manifest.name}</span>
                  <span className="font-mono text-xs text-ink-faint">{entry.manifest.id}</span>
                  <span className="text-xs text-ink-faint">by {entry.manifest.vendor}</span>
                </div>
                <p className="mt-1 text-sm text-ink-soft">{entry.manifest.summary}</p>
                <Capabilities entry={entry} />
                <form action={installConnectorAction} className="mt-3 space-y-3">
                  <input type="hidden" name="connectorId" value={entry.manifest.id} />
                  <ConfigFields entry={entry} />
                  <button type="submit" className={buttonClass}>
                    Install
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --------------------------------------------------------------- built-in */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-wide text-ink-faint uppercase">
          Built in ({builtin.length})
        </h2>
        <p className="text-sm text-ink-soft">
          Connectors we ship are configured on their own screen, so they are listed here to answer
          “what can talk to this desk?” and not installed from this page — one endpoint, one place to
          set it.
        </p>
        <ul className="space-y-2">
          {builtin.map((entry) => (
            <li key={entry.manifest.id} className="rounded-xl2 border border-line bg-surface px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-ink">{entry.manifest.name}</span>
                <span className="text-xs text-ink-faint">by {entry.manifest.vendor}</span>
                {entry.manifest.managePath ? (
                  <a className="ml-auto text-xs font-semibold text-brand hover:underline" href={entry.manifest.managePath}>
                    Configure →
                  </a>
                ) : (
                  <span className="ml-auto text-xs text-ink-faint">Configured by the deployment</span>
                )}
              </div>
              <p className="mt-1 text-sm text-ink-soft">{entry.manifest.summary}</p>
              <Capabilities entry={entry} />
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-ink-faint">
        {catalogSize} connector{catalogSize === 1 ? "" : "s"} in the catalog. Anyone may be given the
        connector catalogue to read; only “Administer the desk” can install, change or remove one.
      </p>
    </div>
  );
}
