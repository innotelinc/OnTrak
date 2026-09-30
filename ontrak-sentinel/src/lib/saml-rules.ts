/**
 * SAML 2.0 rules (S1): the pure half of the IdP's side of SSO.
 *
 * Sentinel speaks OIDC to the family and SAML to the enterprises that will not
 * speak anything else, so this module answers the same two questions OIDC's does
 * — *who may receive identity*, and *is this request one we may answer* — and
 * leaves every byte of transport to the service and the HTTP layer.
 *
 * Five decisions worth stating out loud, because each is a place a SAML
 * implementation usually gets to be wrong:
 *
 *  1. **The ACS URL is matched exactly, against what the service provider
 *     registered.** SAML has no PKCE and no code — the assertion *is* the
 *     credential — so the ACS URL is the only thing standing between a signed
 *     assertion and an attacker's endpoint. A prefix match, a wildcard or a
 *     trailing-slash tolerance is how an assertion gets delivered to somebody
 *     else's origin.
 *  2. **A request is not answered forever.** An `IssueInstant` older than a few
 *     minutes is refused, so a captured AuthnRequest cannot be replayed tomorrow.
 *  3. **The `InResponseTo` is carried through.** The client that sent the request
 *     is the only one whose assertion this is, and it can only check that if we
 *     echo the id it chose.
 *  4. **The assertion is signed, and the digest covers exactly the assertion as
 *     it is sent.** `assertionCanonical` is the bytes a verifier reproduces by
 *     deleting the signature from the document we emitted — no comments, no
 *     inter-element whitespace, one deterministic order. Every XML signature
 *     stands or falls on that being reproducible, so it is stated here as a
 *     function rather than left to a library's default.
 *  5. **The NameID format is the service provider's registration, not each
 *     request's wish.** A request may ask for the format its registration names
 *     (or stay quiet and get it), and asking for a different one is refused —
 *     otherwise a per-request parameter would silently overrule a decision an
 *     administrator made, and an `unspecified` NameID that is really an email is
 *     a claim several downstream tools make a false assumption about.
 *
 * Pure: no crypto, no clock, no `Buffer`. The digest and the signature are
 * injected — see `saml-sign.ts` for the RS256 half — and the time is handed in,
 * so the same decisions run in a server and in a test.
 */

/* -------------------------------------------------------------------------- */
/*  Endpoints, namespaces and limits                                          */
/* -------------------------------------------------------------------------- */

/** Where the IdP's SAML endpoints live, relative to the issuer. */
export const SAML_PATHS = {
  metadata: "/saml/metadata",
  sso: "/saml/sso",
} as const;

export const SAML_BINDINGS = {
  redirect: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
  post: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
} as const;
export type SamlBinding = keyof typeof SAML_BINDINGS;

const NS_SAML = "urn:oasis:names:tc:SAML:2.0:assertion";
const NS_SAMLP = "urn:oasis:names:tc:SAML:2.0:protocol";
const NS_MD = "urn:oasis:names:tc:SAML:2.0:metadata";
const NS_DS = "http://www.w3.org/2000/09/xmldsig#";

const ALG_EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ALG_RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const ALG_SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
const ALG_ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

const CM_BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const AUTHN_CONTEXT_PASSWORD =
  "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";
const AUTHN_CONTEXT_MFA =
  "urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";

/** The NameID formats this provider will produce. Anything else is refused. */
export const SAML_NAME_ID_FORMAT_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
export const SAML_NAME_ID_FORMAT_PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
export const SAML_NAME_ID_FORMAT_UNSPECIFIED = "urn:oasis:names:tc:SAML:2.0:nameid-format:unspecified";

export const SAML_NAME_ID_FORMATS = [
  SAML_NAME_ID_FORMAT_EMAIL,
  SAML_NAME_ID_FORMAT_PERSISTENT,
  SAML_NAME_ID_FORMAT_UNSPECIFIED,
] as const;
export type SamlNameIdFormat = (typeof SAML_NAME_ID_FORMATS)[number];

/** The format used when a service provider does not ask for one. */
export const DEFAULT_NAME_ID_FORMAT: SamlNameIdFormat = SAML_NAME_ID_FORMAT_EMAIL;

export const SP_NAME_MAX = 120;
export const SP_ENTITY_ID_MAX = 300;
export const ACS_URLS_MAX = 10;

