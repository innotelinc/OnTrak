/**
 * OnTrak Sentinel S1 tests: signing-key rotation.
 *
 * A rotation is not a swap, it is an overlap, and the overlap is the whole feature.
 * For as long as a token signed by the old key is valid, the new key has to be
 * *published* before it can be *used* — otherwise the switch is a step that
 * invalidates everything in flight, which is exactly why rotations get postponed
 * until somebody has to do one in a hurry.
 *
 * Each test pins one half of that, in the order the two halves happen:
 *
 *  1. both keys are published (the JWKS and the SAML metadata), so a relying party
 *     can learn the new one before anything depends on its having done so;
 *  2. a token or assertion signed by the retired key still verifies afterwards, so
 *     the switch signs nobody out;
 *  3. the retired key can genuinely be retired — once it is dropped, what it signed
 *     stops verifying, so the window is a window and not a permanent second key;
 *  4. the half-finished configurations that would start and then quietly misbehave
 *     throw instead, because a provider that reveals a key mistake at boot reveals
 *     it in production.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256Hex } from "../src/lib/hash";
import type { HashFn } from "../src/lib/audit-chain";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import {
  activeKey,
  generateSigningKey,
  jwks,
  keyForKid,
  loadSigningKeys,
  oneKey,
  privateKeyToPem,
  SIGNING_KEY_ENV,
  signJwt,
  verifyJwt,
  type SigningKey,
  type SigningKeys,
} from "../src/lib/oidc-keys";
import { codeChallengeFor } from "../src/lib/oidc-rules";
import { MemoryOidcStore, OidcService, type OidcIds } from "../src/lib/oidc-service";
import { signingKeyMaterial, verifySamlAssertion } from "../src/lib/saml-sign";
import { MemorySamlStore, SamlService, type SamlIds } from "../src/lib/saml-service";

const sha256: HashFn = sha256Hex;
const ISSUER = "https://identity.acme.test";
const IDP = ISSUER;
const ENTITY_ID = "https://tix.acme.test/saml";
const ACS = "https://tix.acme.test/saml/acs";
const VERIFIER = "3lR6kQz1vB9wS2pJ8nH4tY7cM0xG5dF1aK9eU2rT6bN8sW";

/** The key that signed everything before the rotation, and the one that signs after. */
const OLD: SigningKey = generateSigningKey("sentinel-2026-08");
const NEW: SigningKey = generateSigningKey("sentinel-2026-09");

/** What a provider publishes while a rotation is half-finished: new key first. */
const ROTATED: SigningKeys = [NEW, OLD];

const OLD_PEM = privateKeyToPem(OLD);
const NEW_PEM = privateKeyToPem(NEW);

/** The key a token's own header says signed it — what a client would read. */
function kidOf(token: string): string {
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as { kid?: string };
  return header.kid ?? "";
}

let seq = 0;

/**
 * The instant every harness starts at, and the clock its fixtures must use.
 *
 * Frozen, because an AuthnRequest older than five minutes is refused — a fixture that
 * stamped itself with the real clock while the service held this one would be rejected
 * for being stale, and the failure would look like a signing problem.
 */
const FROZEN_NOW_MS = Date.parse("2026-09-30T09:00:00.000Z");
const FROZEN_NOW_ISO = new Date(FROZEN_NOW_MS).toISOString();

function runId(scope: string) {
  let n = 0;
  return {
    id: () => `${scope}-id-${++n}`,
    now: () => FROZEN_NOW_ISO,
    nowMs: () => FROZEN_NOW_MS,
  };
}

interface Provider {
  oidc: OidcService;
  spine: IdentityService;
  identities: MemoryIdentityStore;
  store: MemoryOidcStore;
  audit: OrganizationAuditLog;
  clientId: string;
  sessionId: string;
  redirectUri: string;
}

/**
 * A provider holding `keys`, with a signed-in admin and a client registered against
 * it. The store and the spine are returned so a *second* service can be built over
 * the same deployment — which is how a rotation is actually performed: the process
 * is replaced, the data is not.
 */
