/**
 * OnTrak Sentinel's runnable service (S1): the OIDC provider, listening.
 *
 * It wires the identity spine and the OIDC engine, bootstraps a demo
 * organization with an administrator, a session and one registered client, and
 * prints a ready-to-use authorization URL.
 *
 * Two modes, and it says which one it is on the tin:
 *
 *  - **`DATABASE_URL` set** — the spine, the evidence chain, the clients, the
 *    codes, the tokens and the SAML service providers all live in Postgres (the
 *    second and third migrations, `20260929000000_oidc` and
 *    `20260930000000_logout_saml`). Restarting does not forget anything, so this
 *    is the mode a deployment-shaped run uses.
 *  - **`DATABASE_URL` unset** — everything lives in this process's memory and
 *    vanishes when it stops. Fast to start and good for poking at the endpoints;
 *    not a login path for anybody.
 *
 * Bootstrap is idempotent in the durable mode: it reuses the demo organization,
 * its administrator and a client already registered for the demo redirect URI
 * rather than piling up a new row on every restart.
 *
 *   npm run serve
 *   DATABASE_URL=postgresql://… npm run serve
 *   SENTINEL_ISSUER=https://id.example SENTINEL_SIGNING_KEY="$(cat key.pem)" npm run serve
 */

import { randomBytes } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { ConsoleService } from "../src/lib/console-service";
import { CONSOLE_PATHS } from "../src/lib/console-rules";
import { sha256Hex } from "../src/lib/hash";
import { createIdentityServices, createMfaServices, createWebAuthnServices } from "../src/lib/identity-server";
import type { SessionRecord } from "../src/lib/identity-rules";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type AuditTrail,
  type IdentityActor,
  type IdentityStore,
} from "../src/lib/identity-service";
import type { IdentityPrismaClient } from "../src/lib/identity-store-prisma";
import { base32Decode, formatTotpSecret, totpCode, totpCounter } from "../src/lib/mfa-rules";
import { MemoryMfaStore, MfaService, systemTotpSigner } from "../src/lib/mfa-service";
import type { MfaPrismaClient, WebAuthnChallengePrismaClient } from "../src/lib/mfa-store-prisma";
import { generateSigningKey, signingKeyFromPem, type SigningKey } from "../src/lib/oidc-keys";
import { codeChallengeFor, type OidcClientRecord } from "../src/lib/oidc-rules";
import { createOidcServices, startOidcServer } from "../src/lib/oidc-server";
import { MemoryOidcStore, OidcService, type OidcStore } from "../src/lib/oidc-service";
import { PrismaOidcStore, type OidcPrismaClient } from "../src/lib/oidc-store-prisma";
import { SAML_PATHS, type SamlServiceProviderRecord } from "../src/lib/saml-rules";
import { MemorySamlStore, SamlService, type SamlStore } from "../src/lib/saml-service";
import { PrismaSamlStore, type SamlPrismaClient } from "../src/lib/saml-store-prisma";
import { MemoryWebAuthnChallengeStore, WebAuthnService } from "../src/lib/webauthn-service";

const DEMO_REDIRECT = "http://127.0.0.1:8788/callback";
const DEMO_ACS = "http://127.0.0.1:8788/saml/acs";
const DEMO_ENTITY_ID = "http://127.0.0.1:8788/saml";
const DEMO_SLUG = "demo";
const DEMO_ADMIN = process.env.SENTINEL_ADMIN_EMAIL ?? "admin@demo.test";

function signingKey(): SigningKey {
  const pem = process.env.SENTINEL_SIGNING_KEY;
  if (pem) return signingKeyFromPem(pem, process.env.SENTINEL_SIGNING_KID);
  console.warn(
    "[sentinel] SENTINEL_SIGNING_KEY is unset: generating an ephemeral key. " +
      "Every ID token this process signs stops verifying when it stops.",
  );
  return generateSigningKey();
}

/**
 * Enroll the demo administrator's second factor the way the product does.
 *
 * A secret is generated, then confirmed with a code from it — the flag is never
 * flipped directly. The code is computed here with the same primitive the service
 * verifies with, which is exactly what an authenticator app does on somebody's
 * phone; there is no bypass, and a wrong code would be refused like any other.
 *
 * The default policy requires a second factor, so without one every authorize
 * call is refused — which is the policy working, not a bug.
 */
