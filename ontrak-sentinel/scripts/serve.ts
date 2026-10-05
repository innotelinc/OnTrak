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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { PrismaAlertStore, type AlertPrismaClient } from "../src/lib/alert-store-prisma";
import { ConsoleService } from "../src/lib/console-service";
import { upstreamConfigFromEnv } from "../src/lib/upstream-rules";
import { UpstreamSignInService } from "../src/lib/upstream-service";
import { CONSOLE_ASSET_PATHS, CONSOLE_PATHS } from "../src/lib/console-rules";
import { MemoryCredentialStore, type CredentialStore } from "../src/lib/credential-store";
import { PrismaCredentialStore, type CredentialPrismaClient } from "../src/lib/credential-store-prisma";
import { DETECTION_RULES } from "../src/lib/detection-rules";
import {
  DetectionService,
  MemoryAlertStore,
  systemDetectionIds,
  type AlertStore,
} from "../src/lib/detection-service";
import { GUARD_PATHS } from "../src/lib/guard-http";
import { GuardService } from "../src/lib/guard-service";
import {
  guardSyslogConfigFromEnv,
  startGuardSyslog,
  type GuardSyslogHandle,
} from "../src/lib/guard-syslog";
import { createHttpDirectoryReader } from "../src/lib/directory-client";
import { DirectoryService, MemoryDirectoryStore, type DirectoryReader } from "../src/lib/directory-service";
import type { DirectorySource } from "../src/lib/directory-rules";
import type { DirectoryPrismaClient } from "../src/lib/directory-store-prisma";
import { sha256Hex } from "../src/lib/hash";
import { hashPassword } from "../src/lib/password";
import { SignInService, systemSignInIds } from "../src/lib/sign-in-service";
import { MemoryIndicatorStore, ThreatIntelService, type IndicatorStore } from "../src/lib/threat-intel-service";
import {
  AccessReviewService,
  MemoryAccessReviewStore,
  type AccessReviewStore,
} from "../src/lib/access-review-service";
import { PrismaAccessReviewStore, type AccessReviewPrismaClient } from "../src/lib/access-review-store-prisma";
import { accessReviewIntervalMs, startAccessReviewScheduler } from "../src/lib/access-review-scheduler";
import {
  EnforcementService,
  MemoryEnforcementStore,
  systemEnforcementIds,
  type EnforcementStore,
} from "../src/lib/enforcement-service";
import { PrismaEnforcementStore, type EnforcementPrismaClient } from "../src/lib/enforcement-store-prisma";
import { planeFromEnv } from "../src/lib/enforcement-plane";
import { notifierFromEnv } from "../src/lib/alert-notify";
import {
  MemorySuppressionStore,
  SuppressionService,
  type SuppressionStore,
} from "../src/lib/alert-suppression-service";
import {
  PrismaSuppressionStore,
  type AlertSuppressionPrismaClient,
} from "../src/lib/alert-suppression-store-prisma";
import { enforcementSweepIntervalMs, startEnforcementScheduler } from "../src/lib/enforcement-scheduler";
import { PrismaIndicatorStore, type IndicatorPrismaClient } from "../src/lib/threat-intel-store-prisma";
import {
  configureDirectories,
  createIdentityServices,
  createMfaServices,
  createScimServices,
  createWebAuthnServices,
} from "../src/lib/identity-server";
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
import { loadSigningKeys } from "../src/lib/oidc-keys";
import { codeChallengeFor, type OidcClientRecord } from "../src/lib/oidc-rules";
import { createOidcServices, HEALTH_PATH, startOidcServer } from "../src/lib/oidc-server";
import { MemoryOidcStore, OidcService, type OidcStore } from "../src/lib/oidc-service";
import { PrismaOidcStore, type OidcPrismaClient } from "../src/lib/oidc-store-prisma";
import { SAML_PATHS, type SamlServiceProviderRecord } from "../src/lib/saml-rules";
import { SCIM_PATHS } from "../src/lib/scim-rules";
import { MemoryScimStore, ScimService } from "../src/lib/scim-service";
import type { ScimPrismaClient } from "../src/lib/scim-store-prisma";
import { MemorySamlStore, SamlService, type SamlStore } from "../src/lib/saml-service";
import { PrismaSamlStore, type SamlPrismaClient } from "../src/lib/saml-store-prisma";
import { MemoryWebAuthnChallengeStore, WebAuthnService } from "../src/lib/webauthn-service";