async function provider(keys: SigningKeys): Promise<Provider> {
  const scope = `k${++seq}`;
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  const spine = new IdentityService(identities, audit, runId(scope));

  const created = await spine.bootstrapOrganization(
    "founder-1",
    { name: "Acme MSP", slug: `acme-${scope}-${Date.now()}` },
    { identifier: "admin@acme.test", displayName: "Ada Admin" },
  );
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  const actor: IdentityActor = {
    id: created.value.admin.id,
    organizationId: created.value.organization.id,
    role: "ADMIN",
  };

  await spine.setMfaEnrolled(actor, actor.id, true);
  const session = await spine.issueSession(actor.organizationId, actor.id);
  assert.equal(session.ok, true);
  if (!session.ok) throw new Error("unreachable");

  const oidcIds: OidcIds = {
    ...runId(scope),
    clientId: () => `${scope}-client`,
    code: () => `${scope}-code-${Math.random().toString(36).slice(2)}`,
    token: () => `${scope}-token-${Math.random().toString(36).slice(2)}`,
  };
  const store = new MemoryOidcStore();
  const oidc = new OidcService(store, identities, spine, { issuer: ISSUER, keys }, audit, oidcIds, sha256);

  const redirectUri = "https://tix.acme.test/api/sso/callback";
  const client = await oidc.registerClient(actor, {
    name: "OnTrak Tix",
    redirectUris: [redirectUri],
    scopes: ["openid", "profile", "email", "roles"],
  });
  assert.equal(client.ok, true, client.ok ? "" : client.error);
  if (!client.ok) throw new Error("unreachable");

  return { oidc, spine, identities, store, audit, clientId: client.value.clientId, sessionId: session.value.id, redirectUri };
}

/** Run a whole authorization-code flow and hand back the ID token it minted. */
async function issueIdToken(p: Provider, oidc: OidcService = p.oidc): Promise<string> {
  const granted = await oidc.authorize({
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    responseType: "code",
    scope: "openid profile email roles",
    state: "state-1",
    nonce: "nonce-1",
    codeChallenge: codeChallengeFor(VERIFIER, sha256),
    codeChallengeMethod: "S256",
    sessionId: p.sessionId,
  });
  assert.equal(granted.ok, true, granted.ok ? "" : granted.error);
  if (!granted.ok) throw new Error("unreachable");

  const code = new URL(granted.redirectTo).searchParams.get("code");
  assert.ok(code, "the code came back on the redirect");

  const token = await oidc.token({
    grantType: "authorization_code",
    clientId: p.clientId,
    code,
    redirectUri: p.redirectUri,
    codeVerifier: VERIFIER,
  });
  assert.equal(token.ok, true, token.ok ? "" : token.error);
  if (!token.ok) throw new Error("unreachable");
  return token.idToken;
}

/* -------------------------------------------------------------------------- */
/*  What the deployment says                                                 */
/* -------------------------------------------------------------------------- */

test("an unconfigured provider signs with an ephemeral key, and says so", () => {
  const loaded = loadSigningKeys({});

  assert.equal(loaded.ephemeral, true);
  assert.equal(loaded.keys.length, 1);
  // Correct for poking at the endpoints, catastrophic in a deployment — which is why
  // the flag exists rather than the caller inspecting the environment again.
  assert.equal(loaded.keys[0].kid, "sentinel-s1");
});

test("the active key comes from the value a deployment hands over, or from the file it names", () => {
  const fromValue = loadSigningKeys({ [SIGNING_KEY_ENV.key]: NEW_PEM, [SIGNING_KEY_ENV.kid]: NEW.kid });
  assert.equal(fromValue.ephemeral, false);
  assert.equal(fromValue.keys.length, 1);
  assert.equal(fromValue.keys[0].kid, NEW.kid);

  // A container stack mounts the key rather than passing it, so the file path has to
  // load the same key the value does.
  const read: string[] = [];
  const fromFile = loadSigningKeys(
    { [SIGNING_KEY_ENV.keyFile]: "/run/sentinel/signing-key.pem", [SIGNING_KEY_ENV.kid]: NEW.kid },
    (path) => {
      read.push(path);
      return NEW_PEM;
    },
  );
  assert.deepEqual(read, ["/run/sentinel/signing-key.pem"]);
  assert.equal(fromFile.ephemeral, false);
  assert.equal(fromFile.keys[0].kid, NEW.kid);
});