async function enrollDemoTotp(mfa: MfaService, actor: IdentityActor): Promise<{ secret: string; uri: string }> {
  const begun = await mfa.beginEnrollment(actor, actor.id, { account: actor.id, label: "serve-script authenticator" });
  if (!begun.ok) throw new Error(begun.error);

  const secret = base32Decode(begun.value.secret);
  if (!secret) throw new Error("The generated TOTP secret could not be decoded.");
  const code = totpCode(secret, totpCounter(Date.now()), systemTotpSigner());

  const confirmed = await mfa.confirmEnrollment(actor, actor.id, code);
  if (!confirmed.ok) throw new Error(confirmed.error);
  return { secret: begun.value.secret, uri: begun.value.uri };
}

/**
 * The demo organization, administrator and session, created once and reused.
 */
async function bootstrap(
  spine: IdentityService,
  store: IdentityStore,
  mfa: MfaService,
): Promise<{ actor: IdentityActor; session: SessionRecord; totp: { secret: string; uri: string } | null }> {
  const existing = await store.findOrganizationBySlug(DEMO_SLUG);
  if (existing) {
    const admin = await store.findIdentityByIdentifier(existing.id, DEMO_ADMIN);
    if (!admin) throw new Error(`The “${DEMO_SLUG}” organization exists but ${DEMO_ADMIN} does not.`);
    const actor: IdentityActor = { id: admin.id, organizationId: existing.id, role: "ADMIN" };
    const totp = admin.mfaEnrolled ? null : await enrollDemoTotp(mfa, actor);
    const session = await spine.issueSession(actor.organizationId, actor.id);
    if (!session.ok) throw new Error(session.error);
    return { actor, session: session.value, totp };
  }

  const created = await spine.bootstrapOrganization(
    "serve-script",
    { name: "Sentinel demo", slug: DEMO_SLUG },
    { identifier: DEMO_ADMIN, displayName: "Demo Admin" },
  );
  if (!created.ok) throw new Error(created.error);
  const actor: IdentityActor = {
    id: created.value.admin.id,
    organizationId: created.value.organization.id,
    role: "ADMIN",
  };
  const totp = await enrollDemoTotp(mfa, actor);
  const session = await spine.issueSession(actor.organizationId, actor.id);
  if (!session.ok) throw new Error(session.error);
  return { actor, session: session.value, totp };
}

/**
 * An existing demo service provider, or a fresh one — the SAML counterpart of
 * `demoClient`, and idempotent for the same reason: a restart must not pile up a
 * second registration under a different name.
 */
async function demoProvider(saml: SamlService, actor: IdentityActor): Promise<SamlServiceProviderRecord> {
  const listed = await saml.listServiceProviders(actor);
  const existing = (listed.ok ? listed.value : []).find((provider) => provider.entityId === DEMO_ENTITY_ID);
  if (existing) return existing;

  const registered = await saml.registerServiceProvider(actor, {
    name: "Sentinel demo service provider",
    entityId: DEMO_ENTITY_ID,
    acsUrls: [DEMO_ACS],
  });
  if (!registered.ok) throw new Error(registered.error);
  return registered.value;
}

/** An existing demo client, or a fresh one. Re-registering each start would pile up rows. */
async function demoClient(oidc: OidcService, actor: IdentityActor): Promise<OidcClientRecord> {
  const listed = await oidc.listClients(actor);
  const existing = (listed.ok ? listed.value : []).find((client) =>
    client.redirectUris.includes(DEMO_REDIRECT),
  );
  if (existing) return existing;

  const registered = await oidc.registerClient(actor, {
    name: "Sentinel demo client",
    redirectUris: [DEMO_REDIRECT],
    scopes: ["openid", "profile", "email", "roles"],
  });
  if (!registered.ok) throw new Error(registered.error);
  return registered.value;
}

