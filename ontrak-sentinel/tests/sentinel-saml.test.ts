/**
 * OnTrak Sentinel S1 tests: SAML 2.0 SSO.
 *
 * A SAML assertion *is* the credential — there is no code, no PKCE and no second
 * exchange — so each test follows one of the ways a wrongly-issued assertion
 * becomes somebody else's session:
 *
 *  1. an assertion posted to an ACS URL the service provider did not register;
 *  2. an assertion for a session that had already been revoked or timed out;
 *  3. an AuthnRequest replayed a day later;
 *  4. an assertion whose signature does not actually cover what it says.
 *
 * The success path is asserted down to the signature and the audience, because an
 * assertion that "works" but is signed over the wrong bytes is worse than one that
 * fails.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";

import { sha256Hex } from "../src/lib/hash";
import type { HashFn } from "../src/lib/audit-chain";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { generateSigningKey, type SigningKey } from "../src/lib/oidc-keys";
import { routeSaml, SAML_METADATA_CONTENT_TYPE } from "../src/lib/saml-http";
import { SAML_NAME_ID_FORMATS, SAML_PATHS, validateAuthnRequest, validateServiceProvider } from "../src/lib/saml-rules";
import { signingKeyMaterial, verifySamlAssertion } from "../src/lib/saml-sign";
import { MemorySamlStore, SamlService, type SamlIds } from "../src/lib/saml-service";
import type { HttpRequest } from "../src/lib/oidc-http";

const sha256: HashFn = sha256Hex;
const IDP = "https://identity.acme.test";
const ENTITY_ID = "https://tix.acme.test/saml";
const ACS = "https://tix.acme.test/saml/acs";
const KEY: SigningKey = generateSigningKey();

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  let clock = Date.parse("2026-09-30T12:00:00.000Z");
  let n = 0;
  const scope = `s${++harnessSeq}`;
  const ids = {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const spine = new IdentityService(identities, audit, ids);
  const samlIds: SamlIds = {
    id: () => `${scope}-sp-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  return {
    spine,
    audit,
    ids,
    saml: new SamlService(new MemorySamlStore(), spine, { entityId: IDP, keys: KEY }, audit, samlIds, sha256),
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
    nowMs: () => clock,
  };
}

/** A bootstrapped organization, its admin, and a live (MFA-enrolled) session. */
async function ready() {
  const h = harness();
  const created = await h.spine.bootstrapOrganization(
    "founder-1",
    { name: "Acme MSP", slug: `acme-${harnessSeq}-${Date.now()}` },
    { identifier: "admin@acme.test", displayName: "Ada Admin" },
  );
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };

  await h.spine.setMfaEnrolled(actor, actor.id, true);
  const session = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.equal(session.ok, true);
  if (!session.ok) throw new Error("unreachable");

  const provider = await h.saml.registerServiceProvider(actor, { name: "OnTrak Tix", entityId: ENTITY_ID, acsUrls: [ACS] });
  assert.equal(provider.ok, true, provider.ok ? "" : provider.error);
  if (!provider.ok) throw new Error("unreachable");

  return { ...h, actor, orgId: created.value.organization.id, session: session.value, provider: provider.value };
}

/** An AuthnRequest, in the two bindings the IdP serves. */
const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const PERSISTENT_FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

function authnRequestXml(overrides: Record<string, string> = {}): string {
  const { NameIDPolicyFormat = EMAIL_FORMAT, ...attributes } = overrides;
  const at = overrides.IssueInstant ?? new Date(Date.parse("2026-09-30T12:00:00.000Z")).toISOString();
  const rendered = Object.entries({
    ID: "_request-1",
    Version: "2.0",
    IssueInstant: at,
    Destination: `${IDP}${SAML_PATHS.sso}`,
    AssertionConsumerServiceURL: ACS,
    ProtocolBinding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
    ...attributes,
  })
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");
  return (
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"${rendered}>` +
    `<saml:Issuer>${overrides.Issuer ?? ENTITY_ID}</saml:Issuer>` +
    `<samlp:NameIDPolicy Format="${NameIDPolicyFormat}"/>` +
    `</samlp:AuthnRequest>`
  );
}