test("a retired key is published alongside the active one, never in place of it", () => {
  const loaded = loadSigningKeys({
    [SIGNING_KEY_ENV.key]: NEW_PEM,
    [SIGNING_KEY_ENV.kid]: NEW.kid,
    [SIGNING_KEY_ENV.previousKey]: OLD_PEM,
    [SIGNING_KEY_ENV.previousKid]: OLD.kid,
  });

  assert.equal(loaded.ephemeral, false);
  assert.equal(loaded.keys.length, 2);
  // Active first: the order is the contract, not a convenience.
  assert.equal(activeKey(loaded.keys).kid, NEW.kid);
  assert.equal(loaded.keys[1].kid, OLD.kid);
  // The retired key's public half must be the *same key*, not a re-generated one —
  // otherwise the tokens it signed verify against nothing.
  assert.equal(
    loaded.keys[1].publicKey.export({ type: "spki", format: "pem" }).toString(),
    OLD.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
});

test("a retired key with no `kid` is refused rather than published under the active name", () => {
  // Without a name it would be published as the default `kid`, colliding with the
  // active key — a JWKS carrying one `kid` twice, which leaves a client unable to
  // tell which of the two to verify with.
  assert.throws(
    () =>
      loadSigningKeys({
        [SIGNING_KEY_ENV.key]: NEW_PEM,
        [SIGNING_KEY_ENV.kid]: NEW.kid,
        [SIGNING_KEY_ENV.previousKey]: OLD_PEM,
      }),
    /SENTINEL_SIGNING_PREVIOUS_KID is not/,
  );
});

test("naming the active key as its own predecessor is refused", () => {
  assert.throws(
    () =>
      loadSigningKeys({
        [SIGNING_KEY_ENV.key]: NEW_PEM,
        [SIGNING_KEY_ENV.kid]: NEW.kid,
        [SIGNING_KEY_ENV.previousKey]: NEW_PEM,
        [SIGNING_KEY_ENV.previousKid]: NEW.kid,
      }),
    /which is also the active key's/,
  );
});

test("an unreadable key file throws instead of falling through to an ephemeral key", () => {
  const unreadable = () => {
    throw new Error("ENOENT: no such file or directory");
  };

  // The failure this prevents: a volume that did not mount turns into a provider
  // signing with a key nobody agreed on, and it surfaces as clients rejecting
  // tokens rather than as a deployment error.
  assert.throws(
    () => loadSigningKeys({ [SIGNING_KEY_ENV.keyFile]: "/run/sentinel/signing-key.pem" }, unreadable),
    /could not be read/,
  );
  // The same for the retired key: silently dropping it would end a rotation window
  // that the deployment believes is still open.
  assert.throws(
    () =>
      loadSigningKeys(
        {
          [SIGNING_KEY_ENV.key]: NEW_PEM,
          [SIGNING_KEY_ENV.previousKeyFile]: "/run/sentinel/old-key.pem",
          [SIGNING_KEY_ENV.previousKid]: OLD.kid,
        },
        unreadable,
      ),
    /could not be read/,
  );
});

/* -------------------------------------------------------------------------- */
/*  What a relying party can see                                             */
/* -------------------------------------------------------------------------- */

test("the JWKS publishes every key, so a client can learn the new one before it signs", () => {
  const set = jwks(...ROTATED);

  assert.equal(set.keys.length, 2);
  assert.deepEqual(
    set.keys.map((key) => key.kid),
    [NEW.kid, OLD.kid],
  );
  // The private halves must not be in a document anybody can fetch — for the retired
  // key as much as the active one, since for as long as it is published it is still
  // material that can mint identity if it leaks.
  for (const key of set.keys) {
    for (const secretOf of ["d", "p", "q", "dp", "dq", "qi"]) {
      assert.equal(secretOf in key, false, `the JWK Set leaked “${secretOf}”`);
    }
  }
});

test("a token signed before the rotation still verifies after it", async () => {
  const p = await provider(oneKey(OLD));
  const before = await issueIdToken(p);
  assert.equal(kidOf(before), OLD.kid, "the retired key is what signed it");

  // A token issued a minute before the switch, checked against the set the provider
  // publishes a minute after it. This is the property the overlap exists for.
  const verified = verifyJwt(before, ROTATED, { issuer: ISSUER, audience: p.clientId });
  assert.equal(verified.ok, true, verified.ok ? "" : verified.reason);
});

test("dropping the retired key closes the window", async () => {
  const p = await provider(oneKey(OLD));
  const before = await issueIdToken(p);

  assert.equal(verifyJwt(before, ROTATED, { issuer: ISSUER }).ok, true);
  // Once the old key is gone the token is refused, so a rotation genuinely ends
  // rather than leaving a key published forever.
  const after = verifyJwt(before, oneKey(NEW), { issuer: ISSUER });
  assert.equal(after.ok, false);
  assert.match(after.ok === false ? after.reason : "", /does not have/);
});

test("a token naming a key this provider never published is refused", () => {
  const stranger = generateSigningKey("sentinel-somebody-else");
  const forged = signJwt({ iss: ISSUER, sub: "somebody" }, stranger);

  const result = verifyJwt(forged, ROTATED, { issuer: ISSUER });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /does not have/);
});

