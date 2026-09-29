/**
 * Outbound provisioning card (M2): the desk pushing its people to the provider.
 *
 * Split out of the page for the same reason `IdentityConnectionForm` is: the
 * markup — configured, misconfigured, and what the button claims to do — can be
 * rendered and asserted without a session, a database or a provider.
 *
 * The card never offers the button on a deployment that has nowhere to push to.
 * "It failed on every person" is a worse answer than "this deployment has no
 * connector configured", and only one of the two tells an operator what to fix.
 */

export interface ScimPushCardProps {
  configured: boolean;
  /** Why a half-configured connector cannot be used, if it is half configured. */
  issues: string[];
  /** The provider's SCIM origin, shown so an operator can confirm it is the right one. */
  baseUrl: string | null;
  /** The variables that turn this on, named so the fix is in the card. */
  envVars: { baseUrl: string; token: string };
  action: () => Promise<void>;
}

export function ScimPushCard({ configured, issues, baseUrl, envVars, action }: ScimPushCardProps) {
  return (
    <section className="rounded-xl2 border border-line bg-surface p-4">
      <h2 className="font-display text-base font-semibold text-ink">Provisioning (outbound)</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Push this desk&apos;s accounts to the identity provider over SCIM, so a person is added once — here — and the
        provider learns about them. Sign-in still happens at the provider; this is what makes it possible. Roles are
        deliberately not pushed: the provider decides what an identity may do there.
      </p>

      {issues.length > 0 ? (
        <p role="alert" className="mt-3 rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {issues[0]}
        </p>
      ) : null}

      {configured ? (
        <div className="mt-3 space-y-3">
          {baseUrl ? <p className="text-xs text-ink-faint">Provider: {baseUrl}</p> : null}
          <form action={action}>
            <button
              type="submit"
              className="rounded-xl2 border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink hover:border-ok/45 hover:text-ok"
            >
              Push accounts to the provider
            </button>
          </form>
          <p className="text-xs text-ink-faint">
            Re-running this is safe: a person the provider already matches is left alone, so a quiet day writes nothing.
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-2 text-sm text-ink-soft">
          <p>Not configured on this deployment. Set both of these and restart:</p>
          <dl className="space-y-1 text-xs">
            <div>
              <dt className="inline font-semibold text-ink">{envVars.baseUrl}</dt>{" "}
              <dd className="inline">— the provider&apos;s origin, e.g. http://sentinel:8787</dd>
            </div>
            <div>
              <dt className="inline font-semibold text-ink">{envVars.token}</dt>{" "}
              <dd className="inline">— a connector token minted in the provider&apos;s console</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
