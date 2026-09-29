/**
 * Identity connection admin form (M2): the tenant's IdP, as a pure renderer.
 *
 * Split out of the page so the markup — the current state, the redirect URI the
 * IdP needs, and every field — can be rendered and asserted without a session or
 * a database. The role mappings are edited as one-mapping-per-line text, which
 * `parseRoleMappings` reads back.
 */

import { ROLES, type Role } from "../lib/access-rules";
import {
  IDENTITY_PROTOCOLS,
  formatRoleMappings,
  type IdentityConnection,
  type IdentityProtocol,
} from "../lib/identity-rules";

export interface IdentityConnectionFormProps {
  connection: IdentityConnection | null;
  /** Whether the deployment has a client secret set (it is never shown). */
  clientSecretConfigured: boolean;
  /** The absolute redirect URI that must be registered at the IdP. */
  callbackUrl: string;
  action: (formData: FormData) => Promise<void>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium text-ink">
      {label}
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-faint">{hint}</span> : null}
    </label>
  );
}

const inputClass = "mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink";

export function IdentityConnectionForm({ connection, clientSecretConfigured, callbackUrl, action }: IdentityConnectionFormProps) {
  const protocol: IdentityProtocol = connection?.protocol ?? "OIDC";

  return (
    <div className="space-y-4">
      <section className="rounded-xl2 border border-line bg-surface p-4">
        <h2 className="font-display text-base font-semibold text-ink">Current connection</h2>
        {connection ? (
          <dl className="mt-2 space-y-1 text-sm text-ink-soft">
            <div>
              <dt className="inline font-semibold text-ink">Protocol: </dt>
              <dd className="inline">{protocol}</dd>
            </div>
            <div>
              <dt className="inline font-semibold text-ink">Issuer: </dt>
              <dd className="inline break-all">{connection.issuer}</dd>
            </div>
            <div>
              <dt className="inline font-semibold text-ink">Default role: </dt>
              <dd className="inline">{connection.defaultRole}</dd>
            </div>
            <div>
              <dt className="inline font-semibold text-ink">MFA required: </dt>
              <dd className="inline">{connection.mfaRequired ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt className="inline font-semibold text-ink">SCIM: </dt>
              <dd className="inline">{connection.scimEnabled ? "enabled" : "disabled"}</dd>
            </div>
            <div>
              <dt className="inline font-semibold text-ink">Role mappings: </dt>
              <dd className="inline">{connection.roleMappings.length}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">
            No identity provider is configured. Staff sign in with email and password until one is.
          </p>
        )}
        <p className="mt-3 text-xs text-ink-faint">
          Client secret: {clientSecretConfigured ? "configured in the deployment" : "not set (set ONTRAK_TIX_OIDC_CLIENT_SECRET to enable SSO)"}
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          Redirect URI to register at the IdP: <code className="font-mono">{callbackUrl}</code>
        </p>
      </section>

      <form action={action} className="space-y-4 rounded-xl2 border border-line bg-surface p-4">
        <h2 className="font-display text-base font-semibold text-ink">{connection ? "Update the connection" : "Configure an identity provider"}</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Protocol">
            <select name="protocol" defaultValue={protocol} className={inputClass}>
              {IDENTITY_PROTOCOLS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Default role" hint="Used when no mapping matches.">
            <select name="defaultRole" defaultValue={connection?.defaultRole ?? "REQUESTER"} className={inputClass}>
              {ROLES.map((role: Role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Issuer" hint="The OIDC issuer / SAML entity id, e.g. https://login.example.com/realms/acme">
          <input name="issuer" required defaultValue={connection?.issuer ?? ""} className={inputClass} />
        </Field>

        <Field label="Client ID">
          <input name="clientId" required defaultValue={connection?.clientId ?? ""} className={inputClass} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Scopes" hint="Comma separated. openid is always requested.">
            <input name="scopes" defaultValue={connection?.scopes.join(", ") ?? "openid, email, profile, groups"} className={inputClass} />
          </Field>
          <Field label="Allowed email domains" hint="Comma separated. Empty allows any domain.">
            <input name="allowedDomains" defaultValue={connection?.allowedDomains.join(", ") ?? ""} className={inputClass} />
          </Field>
        </div>

        <Field label="Role mappings" hint="One per line: value=ROLE, or claim:value=ROLE. Defaults to the groups claim.">
          <textarea
            name="roleMappings"
            rows={4}
            defaultValue={formatRoleMappings(connection?.roleMappings ?? [])}
            className={`${inputClass} font-mono`}
          />
        </Field>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" name="mfaRequired" defaultChecked={connection?.mfaRequired ?? false} className="size-4 accent-brand" />
            Require multi-factor authentication
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" name="scimEnabled" defaultChecked={connection?.scimEnabled ?? false} className="size-4 accent-brand" />
            Allow SCIM provisioning
          </label>
        </div>

        <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink">
          Save connection
        </button>
      </form>
    </div>
  );
}
