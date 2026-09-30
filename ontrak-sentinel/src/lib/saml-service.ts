/**
 * SAML service (S1): the IdP's side of SSO, over the same S0 spine OIDC uses.
 *
 * `saml-rules.ts` decides everything — who may receive identity, whether a
 * request is answerable, what the assertion says — and this file stores the
 * result, checks it against the spine and records it. Four decisions worth
 * stating out loud:
 *
 *  - **A service provider is registered before it can be served, and the
 *    registration is audited.** It is a decision about who receives identity,
 *    exactly as an OIDC client registration is, so it lands on the same chain.
 *  - **The session is resolved through the spine, not re-derived.** A SAML
 *    sign-in therefore cannot get around a deactivated identity, an unenforced
 *    second factor or an idle timeout — the policy is asked the same way it is
 *    asked at every other entry point.
 *  - **The assertion is signed with the OIDC signing key.** One key pair, one
 *    rotation, one thing to keep secret; a second key would be a second thing
 *    somebody forgets to rotate. `SigningKeys` and the JWKS publication are shared
 *    with `oidc-keys.ts`, so an assertion is signed with whatever key the ID tokens
 *    are signed with — and metadata advertises all of them, the same overlap the
 *    JWKS provides for OIDC.
 *  - **The response is delivered by HTTP-POST, in an auto-submitting form.** The
 *    assertion is a bearer credential, so it must not sit in a query string where
 *    it lands in a proxy log, a referrer and the browser's history — which is
 *    precisely what the artifact-free redirect binding would do with it.
 *
 * Registration is administrator work; the SSO endpoint needs no actor, because
 * the session *is* the credential — the same shape as the OIDC token endpoint.
 */

import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import type { HashFn } from "./audit-chain";
import { sha256Hex } from "./hash";
import { canManageIdentities, canReadDirectory, type IdentityRecord } from "./identity-rules";
import type { AuditTrail, IdentityActor, IdentityService, IdentityStore, ServiceResult } from "./identity-service";
import { activeKey, type SigningKeys } from "./oidc-keys";
import {
  DEFAULT_NAME_ID_FORMAT,
  SAML_NAME_ID_FORMATS,
  SAML_PATHS,
  idpMetadataXml,
  parseAuthnRequestXml,
  postBindingPage,
  samlAssertionXml,
  samlResponseXml,
  signatureBlockXml,
  validateAuthnRequest,
  validateServiceProvider,
  type SamlBinding,
  type SamlNameIdFormat,
  type SamlServiceProviderRecord,
} from "./saml-rules";
import { digestValueB64, rsaXmlSigner, signedInfoXml, signingKeyMaterial, type XmlSigner } from "./saml-sign";

/* -------------------------------------------------------------------------- */
/*  The stored records                                                        */
/* -------------------------------------------------------------------------- */

export interface SamlStore {
  insertServiceProvider(record: SamlServiceProviderRecord): Promise<void>;
  /** Scoped by organization: another tenant's provider is not found at all. */
  findServiceProvider(organizationId: string, entityId: string): Promise<SamlServiceProviderRecord | null>;
  /**
   * Unscoped, because an AuthnRequest carries no tenant hint — the entity id is
   * the only thing in the message that names one, exactly as `client_id` is for
   * OIDC. That is why the entity id is globally unique in the schema.
   */
  findServiceProviderByEntityId(entityId: string): Promise<SamlServiceProviderRecord | null>;
  listServiceProviders(organizationId: string): Promise<SamlServiceProviderRecord[]>;
}

export interface SamlIds {
  id(): string;
  now(): string;
  nowMs(): number;
}

export function systemSamlIds(): SamlIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString(), nowMs: () => Date.now() };
}

