import { redirect } from "next/navigation";

import { requireActor } from "../../../../lib/session";
import { hasPermission } from "../../../../lib/access-rules";
import { identityServicesFor } from "../../../../lib/db";
import { OIDC_CLIENT_SECRET_ENV } from "../../../../lib/oidc-client";
import { IdentityConnectionForm } from "../../../../components/IdentityConnectionForm";
import { ScimPushCard } from "../../../../components/ScimPushCard";
import { SCIM_TARGET_ENV, scimTargetFromEnv } from "../../../../lib/scim-rules";
import { pushPeopleToProviderAction, saveIdentityConnectionAction } from "../../../actions/identity";

export const metadata = { title: "Identity" };

/**
 * Identity provider administration (M2): where an administrator stores the
 * tenant's IdP connection, its role mappings and its MFA/SCIM posture.
 *
 * Gated on `tenant:manage` — this is tenant-wide configuration, not desk work.
 * The client secret is never shown or stored here; the page only reports whether
 * the deployment has one.
 */
export default async function IdentityAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "tenant:manage")) redirect("/inbox");

  const { flash, error } = await searchParams;
  const connection = await identityServicesFor().connectionFor(actor.tenantId);
  const scim = scimTargetFromEnv();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Identity</h1>
        <p className="text-sm text-ink-soft">
          Single sign-on and SCIM for this tenant. Staff sign in through this IdP; the local password stays as a fallback.
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}
      {flash ? <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p> : null}

      <IdentityConnectionForm
        connection={connection}
        clientSecretConfigured={Boolean(process.env[OIDC_CLIENT_SECRET_ENV])}
        callbackUrl="/api/sso/callback"
        action={saveIdentityConnectionAction}
      />

      <ScimPushCard
        configured={scim.target !== null}
        issues={scim.issues}
        baseUrl={scim.target?.baseUrl ?? null}
        envVars={SCIM_TARGET_ENV}
        action={pushPeopleToProviderAction}
      />
    </div>
  );
}