/**
 * The directory readers this deployment was told it can use.
 *
 * `SENTINEL_DIRECTORY_SOURCES` is a comma-separated list — `ENTRA,GOOGLE,GENERIC` by
 * default — and each one gets the same HTTP reader, because Entra and Google differ in
 * their URLs and their paging keys rather than in how a roster arrives. LDAP is absent on
 * purpose: a bind is a different protocol with a different dependency, so a deployment
 * that needs it supplies another reader rather than being handed a fake one.
 */
function directoryReaders(): Partial<Record<DirectorySource, DirectoryReader>> {
  const configured = (process.env.SENTINEL_DIRECTORY_SOURCES ?? "ENTRA,GOOGLE,GENERIC")
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);

  const readers: Partial<Record<DirectorySource, DirectoryReader>> = {};
  for (const entry of configured) {
    if (entry === "ENTRA" || entry === "GOOGLE" || entry === "GENERIC") {
      readers[entry] = createHttpDirectoryReader();
    }
  }
  return readers;
}

const DEMO_REDIRECT = "http://127.0.0.1:8788/callback";
const DEMO_ACS = "http://127.0.0.1:8788/saml/acs";
const DEMO_ENTITY_ID = "http://127.0.0.1:8788/saml";
const DEMO_SLUG = "demo";
const DEMO_ADMIN = process.env.SENTINEL_ADMIN_EMAIL ?? "admin@demo.test";

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

/**
 * A client for one of the family's products, when this run has been told where
 * its SSO callback is — `SENTINEL_TIX_CALLBACK` for the desk,
 * `SENTINEL_TRAINING_CALLBACK` for the training app.
 *
 * Opt-in rather than always-on: registering a client is a statement that a
 * product is being pointed at this provider, and a provider that registers one for
 * something nobody configured is issuing identity to an audience that never asked.
 *
 * Both are **public** clients — neither can keep a secret, so PKCE is the only thing
 * binding an authorization code to the caller that requested it, and both kinds are
 * held to it here. The redirect URI is validated like any other, which means
 * `https`, or `http` on a loopback address: a product reached at a bare LAN address
 * over plain HTTP cannot be registered at all, and is told so rather than being
 * quietly allowed.
 */
async function productClient(
  oidc: OidcService,
  actor: IdentityActor,
  name: string,
  redirect: string,
): Promise<OidcClientRecord | null> {
  if (!redirect) return null;

  const listed = await oidc.listClients(actor);
  const existing = (listed.ok ? listed.value : []).find((client) => client.redirectUris.includes(redirect));
  if (existing) return existing;

  const registered = await oidc.registerClient(actor, {
    name,
    redirectUris: [redirect],
    scopes: ["openid", "profile", "email", "roles"],
  });
  if (!registered.ok) throw new Error(registered.error);
  return registered.value;
}

/**
 * The shared theme, read once.
 *
 * These are the two files every product in the Network carries a byte-identical copy
 * of. A missing one is a warning rather than a crash: an unthemed console is a
 * console, and refusing to start an identity provider because a stylesheet is absent
 * would be a login outage caused by typography.
 */