function redirectBinding(xml: string): string {
  return deflateRawSync(Buffer.from(xml, "utf8")).toString("base64");
}

function postBinding(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
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

/* -------------------------------------------------------------------------- */
/*  Registering a service provider                                            */
/* -------------------------------------------------------------------------- */

test("an ACS URL is only registrable over https, or http on loopback", () => {
  const base = { name: "Tix", entityId: ENTITY_ID };
  assert.deepEqual(validateServiceProvider({ ...base, acsUrls: [ACS] }), []);

  // Plain http in general is a signed assertion sent in the clear.
  assert.equal(validateServiceProvider({ ...base, acsUrls: ["http://tix.acme.test/saml/acs"] }).length, 1);
  // ...but a developer's local SP can be tested, the same exception OIDC makes.
  assert.deepEqual(validateServiceProvider({ ...base, acsUrls: ["http://localhost:3000/saml/acs"] }), []);

  // A fragment is never sent to the server, so a form posted to such a URL lands
  // on the wrong page.
  assert.equal(validateServiceProvider({ ...base, acsUrls: [`${ACS}#x`] }).length, 1);
  assert.equal(validateServiceProvider({ ...base, acsUrls: [] }).length, 1);
  assert.equal(validateServiceProvider({ ...base, acsUrls: [ACS, ACS] }).length, 1);
  assert.equal(validateServiceProvider({ name: "", entityId: "", acsUrls: [ACS] }).length, 2);
});

test("registering a service provider is administrator work, and is audited", async () => {
  const r = await ready();

  const denied = await r.saml.registerServiceProvider({ ...r.actor, role: "AGENT" }, {
    name: "Sneaky",
    entityId: "https://sneaky.test",
    acsUrls: [ACS],
  });
  assert.equal(denied.ok, false);

  // An entity id is globally unique: it is the only thing in an AuthnRequest that
  // names a tenant, so it cannot resolve to two.
  const clash = await r.saml.registerServiceProvider(r.actor, { name: "Other", entityId: ENTITY_ID, acsUrls: [ACS] });
  assert.equal(clash.ok, false);

  const actions = r.audit.trail(r.orgId).map((event) => event.action);
  assert.ok(actions.includes("saml.sp.register"));

  const listed = await r.saml.listServiceProviders(r.actor);
  assert.equal(listed.ok, true);
  assert.equal(listed.ok && listed.value.length, 1);
  assert.equal(listed.ok && listed.value[0].nameIdFormat, "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress");
});

/* -------------------------------------------------------------------------- */
/*  Metadata                                                                  */
/* -------------------------------------------------------------------------- */

test("the metadata document advertises what is served, and nothing else", () => {
  const metadata = harness().saml.metadata();
  const material = signingKeyMaterial(KEY);

  assert.match(metadata, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.ok(metadata.includes(`entityID="${IDP}"`));
  // Both bindings, on the same endpoint.
  assert.equal((metadata.match(/<md:SingleSignOnService/g) ?? []).length, 2);
  for (const format of SAML_NAME_ID_FORMATS) assert.ok(metadata.includes(`<md:NameIDFormat>${format}</md:NameIDFormat>`));
  // The public key a service provider checks the signature with, re-encoded from
  // the JWKS rather than re-derived, so it cannot drift from the key that signs.
  assert.ok(metadata.includes(`<ds:Modulus>${material.modulusB64}</ds:Modulus>`));
  assert.ok(metadata.includes(`<ds:Exponent>${material.exponentB64}</ds:Exponent>`));
  assert.ok(metadata.includes(`<ds:KeyName>${KEY.kid}</ds:KeyName>`));
  // No artifact resolution and no attribute query: this provider answers
  // sign-ins, and a document that claims more is how an integrator finds out in
  // production.
  assert.equal(metadata.includes("ArtifactResolutionService"), false);
  assert.equal(metadata.includes("AttributeService"), false);
  assert.ok(metadata.includes('WantAuthnRequestsSigned="false"'));
});

/* -------------------------------------------------------------------------- */
/*  The AuthnRequest rules                                                    */
/* -------------------------------------------------------------------------- */

test("an AuthnRequest is checked against the service provider that registered it", () => {
  const provider = {
    entityId: ENTITY_ID,
    organizationId: "org-1",
    name: "Tix",
    acsUrls: [ACS],
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" as const,
    createdBy: "admin-1",
    createdAt: "2026-09-30T00:00:00.000Z",
  };
  const context = { ssoUrl: `${IDP}${SAML_PATHS.sso}`, nowMs: Date.parse("2026-09-30T12:00:00.000Z") };
  const good = { issuer: ENTITY_ID, acsUrl: ACS, destination: context.ssoUrl, id: "_r1", issueInstant: "2026-09-30T12:00:00.000Z" };

  assert.equal(validateAuthnRequest(good, provider, context).ok, true);
  // An SP with one ACS URL may omit it; we fall back to the one it registered.
  assert.equal(validateAuthnRequest({ ...good, acsUrl: "" }, provider, context).ok, true);

  // The four refusals that matter.
  assert.equal(validateAuthnRequest(good, null, context).ok, false, "an unknown SP is not answered");
  assert.equal(validateAuthnRequest({ ...good, issuer: "https://elsewhere.test" }, provider, context).ok, false);
  assert.equal(validateAuthnRequest({ ...good, acsUrl: "https://evil.test/acs" }, provider, context).ok, false);
  assert.equal(validateAuthnRequest({ ...good, destination: "https://elsewhere.test/saml/sso" }, provider, context).ok, false);

  // Freshness: a captured request is not answerable tomorrow.
  assert.equal(
    validateAuthnRequest({ ...good, issueInstant: "2026-09-29T12:00:00.000Z" }, provider, context).ok,
    false,
    "an old request is refused",
  );
  assert.equal(validateAuthnRequest({ ...good, issueInstant: "not-a-time" }, provider, context).ok, false);

  const decision = validateAuthnRequest(good, provider, context);
  assert.equal(decision.ok && decision.nameIdFormat, "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress");
  assert.equal(validateAuthnRequest({ ...good, nameIdFormat: "urn:not-ours" }, provider, context).ok, false);
  // The registration decides the format; a request that asks for a different
  // known one is refused rather than quietly overruling the administrator.
  assert.equal(validateAuthnRequest({ ...good, nameIdFormat: PERSISTENT_FORMAT }, provider, context).ok, false);
});

/* -------------------------------------------------------------------------- */
/*  The assertion                                                             */
/* -------------------------------------------------------------------------- */

test("a sign-in produces a signed assertion the service provider can verify", async () => {
  const r = await ready();
  const result = await r.saml.sso({
    samlRequest: redirectBinding(authnRequestXml()),
    relayState: "/tickets",
    binding: "redirect",
    sessionId: r.session.id,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) throw new Error("unreachable");

  // The assertion travels in a form post, never a query string: it is a bearer
  // credential, and a URL ends up in a proxy log and the browser's history.
  assert.match(result.html, /<form method="post" action="https:\/\/tix\.acme\.test\/saml\/acs">/);
  assert.ok(result.html.includes('name="RelayState" value="/tickets"'));
  assert.equal(result.acsUrl, ACS);

  const xml = responseXmlOf(result.html);
  assert.ok(xml.includes(`Destination="${ACS}"`));
  assert.ok(xml.includes('InResponseTo="_request-1"'), "the id the SP chose comes back so it can match the answer");
  assert.ok(xml.includes("urn:oasis:names:tc:SAML:2.0:status:Success"));

  const assertion = assertionOf(xml);
  assert.ok(assertion.includes(`<saml:Issuer>${IDP}</saml:Issuer>`));
  assert.ok(assertion.includes(`<saml:Audience>${ENTITY_ID}</saml:Audience>`), "an assertion is only for its audience");
  assert.ok(assertion.includes(`Recipient="${ACS}"`));
  assert.ok(assertion.includes(`SessionIndex="${r.session.id}"`));
  assert.ok(assertion.includes("admin@acme.test"), "the NameID is the address the format promises");
  assert.ok(assertion.includes("<saml:AttributeValue>ADMIN</saml:AttributeValue>"));
  assert.ok(assertion.includes("<saml:AttributeValue>true</saml:AttributeValue>"), "the MFA claim rides along");

  // The signature is checked the way a service provider would check it — RSA over
  // the `SignedInfo`, then the digest recomputed from the document as it arrived.
  const verified = verifySamlAssertion(assertion, KEY, { hash: sha256, expectedIssuer: IDP, expectedAudience: ENTITY_ID });
  assert.equal(verified.ok, true, verified.ok ? "" : verified.reason);

  // An assertion for another audience is refused even though its signature is fine.
  assert.equal(verifySamlAssertion(assertion, KEY, { hash: sha256, expectedAudience: "https://elsewhere.test" }).ok, false);

  const actions = r.audit.trail(r.orgId).map((event) => event.action);
  assert.ok(actions.includes("saml.sso"));
});

test("a tampered assertion no longer verifies, even though its signature is untouched", async () => {
  const r = await ready();
  const result = await r.saml.sso({
    samlRequest: postBinding(authnRequestXml()),
    binding: "post",
    sessionId: r.session.id,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  const assertion = assertionOf(responseXmlOf(result.html));
  assert.equal(verifySamlAssertion(assertion, KEY, { hash: sha256 }).ok, true);

  // The digest covers the document itself, so editing an attribute invalidates it
  // even though `SignedInfo` — and therefore the RSA signature over it — is
  // untouched. This is the whole reason the digest is not optional.
  const tampered = assertion.replace("<saml:AttributeValue>AGENT</saml:AttributeValue>", "").replace(
    "<saml:AttributeValue>ADMIN</saml:AttributeValue>",
    "<saml:AttributeValue>AGENT</saml:AttributeValue>",
  );
  const verified = verifySamlAssertion(tampered, KEY, { hash: sha256 });
  assert.equal(verified.ok, false);
  assert.match(verified.ok === false ? verified.reason : "", /digest/);

  // And a signature cannot be lifted out of one assertion into another.
  const stolen = assertion.replace(/ID="_[^"]+"/, 'ID="_somebody-elses"');
  assert.equal(verifySamlAssertion(stolen, KEY, { hash: sha256 }).ok, false);
});

test("the display name is carried as its own attribute, and the NameID format is respected", async () => {
  const r = await ready();
  await r.saml.registerServiceProvider(r.actor, {
    name: "Persistent",
    entityId: "https://persistent.test/saml",
    acsUrls: ["https://persistent.test/saml/acs"],
    nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  });

  const result = await r.saml.sso({
    samlRequest: postBinding(
      authnRequestXml({
        Issuer: "https://persistent.test/saml",
        AssertionConsumerServiceURL: "https://persistent.test/saml/acs",
        NameIDPolicyFormat: PERSISTENT_FORMAT,
      }),
    ),
    binding: "post",
    sessionId: r.session.id,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) throw new Error("unreachable");

  const assertion = assertionOf(responseXmlOf(result.html));
  // `persistent` promises an identifier that does not change when the address
  // does, so it is the identity id, not the email.
  assert.ok(assertion.includes(`Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${r.actor.id}`));
  assert.ok(assertion.includes("<saml:AttributeValue>Ada Admin</saml:AttributeValue>"));
});

/* -------------------------------------------------------------------------- */
/*  The session behind the grant                                              */
/* -------------------------------------------------------------------------- */

test("a revoked session gets no assertion, so SSO cannot outlive sign-out", async () => {
  const r = await ready();
  const revoked = await r.spine.revokeSession(r.actor, r.session.id, "user signed out");
  assert.equal(revoked.ok, true);

  const result = await r.saml.sso({
    samlRequest: postBinding(authnRequestXml()),
    binding: "post",
    sessionId: r.session.id,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /not usable/);

  // The refusal is on the chain, because "who tried to sign in as a deleted
  // session?" is a question an incident asks.
  assert.ok(r.audit.trail(r.orgId).some((event) => event.action === "saml.sso.refuse"));
});

test("an unusable AuthnRequest is refused before anything is said about a session", async () => {
  const r = await ready();
  const result = await r.saml.sso({
    samlRequest: postBinding(authnRequestXml({ Issuer: "https://unknown.test/saml" })),
    binding: "post",
    sessionId: r.session.id,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /do not know/);
  // The refusal is recorded against the provider it *could* resolve, if any; an
  // unknown SP has no organization to record it against, and that is correct.
  assert.equal(r.audit.trail(r.orgId).some((event) => event.action === "saml.sso"), false);
});

test("no session at all is a refusal, not an anonymous assertion", async () => {
  const r = await ready();
  const result = await r.saml.sso({ samlRequest: postBinding(authnRequestXml()), binding: "post", sessionId: "" });
  assert.equal(result.ok, false);
});

/* -------------------------------------------------------------------------- */
/*  The HTTP surface                                                          */
/* -------------------------------------------------------------------------- */

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "GET", url: `${IDP}${SAML_PATHS.sso}`, headers: {}, cookies: {}, ...overrides };
}

test("metadata is served as SAML metadata and is safe to cache", async () => {
  const r = await ready();
  const response = await routeSaml(request({ url: `${IDP}${SAML_PATHS.metadata}` }), r.saml);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], SAML_METADATA_CONTENT_TYPE);
  assert.match(String(response.headers["cache-control"] ?? ""), /public/);
  assert.match(response.body, /IDPSSODescriptor/);
});

test("the SSO endpoint answers the redirect binding from the query string", async () => {
  const r = await ready();
  const response = await routeSaml(
    request({
      url: `${IDP}${SAML_PATHS.sso}?SAMLRequest=${encodeURIComponent(redirectBinding(authnRequestXml()))}&RelayState=%2Finbox`,
      cookies: { sentinel_session: r.session.id },
    }),
    r.saml,
  );
  assert.equal(response.status, 200);
  assert.match(String(response.headers["content-type"] ?? ""), /text\/html/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.body, /name="SAMLResponse"/);
});

test("the SSO endpoint answers the POST binding, with the session from the header", async () => {
  const r = await ready();
  const response = await routeSaml(
    request({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-sentinel-session": r.session.id },
      body: `SAMLRequest=${encodeURIComponent(postBinding(authnRequestXml()))}`,
    }),
    r.saml,
  );
  assert.equal(response.status, 200);
  assert.match(response.body, /name="SAMLResponse"/);
});

test("a refused sign-in is a page, never a redirect to somewhere we did not register", async () => {
  const r = await ready();
  const response = await routeSaml(
    request({
      url: `${IDP}${SAML_PATHS.sso}?SAMLRequest=${encodeURIComponent(postBinding(authnRequestXml({ Issuer: "https://unknown.test/saml" })))}`,
      cookies: { sentinel_session: r.session.id },
    }),
    r.saml,
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.location, undefined);
});

test("the SAML router serves its two paths and refuses the rest", async () => {
  const r = await ready();
  assert.equal((await routeSaml(request({ url: `${IDP}/saml/other` }), r.saml)).status, 404);
  assert.equal((await routeSaml(request({ method: "DELETE", url: `${IDP}${SAML_PATHS.sso}` }), r.saml)).status, 405);
  assert.equal((await routeSaml(request({ method: "POST", url: `${IDP}${SAML_PATHS.metadata}` }), r.saml)).status, 405);
});