test("a caller holding one key still refuses a token another key signed", () => {
  const token = signJwt({ iss: ISSUER, sub: "somebody" }, OLD);

  // The single-key form is a relying party that pinned one key: it must keep
  // refusing anything else, so the set support cannot have loosened it.
  assert.equal(verifyJwt(token, NEW, { issuer: ISSUER }).ok, false);
  assert.equal(verifyJwt(token, OLD, { issuer: ISSUER }).ok, true);
});

test("a `kid` resolves to the key that holds it, and to nothing else", () => {
  assert.equal(keyForKid(ROTATED, OLD.kid)?.kid, OLD.kid);
  assert.equal(keyForKid(ROTATED, NEW.kid)?.kid, NEW.kid);
  assert.equal(keyForKid(ROTATED, "not-a-key-we-have"), null);
});

/* -------------------------------------------------------------------------- */
/*  Through the provider                                                      */
/* -------------------------------------------------------------------------- */

test("the provider signs with the active key and keeps verifying the retired one", async () => {
  const p = await provider(oneKey(OLD));
  const before = await issueIdToken(p);

  // The rotation: same deployment, same database, same session — a new key in front
  // of the old one. Nothing else about the process changes.
  const rotated = new OidcService(p.store, p.identities, p.spine, { issuer: ISSUER, keys: ROTATED }, p.audit, {
    id: () => `k${++seq}-rot-${Math.random().toString(36).slice(2)}`,
    clientId: () => `k${seq}-rot-client`,
    code: () => `k${seq}-rot-code-${Math.random().toString(36).slice(2)}`,
    token: () => `k${seq}-rot-token-${Math.random().toString(36).slice(2)}`,
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  }, sha256);

  // A sign-in after the rotation is signed with the *new* key: publishing a key is
  // not the same as using it, and only the active one may ever sign again.
  const after = await issueIdToken(p, rotated);
  assert.equal(kidOf(after), NEW.kid, "the active key is what signs now");

  // And the relying party's cached JWKS is still able to verify the older token,
  // because the retired key is still in the published set.
  const published = rotated.jwks();
  assert.deepEqual(
    published.keys.map((key) => key.kid),
    [NEW.kid, OLD.kid],
  );
  assert.equal(verifyJwt(before, ROTATED, { issuer: ISSUER, audience: p.clientId }).ok, true);
});

/* -------------------------------------------------------------------------- */
/*  The other protocol — one key pair, so one rotation                        */
/* -------------------------------------------------------------------------- */