/**
 * How old an AuthnRequest may be. Five minutes is long enough for a slow
 * redirect and short enough that a request captured today is not a sign-in
 * tomorrow. Clock skew is the caller's problem to configure, not a licence to
 * accept last week's request.
 */
export const AUTHN_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;

/** How long an issued assertion is worth anything. */
export const ASSERTION_TTL_SECONDS = 300;

/* -------------------------------------------------------------------------- */
/*  Registered service providers                                              */
/* -------------------------------------------------------------------------- */

/**
 * A SAML 2.0 service provider: an application the organization has allowed
 * Sentinel to hand a signed assertion to.
 *
 * `entityId` is unique across the provider, not within an organization, for the
 * same reason an OIDC `clientId` is: an AuthnRequest arrives naming it and
 * nothing else — there is no tenant hint in the message — so it has to resolve
 * to exactly one organization.
 */
export interface SamlServiceProviderRecord {
  entityId: string;
  organizationId: string;
  name: string;
  /** Exact match only. `acsUrls[0]` is the default the metadata advertises. */
  acsUrls: readonly string[];
  nameIdFormat: SamlNameIdFormat;
  createdBy: string;
  createdAt: string;
}

export interface SamlIssue {
  field: string;
  message: string;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Whether an ACS URL is one we would register at all.
 *
 * The same rule OIDC redirect URIs get, for the same reason: `https` in general,
 * plain `http` only on a loopback address so a developer's local SP can be
 * tested. A fragment is refused because a browser never sends it, so a form
 * posted to such a URL would land on the wrong page. User-info is refused
 * because an assertion must not be posted to a URL carrying credentials.
 */
export function isRegistrableAcsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

export function validateServiceProvider(input: {
  name?: string;
  entityId?: string;
  acsUrls?: readonly string[];
  nameIdFormat?: string;
}): SamlIssue[] {
  const issues: SamlIssue[] = [];

  const name = input.name?.trim() ?? "";
  if (!name) issues.push({ field: "name", message: "A service provider name is required." });
  else if (name.length > SP_NAME_MAX) {
    issues.push({ field: "name", message: `The name may be at most ${SP_NAME_MAX} characters.` });
  }

  const entityId = input.entityId?.trim() ?? "";
  if (!entityId) issues.push({ field: "entityId", message: "An entity id is required." });
  else if (entityId.length > SP_ENTITY_ID_MAX) {
    issues.push({ field: "entityId", message: `The entity id may be at most ${SP_ENTITY_ID_MAX} characters.` });
  } else if (/\s/.test(entityId)) {
    issues.push({ field: "entityId", message: "An entity id is a URI, so it contains no spaces." });
  }

  const acsUrls = (input.acsUrls ?? []).map((url) => url.trim()).filter(Boolean);
  if (acsUrls.length === 0) issues.push({ field: "acsUrls", message: "At least one ACS URL is required." });
  if (acsUrls.length > ACS_URLS_MAX) {
    issues.push({ field: "acsUrls", message: `A service provider may register at most ${ACS_URLS_MAX} ACS URLs.` });
  }
  if (new Set(acsUrls).size !== acsUrls.length) {
    issues.push({ field: "acsUrls", message: "The same ACS URL is listed twice." });
  }
  for (const url of acsUrls) {
    if (!isRegistrableAcsUrl(url)) {
      issues.push({
        field: "acsUrls",
        message: `“${url}” is not an ACS URL we can register: https, or http on a loopback address.`,
      });
    }
  }

  if (input.nameIdFormat !== undefined && !isKnownNameIdFormat(input.nameIdFormat)) {
    issues.push({ field: "nameIdFormat", message: "That NameID format is not one this provider issues." });
  }

  return issues;
}

export function isKnownNameIdFormat(value: string): value is SamlNameIdFormat {
  return (SAML_NAME_ID_FORMATS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/*  The AuthnRequest                                                          */
/* -------------------------------------------------------------------------- */

/** The fields of an AuthnRequest this provider acts on. Everything else is ignored. */
export interface AuthnRequestInput {
  issuer?: string;
  /** Where the SP wants the response posted. We only ever use a registered one. */
  acsUrl?: string;
  /** The endpoint the SP believes it is talking to. Checked when present. */
  destination?: string;
  id?: string;
  issueInstant?: string;
  relayState?: string;
  /** From `<NameIDPolicy Format="…">`. */
  nameIdFormat?: string;
}

export interface AuthnRequestContext {
  /** Our SSO endpoint, as the SP should have addressed it. */
  ssoUrl: string;
  nowMs: number;
  /** How old a request may be. Overridable so a test need not fake a clock. */
  maxAgeMs?: number;
}

export type AuthnRequestDecision =
  | {
      ok: true;
      provider: SamlServiceProviderRecord;
      acsUrl: string;
      nameIdFormat: SamlNameIdFormat;
      requestId: string | null;
      relayState: string | null;
    }
  | { ok: false; error: string };

function refuse(error: string): AuthnRequestDecision {
  return { ok: false, error };
}

/**
 * Whether an AuthnRequest is one we will answer.
 *
 * The order is deliberate: the service provider is resolved first (by entity id,
 * which is the only thing in the message that names a tenant), then the ACS URL
 * is checked against what that provider registered, then the request's own
 * freshness. Anything refused after the first step is refused *for an SP we
 * know*, which is what makes the refusals safe to reason about.
 */
export function validateAuthnRequest(
  input: AuthnRequestInput,
  provider: SamlServiceProviderRecord | null,
  context: AuthnRequestContext,
): AuthnRequestDecision {
  const issuer = (input.issuer ?? "").trim();
  if (!provider) return refuse("That AuthnRequest names a service provider we do not know.");
  if (issuer !== provider.entityId) {
    return refuse(`The request's Issuer “${issuer}” is not the entity id it resolved to.`);
  }

  // An SP with one ACS URL is allowed to omit it — it is in the metadata, and
  // making it repeat itself is the kind of rule that turns a working integration
  // into a support ticket. Falling back to our own registered default is the safe
  // direction: the URL we use is registered by definition.
  const requestedAcs = (input.acsUrl ?? "").trim();
  if (requestedAcs && !provider.acsUrls.includes(requestedAcs)) {
    // Not a redirect and not a guess: the assertion is simply not issued. A
    // helpful message here would tell a caller which ACS URLs exist.
    return refuse("That AssertionConsumerServiceURL is not one this service provider registered.");
  }
  const acsUrl = requestedAcs || provider.acsUrls[0] || "";
  if (!acsUrl) {
    return refuse("That service provider registered no ACS URL, so there is nowhere to send an assertion.");
  }

  const destination = (input.destination ?? "").trim();
  if (destination && destination !== context.ssoUrl) {
    return refuse("The AuthnRequest was addressed to an endpoint this provider does not serve.");
  }

  const issueInstant = (input.issueInstant ?? "").trim();
  if (issueInstant) {
    const stamped = Date.parse(issueInstant);
    if (Number.isNaN(stamped)) return refuse("The AuthnRequest's IssueInstant is not a timestamp.");
    const age = context.nowMs - stamped;
    const maxAge = context.maxAgeMs ?? AUTHN_REQUEST_MAX_AGE_MS;
    // A request from the future is as suspicious as an old one: it means either
    // a clock we cannot reason about or a request that was minted elsewhere.
    if (age > maxAge || age < -maxAge) {
      return refuse("That AuthnRequest is too old to answer; the service provider must send a fresh one.");
    }
  }

  const requested = (input.nameIdFormat ?? "").trim();
  if (requested && !isKnownNameIdFormat(requested)) {
    return refuse(`This provider does not issue the NameID format “${requested}”.`);
  }
  if (requested && requested !== provider.nameIdFormat) {
    return refuse(
      `This service provider is registered for the NameID format “${provider.nameIdFormat}”, not “${requested}”.`,
    );
  }

  return {
    ok: true,
    provider,
    acsUrl,
    // The registration's format, never the request's: a request can only ever
    // confirm it (see the note above), so a per-request parameter cannot widen
    // what this provider was told to assert.
    nameIdFormat: provider.nameIdFormat,
    requestId: (input.id ?? "").trim() || null,
    relayState: (input.relayState ?? "").trim() || null,
  };
}

/* -------------------------------------------------------------------------- */
/*  XML, read and written                                                     */
/* -------------------------------------------------------------------------- */

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A start tag for exactly this element, namespace prefix optional.
 *
 * Anchoring the name at `<(?:prefix:)?name` rather than looking for the word
 * anywhere inside the tag is not cosmetic: `Issuer="…"` on an `AuthnRequest`
 * would otherwise look like the `<saml:Issuer>` element, and the reader would
 * return an attribute instead of the issuer.
 */
/*
 * Small regex fragments, taken from regex literals so the escaping is written
 * once and cannot drift between the patterns that use them.
 */
const PREFIX = /(?:[A-Za-z_][\w.-]*:)?/.source;
const WS = /\s/.source;
const ANY = /[\s\S]*?/.source;

/** A start tag for exactly this element, a namespace prefix being optional. */
function openTag(localName: string): string {
  return `<${PREFIX}${localName}(?:${WS}[^>]*)?>`;
}

/** One attribute out of an already-matched start tag. */
function attributeValue(tag: string | undefined, name: string): string | null {
  if (!tag) return null;
  const found = new RegExp(`${name}${WS}*=${WS}*"([^"]*)"`, "i").exec(tag);
  return found ? decodeXml(found[1]) : null;
}

function attribute(xml: string, element: string, name: string): string | null {
  return attributeValue(new RegExp(openTag(element), "i").exec(xml)?.[0], name);
}

function elementText(xml: string, localName: string): string | null {
  const found = new RegExp(`${openTag(localName)}(${ANY})</${PREFIX}${localName}${WS}*>`, "i").exec(xml);
  return found ? decodeXml(found[1]) : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Read the fields we act on out of an AuthnRequest document.
 *
 * A deliberately narrow reader: it pulls the handful of attributes and the one
 * element this provider uses, and ignores everything else. It is **not** a
 * general XML parser and does not pretend to be — the security decisions do not
 * depend on it, because every value it returns is checked against what the
 * service provider registered by `validateAuthnRequest`.
 */
export function parseAuthnRequestXml(xml: string): AuthnRequestInput {
  return {
    issuer: elementText(xml, "Issuer") ?? undefined,
    acsUrl: attribute(xml, "AuthnRequest", "AssertionConsumerServiceURL") ?? undefined,
    destination: attribute(xml, "AuthnRequest", "Destination") ?? undefined,
    id: attribute(xml, "AuthnRequest", "ID") ?? undefined,
    issueInstant: attribute(xml, "AuthnRequest", "IssueInstant") ?? undefined,
    nameIdFormat: attribute(xml, "NameIDPolicy", "Format") ?? undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*  The assertion and the signature that makes it worth something             */
/* -------------------------------------------------------------------------- */

export interface SamlAssertionInput {
  /** Our issuer identifier: the same one OIDC discovery advertises. */
  issuer: string;
  assertionId: string;
  /** The SAML entity id of our own IdP — what the SP checks `Issuer` against. */
  idpEntityId: string;
  provider: SamlServiceProviderRecord;
  acsUrl: string;
  requestId: string | null;
  sessionId: string;
  nameIdFormat: SamlNameIdFormat;
  identity: {
    id: string;
    identifier: string;
    displayName: string;
    role: string;
    organizationId: string;
    mfaEnrolled: boolean;
  };
  nowMs: number;
  ttlSeconds?: number;
}

/**
 * The attribute this provider carries about a person.
 *
 * The set is small on purpose: every attribute here is a claim an application
 * will trust without asking again, so it is limited to what the spine actually
 * knows. `organizationId` is included because a service provider serving several
 * of our tenants needs to file the assertion under the right one.
 */
export function samlAttributes(input: SamlAssertionInput): { name: string; value: string }[] {
  return [
    { name: "urn:oid:1.3.6.1.4.1.5923.1.1.1.6", value: input.identity.identifier },
    { name: "displayName", value: input.identity.displayName },
    { name: "role", value: input.identity.role },
    { name: "organizationId", value: input.identity.organizationId },
    { name: "mfa", value: input.identity.mfaEnrolled ? "true" : "false" },
  ];
}

/** One attribute statement, with values as `<saml:AttributeValue>` children. */
function attributeStatementXml(input: SamlAssertionInput): string {
  const attributes = samlAttributes(input)
    .map(
      (attribute) =>
        `<saml:Attribute Name="${xmlEscape(attribute.name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">` +
        `<saml:AttributeValue>${xmlEscape(attribute.value)}</saml:AttributeValue>` +
        `</saml:Attribute>`,
    )
    .join("");
  return `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>`;
}

/**
 * The name a person is known by inside the assertion.
 *
 * A `persistent` NameID is our identity id, because it must not change when
 * somebody's address does; an `emailAddress` one is the address, because that is
 * what the format promises; `unspecified` is the address too, and the word
 * "unspecified" is then honest about what an SP should assume.
 */
export function nameIdValue(input: SamlAssertionInput): string {
  return input.nameIdFormat === SAML_NAME_ID_FORMAT_PERSISTENT ? input.identity.id : input.identity.identifier;
}

/**
 * The assertion element, with the signature material inserted right after the
 * `Issuer` when it is given.
 *
 * Every element is written with no whitespace between tags, so the document is
 * its own canonical form: deleting the `<ds:Signature>` element from what we
 * send leaves exactly the bytes the digest was taken over. That is the whole
 * contract, and it is why `assertionCanonical` is a string replacement rather
 * than a canonicalisation library.
 */
export function samlAssertionXml(input: SamlAssertionInput, signatureBlock: string): string {
  const ttl = input.ttlSeconds ?? ASSERTION_TTL_SECONDS;
  const issued = new Date(input.nowMs).toISOString();
  const expires = new Date(input.nowMs + ttl * 1000).toISOString();
  const authnContext = input.identity.mfaEnrolled ? AUTHN_CONTEXT_MFA : AUTHN_CONTEXT_PASSWORD;
  const inResponseTo =
    input.requestId === null ? "" : ` InResponseTo="${xmlEscape(input.requestId)}"`;

  return (
    `<saml:Assertion xmlns:saml="${NS_SAML}" ID="${xmlEscape(input.assertionId)}" Version="2.0" IssueInstant="${issued}">` +
    signatureBlock +
    `<saml:Issuer>${xmlEscape(input.idpEntityId)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${xmlEscape(input.nameIdFormat)}">${xmlEscape(nameIdValue(input))}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="${CM_BEARER}">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${expires}" Recipient="${xmlEscape(input.acsUrl)}"${inResponseTo}/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${issued}" NotOnOrAfter="${expires}">` +
    `<saml:AudienceRestriction><saml:Audience>${xmlEscape(input.provider.entityId)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${issued}" SessionIndex="${xmlEscape(input.sessionId)}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>${authnContext}</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    attributeStatementXml(input) +
    `</saml:Assertion>`
  );
}

/** The bytes a digest is taken over: the assertion with its signature removed. */
export function assertionCanonical(assertionXml: string): string {
  return assertionXml.replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, "");
}

/** The `<ds:SignedInfo>` element, which is what the RSA signature covers. */
export function signedInfoXml(input: { assertionId: string; digestB64: string }): string {
  return (
    `<ds:SignedInfo>` +
    `<ds:CanonicalizationMethod Algorithm="${ALG_EXC_C14N}"/>` +
    `<ds:SignatureMethod Algorithm="${ALG_RSA_SHA256}"/>` +
    `<ds:Reference URI="#${xmlEscape(input.assertionId)}">` +
    `<ds:Transforms><ds:Transform Algorithm="${ALG_ENVELOPED}"/></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${ALG_SHA256}"/>` +
    `<ds:DigestValue>${input.digestB64}</ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>`
  );
}

/** The whole `<ds:Signature>`, given a signed `SignedInfo` and its signature. */
export function signatureBlockXml(input: {
  signedInfoXml: string;
  signatureValueB64: string;
  kid: string;
}): string {
  return (
    `<ds:Signature xmlns:ds="${NS_DS}">` +
    input.signedInfoXml +
    `<ds:SignatureValue>${input.signatureValueB64}</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:KeyName>${xmlEscape(input.kid)}</ds:KeyName></ds:KeyInfo>` +
    `</ds:Signature>`
  );
}

/** The parts of a signature a verifier needs, pulled back out of a document. */
export interface SamlSignatureParts {
  assertionId: string | null;
  referenceUri: string | null;
  digestB64: string | null;
  signedInfoXml: string | null;
  signatureValueB64: string | null;
  kid: string | null;
}

export function samlSignatureParts(assertionXml: string): SamlSignatureParts {
  const signature = /<ds:Signature[\s\S]*?<\/ds:Signature>/.exec(assertionXml)?.[0] ?? "";
  const signedInfo = /<ds:SignedInfo[\s\S]*?<\/ds:SignedInfo>/.exec(signature)?.[0] ?? null;
  return {
    assertionId: attribute(assertionXml, "Assertion", "ID"),
    referenceUri: attribute(signature, "Reference", "URI"),
    digestB64: elementText(signature, "DigestValue"),
    signedInfoXml: signedInfo,
    signatureValueB64: elementText(signature, "SignatureValue"),
    kid: elementText(signature, "KeyName"),
  };
}

/**
 * The `<samlp:Response>` that carries the assertion.
 *
 * `Destination` and `InResponseTo` are the two fields a service provider checks
 * before it reads the assertion, and both are echoed from the request rather
 * than invented: a response that names a destination the SP did not ask for is
 * one it should refuse.
 */
export function samlResponseXml(input: {
  idpEntityId: string;
  responseId: string;
  acsUrl: string;
  requestId: string | null;
  nowMs: number;
  assertionXml: string;
}): string {
  const issued = new Date(input.nowMs).toISOString();
  const inResponseTo = input.requestId === null ? "" : ` InResponseTo="${xmlEscape(input.requestId)}"`;
  return (
    `<samlp:Response xmlns:samlp="${NS_SAMLP}" ID="${xmlEscape(input.responseId)}" Version="2.0" IssueInstant="${issued}"` +
    ` Destination="${xmlEscape(input.acsUrl)}"${inResponseTo}>` +
    `<saml:Issuer xmlns:saml="${NS_SAML}">${xmlEscape(input.idpEntityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${STATUS_SUCCESS}"/></samlp:Status>` +
    input.assertionXml +
    `</samlp:Response>`
  );
}

/** The auto-posting form an HTTP-POST binding answers with, as a whole page. */
export function postBindingPage(acsUrl: string, samlResponseB64: string, relayState: string | null): string {
  const relay = relayState === null ? "" : `<input type="hidden" name="RelayState" value="${xmlEscape(relayState)}"/>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Continue to your application</title></head>` +
    `<body onload="document.forms[0].submit()">` +
    `<form method="post" action="${xmlEscape(acsUrl)}">` +
    `<input type="hidden" name="SAMLResponse" value="${samlResponseB64}"/>` +
    relay +
    `<noscript><button type="submit">Continue</button></noscript>` +
    `</form></body></html>`
  );
}

/* -------------------------------------------------------------------------- */
/*  Metadata                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The IdP's metadata document.
 *
 * It advertises the two single-sign-on bindings and nothing it does not serve:
 * no artifact binding, no attribute-query (this provider answers sign-ins, not
 * questions about people), and `WantAuthnRequestsSigned="false"` is stated
 * rather than implied — the request carries no secret, and requiring a signature
 * on it would lock out the SPs that cannot sign one.
 */
export function idpMetadataXml(input: {
  entityId: string;
  ssoUrl: string;
  nameIdFormats: readonly SamlNameIdFormat[];
  /** Every published key, active first. */
  keys: readonly { modulusB64: string; exponentB64: string; kid: string }[];
  validUntilMs?: number;
}): string {
  const formats = input.nameIdFormats.map((format) => `<md:NameIDFormat>${format}</md:NameIDFormat>`).join("");
  const validUntil =
    input.validUntilMs === undefined ? "" : ` validUntil="${new Date(input.validUntilMs).toISOString()}"`;
  // One `KeyDescriptor` per published key, because that is what makes a rotation
  // safe for an SP: it re-reads metadata on its own schedule, so the new key has to
  // be visible here *before* the IdP starts signing with it. Advertising only the
  // active key would make every assertion fail for whatever window the SP's cache
  // is still holding the old one — and the SP has no way to know it needs to look.
  const descriptors = input.keys
    .map(
      (key) =>
        `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${NS_DS}">` +
        `<ds:KeyName>${xmlEscape(key.kid)}</ds:KeyName>` +
        `<ds:KeyValue><ds:RSAKeyValue>` +
        `<ds:Modulus>${key.modulusB64}</ds:Modulus>` +
        `<ds:Exponent>${key.exponentB64}</ds:Exponent>` +
        `</ds:RSAKeyValue></ds:KeyValue>` +
        `</ds:KeyInfo></md:KeyDescriptor>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<md:EntityDescriptor xmlns:md="${NS_MD}" entityID="${xmlEscape(input.entityId)}"${validUntil}>` +
    `<md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="${NS_SAMLP}">` +
    descriptors +
    formats +
    `<md:SingleSignOnService Binding="${SAML_BINDINGS.redirect}" Location="${xmlEscape(input.ssoUrl)}"/>` +
    `<md:SingleSignOnService Binding="${SAML_BINDINGS.post}" Location="${xmlEscape(input.ssoUrl)}"/>` +
    `</md:IDPSSODescriptor>` +
    `</md:EntityDescriptor>`
  );
}