/** Everything the SAML side needs that is deployment configuration, not logic. */
export interface SamlConfig {
  /** The IdP's entity id, and the issuer the assertion carries. */
  entityId: string;
  /** Every signing key, active first. The first signs; all are advertised. */
  keys: SigningKeys;
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

export interface RegisterServiceProviderInput {
  name?: string;
  entityId?: string;
  acsUrls?: readonly string[];
  nameIdFormat?: string;
}

export interface SsoInput {
  /** The `SAMLRequest` as it arrived, base64 as the binding defines it. */
  samlRequest?: string;
  relayState?: string;
  binding: SamlBinding;
  /** The session cookie the browser presented. There can be no SSO without one. */
  sessionId: string;
}

export type SsoResult =
  | { ok: true; html: string; acsUrl: string; relayState: string | null }
  | { ok: false; error: string };

/* -------------------------------------------------------------------------- */
/*  Decoding the AuthnRequest                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Turn a `SAMLRequest` into XML.
 *
 * The redirect binding DEFLATEs the message and base64s it; the POST binding
 * base64s the XML directly. Both are decoded here rather than in the service
 * loop, and neither is trusted: what comes out is parsed by the narrow reader in
 * `saml-rules.ts` and every field it yields is checked against what the service
 * provider registered.
 */
export function decodeAuthnRequest(encoded: string, binding: SamlBinding): string {
  const cleaned = encoded.trim();
  if (!cleaned) throw new Error("The request carried no SAMLRequest.");
  const raw = Buffer.from(cleaned, "base64");
  if (raw.length === 0) throw new Error("The SAMLRequest is not base64.");
  // The redirect binding DEFLATEs with a raw stream (no zlib header); the POST
  // binding is the XML itself, base64ed and nothing more.
  if (binding === "redirect") return inflateRawSync(raw).toString("utf8");
  return raw.toString("utf8");
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

export class SamlService {
  constructor(
    private readonly store: SamlStore,
    /** The S0 spine: the session policy, reused rather than re-derived. */
    private readonly spine: IdentityService,
    private readonly config: SamlConfig,
    private readonly audit: AuditTrail | null = null,
    private readonly ids: SamlIds = systemSamlIds(),
    private readonly hash: HashFn = sha256Hex,
    /** Injected so a test can drive the whole flow without an RSA key. */
    private readonly sign: XmlSigner = rsaXmlSigner(activeKey(config.keys)),
  ) {}

  /** The IdP's SSO endpoint, as the SP should have addressed it. */
  get ssoUrl(): string {
    return `${this.config.entityId.replace(/\/+$/, "")}${SAML_PATHS.sso}`;
  }

  /* -------------------------------------------------- service providers */

  /** Register a service provider. Administrator work: it decides who receives assertions. */
  async registerServiceProvider(
    actor: IdentityActor,
    input: RegisterServiceProviderInput,
  ): Promise<ServiceResult<SamlServiceProviderRecord>> {
    if (!canManageIdentities(actor.role)) return { ok: false, error: "You do not register service providers." };

    const issues = validateServiceProvider(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const entityId = input.entityId!.trim();
    if (await this.store.findServiceProviderByEntityId(entityId)) {
      return { ok: false, error: `“${entityId}” is already a service provider here.` };
    }

    const record: SamlServiceProviderRecord = {
      entityId,
      organizationId: actor.organizationId,
      name: input.name!.trim(),
      acsUrls: (input.acsUrls ?? []).map((url) => url.trim()),
      nameIdFormat: (input.nameIdFormat ?? DEFAULT_NAME_ID_FORMAT) as SamlNameIdFormat,
      createdBy: actor.id,
      createdAt: this.ids.now(),
    };
    await this.store.insertServiceProvider(record);
    await this.append(record.organizationId, actor.id, "saml.sp.register", "SamlServiceProvider", record.entityId, {
      name: record.name,
      acsUrls: record.acsUrls,
      nameIdFormat: record.nameIdFormat,
    });
    return { ok: true, value: record };
  }

  /** The service providers this organization has registered. */
  async listServiceProviders(actor: IdentityActor): Promise<ServiceResult<SamlServiceProviderRecord[]>> {
    if (!canReadDirectory(actor.role)) {
      return { ok: false, error: "You do not have access to the registered service providers." };
    }
    return { ok: true, value: await this.store.listServiceProviders(actor.organizationId) };
  }

  /* ------------------------------------------------------------ metadata */

  /**
   * The IdP's metadata document.
   *
   * Public and tenant-independent, which is the point: it describes *this
   * provider*, and a service provider needs it before it has any relationship
   * with us. It carries all three NameID formats we can issue, because it
   * describes what the IdP is capable of rather than what one SP asked for.
   */
  metadata(): string {
    // Every key, not just the active one: see `idpMetadataXml`, which is where the
    // reason an SP needs to see a key it has not been signed with yet is written down.
    const material = this.config.keys.map(signingKeyMaterial);
    return idpMetadataXml({
      entityId: this.config.entityId,
      ssoUrl: this.ssoUrl,
      nameIdFormats: [...SAML_NAME_ID_FORMATS],
      keys: material,
    });
  }

  /* ----------------------------------------------------------------- SSO */

  /**
   * Answer an AuthnRequest with a signed assertion.
   *
   * The order is the security: decode, resolve the SP by entity id (the only
   * thing in the message that names a tenant), check the request against what
   * that SP registered, *then* resolve the session through the spine. Nothing is
   * said about a session before the request is known to be answerable, so the
   * endpoint is not a way of probing whether a session id is live.
   */
  async sso(input: SsoInput): Promise<SsoResult> {
    let xml: string;
    try {
      xml = decodeAuthnRequest(input.samlRequest ?? "", input.binding);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The SAMLRequest could not be decoded." };
    }

    const parsed = parseAuthnRequestXml(xml);
    const provider = parsed.issuer ? await this.store.findServiceProviderByEntityId(parsed.issuer.trim()) : null;

    const decision = validateAuthnRequest({ ...parsed, relayState: input.relayState }, provider, {
      ssoUrl: this.ssoUrl,
      nowMs: this.ids.nowMs(),
    });
    if (!decision.ok) {
      if (provider) {
        await this.append(provider.organizationId, "system:saml", "saml.sso.refuse", "SamlServiceProvider", provider.entityId, {
          reason: decision.error,
        });
      }
      return { ok: false, error: decision.error };
    }

    // Scoped by the provider's organization: another tenant's session is not
    // found, rather than found and refused.
    const session = await this.spine.resolveSession(decision.provider.organizationId, input.sessionId);
    if (!session.ok) {
      await this.append(decision.provider.organizationId, "system:saml", "saml.sso.refuse", "SamlServiceProvider", decision.provider.entityId, {
        reason: session.error,
      });
      return { ok: false, error: session.error };
    }

    const now = this.ids.nowMs();
    const assertionId = `_${this.ids.id().replace(/[^A-Za-z0-9]/g, "")}`;
    const assertion = samlAssertionXml(
      {
        issuer: this.config.entityId,
        idpEntityId: this.config.entityId,
        assertionId,
        provider: decision.provider,
        acsUrl: decision.acsUrl,
        requestId: decision.requestId,
        sessionId: session.value.session.id,
        nameIdFormat: decision.nameIdFormat,
        identity: identityForAssertion(session.value.identity),
        nowMs: now,
      },
      // The signature is inserted here, before the issuer, so the digest is taken
      // over the document *without* it — which is what the verifier reproduces.
      "",
    );

    const digestB64 = digestValueB64(assertion, this.hash);
    const signedInfo = signedInfoXml({ assertionId, digestB64 });
    const signature = this.sign(signedInfo);

    const signed = samlAssertionXml(
      {
        issuer: this.config.entityId,
        idpEntityId: this.config.entityId,
        assertionId,
        provider: decision.provider,
        acsUrl: decision.acsUrl,
        requestId: decision.requestId,
        sessionId: session.value.session.id,
        nameIdFormat: decision.nameIdFormat,
        identity: identityForAssertion(session.value.identity),
        nowMs: now,
      },
      signatureBlockXml({
        signedInfoXml: signedInfo,
        signatureValueB64: signature,
        kid: activeKey(this.config.keys).kid,
      }),
    );

    const response = samlResponseXml({
      idpEntityId: this.config.entityId,
      responseId: `_${assertionId.slice(1)}-r`,
      acsUrl: decision.acsUrl,
      requestId: decision.requestId,
      nowMs: now,
      assertionXml: signed,
    });

    await this.append(decision.provider.organizationId, session.value.identity.id, "saml.sso", "SamlServiceProvider", decision.provider.entityId, {
      subject: session.value.identity.id,
      sessionId: session.value.session.id,
      acsUrl: decision.acsUrl,
      nameIdFormat: decision.nameIdFormat,
      assertionId,
    });

    return {
      ok: true,
      acsUrl: decision.acsUrl,
      relayState: decision.relayState,
      html: postBindingPage(decision.acsUrl, Buffer.from(response, "utf8").toString("base64"), decision.relayState),
    };
  }

  /* ------------------------------------------------------------- internals */

  private async append(
    organizationId: string,
    actor: string,
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.append({
      id: this.ids.id(),
      at: this.ids.now(),
      actor,
      action,
      targetType,
      targetId,
      detail: { ...detail, organizationId },
    });
  }
}

/** The identity fields an assertion carries, projected from the spine's record. */
function identityForAssertion(identity: IdentityRecord): {
  id: string;
  identifier: string;
  displayName: string;
  role: string;
  organizationId: string;
  mfaEnrolled: boolean;
} {
  return {
    id: identity.id,
    identifier: identity.identifier,
    displayName: identity.displayName,
    role: identity.role,
    organizationId: identity.organizationId,
    mfaEnrolled: identity.mfaEnrolled,
  };
}

/* -------------------------------------------------------------------------- */
/*  An in-memory store, used by tests and local development                   */
/* -------------------------------------------------------------------------- */

export class MemorySamlStore implements SamlStore {
  private readonly providers = new Map<string, SamlServiceProviderRecord>();

  async insertServiceProvider(record: SamlServiceProviderRecord): Promise<void> {
    this.providers.set(record.entityId, structuredClone(record));
  }

  async findServiceProvider(organizationId: string, entityId: string): Promise<SamlServiceProviderRecord | null> {
    const found = this.providers.get(entityId);
    return found && found.organizationId === organizationId ? structuredClone(found) : null;
  }

  async findServiceProviderByEntityId(entityId: string): Promise<SamlServiceProviderRecord | null> {
    const found = this.providers.get(entityId);
    return found ? structuredClone(found) : null;
  }

  async listServiceProviders(organizationId: string): Promise<SamlServiceProviderRecord[]> {
    return [...this.providers.values()]
      .filter((entry) => entry.organizationId === organizationId)
      .map((entry) => structuredClone(entry));
  }
}