async function main(): Promise<void> {
  const issuer = process.env.SENTINEL_ISSUER ?? "http://127.0.0.1:8787";
  const host = process.env.SENTINEL_HOST ?? "127.0.0.1";
  const port = Number(process.env.SENTINEL_PORT ?? 8787);
  const durable = Boolean(process.env.DATABASE_URL);
  const keys = signingKey();

  // The WebAuthn relying party. The console's own origin *is* the RP ID's host, so
  // the default is derived from `SENTINEL_ISSUER`; a deployment that serves the
  // console from several subdomains sets `SENTINEL_WEBAUTHN_RP_ID` to the suffix.
  const webAuthnOrigin = process.env.SENTINEL_WEBAUTHN_ORIGIN ?? issuer;
  const webAuthnRpId = process.env.SENTINEL_WEBAUTHN_RP_ID ?? new URL(webAuthnOrigin).hostname;
  const webAuthnConfig = { rpId: webAuthnRpId, rpName: "OnTrak Sentinel", origin: webAuthnOrigin };

  let identities: IdentityStore;
  let audit: AuditTrail;
  let spine: IdentityService;
  let oidc: OidcService;
  let saml: SamlService;
  let mfa: MfaService;
  let webauthn: WebAuthnService;
  let oidcStore: OidcStore;

  if (durable) {
    const prisma = new PrismaClient();
    const stack = createIdentityServices(prisma as unknown as IdentityPrismaClient);
    identities = stack.store;
    audit = stack.audit;
    spine = stack.service;
    const factors = createMfaServices(prisma as unknown as MfaPrismaClient, spine, audit);
    mfa = factors.service;
    webauthn = createWebAuthnServices(
      prisma as unknown as MfaPrismaClient & WebAuthnChallengePrismaClient,
      factors.store,
      spine,
      webAuthnConfig,
      audit,
    ).service;
    oidcStore = new PrismaOidcStore(prisma as unknown as OidcPrismaClient);
    oidc = createOidcServices(oidcStore, identities, spine, { issuer, keys }, audit).service;
    const samlStore: SamlStore = new PrismaSamlStore(prisma as unknown as SamlPrismaClient);
    saml = new SamlService(samlStore, spine, { entityId: issuer, keys }, audit);
  } else {
    identities = new MemoryIdentityStore();
    audit = new OrganizationAuditLog(sha256Hex);
    spine = new IdentityService(identities, audit);
    const factors = new MemoryMfaStore();
    mfa = new MfaService(factors, spine, audit);
    webauthn = new WebAuthnService(factors, new MemoryWebAuthnChallengeStore(), spine, webAuthnConfig, audit);
    oidcStore = new MemoryOidcStore();
    oidc = new OidcService(oidcStore, identities, spine, { issuer, keys }, audit);
    saml = new SamlService(new MemorySamlStore(), spine, { entityId: issuer, keys }, audit);
  }

  const console_ = new ConsoleService(spine, mfa, webauthn, oidcStore);

  const { actor, session, totp } = await bootstrap(spine, identities, mfa);
  const client = await demoClient(oidc, actor);
  const provider = await demoProvider(saml, actor);

  // A PKCE pair the developer can paste straight into the printed URL.
  const verifier = randomBytes(48).toString("base64url");
  const challenge = codeChallengeFor(verifier, sha256Hex);
  const authorize = new URL(`${issuer}/oauth2/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", client.clientId);
  authorize.searchParams.set("redirect_uri", DEMO_REDIRECT);
  authorize.searchParams.set("scope", "openid profile email roles");
  authorize.searchParams.set("state", "demo-state");
  authorize.searchParams.set("nonce", "demo-nonce");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  const { url } = await startOidcServer(oidc, { host, port, saml, console: console_ });

  console.log(`[sentinel] OIDC provider listening on ${url} (issuer ${issuer})`);
  console.log(
    `[sentinel] storage: ${durable ? "PostgreSQL — clients, codes and tokens are persisted" : "in-memory — a restart forgets everything"}`,
  );
  console.log(`[sentinel] discovery: ${url}/.well-known/openid-configuration`);
  console.log(`[sentinel] jwks:      ${url}/.well-known/jwks.json`);
  console.log(`[sentinel] SAML metadata: ${url}${SAML_PATHS.metadata}`);
  console.log(`[sentinel] SAML SSO:      ${url}${SAML_PATHS.sso}`);
  console.log(`[sentinel] console: ${url}${CONSOLE_PATHS.home} (WebAuthn RP ID ${webAuthnRpId}, origin ${webAuthnOrigin})`);
  console.log(`[sentinel] demo client: ${client.clientId}`);
  console.log(`[sentinel] demo service provider: ${provider.entityId} → ${provider.acsUrls.join(", ")}`);
  if (totp) {
    console.log(`[sentinel] enrolled a TOTP factor for ${DEMO_ADMIN} — the default policy requires one:`);
    console.log(`  otpauth: ${totp.uri}`);
    console.log(`  secret:  ${formatTotpSecret(totp.secret)}`);
  } else {
    console.log(`[sentinel] ${DEMO_ADMIN} already has a confirmed TOTP factor; the session policy is satisfied.`);
  }
  console.log("");
  console.log("Open the authorization URL with the demo session attached (header, or a cookie):");
  console.log(`  curl -sS -i -H "X-Sentinel-Session: ${session.id}" "${authorize.toString()}"`);
  console.log("");
  console.log("Or drive the console in a browser, with the same session as a cookie:");
  console.log(`  document.cookie = "sentinel_session=${session.id}; path=/"`);
  console.log(`  then open ${url}${CONSOLE_PATHS.mfa} — enrollment is self-service, with no administrator involved.`);
  console.log("");
  console.log(`  code_verifier: ${verifier}`);
  console.log("");
  if (!durable) {
    console.log("[sentinel] In-memory stores: restarting forgets every identity, client, code and token.");
  }
}

void main();