/** A provider with one registered service provider and a live session. */
async function samlProvider(keys: SigningKeys) {
  const scope = `s${++seq}`;
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  const spine = new IdentityService(identities, audit, runId(scope));

  const created = await spine.bootstrapOrganization(
    "founder-1",
    { name: "Acme MSP", slug: `saml-${scope}-${Date.now()}` },
    { identifier: "admin@acme.test", displayName: "Ada Admin" },
  );
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };

  await spine.setMfaEnrolled(actor, actor.id, true);
  const session = await spine.issueSession(actor.organizationId, actor.id);
  assert.equal(session.ok, true);
  if (!session.ok) throw new Error("unreachable");

  const samlIds: SamlIds = runId(scope);
  const saml = new SamlService(new MemorySamlStore(), spine, { entityId: IDP, keys }, audit, samlIds, sha256);
  const registered = await saml.registerServiceProvider(actor, { name: "OnTrak Tix", entityId: ENTITY_ID, acsUrls: [ACS] });
  assert.equal(registered.ok, true, registered.ok ? "" : registered.error);

  return { saml, sessionId: session.value.id };
}

function authnRequestXml(): string {
  const at = FROZEN_NOW_ISO;
  return (
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
    ` ID="_request-1" Version="2.0" IssueInstant="${at}" Destination="${IDP}/saml/sso"` +
    ` AssertionConsumerServiceURL="${ACS}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">` +
    `<saml:Issuer>${ENTITY_ID}</saml:Issuer>` +
    `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"/>` +
    `</samlp:AuthnRequest>`
  );
}

/** The assertions inside a signed response, pulled out for verification. */
function assertionOf(responseXml: string): string {
  const found = /<saml:Assertion[\s\S]*?<\/saml:Assertion>/.exec(responseXml);
  assert.ok(found, "the response carries an assertion");
  return found[0];
}

function responseXmlOf(html: string): string {
  const encoded = /name="SAMLResponse" value="([^"]+)"/.exec(html);
  assert.ok(encoded, "the page carries a SAMLResponse");
  return Buffer.from(encoded[1], "base64").toString("utf8");
}

test("SAML metadata advertises every published key, so an SP can verify one it has not been signed with", async () => {
  const { saml } = await samlProvider(ROTATED);
  const metadata = saml.metadata();

  // One KeyDescriptor per key. An SP re-reads metadata on its own schedule, so the
  // new key has to be visible here *before* the IdP signs with it — advertising only
  // the active key would break every assertion during the SP's cache window, and the
  // SP would have no way to know it needed to look again.
  assert.equal((metadata.match(/<md:KeyDescriptor use="signing">/g) ?? []).length, 2);
  for (const key of [NEW, OLD]) {
    const material = signingKeyMaterial(key);
    assert.ok(metadata.includes(`<ds:KeyName>${key.kid}</ds:KeyName>`), `${key.kid} is named`);
    assert.ok(metadata.includes(`<ds:Modulus>${material.modulusB64}</ds:Modulus>`), `${key.kid}'s modulus is published`);
  }
});

test("an assertion is signed with the active key, and the retired key will not verify it", async () => {
  const { saml, sessionId } = await samlProvider(ROTATED);
  const result = await saml.sso({
    samlRequest: Buffer.from(authnRequestXml(), "utf8").toString("base64"),
    binding: "post",
    sessionId,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) throw new Error("unreachable");

  const assertion = assertionOf(responseXmlOf(result.html));
  // The signature block names the key, so an SP reading the assertion learns which of
  // the published keys to check it with — which is what makes two published keys safe.
  assert.ok(
    assertion.includes(`<ds:KeyInfo><ds:KeyName>${NEW.kid}</ds:KeyName></ds:KeyInfo>`),
    "the signature names the active key",
  );

  const verified = verifySamlAssertion(assertion, NEW, { hash: sha256, expectedIssuer: IDP, expectedAudience: ENTITY_ID });
  assert.equal(verified.ok, true, verified.ok ? "" : verified.reason);
  // The retired key is published for verification of what it *already* signed; it
  // must not be able to verify what signed after the switch.
  assert.equal(verifySamlAssertion(assertion, OLD, { hash: sha256 }).ok, false);
});