function themeAssets(): Record<string, { body: string; contentType: string }> {
  const files: [string, string, string][] = [
    [CONSOLE_ASSET_PATHS.themeCss, "../src/theme/unity-theme.css", "text/css; charset=utf-8"],
    [CONSOLE_ASSET_PATHS.themeJs, "../public/unity-theme.js", "text/javascript; charset=utf-8"],
  ];
  const assets: Record<string, { body: string; contentType: string }> = {};
  for (const [route, relative, contentType] of files) {
    try {
      assets[route] = { body: readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"), contentType };
    } catch (error) {
      console.warn(`[sentinel] ${relative} could not be read (${error instanceof Error ? error.message : error}); ${route} will not be served.`);
    }
  }
  return assets;
}

async function main(): Promise<void> {
  const issuer = process.env.SENTINEL_ISSUER ?? "http://127.0.0.1:8787";
  const host = process.env.SENTINEL_HOST ?? "127.0.0.1";
  const port = Number(process.env.SENTINEL_PORT ?? 8787);
  const durable = Boolean(process.env.DATABASE_URL);
  // Which key signs and which keys are published: `loadSigningKeys` throws on the two
  // misconfigurations that start and then quietly misbehave, so reaching here means the
  // set is coherent. An ephemeral key is legal — it is what poking at the endpoints
  // uses — but it is never what a deployment should have, so it says so out loud.
  const { keys, ephemeral } = loadSigningKeys();
  if (ephemeral) {
    console.warn(
      "[sentinel] no SENTINEL_SIGNING_KEY or SENTINEL_SIGNING_KEY_FILE: generating an " +
        "ephemeral key. Every ID token this process signs stops verifying when it stops.",
    );
  }

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
  let scim: ScimService;
  let credentials: CredentialStore;
  /** `null` when this deployment was told to read no directories. */
  let directories: DirectoryService | null = null;
  let alertStore: AlertStore;
  /** The indicators detection matches against (S3); empty until a feed is ingested. */
  let intelStore: IndicatorStore;
  /** Access reviews and their schedules (S2). */
  let reviewStore: AccessReviewStore;
  /** Guard's prevention actions and the policy they are judged against (S4). */
  let enforcementStore: EnforcementStore;
  /** The windows in which a detection is known and is not raised (S4). */
  let suppressionStore: SuppressionStore;

  // Where a directory connector points. `meta.location` links are built from it, so
  // they name the deployment's own origin rather than 127.0.0.1.
  const scimBase = `${issuer.replace(/\/+$/, "")}/scim/v2`;

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
    credentials = new PrismaCredentialStore(prisma as unknown as CredentialPrismaClient);
    oidc = createOidcServices(oidcStore, identities, spine, { issuer, keys }, audit).service;
    const samlStore: SamlStore = new PrismaSamlStore(prisma as unknown as SamlPrismaClient);
    saml = new SamlService(samlStore, spine, { entityId: issuer, keys }, audit);
    // Provisioning is handed the spine (writes go through its rules), the audit trail,
    // and the OIDC store for one thing only: deprovisioning has to revoke the access
    // tokens the leaver's sessions minted, not just the sessions.
    scim = createScimServices(
      prisma as unknown as ScimPrismaClient,
      spine,
      { baseUrl: scimBase },
      audit,
      oidcStore,
    ).service;
    // The directory read is separate from the SCIM token store: one is a credential a
    // connector pushes with, this is a connection Sentinel pulls through. Both hand their
    // destructive work to the same SCIM code, so a leaver is one operation either way.
    directories = configureDirectories(
      prisma as unknown as DirectoryPrismaClient,
      spine,
      scim,
      directoryReaders(),
      audit,
    ).service;
    alertStore = new PrismaAlertStore(prisma as unknown as AlertPrismaClient);
    intelStore = new PrismaIndicatorStore(prisma as unknown as IndicatorPrismaClient);
    reviewStore = new PrismaAccessReviewStore(prisma as unknown as AccessReviewPrismaClient);
    enforcementStore = new PrismaEnforcementStore(prisma as unknown as EnforcementPrismaClient);
    suppressionStore = new PrismaSuppressionStore(prisma as unknown as AlertSuppressionPrismaClient);
  } else {
    identities = new MemoryIdentityStore();
    audit = new OrganizationAuditLog(sha256Hex);
    spine = new IdentityService(identities, audit);
    const factors = new MemoryMfaStore();
    mfa = new MfaService(factors, spine, audit);
    webauthn = new WebAuthnService(factors, new MemoryWebAuthnChallengeStore(), spine, webAuthnConfig, audit);
    oidcStore = new MemoryOidcStore();
    credentials = new MemoryCredentialStore();
    oidc = new OidcService(oidcStore, identities, spine, { issuer, keys }, audit);
    saml = new SamlService(new MemorySamlStore(), spine, { entityId: issuer, keys }, audit);
    scim = new ScimService(new MemoryScimStore(), spine, { baseUrl: scimBase }, audit, oidcStore);
    directories = new DirectoryService(new MemoryDirectoryStore(), spine, scim, directoryReaders(), audit);
    alertStore = new MemoryAlertStore();
    intelStore = new MemoryIndicatorStore();
    reviewStore = new MemoryAccessReviewStore();
    enforcementStore = new MemoryEnforcementStore();
    suppressionStore = new MemorySuppressionStore();
  }

  /**
   * The console's login.
   *
   * Built before the bootstrap because the bootstrap's session is what the console
   * *starts* with, and the login is what a person uses afterwards. It lands on
   * `/console` like any other sign-in.
   */
  const signIn = new SignInService(identities, credentials, mfa, spine, audit, systemSignInIds(), {
    defaultOrganizationSlug: DEMO_SLUG,
    landingPath: CONSOLE_PATHS.home,
  });

  // Threat intelligence (S3), built before detection because detection *reads* it: the
  // pipeline is handed the service as its `IndicatorSource` port, so enriching an alert and
  // listing a feed are the same rows in the same table rather than two caches that can
  // disagree about what is active.
  const threatIntel = new ThreatIntelService(intelStore, audit);

  // Guard's detection (S3). The store is durable where there is a database and in memory
  // otherwise; correlation reads sessions and identities directly, because a sensor is not
  // an actor and has no session to resolve.
  // Written out rather than defaulted, because the optional collaborator is last in the
  // constructor on purpose — and a wiring that relied on positional `undefined` paddings to
  // reach it would be the thing that breaks the day the list changes.
  //
  // Built *before* the console, because the console renders the queue that this service
  // holds: the console gets only the three triage methods, so a browser session cannot
  // reach ingest, and the last argument below is deliberately the service rather than a
  // second store.
  // Alert delivery (S4's other half): where a *raised* alert is told to somebody, so a
  // queue nobody is watching is not the detector's only reach. Unset is a deployment with
  // no transport, which is the shipped default and behaves exactly as it did before the
  // seam existed. Said out loud once, because "the detector fired" and "somebody was told"
  // are different claims.
  // The mute (S4): the store the pipeline reads and the console writes. Built before detection
  // because detection is given it, and the service satisfies the pipeline's own `SuppressionSource`
  // port as-is — the same posture the threat-intel feed takes.
  const suppressions = new SuppressionService(suppressionStore, audit);
  const alertNotifier = notifierFromEnv(process.env);
  console.log(
    alertNotifier === null
      ? "[sentinel] alert delivery: no transport configured — alerts are raised into the queue only"
      : `[sentinel] alert delivery: ${alertNotifier.name}`,
  );
  const detection = new DetectionService(
    alertStore,
    identities,
    audit,
    DETECTION_RULES,
    systemDetectionIds(),
    sha256Hex,
    threatIntel,
    alertNotifier,
    suppressions,
  );

  // Access reviews (S2). The deprovisioning port is the SCIM service rather than a second
  // way of switching somebody off, so a `REVOKED` decision ends the identity's sessions and
  // its access tokens exactly as a directory's `active:false` does — and a deployment that
  // cannot deprovision gets a refusal rather than a recorded revocation that did nothing.
  const accessReviews = new AccessReviewService(reviewStore, identities, scim, audit);

  // Guard's prevention (S4). Built beside detection rather than inside it: the two share an
  // organization and little else, and a prevention action is its own record with its own
  // lifetime — a block outlives the alert that led to it. The audit trail is passed so every
  // proposal, approval, refusal and lift lands on the organization's evidence chain.
  // The enforcement **plane** (S4's last piece): where an `ACTIVE` record is actually pushed.
  // Unset is a deployment with no plane, which is the shipped default and behaves exactly
  // as it did before the seam existed — every action still an operator's to take and undo,
  // and nothing claiming a packet was filtered when none was. Which plane this deployment
  // has (or that it has none) is said out loud once, because "the block is approved" and
  // "the block reached something that can drop a packet" are different claims.
  const enforcementPlane = planeFromEnv(process.env);
  console.log(
    enforcementPlane === null
      ? "[sentinel] enforcement plane: none configured — actions are recorded and reversible, but nothing filters packets"
      : `[sentinel] enforcement plane: ${enforcementPlane.name}`,
  );
  const enforcement = new EnforcementService(
    enforcementStore,
    audit,
    systemEnforcementIds(),
    enforcementPlane,
  );

  // The sign-in service and the directory reader are both optional, and independent:
  // a deployment can serve a login with no directories, or read directories with no
  // console login configured. Passing both is what lets the console show either.
  // Upstream sign-in: a deployment that federates a provider (Cerulean's Authentik) sets
  // the SENTINEL_UPSTREAM_* variables and the console gains a second door. Absent means the
  // console is password-only, which is a legitimate deployment and the default here.
  const upstreamConfig = upstreamConfigFromEnv(process.env);
  const upstream = upstreamConfig
    ? new UpstreamSignInService(upstreamConfig, identities, spine, {
        // The state cookie's key. Without an explicit one the attempts do not survive a
        // restart, which is survivable (a sign-in is retried) but is said out loud once.
        secret: (process.env.SENTINEL_UPSTREAM_STATE_SECRET ?? "").trim() || randomBytes(32).toString("base64url"),
        audit,
      })
    : null;
  if (upstreamConfig && !(process.env.SENTINEL_UPSTREAM_STATE_SECRET ?? "").trim()) {
    console.warn("[sentinel] SENTINEL_UPSTREAM_STATE_SECRET is unset; sealed sign-in attempts will not survive a restart.");
  }

  const console_ = new ConsoleService(
    spine,
    mfa,
    webauthn,
    oidcStore,
    scim,
    signIn,
    DEMO_SLUG,
    directories,
    threatIntel,
    detection,
    upstream,
    // The register the console renders (S2). Passed whole: the console's constructor narrows
    // it to the methods the pages use, so a browser session cannot reach `tick` and open
    // reviews for every organization in the deployment.
    accessReviews,
    // Guard's prevention (S4). Narrowed by the constructor to the methods the page uses, so a
    // browser session cannot reach `sweepExpired` and lift another organization's blocks.
    enforcement,
    // The mute (S4), also narrowed: the console can list, create and remove a window, and it
    // deliberately cannot reach the query the pipeline runs — a browser is not a sensor.
    suppressions,
  );
  const guardService = new GuardService(detection, identities, {
    token: (process.env.SENTINEL_GUARD_TOKEN ?? "").trim() || null,
    organizationSlug: (process.env.SENTINEL_GUARD_ORGANIZATION ?? "").trim() || null,
  });
  // No token, no surface at all: an ingest endpoint that exists and says "configure me" is
  // a surface somebody eventually finds a way to write to.
  const guard = guardService.enabled() ? guardService : null;

  // The listener on the network side (S3): the part that makes Guard something you can
  // point at a network rather than a library something else has to feed. Two decisions are
  // worth reading here. It is fed through `guardService.ingest` — the same call a relay's
  // POST makes, with this deployment's own token — so there is one door into detection and
  // the listener is not a second, weaker one; and its tenant is the configured one, because
  // a syslog frame has nowhere to put an organization slug (`guardSyslogConfigFromEnv`
  // refuses to start without it). Only mounted alongside the ingest surface: a listener on
  // a deployment that does not accept telemetry is a socket that wastes its input.
  let syslog: GuardSyslogHandle | null = null;
  if (guard !== null) {
    const syslogConfig = guardSyslogConfigFromEnv(process.env);
    if (syslogConfig !== null) {
      syslog = await startGuardSyslog(syslogConfig, {
        sink: {
          accept: async (payload, at) => {
            const result = await guardService.ingest({
              authorization: `Bearer ${process.env.SENTINEL_GUARD_TOKEN ?? ""}`,
              organization: syslogConfig.organizationSlug,
              payload,
              at,
            });
            return result.ok ? { ok: true } : { ok: false, error: result.error };
          },
        },
        log: (message) => console.warn(`[sentinel] syslog: ${message}`),
      });
    }
  }

  const { actor, session, totp } = await bootstrap(spine, identities, mfa);

  /**
   * The console password, from the environment.
   *
   * Written only when there is none, so an operator who set a password here and then
   * changed it in the console does not have it silently reverted on the next restart.
   * `SENTINEL_ADMIN_PASSWORD_FORCE=1` is the deliberate override for the case where
   * the password is genuinely lost and the console is the only way back in.
   *
   * The value itself is never logged — the line below names the account and says which
   * of the three states this is, and that is all a log may carry.
   */
  async function applyConfiguredPassword(): Promise<void> {
    const wanted = (process.env.SENTINEL_ADMIN_PASSWORD ?? "").trim();
    const existing = await credentials.findForIdentity(actor.organizationId, actor.id);
    if (!wanted) {
      if (!existing) {
        console.log(
          `[sentinel] no console password is set for ${DEMO_ADMIN}, so ${issuer}${CONSOLE_PATHS.signIn} has nothing to check. ` +
            `Set SENTINEL_ADMIN_PASSWORD to enable it.`,
        );
      }
      return;
    }
    const force = (process.env.SENTINEL_ADMIN_PASSWORD_FORCE ?? "") === "1";
    if (existing && !force) {
      console.log(
        `[sentinel] ${DEMO_ADMIN} already has a console password, so SENTINEL_ADMIN_PASSWORD was not applied. ` +
          `Set SENTINEL_ADMIN_PASSWORD_FORCE=1 to overwrite it.`,
      );
      return;
    }
    await credentials.replace(actor.organizationId, actor.id, await hashPassword(wanted));
    console.log(`[sentinel] console password ${existing ? "overwritten" : "set"} for ${DEMO_ADMIN}.`);
  }

  await applyConfiguredPassword();
  const client = await demoClient(oidc, actor);
  const provider = await demoProvider(saml, actor);
  const tixClient = await productClient(oidc, actor, "OnTrak Tix", (process.env.SENTINEL_TIX_CALLBACK ?? "").trim());
  const trainingClient = await productClient(
    oidc,
    actor,
    "OnTrak IT Support Training",
    (process.env.SENTINEL_TRAINING_CALLBACK ?? "").trim(),
  );

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

  const { url } = await startOidcServer(oidc, {
    host,
    port,
    saml,
    console: console_,
    scim,
    guard,
    assets: themeAssets(),
  });

  console.log(`[sentinel] OIDC provider listening on ${url} (issuer ${issuer})`);
  // Scheduled attestation: off unless a deployment asks for it, because a tick opens
  // reviews in every organization here and a product that did that uninvited on first
  // boot would be writing attestations nobody asked for. The handle is deliberately not
  // kept: the timer is `unref`'d, so it never holds the process open, and a deployment
  // that restarts simply loses the next tick rather than a partially-opened review.
  const reviewIntervalMs = accessReviewIntervalMs(process.env);
  if (reviewIntervalMs === null) {
    console.log(
      "[sentinel] access reviews: scheduled attestation is off (set SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES to turn it on)",
    );
  } else {
    startAccessReviewScheduler(accessReviews, {
      intervalMs: reviewIntervalMs,
      log: (message) => console.log(`[sentinel] access reviews: ${message}`),
    });
  }
  // The expiry sweep (S4). On by default, the opposite of scheduled attestation: the
  // alternative to running it is a block that outlives the lifetime it was applied with,
  // which is the outage a TTL exists to bound. `SENTINEL_ENFORCEMENT_SWEEP_INTERVAL_MINUTES=0`
  // turns it off for a deployment that drives the sweep itself; an action with no deadline is
  // never touched by it either way.
  const sweepIntervalMs = enforcementSweepIntervalMs(process.env);
  if (sweepIntervalMs === null) {
    console.log(
      "[sentinel] enforcement: the expiry sweep is off (SENTINEL_ENFORCEMENT_SWEEP_INTERVAL_MINUTES is 0)",
    );
  } else {
    startEnforcementScheduler(enforcement, {
      intervalMs: sweepIntervalMs,
      log: (message) => console.log(`[sentinel] enforcement: ${message}`),
    });
  }
  console.log(
    `[sentinel] storage: ${durable ? "PostgreSQL — clients, codes and tokens are persisted" : "in-memory — a restart forgets everything"}`,
  );
  console.log(`[sentinel] discovery: ${url}/.well-known/openid-configuration`);
  console.log(`[sentinel] jwks:      ${url}/.well-known/jwks.json`);
  console.log(`[sentinel] health:    ${url}${HEALTH_PATH} (the family portal's status light)`);
  console.log(`[sentinel] SAML metadata: ${url}${SAML_PATHS.metadata}`);
  console.log(`[sentinel] SAML SSO:      ${url}${SAML_PATHS.sso}`);
  console.log(`[sentinel] console: ${url}${CONSOLE_PATHS.home} (WebAuthn RP ID ${webAuthnRpId}, origin ${webAuthnOrigin})`);
  console.log(`[sentinel] sign in: ${url}${CONSOLE_PATHS.signIn} (or the bare host ${url}/, which redirects here)`);
  // The provider door, said out loud at startup. Every part of it is a deployment's to get
  // wrong and none of it is visible in a browser until somebody tries to sign in — and the
  // two ways it is half-configured below are the ones that fail *after* the provider has
  // already been asked, which reads to the person as a password problem. The redirect is
  // included because it is the one address a sign-in can finish on: a console reached by any
  // other name bounces the browser here first rather than sealing an attempt it will never
  // see again.
  console.log(
    upstreamConfig
      ? `[sentinel] console SSO: ${upstreamConfig.label} through ${upstreamConfig.issuer} (client ${upstreamConfig.clientId}), returning to ${upstreamConfig.redirectUri}`
      : `[sentinel] console SSO: none configured, so the console signs in with its own passwords`,
  );
  if (upstreamConfig && !upstreamConfig.defaultOrganizationSlug) {
    console.warn("[sentinel] SENTINEL_UPSTREAM_ORGANIZATION is unset, so SSO sign-in has no organization to sign into and will refuse every attempt.");
  }
  if (upstreamConfig && !upstreamConfig.adminGroup) {
    console.warn("[sentinel] SENTINEL_UPSTREAM_ADMIN_GROUP is unset, so every SSO identity arrives as an AGENT.");
  }
  console.log(`[sentinel] theme:   ${url}${CONSOLE_ASSET_PATHS.themeCss} · ${url}${CONSOLE_ASSET_PATHS.themeJs}`);
  console.log(`[sentinel] SCIM:      ${url}${SCIM_PATHS.users} (config: ${url}${SCIM_PATHS.serviceProviderConfig})`);
  console.log(
    guard
      ? `[sentinel] Guard ingest: POST ${url}${GUARD_PATHS.events} (rulebook: GET ${url}${GUARD_PATHS.rules})`
      : `[sentinel] Guard ingest: off (set SENTINEL_GUARD_TOKEN to accept telemetry)`,
  );
  console.log(
    syslog === null
      ? `[sentinel] Guard syslog: off (set SENTINEL_GUARD_SYSLOG_PORT and SENTINEL_GUARD_ORGANIZATION to listen)`
      : `[sentinel] Guard syslog: ${syslog.config.transport} on ${syslog.config.host}:${syslog.config.port} as “${syslog.config.organizationSlug}”`,
  );
  // Deliberately no token is minted or printed here: a provisioning credential belongs
  // to a person acting in the console (`${CONSOLE_PATHS.provisioning}`), is shown once,
  // and never reaches a log or a terminal scrollback.
  console.log(`[sentinel] provision: mint a connector token in the console at ${url}${CONSOLE_PATHS.provisioning}`);
  console.log(`[sentinel] demo client: ${client.clientId}`);
  if (tixClient) {
    console.log(`[sentinel] OnTrak Tix client: ${tixClient.clientId} → ${process.env.SENTINEL_TIX_CALLBACK}`);
  }
  if (trainingClient) {
    console.log(
      `[sentinel] training client: ${trainingClient.clientId} → ${process.env.SENTINEL_TRAINING_CALLBACK}`,
    );
  }
  console.log(`[sentinel] demo service provider: ${provider.entityId} → ${provider.acsUrls.join(", ")}`);
  if (totp) {
    console.log(`[sentinel] enrolled a TOTP factor for ${DEMO_ADMIN} — the default policy requires one:`);
    console.log(`  otpauth: ${totp.uri}`);
    console.log(`  secret:  ${formatTotpSecret(totp.secret)}`);
  } else {
    console.log(`[sentinel] ${DEMO_ADMIN} already has a confirmed TOTP factor; the session policy is satisfied.`);
  }
  console.log("");
  // Its own line, with a stable prefix, because this is the one fact a script
  // driving the provider has to get hold of and scraping a curl example to find it
  // would break the first time the example is reworded.
  console.log(`[sentinel] demo session: ${session.id}`);
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
